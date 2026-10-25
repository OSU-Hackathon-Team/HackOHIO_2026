"""One bounded OpenCode agent using our REA + Ghidra MCP wiring on LibreOffice.

Default prepares a scoped project and prompt. --check-tools checks both MCP readers
without a model. --run-live incurs model charges (requires approval).
No source checkout, held-out cases, specifications, or reconstructed implementations
are used. A completed tool trace is an unreviewed inspection, not verified behavior.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.investigator import allowed_tools, mcp_servers
from engine.libreoffice import find_install
from engine.model_runtime import invoke_opencode
from engine.analysis.ghidra import GhidraAnalysis
from engine.analysis.scoped import prepare_scoped, prepared_readers, check_readers
from launch import sanitize_secrets
from model_config import get_model


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--function', default='Calc_ScSpreadsheetSettings_get_implementation')
    parser.add_argument('--state', type=Path, default=ROOT / 'decomp-state' / 'lo_agent_trials')
    parser.add_argument('--opencode', type=Path, required=True)
    parser.add_argument('--env-file', type=Path, default=ROOT / '.env')
    parser.add_argument('--timeout', type=int, default=300)
    parser.add_argument('--run-live', action='store_true')
    parser.add_argument('--check-tools', action='store_true', help='Run real MCP checks without a model')
    parser.add_argument('--whole-module', action='store_true', help='Explicit legacy full-import diagnostic')
    args = parser.parse_args()
    if not 1 <= args.timeout <= 300:
        parser.error('trial timeout must be between 1 and 300 seconds')
    install = find_install()
    library = install['libraries']['calc']
    folder = args.state.resolve() / time.strftime('%Y%m%dT%H%M%S')
    folder.mkdir(parents=True, exist_ok=False)
    preparation_started = time.monotonic()
    cache_check_seconds = None
    servers = mcp_servers()
    scoped = None
    if not args.whole_module:
        ghidra = Path(os.environ.get('GHIDRA_INSTALL_DIR', '/opt/ghidra_12.1.3_PUBLIC'))
        engine = GhidraAnalysis(args.state.resolve() / 'prepared', ghidra / 'support' / 'analyzeHeadless',
                                timeout=300, warm_workers=0)
        scoped = prepare_scoped(engine, Path(library['path']), [args.function],
                                max_functions=1, max_depth=0)
        # A second preparation must use the same baseline without another import.
        cache_started = time.monotonic()
        reused = prepare_scoped(engine, Path(library['path']), [args.function],
                                max_functions=1, max_depth=0)
        cache_check_seconds = round(time.monotonic() - cache_started, 3)
        if not reused['cache_hit'] or reused['campaign'] != scoped['campaign']:
            raise RuntimeError('scoped baseline reuse check failed')
        servers = prepared_readers(scoped, folder / 'readers', ghidra)
    prompt = (
        f"Inspect ONLY the existing function {args.function} in {library['path']}. "
        "This is a bounded binary-only inspection, not a specification or implementation task. "
        "You must use both MCP servers for actual analysis: first rea_open_binary, then "
        "rea_search_procedures for the exact function name and rea_procedure_info or "
        "rea_procedure_pseudo_code. Use the real address returned by REA, never invent one. "
        "Then ghidra_program_open on the SAME binary, using a fresh private project at "
        f"{folder / 'readers' / 'ghidra' if scoped else folder / 'ghidra'}, "
        f"project_name={'baseline' if scoped else 'trial'}, program_name=libsclo.so, "
        f"read_only=true, update_analysis={'false' if scoped else 'true'}. "
        "Inspect the returned address with ghidra_function_at and "
        "ghidra_decomp_function (timeout_secs=45). Do not rename, patch, save, or edit "
        "the binary or any existing project. Do not inspect other function bodies. "
        "If a tool fails or the target is not found, report that limitation and stop. "
        "Do not fill gaps from the function name or general knowledge. "
        "Close both sessions when done. Return JSON containing function, entry, "
        "behavior_observations, evidence (server, tool, address), and unknowns. "
        "All observations remain unreviewed; successful decompilation does not prove "
        "formula-interpreter equivalence. Do not use external sources or case suites."
    )
    if scoped:
        prompt += (" This is a prepared scoped project: global auto-analysis was skipped. "
                   "REA uses our launcher to read a private copy of that same baseline. "
                   "Only the selected function was decoded. All other calls are unresolved "
                   "boundary dependencies; do not claim whole-module coverage.")
    (folder / 'prompt.txt').write_text(prompt)
    report = {'schema': 1, 'state': 'prepared', 'function': args.function,
              'binary': library['path'], 'binary_sha256': library['sha256'],
              'model': get_model('decomp_worker'), 'timeout_seconds': args.timeout,
              'allowed_tools': list(allowed_tools()), 'run_folder': str(folder)}
    report['preparation_seconds'] = round(time.monotonic() - preparation_started, 3)
    report['cache_check_seconds'] = cache_check_seconds
    if scoped:
        report['scoped_preparation'] = scoped
    started = time.monotonic()
    try:
        if scoped and (args.check_tools or args.run_live):
            report['tool_checks'] = check_readers(servers, scoped, folder, args.function)
            report['state'] = 'tools_checked_unreviewed'
        if args.run_live:
            if not args.opencode.is_file():
                raise FileNotFoundError('OpenCode executable is unavailable')
            reply = invoke_opencode(
                args.opencode, folder, prompt, model=report['model'],
                timeout=args.timeout, env_file=args.env_file,
                agent_name='lo-inspect',
                agent_instruction='Read-only binary analysis with the permitted MCP tools. No guesses. JSON output.',
                mcp=servers, allow_tools=allowed_tools())
            rows = [json.loads(line) for line in (folder / 'events.jsonl').read_text().splitlines()
                    if line.startswith('{')]
            calls = [row.get('part', {}) for row in rows if row.get('type') == 'tool_use']
            completed = [part.get('tool', '') for part in calls
                         if part.get('state', {}).get('status') == 'completed']
            used_rea = any(tool in completed for tool in
                           ('rea_search_procedures', 'rea_procedure_info', 'rea_procedure_pseudo_code'))
            used_ghidra = 'ghidra_decomp_function' in completed
            (folder / 'agent-report.txt').write_text(reply['text'])
            report.update(state='inspected_unreviewed' if used_rea and used_ghidra else 'incomplete',
                          used_rea_analysis=used_rea, used_ghidra_decompilation=used_ghidra,
                          completed_tools=completed, usage=reply['usage'],
                          opencode_version=reply['runtime_version'])
    except Exception as error:
        report.update(state='failed', error=sanitize_secrets(str(error)))
    report['elapsed_seconds'] = round(time.monotonic() - started, 3)
    (folder / 'summary.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2), flush=True)
    return 0 if report['state'] in ('prepared', 'tools_checked_unreviewed', 'inspected_unreviewed') else 2


if __name__ == '__main__':
    raise SystemExit(main())
