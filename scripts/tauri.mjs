import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createRequire } from 'node:module';
import { signLocalBuild } from './macos-signing.mjs';

// Desktop-launched terminals do not always inherit rustup's shell PATH setup.
const require = createRequire(import.meta.url);
const env = { ...process.env };
const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
const cargoBin = join(env.CARGO_HOME ?? join(homedir(), '.cargo'), 'bin');
if (existsSync(join(cargoBin, process.platform === 'win32' ? 'cargo.exe' : 'cargo'))) {
  env[pathKey] = [cargoBin, env[pathKey] ?? ''].join(delimiter);
}
const child = spawn(
  process.execPath,
  [require.resolve('@tauri-apps/cli/tauri.js'), ...process.argv.slice(2)],
  { env, stdio: 'inherit' },
);
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('close', async (code) => {
  process.exitCode = code ?? 1;
  if (code === 0) {
    try {
      await signLocalBuild(process.argv.slice(2), { env });
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
});
