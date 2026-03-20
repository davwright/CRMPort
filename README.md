# CRMPort

A lightweight local server that bridges browser-based CRM extensions (Dynamics 365, Salesforce, etc.) to local development tools, filesystems, and CLI utilities.

## What It Does

CRMPort runs as a system tray application on your machine. Your browser extensions connect to it over localhost, giving them secure access to:

- **File system** — read/write project files, watch for changes
- **CLI tools** — run git, PowerShell, node, dotnet, and other dev tools
- **Clipboard** — read/write clipboard from extension context
- **Outbound HTTP** — proxy API calls through the local machine

## Key Features

- **System tray app** — starts with Windows, lives in the taskbar
- **Plugin architecture** — each browser extension registers its own server-side module
- **Auto-update** — watches git repos or filesystem for updates, hot-reloads plugins without restart
- **Capability-based security** — Ed25519 signed code + JWT capability tokens control what each plugin can do
- **Config UI** — browser-based dashboard to manage plugins, permissions, and server settings
- **Client SDK** — `npm install @crmport/sdk` gives extension developers a typed API

## Quick Start

### Install the server

Download the latest `.msi` from [Releases](https://github.com/davwright/CRMPort/releases) and run it. The installer:
1. Prompts for UAC elevation
2. Installs to `Program Files\CRMPort`
3. Registers autostart
4. Starts the server

### Use from a browser extension

```bash
npm install @crmport/sdk
```

```typescript
import { createClient } from '@crmport/sdk';

const crm = createClient({ pluginId: 'my-extension' });
await crm.connect();

// Read a file
const content = await crm.files.read('C:/Projects/config.json');

// Run git
const result = await crm.exec.run('git', ['status'], { cwd: 'C:/Projects' });

// Watch for changes
crm.files.watch('C:/Projects/src/**/*.ts', (event) => {
  console.log(event.type, event.path);
});
```

### Open the config dashboard

Click the tray icon → **Open Config**, or navigate to `http://localhost:7700/config`.

## Architecture

```
Browser Extension          CRMPort Server (localhost:7700)
┌──────────────┐          ┌─────────────────────────────┐
│ @crmport/sdk │◄──WS───►│ Fastify + WS                │
│              │          │ ┌───────────┐ ┌───────────┐ │
│ Cap token    │          │ │ Plugin A  │ │ Plugin B  │ │
│ (JWT)        │          │ │ (worker)  │ │ (worker)  │ │
└──────────────┘          │ └───────────┘ └───────────┘ │
                          │ ┌───────────────────────┐   │
                          │ │ Capability enforcer   │   │
                          │ │ Ed25519 code verifier │   │
                          │ └───────────────────────┘   │
                          └─────────────────────────────┘
```

## Security

- **Code signing** — all plugin JS is Ed25519 signed at build time; server refuses unsigned/tampered code
- **Capability tokens** — each plugin gets a JWT encoding exactly what it can access (paths, executables, network)
- **CORS + origin checking** — only registered extension origins accepted
- **Challenge-response auth** — HMAC nonce prevents replay attacks
- **127.0.0.1 only** — not reachable from the network
- **ACL-protected install** — server binary in Program Files, admin-only write access

## License

MIT
