# CRMPort — Design Specification

## 1. Overview

CRMPort is a local plugin server for CRM browser extensions. It provides a secure bridge between browser-based CRM tools (Dynamics 365, Salesforce) and local development resources (filesystem, CLI tools, environment).

### Components

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Server | Node.js + Fastify + ws | HTTP/WebSocket API on localhost:7700 |
| Tray app | systray2 | System tray icon + menu, supervises server process |
| Plugin runtime | worker_threads | Isolated execution per plugin with resource limits |
| Config UI | Static HTML/CSS/JS | Browser-based dashboard served by the server |
| Client SDK | @crmport/sdk (npm) | TypeScript library for browser extensions |
| Installer | MSI (Authenticode signed) | Elevated install, registry setup, autostart |

### Tech Stack

| Concern | Library |
|---------|---------|
| HTTP server | fastify |
| WebSocket | ws |
| Tray icon | systray2 |
| Autostart | auto-launch |
| File watching | chokidar |
| Git operations | simple-git |
| Signing | Node.js crypto (Ed25519) |
| Packaging | pkg (single .exe) |
| Windows service | node-windows |
| SDK build | tsup |

---

## 2. Server Architecture

### 2.1 Process Model

```
┌─────────────────────────────────────────┐
│ main.js (supervisor)                    │
│ - systray2 tray icon                    │
│ - fork()s server.js as child            │
│ - restarts child on crash/update        │
│ - handles tray menu events              │
└──────────────┬──────────────────────────┘
               │ fork()
               ▼
┌─────────────────────────────────────────┐
│ server.js (child process)               │
│ - Fastify HTTP on 127.0.0.1:7700       │
│ - WebSocket upgrade handling            │
│ - Plugin manager                        │
│ - Updater (chokidar + simple-git)       │
│ - Config UI static file serving         │
└──────────────┬──────────────────────────┘
               │ worker_threads
               ▼
┌──────────┐ ┌──────────┐ ┌──────────┐
│ Plugin A │ │ Plugin B │ │ Plugin C │
│ (worker) │ │ (worker) │ │ (worker) │
└──────────┘ └──────────┘ └──────────┘
```

The supervisor (main.js) owns the tray icon and stays alive across server restarts. The server (server.js) runs as a forked child process. Each plugin runs in its own worker_thread with resource limits.

### 2.2 Server Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /health | None | Returns server version, uptime |
| GET | /config | None | Serves config UI SPA |
| POST | /api/register | Fingerprint | Register a new plugin, returns cap token |
| POST | /api/unregister | Cap token | Remove a plugin |
| GET | /api/plugins | Cap token | List installed plugins |
| WS | /ws | Cap token | JSON-RPC 2.0 channel for plugin operations |

### 2.3 WebSocket Protocol

JSON-RPC 2.0 over WebSocket. All methods require a valid capability token sent during the WS handshake (as a query param or first message).

**Methods:**

| Method | Params | Returns | Required capability |
|--------|--------|---------|-------------------|
| fs.read | { path } | { content, encoding } | fs.read:<path> |
| fs.write | { path, content } | { ok } | fs.write:<path> |
| fs.list | { path, glob? } | { entries[] } | fs.read:<path> |
| fs.watch | { path, glob? } | subscription id | fs.read:<path> |
| fs.unwatch | { watchId } | { ok } | (none) |
| exec.run | { command, args, cwd? } | { stdout, stderr, code } | exec:<command> |
| exec.stream | { command, args, cwd? } | streaming stdout/stderr | exec:<command> |
| clipboard.read | {} | { text } | clipboard.read |
| clipboard.write | { text } | { ok } | clipboard.write |
| net.fetch | { url, method?, headers?, body? } | { status, headers, body } | net.fetch:<host> |
| server.version | {} | { version, uptime, plugins[] } | (none) |

**Server-initiated notifications (no id):**

| Method | Params | Trigger |
|--------|--------|---------|
| fs.watch.event | { watchId, type, path } | File changed |
| exec.stream.data | { streamId, fd, chunk } | Process output |
| exec.stream.exit | { streamId, code } | Process exited |
| plugin.updated | { pluginId, oldVersion, newVersion } | Plugin hot-reloaded |

---

## 3. Plugin System

### 3.1 Plugin Structure

```
plugins/
  pp-enhancer/
    plugin.json           # manifest
    index.js              # server-side entry point
    index.js.sig          # Ed25519 signature
```

### 3.2 Plugin Manifest (plugin.json)

```json
{
  "name": "pp-enhancer",
  "version": "2.1.0",
  "displayName": "PP Enhancer Backend",
  "description": "Server-side logic for PP Enhancer extension",
  "entry": "index.js",
  "capabilities": [
    "fs.read:C:/Projects/**",
    "fs.write:C:/Projects/**",
    "exec:git",
    "exec:powershell"
  ],
  "source": {
    "type": "git",
    "url": "https://github.com/user/pp-enhancer-server",
    "branch": "main",
    "path": "server-plugin/"
  },
  "extensionIds": [
    "chrome-extension://abcdef1234567890"
  ]
}
```

