import { fork, spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as http from 'node:http';
import { loadConfig } from './config.js';
import { loadPublicKey, verifySignature } from './security.js';

function resolveAsset(...segments: string[]): string {
  const flat = path.join(__dirname, ...segments);
  if (fs.existsSync(flat)) return flat;
  return path.join(__dirname, '..', ...segments);
}

const pkg = JSON.parse(fs.readFileSync(resolveAsset('package.json'), 'utf8'));
const config = loadConfig();
const isDev = process.argv.some(a => a.includes('tsx'));

let serverProcess: ChildProcess | null = null;
let isShuttingDown = false;

function startServer(): void {
  const serverScript = path.join(__dirname, 'server.js');
  serverProcess = fork(serverScript, [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, CRMPORT_SUPERVISED: '1' },
  });

  serverProcess.on('message', (msg: any) => {
    if (msg.type === 'started') {
      console.log(`Server started on port ${msg.port}`);
    }
    if (msg.type === 'self-update') {
      selfUpdate(msg.version, msg.url);
    }
  });

  serverProcess.on('exit', (code) => {
    if (!isShuttingDown) {
      console.log(`Server exited with code ${code}, restarting in 2s...`);
      setTimeout(startServer, 2000);
    }
  });

  serverProcess.on('error', (err) => {
    console.error('Server process error:', err);
  });

  // Forward stdout/stderr
  serverProcess.stdout?.pipe(process.stdout);
  serverProcess.stderr?.pipe(process.stderr);
}

function stopServer(): void {
  if (serverProcess) {
    serverProcess.send('shutdown');
    setTimeout(() => {
      if (serverProcess && !serverProcess.killed) {
        serverProcess.kill('SIGTERM');
      }
    }, 5000);
  }
}

function restartServer(): void {
  console.log('Restarting server...');
  if (serverProcess) {
    serverProcess.once('exit', () => startServer());
    stopServer();
  } else {
    startServer();
  }
}

async function initTray(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { default: SysTray } = require('systray2') as typeof import('systray2');

  const iconPath = resolveAsset('assets', 'icon.ico');
  const icon = fs.readFileSync(iconPath).toString('base64');

  const systray = new SysTray({
    menu: {
      icon,
      title: '',
      tooltip: `CRMPort v${pkg.version}`,
      items: [
        {
          title: `CRMPort v${pkg.version}`,
          tooltip: 'Server version',
          enabled: false,
        },
        { title: '─────────', tooltip: '', enabled: false },
        {
          title: 'Open Config',
          tooltip: 'Open configuration in browser',
          enabled: true,
        },
        {
          title: 'Restart Server',
          tooltip: 'Restart the server process',
          enabled: true,
        },
        { title: '─────────', tooltip: '', enabled: false },
        {
          title: 'Quit',
          tooltip: 'Stop server and exit',
          enabled: true,
        },
      ],
    },
    debug: false,
    copyDir: true,
  });

  await systray.ready();

  systray.onClick((action: any) => {
    switch (action.seq_id) {
      case 2: // Open Config
        openBrowser(`http://localhost:${config.port}/config/`);
        break;
      case 3: // Restart Server
        restartServer();
        break;
      case 5: // Quit
        shutdown();
        break;
    }
  });

  console.log('Tray icon ready');

  // Store for cleanup
  (global as any).__systray = systray;
}

function openBrowser(url: string): void {
  const { exec } = require('node:child_process');
  exec(`start "" "${url}"`, (err: Error | null) => {
    if (err) throw err;
  });
}

async function setupAutostart(): Promise<void> {
  if (!config.autostart) return;

  const AutoLaunch = (await import('auto-launch')).default;
  const launcher = new AutoLaunch({
    name: 'CRMPort',
    path: process.execPath,
    isHidden: true,
  });

  const isEnabled = await launcher.isEnabled();
  if (!isEnabled) {
    await launcher.enable();
    console.log('Autostart enabled');
  }
}

async function selfUpdate(version: string, url: string): Promise<void> {
  console.log(`Self-update: v${pkg.version} → v${version}`);

  // Load code-signing public key — required for update verification
  const codeSignPubPath = path.join(config.keysDir, 'codesign.pub');
  if (!fs.existsSync(codeSignPubPath)) {
    throw new Error('Self-update: no code-signing public key — cannot verify update');
  }
  const codeSigningKey = loadPublicKey(fs.readFileSync(codeSignPubPath, 'utf8'));

  const exe = process.execPath;
  const dir = path.dirname(exe);
  const ext = path.extname(exe);
  const newPath = path.join(dir, `crmport-new${ext}`);
  const oldPath = path.join(dir, `crmport-old${ext}`);

  // Download helper (follows redirects)
  const downloadBuffer = (downloadUrl: string): Promise<Buffer> => new Promise((resolve, reject) => {
    const proto = downloadUrl.startsWith('https') ? https : http;
    proto.get(downloadUrl, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const location = res.headers.location;
        if (!location) return reject(new Error('Redirect with no location'));
        downloadBuffer(location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });

  // Download binary and signature
  console.log(`Self-update: downloading binary from ${url}`);
  const [binary, sigText] = await Promise.all([
    downloadBuffer(url),
    downloadBuffer(`${url}.sig`).then(buf => buf.toString('utf8').trim()),
  ]);

  // Verify signature
  if (!verifySignature(binary, sigText, codeSigningKey)) {
    throw new Error('Self-update: signature verification FAILED — aborting');
  }
  console.log('Self-update: signature verified');

  // Write new binary
  fs.writeFileSync(newPath, binary);

  // Swap: current → old, new → current
  if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  fs.renameSync(exe, oldPath);
  fs.renameSync(newPath, exe);

  console.log(`Self-update: binary replaced, restarting as v${version}...`);

  // Stop server child and tray
  isShuttingDown = true;
  stopServer();

  const systray = (global as any).__systray;
  if (systray) systray.kill(false);

  // Re-exec with inherited stdio (same console, same output)
  const child = spawn(exe, process.argv.slice(1), {
    stdio: 'inherit',
    detached: false,
  });

  child.on('error', (err) => {
    console.error('Self-update restart failed:', err);
    // Roll back
    fs.renameSync(exe, newPath);
    fs.renameSync(oldPath, exe);
    if (fs.existsSync(newPath)) fs.unlinkSync(newPath);
    console.error('Rolled back to previous version');
    process.exit(1);
  });

  child.unref();
  process.exit(0);
}

async function shutdown(): Promise<void> {
  isShuttingDown = true;
  stopServer();

  const systray = (global as any).__systray;
  if (systray) {
    systray.kill(false);
  }

  // Wait for server to exit
  setTimeout(() => process.exit(0), 3000);
}

// --- Entry point ---

async function main(): Promise<void> {
  console.log(`CRMPort v${pkg.version} starting...`);

  if (!isDev) {
    await setupAutostart();
  }

  startServer();

  if (!isDev) {
    await initTray();
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
