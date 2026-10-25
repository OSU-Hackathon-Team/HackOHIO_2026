"""Scoped preparation must never fall back to global analysis or reuse another scope."""
import json
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from engine.analysis.scoped import prepare_scoped, prepared_readers, rea_reader, rea_java


class FakeEngine:
    def __init__(self, root):
        self.root = root
        self.headless = root / 'headless'
        self.calls = []
    def _emit(self, *args, **kwargs):
        pass
    def _run(self, args, *unused):
        self.calls.append(args)
        folder = Path(args[0])
        (folder / 'baseline.gpr').write_text('project')
        (folder / 'baseline.rep').mkdir()
        (folder / 'baseline.rep' / 'db').write_text('immutable')
        (folder / 'scope.json').write_text(json.dumps({'status': 'ok', 'functions': [{'entry': '100010'}]}))


class ScopedPreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.binary = self.root / 'input.so'
        self.binary.write_bytes(b'actual binary bytes')
        self.engine = FakeEngine(self.root)
        self.inventory = {'elf_image_base': '0x0', 'symbols': [
            {'address': '0x10', 'size': 24, 'name': 'first'},
            {'address': '0x40', 'size': 32, 'name': 'second'}]}
        for name, value in [('symbol_inventory', self.inventory), ('tool_version', 'version')]:
            mocked = patch('engine.analysis.scoped.' + name, return_value=value)
            mocked.start()
            self.addCleanup(mocked.stop)

    def test_same_scope_reuses_import_and_different_scope_does_not(self):
        first = prepare_scoped(self.engine, self.binary, ['first'])
        again = prepare_scoped(self.engine, self.binary, ['first'])
        other = prepare_scoped(self.engine, self.binary, ['second'])
        self.assertFalse(first['cache_hit'])
        self.assertTrue(again['cache_hit'])
        self.assertEqual(first['campaign'], again['campaign'])
        self.assertNotEqual(first['campaign'], other['campaign'])
        self.assertEqual(len(self.engine.calls), 2)
        for command in self.engine.calls:
            self.assertIn('-noanalysis', command)
            self.assertIn('ScopedAnalysis.java', command)

    def test_unknown_symbol_and_budget_fail_before_import(self):
        for seeds, kwargs in [(['missing'], {}), (['first', 'second'], {'max_functions': 1}),
                              (['first'], {'max_function_bytes': 8}), (['first'], {'max_depth': 5})]:
            with self.assertRaises(ValueError):
                prepare_scoped(self.engine, self.binary, seeds, **kwargs)
        self.assertEqual(self.engine.calls, [])

    def test_changed_binary_and_limits_invalidate_cache(self):
        first = prepare_scoped(self.engine, self.binary, ['first'])
        limited = prepare_scoped(self.engine, self.binary, ['first'], max_depth=0)
        self.binary.write_bytes(b'changed bytes')
        changed = prepare_scoped(self.engine, self.binary, ['first'])
        self.assertEqual(len({first['campaign'], limited['campaign'], changed['campaign']}), 3)

    def test_pipeline_index_contains_only_prepared_functions_and_is_reused(self):
        from engine.analysis.ghidra import GhidraAnalysis
        from engine.artifacts import LocalArtifactStore
        self.engine.store = LocalArtifactStore(self.root / 'artifacts')
        original_run = self.engine._run
        def run(args, *metadata):
            if '-process' not in args:
                return original_run(args, *metadata)
            self.engine.calls.append(args)
            Path(args[-2]).write_text(json.dumps({'status': 'ok', 'image_base': '100000',
                'functions': [{'entry': '100010', 'name': 'first'},
                              {'entry': '100040', 'name': 'second'}]}))
        self.engine._run = run
        version = patch('engine.analysis.ghidra.tool_version', return_value='version')
        version.start()
        self.addCleanup(version.stop)
        first = GhidraAnalysis.analyze_scoped(self.engine, self.binary, ['first'],
                                            max_functions=1, max_depth=0)
        again = GhidraAnalysis.analyze_scoped(self.engine, self.binary, ['first'],
                                            max_functions=1, max_depth=0)
        self.assertEqual(first['index_artifact'], again['index_artifact'])
        self.assertEqual(first['function_count'], 1)
        index = json.loads(self.engine.store.get(first['index_artifact']))
        self.assertEqual([f['name'] for f in index['functions']], ['first'])
        self.assertEqual(len(self.engine.calls), 2)
        self.assertTrue(all('-noanalysis' in command for command in self.engine.calls))

    def test_damaged_scope_is_not_a_cache_hit(self):
        first = prepare_scoped(self.engine, self.binary, ['first'])
        (Path(first['project']) / 'scope.json').write_text('{}')
        with self.assertRaisesRegex(RuntimeError, 'scope report changed'):
            prepare_scoped(self.engine, self.binary, ['first'])

    def test_rea_reads_a_private_copy_without_importing_or_analyzing(self):
        prepared = prepare_scoped(self.engine, self.binary, ['first'])
        source = Path(prepared['project'])
        target = self.root / 'rea-private'
        with patch('engine.analysis.scoped.subprocess.call', return_value=0) as run:
            result = rea_reader(source / 'manifest.json', self.root / 'headless',
                [str(target), 'rea-project', '-import', str(self.binary), '-readOnly',
                 '-deleteProject', '-postScript', 'ReaGhidraBridge.java', '/tmp/session.json'])
        self.assertEqual(result, 0)
        command = run.call_args.args[0]
        self.assertIn('-process', command)
        self.assertIn('-noanalysis', command)
        self.assertIn('-readOnly', command)
        self.assertNotIn('-import', command)
        (target / 'baseline.rep' / 'db').write_text('reader changed')
        self.assertEqual((source / 'baseline.rep' / 'db').read_text(), 'immutable')

    def test_rea_refuses_another_binary(self):
        prepared = prepare_scoped(self.engine, self.binary, ['first'])
        self.binary.write_bytes(b'other')
        with self.assertRaisesRegex(ValueError, 'target differs'):
            rea_reader(Path(prepared['project']) / 'manifest.json', self.root / 'headless',
                       [str(self.root / 'reader'), 'rea', '-import', str(self.binary)])

    def test_native_rea_search_value_rows_are_deduplicated(self):
        from engine.analysis.rea import procedures
        row = {'address': '0xca1490', 'value': 'Calc_ScSpreadsheetSettings_get_implementation'}
        result = procedures({'operation': 'search_procedures', 'raw_result': [row],
                             'normalized_result': [row]})
        self.assertEqual(result, [{'address': row['address'], 'name': row['value']}])

    def test_prepared_install_adapts_java_and_keeps_ghidra_installation(self):
        prepared = prepare_scoped(self.engine, self.binary, ['first'])
        ghidra = self.root / 'ghidra-install'
        (ghidra / 'support').mkdir(parents=True)
        (ghidra / 'Ghidra').mkdir()
        (ghidra / 'support' / 'analyzeHeadless').write_text('original launcher')
        (ghidra / 'support' / 'LaunchSupport.jar').write_bytes(b'launch support')
        readers = self.root / 'readers'
        java = self.root / 'jdk'
        (java / 'bin').mkdir(parents=True)
        (java / 'bin' / 'java').write_text('java')
        (java / 'bin' / 'javac').write_text('javac')
        (java / 'release').write_text('release')
        with patch.dict('os.environ', {'JAVA_HOME': str(java)}):
            servers = prepared_readers(prepared, readers, ghidra)
        support = readers / 'rea-java' / 'bin'
        self.assertEqual((support / 'javac').read_text(), 'javac')
        self.assertFalse((support / 'java').is_symlink())
        self.assertEqual(servers['rea']['environment']['GHIDRA_INSTALL_DIR'], str(ghidra))
        self.assertEqual(servers['ghidra']['command'][-1], str(readers / 'ghidra'))

    def test_direct_java_launch_reuses_scope_and_java_probes_pass_through(self):
        prepared = prepare_scoped(self.engine, self.binary, ['first'])
        pointer = Path(prepared['project']) / 'manifest.json'
        prefix = ['-cp', 'Utility.jar', 'ghidra.Ghidra', 'ghidra.app.util.headless.AnalyzeHeadless']
        with patch('engine.analysis.scoped.subprocess.call', return_value=0) as run:
            rea_java(pointer, Path('/java'), [*prefix, str(self.root / 'private'), 'rea',
                                            '-import', str(self.binary), '-readOnly'])
            command = run.call_args.args[0]
            self.assertEqual(command[1:5], prefix)
            self.assertIn('-process', command)
            self.assertIn('-noanalysis', command)
            self.assertNotIn('-import', command)
            rea_java(pointer, Path('/java'), ['-version'])
            self.assertEqual(run.call_args.args[0], ['/java', '-version'])
            rea_java(pointer, Path('/java'), ['-XshowSettings:properties', '-version'],
                     java_home=Path('/private-jdk'))
            self.assertIn('-Djava.home=/private-jdk', run.call_args.args[0])


