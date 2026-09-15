"""Project-local workaround for Xcode 26.6's compiler-probe pipe deadlock.

Only compiler probes are buffered. Their stdout, stderr, and exit status are
preserved; normal compilation directly executes Apple's compiler.
Upstream fix: https://github.com/swiftlang/swift-build/pull/1315
"""
import os
from pathlib import Path
import subprocess


COMPILER_WRAPPER = '''#!/usr/bin/python3
import os, subprocess, sys
real = REAL_BIN + ('/clang++' if sys.argv[0].endswith('++') else '/clang')
args = sys.argv[1:]
if not all(flag in args for flag in ['-v', '-E', '-dM', '/dev/null']):
    os.execv(real, [real, *args])
result = subprocess.run([real, *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
for fd, data in [(1, result.stdout), (2, result.stderr)]:
    remaining = memoryview(data)
    while remaining:
        remaining = remaining[os.write(fd, remaining):]
    os.close(fd)
os._exit(result.returncode if result.returncode >= 0 else 128 - result.returncode)
'''

XCODEBUILD_WRAPPER = '''#!/usr/bin/python3
import os, sys
os.environ['XCBUILD_LAUNCH_IN_PROCESS'] = '1'
os.environ['SWIFTBUILD_LAUNCH_IN_PROCESS'] = '1'
base = os.path.dirname(os.path.realpath(__file__))
args = sys.argv[1:]
# Expo CLI uses the implicit build action; ExpoModulesJSI uses explicit build.
if any(arg in args for arg in ['build', 'archive', '-workspace', '-project']):
    args += ['CC=' + base + '/clang', 'CXX=' + base + '/clang++']
os.execv('/usr/bin/xcodebuild', ['/usr/bin/xcodebuild', *args])
'''


def create_wrappers(root, real_bin):
    override_usr = root / '.expo/xcode-toolchain/usr'
    override_bin = override_usr / 'bin'
    override_bin.mkdir(parents=True, exist_ok=True)
    links = [(real_bin.parent / name, override_usr / name)
             for name in ['lib', 'share', 'include', 'libexec']]
    links += [(tool, override_bin / tool.name) for tool in real_bin.iterdir()
              if tool.name not in ['clang', 'clang++', 'xcodebuild']]
    for source, target in links:
        if target.is_symlink():
            target.unlink()
        if source.exists() and not target.exists():
            target.symlink_to(source)
    for name in ['clang', 'clang++', 'xcodebuild']:
        target = override_bin / name
        script = XCODEBUILD_WRAPPER if name == 'xcodebuild' else COMPILER_WRAPPER.replace('REAL_BIN', repr(str(real_bin)))
        target.write_text(script)
        target.chmod(0o755)
    return override_bin


def configure_toolchain(root):
    version = subprocess.check_output(['/usr/bin/xcodebuild', '-version'], text=True)
    if not version.startswith('Xcode 26.6\n'):
        return None
    real_bin = Path(subprocess.check_output(['xcrun', '--find', 'clang'], text=True).strip()).parent
    compiler_bin = create_wrappers(root, real_bin)
    env = os.environ.copy()
    if not env.get('DEVELOPER_DIR'):
        env['DEVELOPER_DIR'] = subprocess.check_output(['xcode-select', '-p'], text=True).strip()
    env.update({
        'PATH': str(compiler_bin) + os.pathsep + env.get('PATH', ''),
        'XCBUILD_LAUNCH_IN_PROCESS': '1',
        'SWIFTBUILD_LAUNCH_IN_PROCESS': '1',
    })
    print('Using the project-local Xcode 26.6 compiler-probe workaround.', flush=True)
    return compiler_bin, env


def prepare_native_build(root, compiler_bin, env, platform=None):
    # Keep EAS's generated Gymfile and signing options. Every generated native
    # target needs these settings because Xcode resets PATH in build phases.
    projects = sorted((root / 'ios').glob('*.xcodeproj/project.pbxproj'))
    projects += sorted((root / 'ios/Pods').glob('*.xcodeproj/project.pbxproj'))
    if len(projects) < 2:
        raise SystemExit('Run npx expo prebuild --platform ios before using --no-install.')
    patch_projects = '''
const fs = require('node:fs');
const xcode = require('xcode');
const [compilerDir, ...projects] = process.argv.slice(1);
for (const path of projects) {
  const project = xcode.project(path);
  project.parseSync();
  for (const config of Object.values(project.pbxXCBuildConfigurationSection())) {
    if (!config || typeof config !== 'object' || !config.buildSettings) continue;
    config.buildSettings.CC = JSON.stringify(compilerDir + '/clang');
    config.buildSettings.CXX = JSON.stringify(compilerDir + '/clang++');
  }
  fs.writeFileSync(path, project.writeSync());
}
'''
    subprocess.run(['node', '-e', patch_projects, str(compiler_bin), *map(str, projects)],
                   cwd=root, check=True)
    # Build both local destinations, or only the device slice on EAS. The
    # dependency caches each slice and its build phase can then reuse it.
    jsi_script = root / 'node_modules/expo-modules-jsi/apple/scripts/build-xcframework.sh'
    if jsi_script.exists():
        jsi_env = dict(env, PODS_ROOT=str(root / 'ios/Pods'), RN_ROOT=str(root / 'node_modules/react-native'))
        jsi_env.pop('PLATFORM_NAME', None)
        if platform:
            jsi_env['PLATFORM_NAME'] = platform
        subprocess.run(['bash', str(jsi_script)], cwd=root, env=jsi_env, check=True)
