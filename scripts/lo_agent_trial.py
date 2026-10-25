"""One bounded OpenCode agent using our REA + Ghidra MCP wiring on LibreOffice.

Default prepares a prompt only. --run-live incurs model charges (requires approval).
No source checkout, held-out cases, specifications, or reconstructed implementations
are used. A completed tool trace is an unreviewed inspection, not verified behavior.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.investigator import allowed_tools, mcp_servers
from engine.libreoffice import find_install
from engine.model_runtime import invoke_opencode
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
    args = parser.parse_args()
    if not 1 <= args.timeout <= 300:
        parser.error('trial timeout must be between 1 and 300 seconds')
    install = find_install()
    library = install['libraries']['calc']
    folder = args.state.resolve() / time.strftime('%Y%m%dT%H%M%S')
    folder.mkdir(parents=True, exist_ok=False)
    prompt = (
        f"Inspect ONLY the existing function {args.function} in {library['path']}. "
        "This is a bounded binary-only inspection, not a specification or implementation task. "
        "You must use both MCP servers for actual analysis: first rea_open_binary, then "
        "rea_search_procedures for the exact function name and rea_procedure_info or "
        "rea_procedure_pseudo_code. Use the real address returned by REA, never invent one. "
        "Then ghidra_program_open on the SAME binary, using a fresh private project at "
        f"{folder / 'ghidra'}, project_name=trial, program_name=libsclo.so, "
        "read_only=true. Inspect the returned address with ghidra_function_at and "
        "ghidra_decomp_function (timeout_secs=45). Do not rename, patch, save, or edit "
        "the binary or any existing project. Do not inspect other function bodies. "
        "If a tool fails or the target is not found, report that limitation and stop. "
        "Do not fill gaps from the function name or general knowledge. "
        "Close both sessions when done. Return JSON containing function, entry, "
        "behavior_observations, evidence (server, tool, address), and unknowns. "
        "All observations remain unreviewed; successful decompilation does not prove "
        "formula-interpreter equivalence. Do not use external sources or case suites."
    )
    (folder / 'prompt.txt').write_text(prompt)
    report = {'schema': 1, 'state': 'prepared', 'function': args.function,
              'binary': library['path'], 'binary_sha256': library['sha256'],
              'model': get_model('decomp_worker'), 'timeout_seconds': args.timeout,
              'allowed_tools': list(allowed_tools()), 'run_folder': str(folder)}
    started = time.monotonic()
    try:
        if args.run_live:
            if not args.opencode.is_file():
                raise FileNotFoundError('OpenCode executable is unavailable')
            reply = invoke_opencode(
                args.opencode, folder, prompt, model=report['model'],
                timeout=args.timeout, env_file=args.env_file,
                agent_name='lo-inspect',
                agent_instruction='Read-only binary analysis with the permitted MCP tools. No guesses. JSON output.',
                mcp=mcp_servers(), allow_tools=allowed_tools())
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
    return 0 if report['state'] in ('prepared', 'inspected_unreviewed') else 2


if __name__ == '__main__':
    raise SystemExit(main())