class ScopedPipelineOrderingTests(unittest.TestCase):
    def test_runtime_discovery_precedes_analysis_and_preserves_the_boundary(self):
        from contextlib import nullcontext
        from types import SimpleNamespace
        from engine.lo_pipeline import LoPipelineConfig, LoPipelineDeps, run_pipeline
        events = []
        inventory = {'elf_image_base': '0x0', 'symbols': [
            {'address': '0x10', 'size': 24, 'name': 'observed'}]}
        triage = {'hooked': 1, 'cases': {'public': {'hits': [
            {'entry': '00000010', 'offset': '0x10', 'count': 1}]}}}
        manifest = {'campaign': 'scoped', 'binary_sha256': 'hash', 'function_count': 1,
                    'scope': {'frontier': [{'entry': '100040', 'reason': 'unknown_symbol_extent'}]}}
        def trace(*args, **kwargs):
            events.append('runtime')
            return triage
        def analyze(*args, **kwargs):
            events.append('scoped_analysis')
            self.assertEqual(args[1], ['0x10'])
            return manifest
        def scope(*args, **kwargs):
            events.append('scope')
            self.assertEqual(args[2].seeds, ('00100010',))
            self.assertEqual(kwargs['additional_unresolved'][0]['kind'], 'scoped_analysis_boundary')
            raise RuntimeError('stop before model work')
        engine = SimpleNamespace(analyze_scoped=analyze, index=lambda _: {
            'image_base': '00100000', 'functions': [{'entry': '00100010', 'name': 'observed'}]})
        deps = LoPipelineDeps(engine=engine, rea_factory=lambda: nullcontext(None),
            driver_factory=lambda: nullcontext(None), worker=None, reviewer=None,
            persist_scope=scope, persist_dossier=None, persist_spec=None, log=lambda _: None)
        config = LoPipelineConfig(cases=[{'id': 'public'}], query='inspect observed function',
                                  expected_observables=['result'], max_functions=1, scoped_analysis=True)
        install = {'program_dir': '/lo', 'libraries': {'calc': {
            'path': '/lo/libsclo.so', 'sha256': 'hash', 'symbols': {'named': True}}}}
        with patch('engine.lo_pipeline.symbol_inventory', return_value=inventory), \
             patch('engine.lo_pipeline.runtime_triage', side_effect=trace):
            with self.assertRaisesRegex(RuntimeError, 'stop before model'):
                run_pipeline(config, install, deps)
        self.assertEqual(events, ['runtime', 'scoped_analysis', 'scope'])
        events.clear()
        triage['cases']['public']['hits'] = []
        with patch('engine.lo_pipeline.symbol_inventory', return_value=inventory), \
             patch('engine.lo_pipeline.runtime_triage', side_effect=trace):
            with self.assertRaisesRegex(RuntimeError, 'refusing whole-module'):
                run_pipeline(config, install, deps)
        self.assertEqual(events, ['runtime'])


