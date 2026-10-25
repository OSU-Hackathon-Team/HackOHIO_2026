"""Prepare only symbol-bounded functions; cache a private, immutable Ghidra baseline.

No global auto-analysis runs. Unknown callee extents remain explicit frontier items.
This is analyst evidence preparation, not proof of recovered subsystem behavior.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys

if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from engine.analysis.elfinfo import build_id, debug_file_for
from engine.analysis.ghidra import SCRIPT_DIR, _flock_ex, _flock_un, file_hash, tool_version

LIMITATIONS = ['Global auto-analysis, type propagation and exception/unwind recovery were not run.',
               'Only selected symbol extents were decoded; unanalysed dependencies remain unresolved.']


def symbol_inventory(binary: Path) -> dict:
    data = binary.read_bytes()
    if len(data) < 64 or data[:6] != b'\x7fELF\x02\x01':
        raise ValueError('scoped preparation currently requires ELF64 little-endian')
    phoff = struct.unpack_from('<Q', data, 32)[0]
    entsize, count = struct.unpack_from('<HH', data, 54)
    if entsize < 56 or phoff + count * entsize > len(data):
        raise ValueError('invalid ELF program headers')
    bases = [struct.unpack_from('<Q', data, phoff + i * entsize + 16)[0]
             for i in range(count) if struct.unpack_from('<I', data, phoff + i * entsize)[0] == 1]
    if not bases:
        raise ValueError('ELF has no load segments')
    commands = [['nm', '-D', '-S', '-n', '--defined-only', str(binary)],
                ['nm', '-S', '-n', '--defined-only', str(binary)]]
    debug = debug_file_for(build_id(data))
    if debug:
        commands.append(['nm', '-S', '-n', '--defined-only', str(debug)])
    symbols = {}
    for command in commands:
        result = subprocess.run(command, capture_output=True, text=True, timeout=60)
        for line in result.stdout.splitlines():
            fields = line.split(maxsplit=3)
            if len(fields) == 4 and fields[2] in ('T', 't', 'W', 'w'):
                address, size = int(fields[0], 16), int(fields[1], 16)
                if size:
                    symbols[(address, fields[3])] = {'address': hex(address), 'size': size,
                                                    'name': fields[3]}
    names = sorted({s['name'] for s in symbols.values()})
    if names:
        demangled = subprocess.run(['c++filt'], input='\n'.join(names) + '\n',
                                   capture_output=True, text=True, timeout=60)
        if demangled.returncode == 0 and len(demangled.stdout.splitlines()) == len(names):
            display = dict(zip(names, demangled.stdout.splitlines()))
            for symbol in symbols.values():
                symbol['display_name'] = display[symbol['name']]
    return {'elf_image_base': hex(min(bases)), 'symbols': sorted(symbols.values(),
             key=lambda s: (int(s['address'], 16), s['name']))}


def prepare_scoped(engine, binary: Path, seeds: list[str], *, max_functions: int = 8,
                   max_depth: int = 1, max_function_bytes: int = 65536) -> dict:
    if not seeds or not 1 <= max_functions <= 128 or not 0 <= max_depth <= 4:
        raise ValueError('need seeds, 1..128 functions and depth 0..4')
    if not 1 <= max_function_bytes <= 262144:
        raise ValueError('function byte budget must be 1..262144')
    binary = binary.resolve(strict=True)
    inventory = symbol_inventory(binary)
    roots = []
    for seed in seeds:
        matches = [s for s in inventory['symbols'] if seed in
                   (s['name'], s.get('display_name'), s['address'])]
        if not matches:
            raise ValueError(f'no sized ELF/debug function symbol for {seed}; no full-analysis fallback')
        if len({s['address'] for s in matches}) != 1:
            raise ValueError(f'ambiguous function seed: {seed}')
        roots.append(matches[0])
    roots = sorted({s['address']: s for s in roots}.values(), key=lambda s: int(s['address'], 16))
    if len(roots) > max_functions or any(s['size'] > max_function_bytes for s in roots):
        raise ValueError('seed functions exceed the declared preparation budget')
    request = {**inventory, 'seeds': [s['address'] for s in roots],
               'max_functions': max_functions, 'max_depth': max_depth,
               'max_function_bytes': max_function_bytes}
    identity = {'schema': 1, 'binary_sha256': file_hash(binary),
                'ghidra_version_sha256': tool_version(engine.headless),
                'script_sha256': file_hash(SCRIPT_DIR / 'ScopedAnalysis.java'), 'request': request,
                'limitations': LIMITATIONS}
    key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    folder = engine.root / 'scoped-projects' / key
    folder.mkdir(parents=True, exist_ok=True)
    with (folder / '.lock').open('a+b') as lock:
        _flock_ex(lock)
        try:
            pointer = folder / 'manifest.json'
            if pointer.exists():
                manifest = json.loads(pointer.read_text())
                if not (folder / 'baseline.gpr').is_file() or not (folder / 'baseline.rep').is_dir():
                    raise RuntimeError('scoped baseline is missing; refusing a false cache hit')
                if file_hash(folder / 'scope.json') != manifest['scope_sha256']:
                    raise RuntimeError('cached scope report changed')
                engine._emit(key, 'scoped_cache_hit')
                return {**manifest, 'cache_hit': True}
            # Only incomplete private builds are replaced; published baselines stay immutable.
            for name in ('baseline.gpr', 'baseline.rep'):
                path = folder / name
                if path.is_dir():
                    shutil.rmtree(path)
                else:
                    path.unlink(missing_ok=True)
            (folder / 'request.json').write_text(json.dumps(request))
            engine._run([str(folder), 'baseline', '-import', str(binary), '-noanalysis',
                         '-scriptPath', str(SCRIPT_DIR), '-postScript', 'ScopedAnalysis.java',
                         str(folder / 'request.json'), str(folder / 'scope.json')], key, 'scoped_prepare')
            report = json.loads((folder / 'scope.json').read_text())
            if report.get('status') != 'ok' or not report.get('functions'):
                raise RuntimeError('scoped preparation did not produce function evidence')
            if not (folder / 'baseline.gpr').is_file() or not (folder / 'baseline.rep').is_dir():
                raise RuntimeError('scoped preparation produced no reusable project')
            manifest = {'schema': 1, 'campaign': key, 'binary': str(binary),
                        'binary_sha256': identity['binary_sha256'], 'project': str(folder),
                        'program_name': binary.name, 'scope': report,
                        'scope_sha256': file_hash(folder / 'scope.json'),
                        'analysis_options': {'profile': 'scoped', 'global_auto_analysis': False,
                                             'limitations': LIMITATIONS,
                                             'script_sha256': identity['script_sha256']}}
            temporary = pointer.with_suffix('.tmp')
            temporary.write_text(json.dumps(manifest, indent=2))
            os.replace(temporary, pointer)
            return {**manifest, 'cache_hit': False}
        finally:
            _flock_un(lock)


def prepared_readers(manifest: dict, destination: Path, ghidra: Path) -> dict:
    """Separate read-only copies, following WarmGhidraPool's project-copy pattern."""
    from engine.investigator import mcp_servers
    destination.mkdir(parents=True, exist_ok=False)
    source = Path(manifest['project'])
    for name in ('ghidra',):
        target = destination / name
        target.mkdir()
        shutil.copy2(source / 'baseline.gpr', target / 'baseline.gpr')
        shutil.copytree(source / 'baseline.rep', target / 'baseline.rep')
    java_home = Path(os.environ.get('JAVA_HOME') or Path(shutil.which('java')).resolve().parent.parent)
    install = destination / 'rea-java'
    install.mkdir()
    for child in java_home.iterdir():
        if child.name != 'bin':
            (install / child.name).symlink_to(child, target_is_directory=child.is_dir())
    support = install / 'bin'
    support.mkdir()
    for child in (java_home / 'bin').iterdir():
        if child.name != 'java':
            (support / child.name).symlink_to(child, target_is_directory=child.is_dir())
    # REA invokes Java directly on Linux, bypassing support/analyzeHeadless.
    # Keep its authenticated bridge; adapt only its headless import invocation.
    wrapper = support / 'java'
    import shlex
    import sys
    wrapper.write_text('#!/bin/sh\nexec ' + shlex.join([
        sys.executable, str(Path(__file__).resolve()), '--rea-java',
        str(source / 'manifest.json'), str(java_home / 'bin' / 'java'), str(install)]) + ' "$@"\n')
    wrapper.chmod(0o700)
    servers = mcp_servers(str(ghidra))
    servers['rea']['environment'].update(GHIDRA_INSTALL_DIR=str(ghidra), JAVA_HOME=str(install),
                                        REA_GHIDRA_DISABLED_ANALYZERS='')
    servers['rea']['command'] = [sys.executable, str(Path(__file__).with_name('scoped_mcp.py')),
        str(source / 'manifest.json'), json.dumps(servers['rea']['command'])]
    servers['ghidra']['command'] = [sys.executable, str(Path(__file__).with_name('scoped_mcp.py')),
        str(source / 'manifest.json'), json.dumps(servers['ghidra']['command']),
        'ghidra', str(destination / 'ghidra')]
    return servers


