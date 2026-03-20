# CRMPort SDK — Extension Development Guide

Build browser extensions that read/write local files, run commands, and access the clipboard through CRMPort's secure local server.

## Architecture

```
Browser Extension                    CRMPort Server (localhost:7700)
┌─────────────────┐                  ┌──────────────────────────┐
│ background       │── WebSocket ──→ │ JSON-RPC 2.0             │
│ service-worker   │   (ws://...)    │                          │
│                  │                 │ ┌──────────────────────┐ │
│ content scripts  │── message ──→   │ │ Plugin Worker Thread │ │
│ (https:// page)  │   (chrome.      │ │  your server code    │ │
│                  │    runtime)     │ │  runs here           │ │
│ popup            │                 │ └──────────────────────┘ │
└─────────────────┘                  └──────────────────────────┘
```

Content scripts on `https://` pages can't open WebSocket connections to `localhost`. All CRMPort communication goes through the background service worker.

## Quick Start

### 1. Create the server-side plugin

Your extension bundles a `crmport-plugin/` directory with two files:

**`crmport-plugin/plugin.json`**
```json
{
  "name": "my-extension",
  "version": "1.0.0",
  "displayName": "My Extension",
  "entry": "index.js",
  "capabilities": [
    "fs.read:C:/Projects/**",
    "fs.write:C:/Projects/**",
    "exec:npm",
    "exec:git"
  ]
}
```

Capabilities use glob patterns. Only request what you need.

**`crmport-plugin/index.js`**
```js
'use strict';
const fs = require('fs');
const path = require('path');

exports.init = function init(ctx) {
  const { registerHandler, pluginDir } = ctx;

  // Read config from plugin.json
  const manifest = JSON.parse(
    fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf-8')
  );

  // Register a custom JSON-RPC method
  // Clients call this as: plugin.my-extension.greet
  registerHandler('greet', async (params) => {
    return { message: `Hello from ${manifest.displayName}!` };
  });

  registerHandler('read-config', async (params) => {
    const content = fs.readFileSync(params.path, 'utf-8');
    return { content };
  });
};
```

Handlers registered with `registerHandler('foo', ...)` become callable as `plugin.<pluginId>.foo` over the WebSocket.

### 2. Background service worker

The service worker connects to CRMPort, deploys the plugin, and proxies calls for content scripts.

**`background/service-worker.js`**
```js
const VER = chrome.runtime.getManifest().version;
const PLUGIN_ID = 'my-extension';
const CRMPORT = 'http://127.0.0.1:7700';
const CRMPORT_WS = 'ws://127.0.0.1:7700/ws';

let ws = null;
let authenticated = false;
let serverConnected = false;
let capabilityToken = null;
let idCounter = 0;
const pending = new Map();

// ── Token persistence ───────────────────────────────────────────
async function loadToken() {
  const r = await chrome.storage.local.get(['crmportToken']);
  capabilityToken = r.crmportToken || null;
}
async function saveToken(token) {
  capabilityToken = token;
  await chrome.storage.local.set({ crmportToken: token });
}

// ── Registration + deployment ───────────────────────────────────
async function ensurePlugin() {
  // Check if already running with correct version
  const info = await fetch(`${CRMPORT}/api/plugins`).then(r => r.json());
  const running = info.plugins.find(
    p => p.pluginId === PLUGIN_ID && p.version === VER
  );

  if (running) {
    if (!capabilityToken) await registerPlugin();
    return;
  }

  // Register
  await registerPlugin();

  // Deploy plugin files from extension bundle
  const files = {};
  for (const name of ['plugin.json', 'index.js']) {
    const url = chrome.runtime.getURL(`crmport-plugin/${name}`);
    files[name] = await fetch(url).then(r => r.text());
  }

  const resp = await fetch(`${CRMPORT}/api/deploy-plugin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pluginId: PLUGIN_ID, files }),
  });
  if (!resp.ok) throw new Error('Deploy failed');
}