class RuntimeHookTargetTests(unittest.TestCase):
    def test_debug_symbols_become_module_offsets_skipping_fragments(self):
        from engine.lo_pipeline import hook_offsets
        inventory = {'elf_image_base': '0x1000', 'symbols': [
            {'address': '0x2000', 'size': 9, 'name': '_ZN13ScCompiler9NextTokenEv'},
            {'address': '0x3000', 'size': 9, 'name': '_ZN13ScInterpreter5ScAddEv',
             'display_name': 'ScInterpreter::ScAdd()'},
            {'address': '0x3100', 'size': 4, 'name': '_ZN13ScInterpreter5ScAddEv.cold',
             'display_name': 'ScInterpreter::ScAdd() [clone .cold]'}]}
        offsets = hook_offsets(inventory, ['*ScInterpreter*', '*ScCompiler*'])
        self.assertEqual(list(offsets.items()), [('0x2000', '_ZN13ScInterpreter5ScAddEv'),
                                                 ('0x1000', '_ZN13ScCompiler9NextTokenEv')])
        self.assertEqual(list(hook_offsets(inventory, ['*ScInterpreter*', '*ScCompiler*'], limit=1)),
                         ['0x2000'])

    def test_warmup_run_is_discarded_before_cases_are_observed(self):
        from engine.lo_pipeline import runtime_triage
        from types import SimpleNamespace
        labels = []
        class Tracer:
            def __init__(self, *args, **kwargs): self.kwargs = kwargs
            def start(self): return {'hooked': 1}
            def observe(self, label, drive):
                labels.append(label)
                drive()
                return {'label': label, 'hits': [{'entry': 'init' if label == '__warmup__' else 'op'}]}
            def close(self): pass
        driver = SimpleNamespace(pid=1, evaluate=lambda case: case['id'])
        result = runtime_triage(None, driver, [{'id': 'a'}, {'id': 'b'}], module='m', patterns=[],
                                image_base=0, tracer_cls=Tracer)
        self.assertEqual(labels, ['__warmup__', 'a', 'b'])
        self.assertEqual(list(result['cases']), ['a', 'b'])

    def test_hook_script_prefers_supplied_offsets(self):
        from engine.analysis.rea import frida_hook_source
        source = frida_hook_source('libsclo.so', ['*ScInterpreter*'], offsets={'0x2000': 'ScAdd'})
        self.assertIn('const OFFSETS = {"0x2000": "ScAdd"};', source)
        self.assertIn('const OFFSETS = {};', frida_hook_source('libsclo.so', ['*X*']))


