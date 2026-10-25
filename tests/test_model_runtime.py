"""Regression checks for explicit Bedrock registration and read-only agent startup."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from engine.model_runtime import invoke_opencode


class ModelRuntimeTests(unittest.TestCase):
    def test_qwen_registration_permissions_and_isolated_working_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            model_id = 'qwen.test-coder'

            def run(command, **kwargs):
                if command[-1] == '--version':
                    return subprocess.CompletedProcess(command, 0, stdout='1.19.4\n')
                config = json.loads((folder / 'opencode.json').read_text())
                registered = config['provider']['amazon-bedrock']['models'][model_id]
                self.assertEqual(registered['status'], 'active')
                self.assertEqual(registered['provider']['npm'], '@ai-sdk/amazon-bedrock')
                self.assertEqual(config['small_model'], 'amazon-bedrock/' + model_id)
                self.assertEqual(config['permission'], {'*': 'deny', 'rea_open_binary': 'allow'})
                self.assertEqual(kwargs['env']['PWD'], str(folder.resolve()))
                self.assertIn('--pure', command)
                self.assertEqual(command[command.index('--title') + 1], 'inspect')
                kwargs['stdout'].write(json.dumps({'type': 'text', 'part': {'text': 'answer'}}) + '\n')
                return subprocess.CompletedProcess(command, 0)

            with patch.dict(os.environ, {}, clear=True), patch('engine.model_runtime.subprocess.run', side_effect=run):
                result = invoke_opencode(Path('/opencode'), folder, 'inspect',
                                         model='amazon-bedrock/' + model_id, timeout=30,
                                         env_file=folder / 'absent', agent_name='inspect',
                                         agent_instruction='read only', allow_tools=('rea_open_binary',))
            self.assertEqual(result['text'], 'answer')
            self.assertEqual(result['runtime_version'], '1.19.4')

    def test_claude_override_does_not_receive_qwen_registration(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)

            def run(command, **kwargs):
                if command[-1] == '--version':
                    return subprocess.CompletedProcess(command, 0, stdout='1.19.4')
                self.assertNotIn('provider', json.loads((folder / 'opencode.json').read_text()))
                kwargs['stdout'].write('{"type":"text","part":{"text":"answer"}}\n')
                return subprocess.CompletedProcess(command, 0)

            # Tool-free Bedrock calls go straight to Converse; a tool keeps this on the OpenCode path.
            with patch('engine.model_runtime.subprocess.run', side_effect=run):
                invoke_opencode(Path('/opencode'), folder, 'inspect', model='amazon-bedrock/anthropic.test',
                                timeout=30, env_file=folder / 'absent', agent_name='inspect',
                                agent_instruction='read only', allow_tools=('rea_open_binary',))