def check_readers(servers: dict, manifest: dict, folder: Path, function: str) -> dict:
    """Real free MCP calls; retain raw results and fail before any model invocation."""
    import time
    from engine.analysis.mcp_stdio import McpStdioClient, tool_payload
    from engine.analysis.rea import procedures
    result = {}
    for name in ('rea', 'ghidra'):
        started = time.monotonic()
        config = servers[name]
        calls = []
        with McpStdioClient(config['command'], env=config.get('environment'), timeout=120) as client:
            def call(tool, arguments):
                raw = client.call_tool(tool, arguments)
                calls.append({'tool': tool, 'arguments': arguments, 'result': raw})
                (folder / (name + '-check.json')).write_text(json.dumps(calls, indent=2))
                return tool_payload(raw)
            if name == 'rea':
                call('open_binary', {'path': manifest['binary'], 'provider_id': 'ghidra'})
                hits = procedures(call('search_procedures', {'pattern': function, 'mode': 'literal'}))
                hits = [p for p in hits if p['name'] == function]
                if len(hits) != 1:
                    raise ValueError('REA did not resolve exactly one selected function; inspect rea-check.json')
                result['entry'] = hits[0]['address']
                call('procedure_pseudo_code', {'procedure': result['entry']})
                call('close_binary', {})
            else:
                opened = call('program.open', {'path': manifest['binary'], 'read_only': True,
                    'update_analysis': False, 'project_location': str(folder / 'readers' / 'ghidra'),
                    'project_name': 'baseline', 'program_name': manifest['program_name']})
                session = opened['session_id']
                call('function.at', {'session_id': session, 'address': result['entry']})
                decompiled = call('decomp.function', {'session_id': session,
                    'function_start': result['entry'], 'timeout_secs': 45})
                if (not isinstance(decompiled, dict) or not decompiled.get('decompile_completed') or
                    decompiled.get('timed_out') or decompiled.get('cancelled') or
                    not isinstance(decompiled.get('c'), str) or not decompiled['c'].strip() or
                    int(decompiled['function']['entry_point'], 16) != int(result['entry'], 16)):
                    raise ValueError('Ghidra decompilation failed; inspect ghidra-check.json')
                call('program.close', {'session_id': session})
        result[name + '_seconds'] = round(time.monotonic() - started, 3)
    return result


