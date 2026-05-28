#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, hostname, platform, arch } from 'node:os';

// Resolve project root from this script's location (scripts/ -> project root).
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// Ensure child processes can find node and project binaries via PATH.
// Chrome-launched native hosts inherit a minimal PATH that often excludes
// Homebrew/nvm/fnm directories, breaking #!/usr/bin/env node shebangs.
const nodeBinDir = dirname(process.execPath);
const localBinDir = resolve(PROJECT_ROOT, 'node_modules', '.bin');
const sep = platform() === 'win32' ? ';' : ':';
const currentPath = process.env.PATH || (platform() === 'win32' ? '' : '/usr/bin:/bin');
const localAppData = process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local');
const userBinDirs = platform() === 'win32'
  ? [resolve(localAppData, 'OfficeCLI')]
  : [
      resolve(homedir(), '.local', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ];
const managedPathDirs = new Set([nodeBinDir, localBinDir, ...userBinDirs]);
const existingPathDirs = currentPath.split(sep).filter(d => d && !managedPathDirs.has(d));
process.env.PATH = [...new Set([nodeBinDir, ...userBinDirs, ...existingPathDirs, localBinDir])].join(sep);

const MCP_PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 128_000;
const DEFAULT_SHELL = platform() === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/sh';

const TOOL_DEFINITIONS = [
  {
    name: 'shell_exec',
    title: 'Execute Shell Command',
    description: 'Execute a shell command on the local system. Returns stdout, stderr, and exit code.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to user home.' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Additional environment variables to set.' },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 600000, description: 'Timeout in milliseconds. Default 120000.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    annotations: { operation: 'write', risk: 'high' },
  },
  {
    name: 'shell_status',
    title: 'Shell Host Status',
    description: 'Report host health, platform, shell, current working directory, and Node.js version.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { operation: 'read', risk: 'low' },
  },
];

// --- Native messaging framing (4-byte LE length prefix) ---

let buffer = Buffer.alloc(0);
let messageResolve = null;
const messageQueue = [];

function onStdinData(chunk) {
  buffer = Buffer.concat([buffer, chunk]);
  drainBuffer();
}

function drainBuffer() {
  while (true) {
    if (buffer.length < 4) return;
    const len = buffer.readUInt32LE(0);
    if (len === 0 || len > 10 * 1024 * 1024) {
      process.stderr.write(`[shell-mcp-host] Invalid message length: ${len}\n`);
      process.exit(1);
    }
    if (buffer.length < 4 + len) return;
    const json = buffer.subarray(4, 4 + len).toString('utf8');
    buffer = buffer.subarray(4 + len);
    try {
      const msg = JSON.parse(json);
      if (messageResolve) {
        const r = messageResolve;
        messageResolve = null;
        r(msg);
      } else {
        messageQueue.push(msg);
      }
    } catch (err) {
      process.stderr.write(`[shell-mcp-host] JSON parse error: ${err.message}\n`);
    }
  }
}

let stdinEnded = false;
const EOF = Symbol('EOF');

function readMessage() {
  if (messageQueue.length > 0) return Promise.resolve(messageQueue.shift());
  if (stdinEnded) return Promise.resolve(EOF);
  return new Promise((resolve) => { messageResolve = resolve; });
}

process.stdin.on('data', onStdinData);
process.stdin.on('end', () => {
  stdinEnded = true;
  if (messageResolve) {
    const r = messageResolve;
    messageResolve = null;
    r(EOF);
  }
});
process.stdin.on('error', () => {
  stdinEnded = true;
  if (messageResolve) {
    const r = messageResolve;
    messageResolve = null;
    r(EOF);
  }
});

function writeNativeMessage(message) {
  return new Promise((resolve) => {
    const json = JSON.stringify(message);
    const body = Buffer.from(json, 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    process.stdout.write(header);
    process.stdout.write(body, resolve);
  });
}

// --- JSON-RPC helpers ---

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } };
}

// --- Request handlers ---

function handleInitialize(id) {
  return jsonRpcResult(id, {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: 'deepseek-pp-shell', version: '1.0.0' },
    instructions: 'General-purpose shell execution host. Use shell_exec to run any command on the local system.',
  });
}

function handleListTools(id) {
  return jsonRpcResult(id, { tools: TOOL_DEFINITIONS });
}