class SpecForDossierTests(unittest.TestCase):
    def test_partial_dossier_gets_a_draft_spec_and_writer_errors_are_returned(self):
        from engine.lo_pipeline import spec_for_dossier
        from types import SimpleNamespace
        store = SimpleNamespace(get=lambda key: json.dumps({'status': 'draft'}).encode())
        calls = []
        def persist(root, artifact):
            calls.append(artifact)
            return {'artifact': 'spec-1', 'markdown_path': '/s.md', 'requirements': 3}
        spec, error = spec_for_dossier(persist, store, Path('/state'),
                                       {'readiness': 'partial', 'artifact': 'dossier-1'})
        self.assertEqual(spec, {'artifact': 'spec-1', 'markdown_path': '/s.md', 'status': 'draft',
                                'requirements': 3, 'writer': None})
        self.assertIsNone(error)
        self.assertEqual(calls, ['dossier-1'])
        self.assertEqual(spec_for_dossier(persist, store, Path('/state'),
                                          {'readiness': 'blocked', 'artifact': 'd'}), (None, None))
        def broken(root, artifact):
            raise RuntimeError('writer offline')
        self.assertEqual(spec_for_dossier(broken, store, Path('/state'),
                                          {'readiness': 'partial', 'artifact': 'd'}),
                         (None, 'RuntimeError: writer offline'))


class HandoffTests(unittest.TestCase):
    def test_claims_carry_review_verdicts_and_only_public_cases_are_written(self):
        from engine.lo_pipeline import build_handoff, write_handoff
        from types import SimpleNamespace
        blobs = {
            'draft': json.dumps({'answer': {'inputs': 'two numbers', 'outputs': 'sum', 'state': 's',
                'side_effects': 'none', 'errors': 'none', 'unknowns': ['overflow'], 'dependencies': [],
                'claims': [{'statement': 'adds the top two stack values', 'evidence_addresses': ['0010']},
                           {'statement': 'never fails', 'evidence_addresses': ['0014']}]}}),
            'review': json.dumps({'answer': {'missing_behavior': ['error propagation'], 'reviews': [
                {'claim_index': 0, 'outcome': 'supported_static', 'reason': 'add at 0010'},
                {'claim_index': 1, 'outcome': 'contradicted', 'reason': 'error branch at 0014'}]}})}
        store = SimpleNamespace(get=lambda key: blobs[key].encode())
        analysed = [
            {'entry': '00100010', 'draft': {'state': 'unreviewed', 'artifact': 'draft'},
             'review': {'state': 'reviewed', 'artifact': 'review'}},
            {'entry': '00100040', 'draft': {'state': 'failed'}, 'review': None}]
        scope = {'included': [{'entry': '00100010', 'name': 'ScAdd'}, {'entry': '00100040'}]}
        public = [{'id': 'add', 'formula': '=1+2', 'cells': {}, 'expected': {'value': 3}}]
        handoff = build_handoff(store, analysed, scope, public, {'add': {'observed': {'value': 3.0}},
                                                                 'secret': {'observed': {'value': 9}}})
        first = handoff['functions'][0]
        self.assertEqual([c['review']['outcome'] for c in first['claims']],
                         ['supported_static', 'contradicted'])
        self.assertEqual(first['missing_behavior'], ['error propagation'])
        self.assertEqual(handoff['functions'][1]['claims'], [])
        self.assertEqual(handoff['observed_cases'],
                         [{'id': 'add', 'formula': '=1+2', 'cells': {}, 'description': None,
                           'input': {'formula': '=1+2', 'cells': {}}, 'observed': {'value': 3.0}}])
        with tempfile.TemporaryDirectory() as temp:
            summary = {'library': 'calc', 'cases': {'public': 1, 'held_out': 1}, 'spec': None,
                       'dossier': {'readiness': 'partial', 'blockers': ['uncovered calls']}}
            folder = write_handoff(Path(temp) / 'run-handoff', summary, handoff, store)
            evidence = json.loads((folder / 'evidence.json').read_text())
            readme = (folder / 'README.md').read_text()
        self.assertEqual(evidence['claim_outcomes'], {'contradicted': 1, 'supported_static': 1})
        self.assertEqual(evidence['held_out_cases_withheld'], 1)
        self.assertNotIn('secret', json.dumps(evidence))
        self.assertIn('[supported_static] adds the top two stack values', readme)
        self.assertIn('Hand-author the FeatureSpec', readme)


