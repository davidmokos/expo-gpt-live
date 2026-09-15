#!/usr/bin/env python3
"""Apply the shared Xcode workaround after EAS generates the iOS project."""
import os
from pathlib import Path

from xcode_toolchain import configure_toolchain, prepare_native_build


def main():
    if os.environ.get('EAS_BUILD_PLATFORM') != 'ios':
        return
    root = Path(__file__).resolve().parent.parent
    toolchain = configure_toolchain(root)
    if toolchain:
        compiler_bin, env = toolchain
        prepare_native_build(root, compiler_bin, env, platform='iphoneos')


if __name__ == '__main__':
    main()
