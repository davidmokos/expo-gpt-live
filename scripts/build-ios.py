#!/usr/bin/env python3
"""Run Expo's iOS CLI, with the Xcode 26.6 compiler workaround when needed.

Accepts the same flags as `npx expo run:ios`, including --device and --port.
Expo handles native signing, device selection, installation, and Metro.
"""
import os
from pathlib import Path
import subprocess
import sys

from xcode_toolchain import configure_toolchain, prepare_native_build


def main():
    root = Path(__file__).resolve().parent.parent
    args = sys.argv[1:]
    env = os.environ.copy()
    if not any(arg.split('=', 1)[0] in ['--help', '-h', '--binary'] for arg in args):
        toolchain = configure_toolchain(root)
        if toolchain:
            compiler_bin, env = toolchain
            if '--no-install' not in args:
                subprocess.run(['npx', 'expo', 'prebuild', '--platform', 'ios'],
                               cwd=root, env=env, check=True)
                args = ['--no-install', *args]
            prepare_native_build(root, compiler_bin, env)
    os.chdir(root)
    os.execvpe('npx', ['npx', 'expo', 'run:ios', *args], env)


if __name__ == '__main__':
    main()