### 3.3 Plugin Lifecycle

1. **Load**: Read `plugin.json` → verify `index.js` signature → spawn worker_thread
2. **Run**: Worker receives sandboxed API object (fs, exec, clipboard, net) filtered by capabilities
3. **Reload**: File change or git update detected → verify new signature → terminate old worker → spawn new
4. **Unload**: Terminate worker, deregister routes, clean up watchers

### 3.4 Plugin Worker Sandbox

Each worker receives a restricted API. The worker cannot access Node.js globals directly — only the API surface provided via `workerData` and `parentPort` message passing.

```
Worker thread resource limits:
  maxOldGenerationSizeMb: 64
  maxYoungGenerationSizeMb: 16
  codeRangeSizeMb: 16
  stackSizeMb: 4
```

---

## 4. Security Model

### 4.1 Two Keypairs

| Keypair | Purpose | Private key | Public key |
|---------|---------|-------------|------------|
| Code-signing | Verify plugin JS integrity | Dev machine / CI only | Embedded in server .exe |
| Capability-signing | Issue/verify cap tokens | On server (ACL-protected) | In each JWT (self-contained) |

### 4.2 Code Signing Flow

```
Build time:
  1. Bundle plugin JS (esbuild/rollup)
  2. Sign: signature = Ed25519.sign(content, CODE_PRIVATE_KEY)
  3. Write index.js.sig

Runtime:
  1. Read index.js + index.js.sig
  2. Verify: Ed25519.verify(content, signature, CODE_PUBLIC_KEY)
  3. If invalid → refuse to load, log security alert
  4. If valid → load in worker_thread
```

### 4.3 Capability Token (JWT)

```json
{
  "alg": "EdDSA",
  "typ": "JWT",
  "payload": {
    "sub": "pp-enhancer",
    "iss": "crmport",
    "iat": 1711929600,
    "exp": 1714521600,
    "cap": {
      "allow": ["fs.read:C:/Projects/**", "exec:git"],
      "deny": ["fs.read:**/.env", "fs.read:**/secrets/**"]
    },
    "limits": {
      "max_requests_per_minute": 120,
      "max_file_size_bytes": 10485760,
      "max_exec_timeout_ms": 30000
    }
  }
}
```

### 4.4 Request Authentication

1. **CORS**: Only registered `chrome-extension://` origins
2. **Cap token**: Sent as Bearer token or WS handshake param
3. **Challenge-response** (sensitive ops): Server issues nonce → client signs HMAC(nonce + payload, token) → server verifies
4. **Origin header validation**: Reject unknown origins
5. **127.0.0.1 binding**: Not network-accessible

### 4.5 Self-Update Security

1. Running server detects new version (git fetch / file watch)
2. Downloads new binary + signature
3. Verifies Ed25519 signature of new binary using embedded public key
4. If valid → elevates via UAC → replaces exe → restarts
5. If invalid → rejects update, logs security alert

---

## 5. Auto-Update System

### 5.1 Update Sources

| Source | Detection | Mechanism |
|--------|-----------|-----------|
| Git repo | Poll every 60s via simple-git fetch | Compare HEAD vs remote, git pull if behind |
| Filesystem | chokidar watch on source directory | Detect file changes, copy + verify |
| Client-driven | Extension reports newer version on connect | Server pulls from configured source |

### 5.2 Update Types

| Type | Impact | Method |
|------|--------|--------|
| Plugin update | No restart | Hot-reload: terminate worker → verify new code → spawn new worker |
| Server update | Restart required | Supervisor downloads new server.js → verifies → restarts child |
| Binary update | Full restart | UAC elevate → replace .exe → supervisor restarts |

### 5.3 Version Negotiation

When a client connects, it sends its SDK version and expected plugin version. If the server's plugin is older:

1. Server checks the configured source for the newer version
2. Downloads + verifies signature
3. Hot-reloads the plugin
4. Notifies the client via `plugin.updated` notification

---

## 6. Client SDK (@crmport/sdk)

### 6.1 Package Structure

```
@crmport/sdk/
  src/
    index.ts              # createClient(), re-exports
    client.ts             # CRMPortClient class
    transport.ts          # ReconnectingWebSocket wrapper
    auth.ts               # Token storage, challenge-response HMAC
    installer.ts          # detectServer(), getInstallerUrl()
    api/
      files.ts            # FileOperations interface + implementation
      exec.ts             # ExecOperations interface + implementation
      clipboard.ts        # ClipboardOperations
      net.ts              # NetOperations (proxied fetch)
    errors.ts             # PermissionDeniedError, NotConnectedError, etc.
    types.ts              # Shared types
  dist/
    index.js              # CJS
    index.mjs             # ESM
    index.d.ts            # TypeScript declarations
```

### 6.2 Core API

