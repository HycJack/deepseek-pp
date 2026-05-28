#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { arch, homedir, platform, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HOST_NAME = 'com.deepseek_pp.shell';
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const HOST_SCRIPT = resolve(PROJECT_ROOT, 'scripts', 'shell-mcp-host.mjs');
const OFFICECLI_REPO = 'iOfficeAI/OfficeCLI';
const OFFICECLI_BINARY = platform() === 'win32' ? 'officecli.exe' : 'officecli';
const OFFICECLI_MIRROR_BASE = 'https://d.officecli.ai';
const OFFICECLI_GITHUB_RELEASE_BASE = `https://github.com/${OFFICECLI_REPO}/releases/latest/download`;
const OFFICECLI_REQUIRED_HELP_PATTERNS = [
  /\bview\s+<file>\s+<mode>/,
  /\bget\s+<file>\s+<path>/,
  /\bset\s+<file>\s+<path>/,
  /\bbatch\s+<file>/,
  /\bvalidate\s+<file>/,
  /--json\b/,
];

function parseArgs(argv) {
  const args = { extensionId: null, browser: 'chrome', skipOfficecli: false, forceOfficecli: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--extension-id' && argv[i + 1]) args.extensionId = argv[++i];
    else if (argv[i] === '--browser' && argv[i + 1]) args.browser = argv[++i];
    else if (argv[i] === '--skip-officecli') args.skipOfficecli = true;
    else if (argv[i] === '--force-officecli') args.forceOfficecli = true;
    else if (argv[i] === '--help') { printHelp(); process.exit(0); }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/install-shell-host.mjs [options]

Options:
  --extension-id <id>   Chrome extension ID (required for Chrome/Edge)
  --browser <name>      Target browser: chrome, chromium, edge, firefox (default: chrome)
  --skip-officecli      Install only the Shell Native Host
  --force-officecli     Reinstall OfficeCLI even if a compatible binary exists
  --help                Show this help

Examples:
  node scripts/install-shell-host.mjs --extension-id abcdefghijklmnopqrstuvwxyz123456
  node scripts/install-shell-host.mjs --browser firefox
`);
}

function getManifestDir(browser) {
  const os = platform();
  const home = homedir();

  if (os === 'darwin') {
    switch (browser) {
      case 'chrome': return `${home}/Library/Application Support/Google/Chrome/NativeMessagingHosts`;
      case 'chromium': return `${home}/Library/Application Support/Chromium/NativeMessagingHosts`;
      case 'edge': return `${home}/Library/Application Support/Microsoft Edge/NativeMessagingHosts`;
      case 'firefox': return `${home}/Library/Application Support/Mozilla/NativeMessagingHosts`;
      default: return `${home}/Library/Application Support/Google/Chrome/NativeMessagingHosts`;
    }
  }

  if (os === 'linux') {
    switch (browser) {
      case 'chrome': return `${home}/.config/google-chrome/NativeMessagingHosts`;
      case 'chromium': return `${home}/.config/chromium/NativeMessagingHosts`;
      case 'edge': return `${home}/.config/microsoft-edge/NativeMessagingHosts`;
      case 'firefox': return `${home}/.mozilla/native-messaging-hosts`;
      default: return `${home}/.config/google-chrome/NativeMessagingHosts`;
    }
  }

  if (os === 'win32') {
    const appData = process.env.LOCALAPPDATA || resolve(home, 'AppData', 'Local');
    return resolve(appData, 'DeepSeekPP', 'NativeMessagingHosts');
  }

  throw new Error(`Unsupported platform: ${os}`);
}

function getRegistryKey(browser) {
  switch (browser) {
    case 'chrome': return `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
    case 'edge': return `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`;
    case 'chromium': return `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`;
    default: return null;
  }
}

function buildManifest(args) {
  const manifest = {
    name: HOST_NAME,
    description: 'DeepSeek++ Shell MCP - General purpose shell execution via Native Messaging',
    path: HOST_SCRIPT,
    type: 'stdio',
  };

  if (args.browser === 'firefox') {
    manifest.allowed_extensions = ['deepseek-pp@zhu1090093659.github'];
  } else {
    if (!args.extensionId) {
      console.error('Error: --extension-id is required for Chrome/Edge/Chromium.');
      console.error('Find it at chrome://extensions (or edge://extensions) with Developer mode on.');
      process.exit(1);
    }
    manifest.allowed_origins = [`chrome-extension://${args.extensionId}/`];
  }

  return manifest;
}

function createWrapper() {
  const nodePath = process.execPath;
  mkdirSync(resolve(PROJECT_ROOT, 'native-host'), { recursive: true });

  if (platform() === 'win32') {
    const wrapperPath = resolve(PROJECT_ROOT, 'native-host', 'shell-mcp-host.bat');
    const content = `@echo off\r\n"${nodePath}" "${HOST_SCRIPT}" %*\r\n`;
    writeFileSync(wrapperPath, content);
    return wrapperPath;
  }

  const wrapperPath = resolve(PROJECT_ROOT, 'native-host', 'shell-mcp-host');
  const content = `#!/bin/sh\nexec "${nodePath}" "${HOST_SCRIPT}" "$@"\n`;
  writeFileSync(wrapperPath, content, { mode: 0o755 });
  return wrapperPath;
}

