import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  browserCommand,
  parseArgs,
  resolveConfigPath,
  startRouterOnAvailablePort
} from './cli.js';

test('parseArgs separates router options from claude args', () => {
  assert.deepEqual(parseArgs([
    '--port',
    '9000',
    '--config=config/routes.json',
    '--no-open',
    '--claude-bin',
    'claude-dev',
    '--',
    '--model',
    'claude-sonnet-5'
  ]), {
    claudeArgs: ['--model', 'claude-sonnet-5'],
    claudeBin: 'claude-dev',
    config: 'config/routes.json',
    help: false,
    host: '127.0.0.1',
    logPath: undefined,
    open: false,
    port: 9000
  });
});

test('resolveConfigPath prefers explicit config then local routes.json', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ccr-'));
  await mkdir(join(cwd, 'config'));
  await writeFile(join(cwd, 'config', 'routes.json'), '{}');

  assert.equal(
    await resolveConfigPath({ cwd, env: {}, explicitConfig: 'custom.json' }),
    join(cwd, 'custom.json')
  );
  assert.equal(
    await resolveConfigPath({ cwd, env: {}, explicitConfig: undefined }),
    join(cwd, 'config', 'routes.json')
  );
});

test('browserCommand chooses platform opener', () => {
  assert.deepEqual(browserCommand('darwin', 'http://localhost:8787'), {
    command: 'open',
    args: ['http://localhost:8787']
  });
  assert.deepEqual(browserCommand('linux', 'http://localhost:8787'), {
    command: 'xdg-open',
    args: ['http://localhost:8787']
  });
  assert.deepEqual(browserCommand('win32', 'http://localhost:8787'), {
    command: 'cmd',
    args: ['/c', 'start', '', 'http://localhost:8787']
  });
});

test('startRouterOnAvailablePort retries when the preferred port is busy', async () => {
  const attempts = [];
  const started = await startRouterOnAvailablePort({
    port: 8787,
    host: '127.0.0.1',
    configPath: undefined,
    logPath: undefined
  }, async (options) => {
    attempts.push(options.port);

    if (options.port === 8787) {
      const error = new Error('busy');
      error.code = 'EADDRINUSE';
      throw error;
    }

    return {
      port: options.port,
      server: { close: (callback) => callback?.() }
    };
  });

  assert.equal(started.port, 8788);
  assert.deepEqual(attempts, [8787, 8788]);
});