async function handleCallTool(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};

  if (name === 'shell_status') {
    return jsonRpcResult(id, {
      content: [{ type: 'text', text: `Shell host ready on ${platform()} ${arch()}` }],
      structuredContent: {
        ok: true,
        data: {
          platform: platform(),
          arch: arch(),
          shell: DEFAULT_SHELL,
          cwd: homedir(),
          nodeVersion: process.version,
          hostname: hostname(),
        },
      },
    });
  }

  if (name === 'shell_exec') {
    const command = args.command;
    if (typeof command !== 'string' || command.trim().length === 0) {
      return jsonRpcResult(id, {
        isError: true,
        content: [{ type: 'text', text: 'command is required and must be a non-empty string.' }],
      });
    }

    const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : homedir();
    const env = args.env && typeof args.env === 'object' ? { ...process.env, ...args.env } : process.env;
    const timeoutMs = typeof args.timeout_ms === 'number' && args.timeout_ms >= 1000
      ? Math.min(args.timeout_ms, 600_000)
      : DEFAULT_TIMEOUT_MS;

    try {
      const result = await execCommand(command, { cwd, env, timeoutMs });
      return jsonRpcResult(id, {
        content: [{ type: 'text', text: formatExecSummary(result) }],
        structuredContent: {
          ok: result.exitCode === 0,
          data: result,
        },
        isError: result.exitCode !== 0,
      });
    } catch (err) {
      return jsonRpcResult(id, {
        isError: true,
        content: [{ type: 'text', text: err.message }],
      });
    }
  }

  return jsonRpcError(id, -32602, `Unknown tool: ${name}`);
}

// --- Shell execution ---

function execCommand(command, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const isWin = platform() === 'win32';
    const shellArgs = isWin ? ['/c', command] : ['-c', command];
    const shellBin = isWin ? 'cmd.exe' : DEFAULT_SHELL;

    const child = spawn(shellBin, shellArgs, {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdoutBytes < MAX_OUTPUT_BYTES) {
        const remaining = MAX_OUTPUT_BYTES - stdoutBytes;
        stdout.push(chunk.length <= remaining ? chunk : chunk.subarray(0, remaining));
      }
      stdoutBytes += chunk.length;
    });

    child.stderr.on('data', (chunk) => {
      if (stderrBytes < MAX_OUTPUT_BYTES) {
        const remaining = MAX_OUTPUT_BYTES - stderrBytes;
        stderr.push(chunk.length <= remaining ? chunk : chunk.subarray(0, remaining));
      }
      stderrBytes += chunk.length;
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn command: ${err.message}`));
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        command,
        exitCode: timedOut ? -1 : (exitCode ?? -1),
        signal: signal || (timedOut ? 'SIGTERM' : null),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        truncated: stdoutBytes > MAX_OUTPUT_BYTES || stderrBytes > MAX_OUTPUT_BYTES,
        timedOut,
      });
    });
  });
}

function formatExecSummary(result) {
  const parts = [];
  if (result.timedOut) parts.push('[TIMED OUT]');
  if (result.exitCode !== 0) parts.push(`[exit ${result.exitCode}]`);
  if (result.truncated) parts.push('[output truncated]');
  if (result.stdout) parts.push(result.stdout.slice(0, 4000));
  if (result.stderr) parts.push(`STDERR: ${result.stderr.slice(0, 2000)}`);
  return parts.join('\n') || '(no output)';
}

// --- Message dispatch ---

async function handleMessage(envelope) {
  if (envelope.protocol !== 'deepseek-pp-mcp-native' || envelope.version !== 1) {
    await writeNativeMessage(jsonRpcError(null, -32600, 'Invalid envelope: expected deepseek-pp-mcp-native v1'));
    return;
  }

  const message = envelope.message;
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    await writeNativeMessage(jsonRpcError(null, -32600, 'Invalid JSON-RPC request.'));
    return;
  }

  const id = message.id ?? null;

  if (!('id' in message)) {
    return;
  }

  let response;
  switch (message.method) {
    case 'initialize':
      response = handleInitialize(id);
      break;
    case 'tools/list':
      response = handleListTools(id);
      break;
    case 'tools/call':
      response = await handleCallTool(id, message.params);
      break;
    default:
      response = jsonRpcError(id, -32601, `Unsupported method: ${message.method}`);
  }

  await writeNativeMessage(response);
}

// --- Persistent main loop ---

async function main() {
  while (true) {
    let envelope;
    try {
      envelope = await readMessage();
    } catch {
      break;
    }
    if (envelope === EOF) break;
    try {
      await handleMessage(envelope);
    } catch (err) {
      process.stderr.write(`[shell-mcp-host] Error: ${err.message || err}\n`);
      await writeNativeMessage(jsonRpcError(null, -32603, err.message || 'Internal error'));
    }
  }
}

main().catch((err) => {
  process.stderr.write(`[shell-mcp-host] Fatal: ${err.message || err}\n`);
  process.exit(1);
});
