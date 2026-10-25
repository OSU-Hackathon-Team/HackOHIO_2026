"""Blind claim-to-case links: predictions never see results, and agreement comes from execution."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from engine.artifacts import LocalArtifactStore
from engine.libreoffice import matches


def put(store, data):
    return store.put(json.dumps(data, sort_keys=True).encode())


class Fixture:
    """One reviewed function with two supported claims and one contradicted claim."""

    def __init__(self, root: Path):
        self.store = LocalArtifactStore(root / 'artifacts')
        self.engine = SimpleNamespace(store=self.store, root=root)
        self.campaign, self.binary = 'c' * 64, 'b' * 64
        self.scope = {'campaign': self.campaign, 'scope_id': 's' * 64, 'revision': 1,
                      'included': [{'entry': '00100000', 'name': 'ScAdd'}], 'unresolved': [],
                      'request': {'query': 'arithmetic', 'mode': 'subsystem', 'seeds': ['ScAdd'],
                                  'expected_observables': []}, 'boundaries': []}
        self.scope_artifact = put(self.store, self.scope)
        evidence = put(self.store, {'entry': '00100000', 'references': [],
                                    'instructions': [{'address': '00100000', 'text': 'ADDSD'}]})
        claims = [{'statement': 'Adds the two operands and returns the sum', 'evidence_addresses': ['00100000'],
                   'assumptions': [], 'alternatives': []},
                  {'statement': 'Returns error 532 when dividing by zero', 'evidence_addresses': ['00100000'],
                   'assumptions': [], 'alternatives': []},
                  {'statement': 'Always returns zero', 'evidence_addresses': ['00100000'],
                   'assumptions': [], 'alternatives': []}]
        self.draft_artifact = put(self.store, {
            'campaign': self.campaign, 'subject': '00100000', 'state': 'unreviewed',
            'scope_artifact': self.scope_artifact, 'evidence_artifact': evidence,
            'answer': {'inputs': 'two numbers', 'outputs': 'sum', 'state': 'none', 'side_effects': 'none',
                       'errors': 'none', 'pseudocode': 'add', 'unknowns': [], 'dependencies': [],
                       'claims': claims}})
        self.review_artifact = put(self.store, {
            'draft_artifact': self.draft_artifact, 'state': 'reviewed', 'model': 'review-model',
            'answer': {'missing_behavior': [], 'unresolved': [], 'reviews': [
                {'claim_index': 0, 'outcome': 'supported_static', 'reason': 'add', 'evidence_addresses': ['00100000']},
                {'claim_index': 1, 'outcome': 'supported_static', 'reason': 'div', 'evidence_addresses': ['00100000']},
                {'claim_index': 2, 'outcome': 'contradicted', 'reason': 'no', 'evidence_addresses': ['00100000']}]}})
        self.observations = {'add': {'observed': {'value': 3.0000000000001}},
                             'div_zero': {'observed': {'error': 532, 'text': '#DIV/0!'}},
                             'concat': {'observed': {'text': 'ab'}}}
        results = []
        for case_id, formula in [('add', '=1+2'), ('div_zero', '=1/0'), ('concat', '="a"&"b"')]:
            record = {'schema': 1, 'case_id': case_id, 'kind': 'uno_formula', 'target': 'ScAdd',
                      'binary_sha256': self.binary, 'input': {'formula': formula, 'cells': {}},
                      'expected': self.observations[case_id]['observed'],
                      'observed': self.observations[case_id]['observed'], 'outcome': 'agreement',
                      'execution_mode': 'original'}
            results.append({**record, 'artifact': put(self.store, record)})
        self.report_artifact = put(self.store, {'schema': 1, 'results': results})
        self.cases = [{'id': 'add', 'input': {'formula': '=1+2', 'cells': {}}, 'description': 'Addition'},
                      {'id': 'div_zero', 'input': {'formula': '=1/0', 'cells': {}}, 'description': None}]

    def run(self, linker, replies):
        prompts = []

        def fake_invoke(_opencode, folder, prompt, **_kwargs):
            prompts.append(prompt)
            (folder / 'events.jsonl').write_text('{}\n')
            return {'text': replies.pop(0), 'usage': {'input': 10, 'output': 5, 'reasoning': 0, 'cost': 0.0},
                    'runtime_version': 'test'}
        with patch('engine.validation.case_links.invoke_opencode', side_effect=fake_invoke), \
                patch('engine.validation.case_links.get_model', return_value='amazon-bedrock/test'):
            result = linker.run(self.draft_artifact, self.review_artifact, self.cases, self.observations,
                                report_artifact=self.report_artifact, matches=matches,
                                observation_format='value, text or error')
        return result, prompts


class CaseLinkerTests(unittest.TestCase):
    def setUp(self):
        from engine.validation.case_links import CaseLinker
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.fx = Fixture(Path(self.temp.name))
        self.linker = CaseLinker(self.fx.engine, Path('/unused/opencode'))

    def test_predictions_are_blind_and_agreement_comes_from_the_original_result(self):
        reply = json.dumps({'links': [
            {'claim_index': 0, 'case_id': 'add', 'predicted': {'value': 3}, 'rationale': 'The sum of 1 and 2.'},
            {'claim_index': 1, 'case_id': 'div_zero', 'predicted': {'error': 532, 'text': '#DIV/0!'},
             'rationale': 'Division by zero yields error 532.'},
            {'claim_index': 0, 'case_id': 'div_zero', 'predicted': {'value': 1}, 'rationale': 'Wrong guess.'}]})
        result, prompts = self.fx.run(self.linker, [reply])
        self.assertEqual(result['state'], 'linked')
        # Observed results, the contradicted claim and the unlisted case never reach the model.
        for leak in ['3.0000000000001', '#DIV/0!', 'Always returns zero', 'concat']:
            self.assertNotIn(leak, prompts[0])
        by_key = {(l['claim_index'], l['case_id']): l for l in result['links']}
        self.assertTrue(by_key[(0, 'add')]['agreement'])
        self.assertEqual(by_key[(0, 'add')]['expected_observed'], 3.0000000000001)
        self.assertEqual(by_key[(1, 'div_zero')]['observed_pointer'], '/error')
        self.assertTrue(by_key[(1, 'div_zero')]['agreement'])
        self.assertFalse(by_key[(0, 'div_zero')]['agreement'])
        self.assertEqual(by_key[(0, 'div_zero')]['expected_observed'], None)

    def test_invalid_links_are_repaired_once_then_rejected_without_links(self):
        bad = json.dumps({'links': [{'claim_index': 2, 'case_id': 'add', 'predicted': {'value': 0},
                                     'rationale': 'Contradicted claim.'},
                                    {'claim_index': 0, 'case_id': 'concat', 'predicted': {'text': 'ab'},
                                     'rationale': 'Not a candidate.'}]})
        result, prompts = self.fx.run(self.linker, [bad, bad])
        self.assertEqual(result['state'], 'rejected')
        self.assertEqual(result['links'], [])
        self.assertEqual(len(prompts), 2)
        self.assertIn('unknown claim_index 2', prompts[1])
        self.assertIn("unknown case_id 'concat'", prompts[1])

    def test_no_supported_claims_or_cases_means_no_model_call(self):
        self.fx.cases = []
        result, prompts = self.fx.run(self.linker, [])
        self.assertEqual((result['state'], prompts), ('skipped', []))

    def test_dossier_turns_agreeing_links_into_case_agreement_and_flags_disagreement(self):
        from engine.dossier import assemble
        reply = json.dumps({'links': [
            {'claim_index': 0, 'case_id': 'add', 'predicted': {'value': 3}, 'rationale': 'Sum.'},
            {'claim_index': 1, 'case_id': 'add', 'predicted': {'value': 0}, 'rationale': 'Wrong.'}]})
        result, _ = self.fx.run(self.linker, [reply])
        links = put(self.fx.store, {'schema': 1, 'links': result['links']})
        manifest = {'campaign': self.fx.campaign, 'binary_sha256': self.fx.binary}
        dossier = assemble(self.fx.engine, manifest, self.fx.scope_artifact, [self.fx.draft_artifact],
                           [self.fx.review_artifact], [self.fx.report_artifact], [links])
        states = [claim['execution_state'] for claim in dossier['claims']]
        self.assertEqual(states, ['case_agreement', 'case_disagreement', 'unmapped'])


class PipelineLinkTests(unittest.TestCase):
    def test_only_cases_that_ran_the_function_are_offered_and_failures_do_not_stop_the_run(self):
        from engine.lo_pipeline import build_handoff, link_claims_to_cases
        offered = {}

        class FakeLinker:
            engine = SimpleNamespace(store=SimpleNamespace(put=lambda data: 'artifact-%d' % len(data)))

            def run(self, draft_artifact, _review, cases, _observations, **_kwargs):
                offered[draft_artifact] = [case['id'] for case in cases]
                if draft_artifact == 'broken':
                    raise RuntimeError('Bedrock throttled')
                return {'state': 'linked', 'links': [
                    {'draft_artifact': draft_artifact, 'claim_index': 0, 'case_id': 'add', 'agreement': True},
                    {'draft_artifact': draft_artifact, 'claim_index': 1, 'case_id': 'add', 'agreement': False}]}
        analysed = [
            {'entry': '00100000', 'draft': {'state': 'unreviewed', 'artifact': 'draft'},
             'review': {'state': 'reviewed', 'artifact': 'review'}},
            {'entry': '00200000', 'draft': {'state': 'unreviewed', 'artifact': 'broken'},
             'review': {'state': 'reviewed', 'artifact': 'review2'}},
            {'entry': '00300000', 'draft': {'state': 'unreviewed', 'artifact': 'not-run'},
             'review': {'state': 'reviewed', 'artifact': 'review3'}}]
        public = [{'id': 'add', 'formula': '=1+2'}, {'id': 'sub', 'formula': '=2-1'}]
        per_entry = {0x00100000: [{'case': 'add'}], 0x00200000: [{'case': 'sub'}, {'case': 'held_secret'}]}
        linked = link_claims_to_cases(FakeLinker(), analysed, public, per_entry, {}, report_artifact='r',
                                      model_role='decomp_worker', workers=2, log=lambda _: None)
        self.assertEqual(offered, {'draft': ['add'], 'broken': ['sub']})
        self.assertEqual(linked['summary']['states'], {'failed': 1, 'linked': 1})
        self.assertEqual((linked['summary']['claims_with_agreement'], linked['summary']['claims_with_disagreement']), (1, 1))
        self.assertEqual(len(linked['link_artifacts']), 1)
        blobs = {'draft': json.dumps({'answer': {'claims': [{'statement': 'adds'}, {'statement': 'subtracts'}]}}),
                 'review': json.dumps({'answer': {'reviews': []}})}
        store = SimpleNamespace(get=lambda key: blobs[key].encode())
        handoff = build_handoff(store, analysed[:1], {'included': [{'entry': '00100000', 'name': 'ScAdd'}]},
                                public, {}, case_links=linked['case_links'])
        claims = handoff['functions'][0]['claims']
        self.assertEqual(claims[0]['case_links'], [{'case_id': 'add', 'agreement': True}])
        self.assertEqual(claims[1]['case_links'], [{'case_id': 'add', 'agreement': False}])


if __name__ == '__main__':
    unittest.main()
