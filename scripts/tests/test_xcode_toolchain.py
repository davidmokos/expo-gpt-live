"""Regression checks for compiler output and Xcode version gating."""
import base64
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from xcode_toolchain import configure_toolchain, create_wrappers


FAKE_COMPILER = '''#!/usr/bin/python3
import json, os, sys
if '-dM' in sys.argv:
    # Exceed both pipe buffers, writing stderr first as real clang can do.
    sys.stderr.buffer.write(b'warning\\n' * 40000)
    sys.stderr.flush()
    sys.stdout.buffer.write(b'#define VALUE 42\\n' * 40000)
    sys.stdout.flush()
    sys.exit(7)
print(json.dumps([os.path.basename(sys.argv[0]), *sys.argv[1:]]))
print('ordinary compiler diagnostic', file=sys.stderr)
sys.exit(3)
'''

SEQUENTIAL_READER = '''
import base64, json, subprocess, sys
with subprocess.Popen(json.loads(sys.argv[1]), stdout=subprocess.PIPE, stderr=subprocess.PIPE) as p:
    out = p.stdout.read()
    err = p.stderr.read()
    print(json.dumps([p.wait(), base64.b64encode(out).decode(), base64.b64encode(err).decode()]))
'''


class CompilerWrapperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='xcode-probe-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'project with spaces'
        self.real_bin = Path(self.temp.name) / 'toolchain with spaces/usr/bin'
        self.real_bin.mkdir(parents=True)
        for name in ['clang', 'clang++']:
            compiler = self.real_bin / name
            compiler.write_text(FAKE_COMPILER)
            compiler.chmod(0o755)
        self.wrappers = create_wrappers(self.root, self.real_bin)

    def test_probe_preserves_both_streams_and_failure_status_with_sequential_reads(self):
        command = [str(self.wrappers / 'clang'), '-v', '-E', '-dM', '-x', 'c', '/dev/null']
        # A watchdog around the reader also catches the original pipe deadlock.
        reader = subprocess.Popen([sys.executable, '-c', SEQUENTIAL_READER, json.dumps(command)],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        try:
            out, err = reader.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(reader.pid, signal.SIGKILL)
            reader.communicate()
            self.fail('Compiler probe deadlocked when streams were read sequentially')
        self.assertEqual(reader.returncode, 0, err.decode())
        code, stdout, stderr = json.loads(out)
        self.assertEqual(code, 7)
        self.assertEqual(base64.b64decode(stdout), b'#define VALUE 42\n' * 40000)
        self.assertEqual(base64.b64decode(stderr), b'warning\n' * 40000)

    def test_normal_compilation_forwards_arguments_and_uses_the_matching_compiler(self):
        for name in ['clang', 'clang++']:
            with self.subTest(compiler=name):
                args = ['-c', 'source with spaces.cpp', '-o', 'output.o']
                result = subprocess.run([str(self.wrappers / name), *args], capture_output=True, timeout=5)
                self.assertEqual(result.returncode, 3)
                self.assertEqual(json.loads(result.stdout), [name, *args])
                self.assertEqual(result.stderr, b'ordinary compiler diagnostic\n')

    def test_unaffected_xcode_does_not_generate_overrides(self):
        for version in ['Xcode 26.4\nBuild version 17E202\n', 'Xcode 26.7\nBuild version 17G1\n']:
            with self.subTest(version=version), patch('xcode_toolchain.subprocess.check_output', return_value=version):
                destination = Path(self.temp.name) / 'unaffected'
                self.assertIsNone(configure_toolchain(destination))
                self.assertFalse(destination.exists())

    @unittest.skipUnless(sys.platform == 'darwin', 'Apple clang integration check requires macOS')
    def test_real_apple_clang_output_matches(self):
        compiler = Path(subprocess.check_output(['xcrun', '--find', 'clang'], text=True).strip())
        wrapper = create_wrappers(self.root, compiler.parent) / 'clang'
        args = ['-v', '-E', '-dM', '-x', 'c', '/dev/null']
        expected = subprocess.run([str(compiler), *args], capture_output=True, timeout=10)
        actual = subprocess.run([str(wrapper), *args], capture_output=True, timeout=10)
        self.assertEqual((actual.returncode, actual.stdout, actual.stderr),
                         (expected.returncode, expected.stdout, expected.stderr))


if __name__ == '__main__':
    unittest.main()