```typescript
// Create and connect
const client = createClient({
  pluginId: string,
  token?: string,           // from prior registration
  port?: number,            // default 7700
  reconnect?: { enabled: boolean, backoff: 'exponential' | 'linear', maxRetries?: number },
  timeout?: number,         // request timeout ms, default 30000
});

// Namespaces
client.files     // FileOperations
client.exec      // ExecOperations
client.clipboard // ClipboardOperations
client.net       // NetOperations

// Lifecycle
client.connect(): Promise<void>
client.disconnect(): void
client.isConnected(): boolean
client.onStatusChange(cb: (status) => void): () => void

// Registration
client.register(opts): Promise<{ token: string }>

// Server info
client.version(): Promise<{ version, uptime, plugins[] }>
```

### 6.3 Installation Helpers

```typescript
import { detectServer, getInstallerUrl } from '@crmport/sdk/installer';

// Probe localhost for running server
const status = await detectServer({ port: 7700, timeout: 2000 });
// { found: boolean, version?: string }

// Get platform-appropriate installer URL
const url = getInstallerUrl(); // auto-detects platform
```

### 6.4 Wire Protocol

JSON-RPC 2.0 over WebSocket.

```
→ {"jsonrpc":"2.0","id":"1","method":"fs.read","params":{"path":"C:/x.json"}}
← {"jsonrpc":"2.0","id":"1","result":{"content":"...","encoding":"utf8"}}

→ {"jsonrpc":"2.0","id":"2","method":"exec.run","params":{"command":"git","args":["status"]}}
← {"jsonrpc":"2.0","id":"2","result":{"stdout":"...","stderr":"","code":0}}

← {"jsonrpc":"2.0","method":"fs.watch.event","params":{"watchId":"w1","type":"change","path":"..."}}
```

### 6.5 Error Codes

| Code | Name | Meaning |
|------|------|---------|
| -32001 | PermissionDenied | Capability token doesn't allow this operation |
| -32002 | NotConnected | WebSocket not connected |
| -32003 | ServerNotFound | Server not running on expected port |
| -32004 | SignatureInvalid | Code signature verification failed |
| -32005 | TokenExpired | Capability token has expired |
| -32006 | RateLimited | Too many requests per minute |
| -32600 | InvalidRequest | Malformed JSON-RPC |
| -32601 | MethodNotFound | Unknown method |
| -32603 | InternalError | Server-side error |

---

## 7. Config UI

Served as static HTML at `http://localhost:7700/config`.

### Sections

| Tab | Content |
|-----|---------|
| Server | Version, uptime, source repo, last update check, "Update Now" button |
| Plugins | Table of plugins with version, status, source, actions (stop/start/restart/uninstall/permissions) |
| Security | Public key fingerprint, authorized extension IDs, token rotation, capability editor |
| Logs | Filterable live log stream via WebSocket |
| Settings | Port, update interval, log level, autostart toggle |

---

## 8. Folder Structure

```
CRMPort/
├── packages/
│   ├── server/                # The server application
│   │   ├── src/
│   │   │   ├── main.ts        # Supervisor + tray icon
│   │   │   ├── server.ts      # Fastify HTTP/WS server
│   │   │   ├── plugin-manager.ts
│   │   │   ├── plugin-worker.ts
│   │   │   ├── updater.ts
│   │   │   ├── security.ts    # Ed25519 verify, JWT, HMAC
│   │   │   ├── capability.ts  # Capability checking logic
│   │   │   └── routes/
│   │   │       ├── health.ts
│   │   │       ├── register.ts
│   │   │       └── config.ts
│   │   ├── config-ui/         # Static HTML/CSS/JS
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── sdk/                   # @crmport/sdk npm package
│       ├── src/
│       │   ├── index.ts
│       │   ├── client.ts
│       │   ├── transport.ts
│       │   ├── auth.ts
│       │   ├── installer.ts
│       │   ├── api/
│       │   │   ├── files.ts
│       │   │   ├── exec.ts
│       │   │   ├── clipboard.ts
│       │   │   └── net.ts
│       │   ├── errors.ts
│       │   └── types.ts
│       ├── package.json
│       └── tsconfig.json
├── plugins/                   # Installed plugins (runtime)
├── keys/                      # Ed25519 keys
├── package.json               # Workspace root
├── tsconfig.base.json
├── README.md
└── DESIGN.md
```

---

## 9. Implementation Phases

### Phase 1: Foundation
- Workspace setup (monorepo with npm workspaces)
- Server skeleton: Fastify + /health endpoint
- Tray app: systray2 + supervisor fork pattern
- SDK skeleton: createClient(), detectServer()

### Phase 2: Plugin System
- Plugin manifest schema
- Plugin manager: load/unload/reload via worker_threads
- Sandboxed API: fs, exec operations
- File watching with chokidar

### Phase 3: Security
- Ed25519 code signing (build script + runtime verification)
- Capability token issuance and enforcement
- CORS + origin validation + token auth middleware

### Phase 4: Config UI
- Static SPA with plugin management
- Live log streaming
- Permission editor
- Settings persistence

### Phase 5: Auto-Update
- Git repo polling
- Hot-reload on file changes
- Client-driven version negotiation
- Self-update with UAC elevation

### Phase 6: Distribution
- pkg build to single .exe
- MSI installer (WiX or electron-builder)
- Authenticode signing
- GitHub Releases automation
