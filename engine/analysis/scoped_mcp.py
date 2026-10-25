"""Expose the real REA tools with explicit effective scoped-analysis provenance.

Upstream evidence is retained unchanged. Its default-analysis notices do not describe
our prepared-project adapter, so every result carries a separate context annotation.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
import sys

if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from engine.analysis.mcp_stdio import McpStdioClient, PROTOCOL_VERSION
from engine.investigator import REA_READ_ONLY


GHIDRA_TOOLS = ('program.open', 'function.at', 'function.report', 'decomp.function', 'program.close')


def annotate(result: dict, manifest: dict, server: str = 'rea') -> dict:
    result = copy.deepcopy(result)
    context = {'profile': 'splice-scoped-prepared', 'global_auto_analysis': False,
               'campaign': manifest['campaign'], 'scope_sha256': manifest['scope_sha256'],
               'limitations': manifest['analysis_options'].get('limitations', [])}
    result.setdefault('_meta', {})['splice_analysis_context'] = context
    structured = result.get('structuredContent')
    represented = False
    for item in result.get('content', []):
        if item.get('type') == 'text':
            try:
                represented = represented or json.loads(item['text']) == structured
            except (ValueError, KeyError):
                pass
    if structured is not None and not represented:
        result.setdefault('content', []).append({'type': 'text',
            'text': 'Structured tool result: ' + json.dumps(structured)})
    result.setdefault('content', []).append({'type': 'text', 'text':
        'Splice effective analysis context: ' + json.dumps(context) +
        '. This reader loads our scoped prepared project. Upstream REA ghidra-default '
        'and default-auto-analysis-complete notices are upstream defaults and do not '
        'describe this adapted session. Unselected functions are not analyzed.'})
    return result


def serve(client, manifest: dict, source, output, *, server='rea', expected_project=None) -> None:
    allowed = REA_READ_ONLY if server == 'rea' else GHIDRA_TOOLS
    for line in source:
        try:
            request = json.loads(line)
        except ValueError:
            output.write(json.dumps({'jsonrpc': '2.0', 'id': None,
                'error': {'code': -32700, 'message': 'Invalid JSON'}}) + '\n')
            output.flush()
            continue
        if not isinstance(request, dict):
            output.write(json.dumps({'jsonrpc': '2.0', 'id': None,
                'error': {'code': -32600, 'message': 'Expected a JSON-RPC object'}}) + '\n')
            output.flush()
            continue
        if 'id' not in request:
            continue
        reply = {'jsonrpc': '2.0', 'id': request['id']}
        method = request.get('method')
        try:
            if method == 'initialize':
                reply['result'] = {'protocolVersion': PROTOCOL_VERSION,
                    'capabilities': {'tools': {}},
                    'serverInfo': {'name': 'splice-scoped-' + server, 'version': '1'}}
            elif method == 'ping':
                reply['result'] = {}
            elif method in ('tools/list', 'tools/call'):
                params = request.get('params', {})
                name = params.get('name')
                arguments = params.get('arguments', {})
                denied = method == 'tools/call' and name not in allowed
                if method == 'tools/call' and name == 'program.open':
                    denied = denied or (arguments.get('update_analysis') is not False or
                        arguments.get('read_only') is not True or expected_project is None or
                        Path(arguments.get('project_location', '')).resolve() != Path(expected_project).resolve() or
                        arguments.get('project_name') != 'baseline' or
                        arguments.get('program_name') != manifest['program_name'] or
                        arguments.get('path') != manifest['binary'])
                if method == 'tools/call' and name == 'open_binary':
                    denied = denied or arguments.get('path') != manifest['binary']
                if denied:
                    result = {'isError': True, 'content': [{'type': 'text',
                              'text': 'Scoped reader requires permitted tools and its prepared read-only project; global analysis is forbidden'}]}
                else:
                    result = client.request(method, params)
                if method == 'tools/list':
                    result = {**result, 'tools': [t for t in result.get('tools', [])
                                                 if t['name'] in allowed]}
                reply['result'] = annotate(result, manifest, server) if method == 'tools/call' else result
            else:
                reply['error'] = {'code': -32601, 'message': 'Unsupported method'}
        except Exception as error:
            reply['error'] = {'code': -32603, 'message': str(error)}
        output.write(json.dumps(reply) + '\n')
        output.flush()


if __name__ == '__main__':
    manifest = json.loads(Path(sys.argv[1]).read_text())
    with McpStdioClient(json.loads(sys.argv[2]), timeout=120) as client:
        serve(client, manifest, sys.stdin, sys.stdout,
              server=sys.argv[3] if len(sys.argv) > 3 else 'rea',
              expected_project=sys.argv[4] if len(sys.argv) > 4 else None)