async function registerPlugin() {
  const resp = await fetch(`${CRMPORT}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pluginId: PLUGIN_ID,
      displayName: 'My Extension',
      version: VER,
      extensionIds: [chrome.runtime.id],
      capabilities: [
        'fs.read:C:/Projects/**',
        'fs.write:C:/Projects/**',
        'exec:npm',
        'exec:git',
      ],
    }),
  });
  if (!resp.ok) throw new Error('Registration failed');
  const data = await resp.json();
  if (data.capabilityToken) await saveToken(data.capabilityToken);
}

// ── Authentication (auto-renews expired tokens) ─────────────────
async function authenticate() {
  try {
    return await rpc('auth', {
      token: capabilityToken, version: VER, pluginId: PLUGIN_ID,
    });
  } catch (e) {
    // Token expired — re-register for a fresh one
    await registerPlugin();
    return await rpc('auth', {
      token: capabilityToken, version: VER, pluginId: PLUGIN_ID,
    });
  }
}

// ── WebSocket ───────────────────────────────────────────────────
function connect() {
  if (ws?.readyState === WebSocket.OPEN) return;
  ws = new WebSocket(CRMPORT_WS);

  ws.onopen = async () => {
    await ensurePlugin();
    await authenticate();
    authenticated = true;
    serverConnected = true;
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id) {
      const p = pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      }
    }
  };

  ws.onclose = () => {
    authenticated = false;
    serverConnected = false;
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('Disconnected')); }
    pending.clear();
    setTimeout(connect, 5000);
  };

  ws.onerror = () => {};
}

function rpc(method, params, timeout = 30000) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error('Not connected'));
    const id = String(++idCounter);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Timeout')); }, timeout);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

// ── Heartbeat (keeps MV3 service worker alive) ──────────────────
setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'ping' }));
  }
}, 20000);

// ── Message handler for content scripts ─────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'get-server-status') {
    sendResponse({ connected: serverConnected });
    return true;
  }
  if (msg.action === 'plugin-call') {
    rpc(`plugin.${PLUGIN_ID}.${msg.method}`, msg.params)
      .then(result => sendResponse({ ok: true, result }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // async response
  }
});

// ── Init ────────────────────────────────────────────────────────
loadToken().then(connect);
```

### 3. Content scripts

Content scripts call plugin methods through `chrome.runtime.sendMessage`:

```js
// Call a custom plugin method
async function pluginCall(method, params) {
  const resp = await chrome.runtime.sendMessage({
    action: 'plugin-call',
    method,
    params: params || {},
  });
  if (!resp?.ok) throw new Error(resp?.error || 'Plugin call failed');
  return resp.result;
}

// Usage
const result = await pluginCall('greet', { name: 'world' });
console.log(result.message); // "Hello from My Extension!"

const config = await pluginCall('read-config', {
  path: 'C:/Projects/myapp/config.json'
});
```

### 4. Manifest

```json
{
  "manifest_version": 3,
  "permissions": ["activeTab", "storage"],
  "host_permissions": ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
  "background": { "service_worker": "background/service-worker.js" },
  "web_accessible_resources": [{
    "matches": ["<all_urls>"],
    "resources": ["crmport-plugin/plugin.json", "crmport-plugin/index.js"]
  }],
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'; connect-src 'self' ws://127.0.0.1:7700 http://127.0.0.1:7700"
  }
}
```

## Built-in Capabilities

These capabilities can be requested during registration and used via the JSON-RPC WebSocket:

### File System

| Method | Params | Returns | Capability |
|--------|--------|---------|------------|
| `fs.read` | `{ path }` | `{ content, encoding }` | `fs.read:<glob>` |
| `fs.write` | `{ path, content }` | `{ ok }` | `fs.write:<glob>` |
| `fs.list` | `{ path }` | `{ entries: [{ name, type, path }] }` | `fs.read:<glob>` |
| `fs.watch` | `{ path, glob? }` | `{ watchId }` | `fs.read:<glob>` |
| `fs.unwatch` | `{ watchId }` | `{ ok }` | — |

File watch delivers `fs.watch.event` notifications: `{ watchId, type, path }`.

### Process Execution

| Method | Params | Returns | Capability |
|--------|--------|---------|------------|
| `exec.run` | `{ command, args[], cwd? }` | `{ stdout, stderr, code }` | `exec:<command>` |
| `exec.stream` | `{ command, args[], cwd? }` | `{ streamId }` | `exec:<command>` |

Stream delivers `exec.stream.data` (`{ streamId, fd, chunk }`) and `exec.stream.exit` (`{ streamId, code }`).

### Clipboard

| Method | Params | Returns | Capability |
|--------|--------|---------|------------|
| `clipboard.read` | `{}` | `{ text }` | `clipboard.read` |
| `clipboard.write` | `{ text }` | `{ ok }` | `clipboard.write` |

### Network

| Method | Params | Returns | Capability |
|--------|--------|---------|------------|
| `net.fetch` | `{ url, method?, headers?, body? }` | `{ status, headers, body }` | `net.fetch:<host>` |

## Capability Patterns

Capabilities are glob-based:

```
fs.read:C:/Projects/**       # Read anything under C:/Projects
fs.write:C:/Projects/myapp/* # Write only in one directory
fs.read:**/.env              # Read .env files anywhere (use in deny)
exec:npm                     # Run npm
exec:git                     # Run git
exec:*                       # Run any command (avoid)
clipboard.read               # Read clipboard
net.fetch:api.example.com    # Fetch from one host
```

The server issues a JWT capability token with `allow` and `deny` lists. The token is valid for 90 days.

## Plugin Handler API

The `init` function receives a context object:

```js
exports.init = function(ctx) {
  ctx.pluginId;    // "my-extension"
  ctx.pluginDir;   // Absolute path to the plugin's directory on disk

  ctx.registerHandler(name, async (params) => {
    // params = whatever the client sent
    // return value is sent back as the JSON-RPC result
    // throw { code: -32603, message: '...' } for errors
  });
};
```

Handlers run in a worker thread with:
- 64 MB old generation heap
- 16 MB young generation heap
- 30 second execution timeout per request
- Full `require()` / `fs` / `child_process` access

## Plugin Deployment Flow

```
Extension loads
    │
    ▼
GET /api/plugins ─── plugin running with correct version? ─── yes ──→ skip
    │                                                                    │
    no                                                                   │
    ▼                                                                    │
POST /api/register ← get capability token                               │
    │                                                                    │
    ▼                                                                    │
POST /api/deploy-plugin ← send plugin.json + index.js                   │
    │                    CRMPort writes to ~/.crmport/plugins/           │
    │                    and loads the worker                            │
    ▼                                                                    │
WebSocket /ws ──── auth { token, pluginId } ◄────────────────────────────┘
    │
    ▼
Ready — plugin-call messages work
```

On extension update, the version changes, so `ensurePlugin()` re-deploys automatically.

## HTTP API Reference

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/health` | — | Server status, version, uptime |
| `GET` | `/api/version` | — | Version + public key fingerprint |
| `GET` | `/api/plugins` | — | List running + registered plugins |
| `POST` | `/api/register` | — | Register plugin, get capability token |
| `POST` | `/api/deploy-plugin` | — | Upload plugin files, (re)load worker |
| `DELETE` | `/api/plugins/:id` | Bearer | Unregister plugin |
| `GET` | `/api/config` | — | Server configuration |
| `POST` | `/api/config` | — | Update configuration |
| `WS` | `/ws` | JWT | JSON-RPC 2.0 (plugin calls) |
| `WS` | `/ws/logs` | — | Live log stream (config UI) |

## TypeScript SDK (Node.js)

For Node.js plugins or tools that need to talk to CRMPort programmatically:

```ts
import { createClient } from '@crmport/sdk';

const client = createClient({
  pluginId: 'my-tool',
  token: 'eyJ...',           // capability token from registration
  reconnect: { enabled: true, backoff: 'exponential' },
});

await client.connect();

// File operations
const file = await client.files.read('C:/Projects/app/config.json');
await client.files.write('C:/Projects/app/out.json', JSON.stringify(data));
const entries = await client.files.list('C:/Projects/app/src');

// Watch for changes
const watcher = client.files.watch('C:/Projects/app/src', (event) => {
  console.log(`${event.type}: ${event.path}`);
});

// Execute commands
const result = await client.exec.run('npm', ['test'], { cwd: 'C:/Projects/app' });
console.log(result.stdout);

// Streaming execution
const stream = client.exec.stream('npm', ['run', 'build']);
stream.onStdout(chunk => process.stdout.write(chunk));
stream.onStderr(chunk => process.stderr.write(chunk));
const { code } = await stream.done;

// Clipboard
const text = await client.clipboard.read();
await client.clipboard.write('copied!');

// Network proxy
const resp = await client.net.fetch('https://api.example.com/data');

// Server info
const info = await client.version();

// Disconnect
client.disconnect();
```

## Server Detection

```ts
import { detectServer, waitForServer } from '@crmport/sdk/installer';

// Quick probe
const result = await detectServer();
if (result.found) {
  console.log(`CRMPort v${result.version}`);
}

// Wait with retries
const ready = await waitForServer({ maxRetries: 10, intervalMs: 2000 });
```

## Error Handling

```ts
import {
  PermissionDeniedError,
  NotConnectedError,
  TokenExpiredError,
  RateLimitedError,
} from '@crmport/sdk';

try {
  await client.files.read('C:/Windows/System32/secret.txt');
} catch (err) {
  if (err instanceof PermissionDeniedError) {
    // Requested path not in your capability globs
  }
  if (err instanceof TokenExpiredError) {
    // Re-register to get a fresh token
  }
  if (err instanceof RateLimitedError) {
    // Back off — default limit is 120 req/min
  }
}
```

## Security Model

- **Capability tokens** (Ed25519 JWT): issued on registration, scoped to specific paths/commands, expire after 90 days. On expiry, the `authenticate()` function automatically re-registers and gets a fresh token — no user action needed
- **Code signing** (Ed25519): release binaries are signed with a private key kept on the build machine. The server verifies updates against the embedded public key before applying
- **Worker isolation**: plugins run in Node.js worker threads with memory limits (64 MB heap)
- **CORS**: only `chrome-extension://` and `moz-extension://` origins are allowed

## Example: Form Editor

The Form Editor extension is a complete reference implementation. It:

1. Bundles a `crmport-plugin/` with parser logic for TypeScript form handlers
2. On load, the service worker calls `ensurePlugin()` to register + deploy
3. Content scripts call `pluginCall('fieldspec.get', { entity, field })` to fetch data
4. The plugin worker reads `.spec.ts` files, parses them, and returns structured data
5. On save, the plugin writes the file, runs `npm run build`, and deploys

See `c:\git\extensions\form-editor\` for the full implementation.