class ScopedProvenanceTests(unittest.TestCase):
    def test_upstream_result_is_preserved_with_distinct_effective_context(self):
        from engine.analysis.scoped_mcp import annotate, serve
        from types import SimpleNamespace
        original = {'isError': False, 'structuredContent': {'result': []},
                    'content': [{'type': 'text', 'text': 'upstream evidence'}]}
        manifest = {'campaign': 'scope', 'scope_sha256': 'digest',
                    'analysis_options': {'limitations': ['partial']}}
        wrapped = annotate(original, manifest)
        self.assertEqual(wrapped['structuredContent'], original['structuredContent'])
        self.assertEqual(len(original['content']), 1)
        self.assertFalse(wrapped['_meta']['splice_analysis_context']['global_auto_analysis'])
        self.assertIn('do not describe', wrapped['content'][-1]['text'])
        output = io.StringIO()
        messages = [{'jsonrpc': '2.0', 'id': 7, 'method': 'initialize'},
                    {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
                    {'jsonrpc': '2.0', 'id': 8, 'method': 'tools/call',
                     'params': {'name': 'search_procedures', 'arguments': {}}}]
        serve(SimpleNamespace(request=lambda *args: original), manifest,
              io.StringIO(''.join(json.dumps(m) + '\n' for m in messages)), output)
        replies = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([r['id'] for r in replies], [7, 8])
        self.assertEqual(replies[0]['result']['serverInfo']['name'], 'splice-scoped-rea')
        self.assertEqual(replies[1]['result']['structuredContent'], original['structuredContent'])

    def test_proxy_rejects_mutating_tools_and_malformed_frames(self):
        from engine.analysis.scoped_mcp import serve
        from unittest.mock import Mock
        client = Mock()
        output = io.StringIO()
        manifest = {'campaign': 'scope', 'scope_sha256': 'digest', 'analysis_options': {}}
        serve(client, manifest, io.StringIO('bad json\n[]\n' + json.dumps({
            'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call',
            'params': {'name': 'patch_byte', 'arguments': {}}}) + '\n'), output)
        results = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(results[0]['error']['code'], -32700)
        self.assertEqual(results[1]['error']['code'], -32600)
        self.assertTrue(results[2]['result']['isError'])
        client.request.assert_not_called()

    def test_ghidra_code_is_visible_to_text_clients_and_full_analysis_is_rejected(self):
        from engine.analysis.scoped_mcp import annotate, serve
        from unittest.mock import Mock
        manifest = {'campaign': 'scope', 'scope_sha256': 'digest', 'analysis_options': {},
                    'binary': '/target.so', 'program_name': 'target.so'}
        result = annotate({'content': [{'type': 'text', 'text': 'ok'}],
            'structuredContent': {'c': 'return 42;', 'decompile_completed': True}}, manifest, 'ghidra')
        self.assertTrue(any('return 42;' in part['text'] for part in result['content']))
        request = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {
            'name': 'program.open', 'arguments': {'path': '/target.so', 'read_only': True,
            'update_analysis': True, 'project_location': '/copy', 'project_name': 'baseline',
            'program_name': 'target.so'}}}
        client = Mock()
        output = io.StringIO()
        serve(client, manifest, io.StringIO(json.dumps(request) + '\n'), output,
              server='ghidra', expected_project=Path('/copy'))
        self.assertTrue(json.loads(output.getvalue())['result']['isError'])
        client.request.assert_not_called()