def rea_reader(manifest_path: Path, headless: Path, args: list[str], *, prefix=()) -> int:
    """Adapt REA's import launch to a private copy of the explicitly scoped baseline."""
    manifest = json.loads(manifest_path.read_text())
    if '-import' not in args:
        raise ValueError('expected a headless import; refusing unscoped launch')
    at = args.index('-import')
    if at != 2 or '-preScript' in args:
        raise ValueError('unsupported REA launch for a prepared scoped reader')
    if file_hash(Path(args[at + 1])) != manifest['binary_sha256']:
        raise ValueError('REA target differs from the prepared binary')
    root = Path(args[0])
    root.mkdir(parents=True, exist_ok=True)
    source = Path(manifest['project'])
    if file_hash(source / 'scope.json') != manifest['scope_sha256']:
        raise ValueError('prepared scope report changed')
    shutil.copy2(source / 'baseline.gpr', root / 'baseline.gpr')
    shutil.copytree(source / 'baseline.rep', root / 'baseline.rep')
    command = [str(headless), *prefix, str(root), 'baseline', '-process', manifest['program_name'],
               '-noanalysis', *args[at + 2:]]
    audit = manifest_path.parent / 'reader-launches.jsonl'
    with audit.open('a') as stream:
        stream.write(json.dumps({'scope_sha256': manifest['scope_sha256'], 'argv': command,
                                 'global_auto_analysis': False}) + '\n')
    return subprocess.call(command)


def rea_java(manifest_path: Path, java: Path, args: list[str], *, java_home: Path | None = None) -> int:
    # REA uses the JVM-reported java.home for later launches. This is a valid private
    # view of the same JDK, keeping its configured launcher in use after the probe.
    options = [f'-Djava.home={java_home}'] if java_home else []
    main = 'ghidra.app.util.headless.AnalyzeHeadless'
    if main not in args:
        return subprocess.call([str(java), *options, *args])
    at = args.index(main) + 1
    return rea_reader(manifest_path, java, args[at:], prefix=[*options, *args[:at]])


if __name__ == '__main__':
    import sys
    # Executed by the tiny REA launch wrapper; no dependency code is patched.
    raise SystemExit(rea_java(Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[5:],
                             java_home=Path(sys.argv[4])))