function writeWindowsRegistry(browser, manifestPath) {
  const regKey = getRegistryKey(browser);
  if (!regKey) return;

  try {
    execSync(`reg add "${regKey}" /ve /t REG_SZ /d "${manifestPath}" /f`, { stdio: 'pipe' });
    console.log(`Registry: ${regKey}`);
  } catch (err) {
    console.error(`Warning: Failed to write registry key. You may need to run as Administrator.`);
    console.error(`  Manual: reg add "${regKey}" /ve /t REG_SZ /d "${manifestPath}" /f`);
  }
}

function getOfficeCliInstallDir() {
  if (platform() === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local');
    return resolve(localAppData, 'OfficeCLI');
  }
  return resolve(homedir(), '.local', 'bin');
}

function isProjectNodeModulesPath(path) {
  const normalized = path.replaceAll('\\', '/');
  return normalized.includes('/node_modules/.bin/');
}

function getPathOfficeCliCandidates() {
  const command = platform() === 'win32' ? 'where.exe' : 'which';
  const args = platform() === 'win32' ? [OFFICECLI_BINARY] : ['-a', 'officecli'];
  try {
    const out = execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getOfficeCliCandidates() {
  const installPath = resolve(getOfficeCliInstallDir(), OFFICECLI_BINARY);
  const candidates = [installPath, ...getPathOfficeCliCandidates()]
    .filter(candidate => !isProjectNodeModulesPath(candidate));
  return [...new Set(candidates)];
}

function isCompatibleOfficeCli(binaryPath) {
  if (!existsSync(binaryPath)) return false;
  try {
    const help = execFileSync(binaryPath, ['--help'], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, OFFICECLI_SKIP_UPDATE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return OFFICECLI_REQUIRED_HELP_PATTERNS.every(pattern => pattern.test(help));
  } catch {
    return false;
  }
}

function findCompatibleOfficeCli() {
  return getOfficeCliCandidates().find(isCompatibleOfficeCli) ?? null;
}

function detectLinuxMusl() {
  if (existsSync('/etc/alpine-release')) return true;
  try {
    const out = execFileSync('ldd', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return /musl/i.test(out);
  } catch {
    return false;
  }
}

function getOfficeCliAssetName() {
  const os = platform();
  const cpu = arch();
  if (os === 'darwin') {
    if (cpu === 'arm64') return 'officecli-mac-arm64';
    if (cpu === 'x64') return 'officecli-mac-x64';
  }
  if (os === 'linux') {
    const distro = detectLinuxMusl() ? 'linux-alpine' : 'linux';
    if (cpu === 'x64') return `officecli-${distro}-x64`;
    if (cpu === 'arm64') return `officecli-${distro}-arm64`;
  }
  if (os === 'win32') {
    if (cpu === 'x64') return 'officecli-win-x64.exe';
    if (cpu === 'arm64') return 'officecli-win-arm64.exe';
  }
  throw new Error(`Unsupported OfficeCLI platform: ${os}/${cpu}`);
}

async function fetchBytes(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'deepseek-pp-officecli-installer' },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function downloadWithFallback(asset, outPath) {
  const primary = `${OFFICECLI_MIRROR_BASE}/releases/latest/download/${asset}`;
  const fallback = `${OFFICECLI_GITHUB_RELEASE_BASE}/${asset}`;
  try {
    writeFileSync(outPath, await fetchBytes(primary));
    console.log(`  downloaded ${asset} via mirror`);
  } catch (primaryError) {
    console.log(`  mirror unavailable for ${asset}, falling back to GitHub`);
    try {
      writeFileSync(outPath, await fetchBytes(fallback));
    } catch (fallbackError) {
      throw new Error(`Failed to download ${asset}: mirror=${primaryError.message}; github=${fallbackError.message}`);
    }
  }
}

async function verifyOfficeCliChecksum(asset, binaryPath) {
  const sumsPath = resolve(tmpdir(), `officecli-SHA256SUMS-${process.pid}`);
  try {
    try {
      await downloadWithFallback('SHA256SUMS', sumsPath);
    } catch {
      console.log('  checksum file unavailable, skipping verification');
      return;
    }
    const sums = readFileSync(sumsPath, 'utf8');
    const expectedLine = sums.split(/\r?\n/).find(line => line.includes(asset));
    if (!expectedLine) {
      console.log('  checksum entry not found, skipping verification');
      return;
    }
    const expected = expectedLine.trim().split(/\s+/)[0].toLowerCase();
    const actual = createHash('sha256').update(readFileSync(binaryPath)).digest('hex');
    if (actual !== expected) {
      throw new Error(`Checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
    }
    console.log('  checksum verified');
  } finally {
    rmSync(sumsPath, { force: true });
  }
}

function verifyDownloadedOfficeCli(binaryPath) {
  if (platform() !== 'win32') {
    chmodSync(binaryPath, 0o755);
  }
  execFileSync(binaryPath, ['--version'], {
    timeout: 20_000,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, OFFICECLI_SKIP_UPDATE: '1' },
  });
  if (!isCompatibleOfficeCli(binaryPath)) {
    throw new Error('Downloaded OfficeCLI does not expose the required command-based interface.');
  }
}

function addOfficeCliToUserPath(installDir) {
  if (platform() === 'win32') {
    try {
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `$p=[Environment]::GetEnvironmentVariable('Path','User'); if (($p -split ';') -notcontains '${installDir.replaceAll("'", "''")}') { [Environment]::SetEnvironmentVariable('Path', (($p.TrimEnd(';') + ';${installDir.replaceAll("'", "''")}').TrimStart(';')), 'User') }`,
      ], { stdio: 'pipe' });
      console.log(`Added ${installDir} to the user PATH.`);
    } catch {
      console.log(`Could not update the user PATH automatically. Add this directory manually: ${installDir}`);
    }
    return;
  }

  const shellRc = platform() === 'darwin' || process.env.SHELL?.includes('zsh')
    ? resolve(homedir(), '.zshrc')
    : resolve(homedir(), '.bashrc');
  const pathLine = `export PATH="${installDir}:$PATH"`;
  try {
    const existing = existsSync(shellRc) ? readFileSync(shellRc, 'utf8') : '';
    if (!existing.includes(installDir)) {
      writeFileSync(shellRc, `${existing}${existing.endsWith('\n') || existing.length === 0 ? '' : '\n'}\n${pathLine}\n`);
      console.log(`Added ${installDir} to PATH in ${shellRc}.`);
    }
  } catch {
    console.log(`Could not update shell PATH automatically. Add this line manually: ${pathLine}`);
  }
}

async function ensureOfficeCliInstalled({ force }) {
  if (!force) {
    const existing = findCompatibleOfficeCli();
    if (existing) {
      console.log(`OfficeCLI command binary already available: ${existing}`);
      return existing;
    }
  }

  const asset = getOfficeCliAssetName();
  const installDir = getOfficeCliInstallDir();
  const targetPath = resolve(installDir, OFFICECLI_BINARY);
  const tempPath = resolve(tmpdir(), `${OFFICECLI_BINARY}-${process.pid}`);
  const stagedPath = `${targetPath}.new`;

  console.log(`Installing OfficeCLI from ${OFFICECLI_REPO} (${asset})...`);
  await downloadWithFallback(asset, tempPath);
  await verifyOfficeCliChecksum(asset, tempPath);
  verifyDownloadedOfficeCli(tempPath);

  mkdirSync(installDir, { recursive: true });
  copyFileSync(tempPath, stagedPath);
  if (platform() !== 'win32') {
    chmodSync(stagedPath, 0o755);
  }
  if (platform() === 'darwin') {
    try { execFileSync('xattr', ['-d', 'com.apple.quarantine', stagedPath], { stdio: 'ignore' }); } catch {}
    try { execFileSync('codesign', ['-s', '-', '-f', stagedPath], { stdio: 'ignore' }); } catch {}
  }
  renameSync(stagedPath, targetPath);
  rmSync(tempPath, { force: true });

  addOfficeCliToUserPath(installDir);
  console.log(`OfficeCLI installed: ${targetPath}`);
  return targetPath;
}

function install() {
  const args = parseArgs(process.argv.slice(2));
  const dir = getManifestDir(args.browser);
  const manifestPath = resolve(dir, `${HOST_NAME}.json`);

  const wrapperPath = createWrapper();
  const manifest = buildManifest(args);
  manifest.path = wrapperPath;

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    console.log(`Created directory: ${dir}`);
  }

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  if (platform() === 'win32') {
    writeWindowsRegistry(args.browser, manifestPath);
  }

  console.log(`\nInstalled native messaging host manifest:`);
  console.log(`  ${manifestPath}\n`);
  console.log(`Host script: ${manifest.path}`);
  console.log(`Host name:   ${HOST_NAME}`);
  console.log(`Browser:     ${args.browser}`);
  if (manifest.allowed_origins) console.log(`Origin:      ${manifest.allowed_origins[0]}`);
  if (manifest.allowed_extensions) console.log(`Extension:   ${manifest.allowed_extensions[0]}`);
  console.log('');
  if (args.skipOfficecli) {
    console.log('OfficeCLI install skipped by --skip-officecli.');
  }
  return args;
}

async function main() {
  const args = install();
  if (!args.skipOfficecli) {
    await ensureOfficeCliInstalled({ force: args.forceOfficecli });
  }
  console.log(`\nDone. Restart ${args.browser} to activate.`);
}

main().catch((err) => {
  console.error(`\nInstall failed: ${err.message}`);
  process.exit(1);
});
