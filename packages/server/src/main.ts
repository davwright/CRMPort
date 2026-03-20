import { fork, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { loadConfig } from './config.js';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const config = loadConfig();

let serverProcess: ChildProcess | null = null;
let isShuttingDown = false;

function startServer(): void {
  const serverScript = path.join(__dirname, 'server.js');
  serverProcess = fork(serverScript, [], {
    stdio: 'pipe',
    env: { ...process.env, CRMPORT_SUPERVISED: '1' },
  });

  serverProcess.on('message', (msg: any) => {
    if (msg.type === 'started') {
      console.log(`Server started on port ${msg.port}`);
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

  const iconPath = path.join(__dirname, '..', 'assets', 'icon.ico');
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

  await setupAutostart();
  startServer();
  await initTray();

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
