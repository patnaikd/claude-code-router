import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startRouterServer } from './server.js';

const DEFAULT_PORT = 8787;
const MAX_PORT_ATTEMPTS = 50;

export async function runCli(argv, {
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
  spawnImpl = spawn,
  startServerImpl = startRouterOnAvailablePort,
  openBrowserImpl = openBrowser,
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  const options = parseArgs(argv);

  if (options.help) {
    stdout.write(helpText());
    return 0;
  }

  const configPath = await resolveConfigPath({ cwd, env, explicitConfig: options.config });
  const logPath = options.logPath ? resolve(cwd, options.logPath) : join(cwd, '.router-logs', 'calls.jsonl');
  const started = await startServerImpl({
    port: options.port ?? Number(env.PORT ?? DEFAULT_PORT),
    host: options.host,
    configPath,
    logPath
  });
  const baseUrl = `http://localhost:${started.port}`;

  stdout.write(`Claude Code router listening on ${baseUrl}\n`);
  if (configPath) {
    stdout.write(`Using routes config: ${configPath}\n`);
  }
  stdout.write(`Dashboard: ${baseUrl}\n`);

  if (options.open) {
    await openBrowserImpl(baseUrl, { platform, spawnImpl, stderr });
  }

  const claudeArgs = options.claudeArgs;
  stdout.write(`Launching ${options.claudeBin} with ANTHROPIC_BASE_URL=${baseUrl}\n`);

  const child = spawnImpl(options.claudeBin, claudeArgs, {
    cwd,
    env: {
      ...env,
      ANTHROPIC_BASE_URL: baseUrl
    },
    stdio: 'inherit'
  });

  const exitCode = await waitForClaude(child, started.server, stderr, options.claudeBin);
  process.exitCode = exitCode;
  return exitCode;
}

export function parseArgs(argv) {
  const options = {
    claudeArgs: [],
    claudeBin: 'claude',
    config: undefined,
    help: false,
    host: '127.0.0.1',
    logPath: undefined,
    open: true,
    port: undefined
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--') {
      options.claudeArgs.push(...argv.slice(index + 1));
      break;
    }

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--no-open') {
      options.open = false;
    } else if (arg === '--port' || arg === '-p') {
      options.port = Number(readValue(argv, index, arg));
      index += 1;
    } else if (arg.startsWith('--port=')) {
      options.port = Number(arg.slice('--port='.length));
    } else if (arg === '--host') {
      options.host = readValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith('--host=')) {
      options.host = arg.slice('--host='.length);
    } else if (arg === '--config' || arg === '-c') {
      options.config = readValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith('--config=')) {
      options.config = arg.slice('--config='.length);
    } else if (arg === '--log-path') {
      options.logPath = readValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith('--log-path=')) {
      options.logPath = arg.slice('--log-path='.length);
    } else if (arg === '--claude-bin') {
      options.claudeBin = readValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith('--claude-bin=')) {
      options.claudeBin = arg.slice('--claude-bin='.length);
    } else {
      options.claudeArgs.push(arg);
    }
  }

  if (!Number.isInteger(options.port) && options.port !== undefined) {
    throw new Error('--port must be an integer');
  }

  return options;
}

export async function resolveConfigPath({ cwd, env, explicitConfig }) {
  if (explicitConfig) {
    return resolve(cwd, explicitConfig);
  }

  if (env.ROUTER_CONFIG) {
    return resolve(cwd, env.ROUTER_CONFIG);
  }

  const localConfig = join(cwd, 'config', 'routes.json');

  try {
    await access(localConfig);
    return localConfig;
  } catch {
    return undefined;
  }
}

export async function startRouterOnAvailablePort(
  { port, host, configPath, logPath },
  startRouterServerImpl = startRouterServer
) {
  let candidate = port;
  let lastError;

  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt += 1) {
    try {
      return await startRouterServerImpl({
        port: candidate,
        host,
        configPath,
        logPath
      });
    } catch (error) {
      if (error.code !== 'EADDRINUSE') {
        throw error;
      }

      lastError = error;
      candidate += 1;
    }
  }

  throw new Error(`No available port found from ${port} to ${candidate - 1}: ${lastError?.message}`);
}

export async function openBrowser(url, { platform = process.platform, spawnImpl = spawn, stderr = process.stderr } = {}) {
  const command = browserCommand(platform, url);
  const child = spawnImpl(command.command, command.args, {
    detached: true,
    stdio: 'ignore'
  });

  child.on('error', (error) => {
    stderr.write(`Could not open browser: ${error.message}\n`);
  });
  child.unref?.();
}

export function browserCommand(platform, url) {
  if (platform === 'darwin') {
    return { command: 'open', args: [url] };
  }

  if (platform === 'win32') {
    return { command: 'cmd', args: ['/c', 'start', '', url] };
  }

  return { command: 'xdg-open', args: [url] };
}

function readValue(argv, index, flag) {
  const value = argv[index + 1];

  if (!value) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

function waitForClaude(child, server, stderr, claudeBin) {
  return new Promise((resolve) => {
    let settled = false;

    const closeServer = async (code) => {
      if (settled) {
        return;
      }

      settled = true;
      await new Promise((closeResolve) => server.close(closeResolve));
      resolve(code);
    };

    child.on('error', async (error) => {
      stderr.write(`Failed to launch ${claudeBin}: ${error.message}\n`);
      await closeServer(error.code === 'ENOENT' ? 127 : 1);
    });

    child.on('exit', async (code, signal) => {
      if (signal) {
        await closeServer(128);
        return;
      }

      await closeServer(code ?? 0);
    });

    process.once('SIGINT', () => {
      child.kill('SIGINT');
    });
    process.once('SIGTERM', () => {
      child.kill('SIGTERM');
    });
  });
}

function helpText() {
  return `Claude Code Router

Usage:
  claude-code-router [options] [-- claude args...]
  ccr [options] [-- claude args...]

Options:
  -p, --port <port>        Preferred router port. Uses the next free port if busy. Default: 8787
      --host <host>        Bind host. Default: 127.0.0.1
  -c, --config <path>      Route config path. Defaults to ./config/routes.json when present
      --log-path <path>    JSONL log path. Default: ./.router-logs/calls.jsonl
      --claude-bin <name>  Claude executable. Default: claude
      --no-open            Do not open the dashboard in a browser
  -h, --help               Show this help

Examples:
  ccr
  ccr --port 9000 -- --model claude-sonnet-5
  ccr --config config/routes.json --no-open
`;
}
