import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/setup.mjs', import.meta.url));

test('setup creates matching private tokens without printing them or adding an OpenAI key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-setup-'));
  try {
    const output = execFileSync(process.execPath, [script], { cwd: directory, encoding: 'utf8' });
    const file = join(directory, '.env.local');
    const env = Object.fromEntries(
      (await readFile(file, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => line.split('=')),
    );
    assert.equal(env.OPENAI_API_KEY, '');
    assert.match(env.API_TOKEN, /^[a-f0-9]{64}$/);
    assert.equal(env.EXPO_PUBLIC_API_TOKEN, env.API_TOKEN);
    assert.equal(new URL(env.EXPO_PUBLIC_API_URL).port, '8088');
    assert.equal(output.includes(env.API_TOKEN), false);
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('setup preserves an existing environment file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-setup-'));
  try {
    const file = join(directory, '.env.local');
    const existing = 'OPENAI_API_KEY=existing-value\n';
    await writeFile(file, existing);
    execFileSync(process.execPath, [script], { cwd: directory });
    assert.equal(await readFile(file, 'utf8'), existing);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
