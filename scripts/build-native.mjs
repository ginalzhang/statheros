import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, chmodSync } from 'node:fs';
// Packaged release helpers omit debug info; this also avoids a separate dSYM generation step.
const args = ['build', '-c', 'release', '-debug-info-format', 'none', '--package-path', 'native', '--scratch-path', '.cache/swift-release', '--arch', 'arm64', '--disable-sandbox', '--cache-path', '.cache/swiftpm'];
const env = { ...process.env, MACOSX_DEPLOYMENT_TARGET: '26.0', CLANG_MODULE_CACHE_PATH: '/private/tmp/steady-native-module-cache', SWIFTPM_MODULECACHE_OVERRIDE: '/private/tmp/steady-native-module-cache' };
const result = spawnSync('swift', args, { stdio: 'inherit', env });
if (result.status !== 0) process.exit(result.status ?? 1);
mkdirSync('resources/bin', { recursive: true });
const location = spawnSync('swift', [...args, '--show-bin-path'], { encoding: 'utf8', env });
if (location.status !== 0) throw new Error(location.stderr);
copyFileSync(`${location.stdout.trim()}/SteadyNative`, 'resources/bin/SteadyNative');
chmodSync('resources/bin/SteadyNative', 0o755);
