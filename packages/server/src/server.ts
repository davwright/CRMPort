import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

import { loadConfig, saveConfig, loadRegistry, saveRegistry, type PluginRegistration, type ServerConfig } from './config.js';
import { PluginManager } from './plugin-manager.js';
import { Updater } from './updater.js';
import {
  loadPublicKey,
  loadPrivateKey,
  verifyCapabilityToken,
  issueCapabilityToken,
  generateAuthToken,
  getPublicKeyFingerprint,
  type CapabilityClaims,
} from './security.js';
import { CapabilityEnforcer, RateLimiter } from './capability.js';

function resolveAsset(...segments: string[]): string {
  const flat = path.join(__dirname, ...segments);
  if (fs.existsSync(flat)) return flat;
  return path.join(__dirname, '..', ...segments);
}

const pkg = JSON.parse(fs.readFileSync(resolveAsset('package.json'), 'utf8'));
const startTime = Date.now();

export async function createServer() {
  const config = loadConfig();
  const pluginManager = new PluginManager(config);
  const updater = new Updater(config);
  const rateLimiters = new Map<string, RateLimiter>();

  // Load keys
  let capabilityPrivateKey: crypto.KeyObject | null = null;
  let capabilityPublicKey: crypto.KeyObject | null = null;
  let codeSigningPublicKey: crypto.KeyObject | null = null;

  const capPrivPath = path.join(config.keysDir, 'capability.key');
  const capPubPath = path.join(config.keysDir, 'capability.pub');
  const codeSignPubPath = path.join(config.keysDir, 'codesign.pub');

  if (fs.existsSync(capPrivPath) && fs.existsSync(capPubPath)) {
    capabilityPrivateKey = loadPrivateKey(fs.readFileSync(capPrivPath, 'utf8'));
    capabilityPublicKey = loadPublicKey(fs.readFileSync(capPubPath, 'utf8'));
  } else {
    // Auto-generate capability keypair on first run
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    capabilityPrivateKey = privateKey;
    capabilityPublicKey = publicKey;
    fs.writeFileSync(capPrivPath, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    fs.writeFileSync(capPubPath, publicKey.export({ type: 'spki', format: 'pem' }).toString());
  }

  if (fs.existsSync(codeSignPubPath)) {
    codeSigningPublicKey = loadPublicKey(fs.readFileSync(codeSignPubPath, 'utf8'));
    pluginManager.setCodeSigningKey(codeSigningPublicKey);
  }

  // Create Fastify instance
  const app = Fastify({ logger: { level: config.logLevel } });

  // CORS — allow only registered extension origins
  await app.register(fastifyCors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // Allow non-browser requests (curl, etc.)
      if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) {
        return cb(null, true);
      }
      if (origin === `http://127.0.0.1:${config.port}` || origin === `http://localhost:${config.port}`) {
        return cb(null, true); // Allow config UI
      }
      cb(new Error('CORS: origin not allowed'), false);
    },
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Plugin-Id', 'X-Plugin-Version'],
  });

  // Serve config UI
  const configUiPath = resolveAsset('config-ui');
  if (fs.existsSync(configUiPath)) {
    await app.register(fastifyStatic, { root: configUiPath, prefix: '/config/' });
  }

  // WebSocket support
  await app.register(fastifyWebsocket);

  // --- HTTP Routes ---

  app.get('/health', async () => ({
    status: 'ok',
    version: pkg.version,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    plugins: pluginManager.getPluginInfo(),
  }));

  app.get('/api/version', async () => ({
    version: pkg.version,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    fingerprint: capabilityPublicKey ? getPublicKeyFingerprint(capabilityPublicKey) : null,
  }));

  app.get('/api/plugins', async () => ({
    plugins: pluginManager.getPluginInfo(),
    registered: loadRegistry().map((r) => ({
      pluginId: r.pluginId,
      displayName: r.displayName,
      version: r.version,
      capabilities: r.capabilities,
      installedAt: r.installedAt,
      updatedAt: r.updatedAt,
    })),
  }));

  app.post<{ Body: {
    pluginId: string;
    displayName?: string;
    version: string;
    extensionIds?: string[];
    capabilities: string[];
    source?: PluginRegistration['source'];
    publicKeyFingerprint?: string;
  } }>('/api/register', async (req, reply) => {
    const { pluginId, displayName, version, extensionIds, capabilities, source, publicKeyFingerprint } = req.body;

    if (!pluginId || !version || !capabilities) {
      return reply.status(400).send({ error: 'Missing required fields: pluginId, version, capabilities' });
    }

    // Verify fingerprint matches if provided
    if (publicKeyFingerprint && capabilityPublicKey) {
      const serverFp = getPublicKeyFingerprint(capabilityPublicKey);
      if (publicKeyFingerprint !== serverFp) {
        return reply.status(403).send({ error: 'Public key fingerprint mismatch' });
      }
    }

    const authToken = generateAuthToken();
    const now = new Date().toISOString();

    const registration: PluginRegistration = {
      pluginId,
      displayName: displayName || pluginId,
      version,
      extensionIds: extensionIds || [],
      capabilities,
      deniedCapabilities: [],
      source,
      authToken,
      installedAt: now,
      updatedAt: now,
    };

    // Save to registry
    const registry = loadRegistry();
    const existing = registry.findIndex((r) => r.pluginId === pluginId);
    if (existing >= 0) {
      registration.installedAt = registry[existing].installedAt;
      registry[existing] = registration;
    } else {
      registry.push(registration);
    }
    saveRegistry(registry);

    // Create plugin directory
    const pluginDir = path.join(config.pluginsDir, pluginId);
    fs.mkdirSync(pluginDir, { recursive: true });

    // Issue capability token
    let capToken: string | null = null;
    if (capabilityPrivateKey) {
      const claims: CapabilityClaims = {
        sub: pluginId,
        iss: 'crmport',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60, // 90 days
        cap: {
          allow: capabilities,
          deny: [],
        },
        limits: {
          max_requests_per_minute: 120,
          max_file_size_bytes: 10 * 1024 * 1024,
          max_exec_timeout_ms: 30_000,
        },
      };
      capToken = issueCapabilityToken(claims, capabilityPrivateKey);
    }

    return {
      ok: true,
      pluginId,
      authToken,
      capabilityToken: capToken,
      fingerprint: capabilityPublicKey ? getPublicKeyFingerprint(capabilityPublicKey) : null,
    };
  });

  app.delete<{ Params: { pluginId: string } }>('/api/plugins/:pluginId', async (req, reply) => {
    const { pluginId } = req.params;
    const auth = req.headers.authorization;
    if (!auth) return reply.status(401).send({ error: 'Authorization required' });

    const registry = loadRegistry();
    const reg = registry.find((r) => r.pluginId === pluginId);
    if (!reg) return reply.status(404).send({ error: 'Plugin not found' });
    if (`Bearer ${reg.authToken}` !== auth) return reply.status(403).send({ error: 'Invalid token' });

    await pluginManager.unloadPlugin(pluginId);
    updater.unwatchPlugin(pluginId);

    const newRegistry = registry.filter((r) => r.pluginId !== pluginId);
    saveRegistry(newRegistry);

    return { ok: true };
  });

  // Deploy plugin files and (re)load
  app.post<{ Body: {
    pluginId: string;
    files: Record<string, string>; // { "plugin.json": "...", "index.js": "..." }
  } }>('/api/deploy-plugin', async (req, reply) => {
    const { pluginId, files } = req.body;
    if (!pluginId || !files || typeof files !== 'object') {
      return reply.status(400).send({ error: 'Missing pluginId or files' });
    }

    // Verify plugin is registered
    const registry = loadRegistry();
    const reg = registry.find((r) => r.pluginId === pluginId);
    if (!reg) {
      return reply.status(404).send({ error: `Plugin ${pluginId} not registered — call /api/register first` });
    }

    // Write files to plugin directory
    const pluginDir = path.join(config.pluginsDir, pluginId);
    fs.mkdirSync(pluginDir, { recursive: true });

    for (const [filename, content] of Object.entries(files)) {
      // Sanitize filename — no path traversal
      const safe = path.basename(filename);
      fs.writeFileSync(path.join(pluginDir, safe), content, 'utf8');
    }

    // (Re)load the plugin
    await pluginManager.loadPlugin(reg);
    app.log.info(`Deployed and loaded plugin: ${pluginId}`);
    broadcastLog('info', `Plugin deployed: ${pluginId}`);

    return { ok: true, pluginId, files: Object.keys(files) };
  });

  app.get('/api/config', async () => config);

  app.post<{ Body: Partial<ServerConfig> }>('/api/config', async (req) => {
    const updates = req.body;
    const newConfig = { ...config, ...updates };
    saveConfig(newConfig);
    return { ok: true, config: newConfig };
  });

  // --- Log streaming for config UI ---

  const logSubscribers = new Set<import('ws').WebSocket>();

  // Hook into Fastify's pino logger to broadcast log lines
  const origWrite = (app.log as any)[Symbol.for('pino.logWrite')] || null;
  app.addHook('onResponse', (request, reply, done) => {
    if (logSubscribers.size > 0) {
      const line = JSON.stringify({
        time: Date.now(),
        level: 'info',
        method: request.method,
        url: request.url,
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
      });
      for (const ws of logSubscribers) {
        if (ws.readyState === 1) ws.send(line);
      }
    }
    done();
  });

  // Broadcast arbitrary log messages
  function broadcastLog(level: string, msg: string) {
    if (logSubscribers.size === 0) return;
    const line = JSON.stringify({ time: Date.now(), level, msg });
    for (const ws of logSubscribers) {
      if (ws.readyState === 1) ws.send(line);
    }
  }

  app.register(async function (logWsApp) {
    logWsApp.get('/ws/logs', { websocket: true }, (socket) => {
      logSubscribers.add(socket);
      socket.send(JSON.stringify({ time: Date.now(), level: 'info', msg: `Connected — CRMPort v${pkg.version}` }));
      socket.on('close', () => logSubscribers.delete(socket));
    });
  });

  // --- WebSocket Route (JSON-RPC 2.0) ---

  app.register(async function (wsApp) {
    wsApp.get('/ws', { websocket: true }, (socket, req) => {
      let enforcer: CapabilityEnforcer | null = null;
      let pluginId: string | null = null;
      let rateLimiter: RateLimiter | null = null;

      socket.on('message', async (raw: Buffer) => {
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          socket.send(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }));
          return;
        }

        const { id, method, params } = msg;

        // First message must be auth
        if (!enforcer) {
          if (method !== 'auth') {
            socket.send(JSON.stringify({
              jsonrpc: '2.0', id,
              error: { code: -32001, message: 'First message must be auth' },
            }));
            return;
          }

          const token = params?.token;
          if (!token || !capabilityPublicKey) {
            socket.send(JSON.stringify({
              jsonrpc: '2.0', id,
              error: { code: -32001, message: 'Invalid token' },
            }));
            return;
          }

          const claims = verifyCapabilityToken(token, capabilityPublicKey);
          if (!claims) {
            socket.send(JSON.stringify({
              jsonrpc: '2.0', id,
              error: { code: -32005, message: 'Token expired or invalid' },
            }));
            return;
          }

          enforcer = new CapabilityEnforcer(claims);
          pluginId = claims.sub;
          rateLimiter = new RateLimiter(claims.limits.max_requests_per_minute);
          rateLimiters.set(pluginId, rateLimiter);

          // Check for version negotiation
          if (params?.version) {
            updater.checkClientVersion(pluginId, params.version);
          }

          broadcastLog('info', `Plugin authenticated: ${pluginId} v${params?.version || '?'}`);
          socket.send(JSON.stringify({
            jsonrpc: '2.0', id,
            result: {
              ok: true,
              serverVersion: pkg.version,
              pluginId,
              capabilities: enforcer.allowedCapabilities,
            },
          }));
          return;
        }

        // Rate limit
        if (rateLimiter && !rateLimiter.check()) {
          socket.send(JSON.stringify({
            jsonrpc: '2.0', id,
            error: { code: -32006, message: 'Rate limited' },
          }));
          return;
        }

        // server.version — no capability needed
        if (method === 'server.version') {
          socket.send(JSON.stringify({
            jsonrpc: '2.0', id,
            result: {
              version: pkg.version,
              uptime: Math.floor((Date.now() - startTime) / 1000),
              plugins: pluginManager.getPluginInfo(),
            },
          }));
          return;
        }

        // Capability check
        const [capNs] = method.split('.');
        const capKey = `${capNs}.${method.split('.')[1]}`;
        const resource = params?.path || params?.command;

        try {
          enforcer.require(capKey, resource);
        } catch (err: any) {
          socket.send(JSON.stringify({
            jsonrpc: '2.0', id,
            error: { code: err.code || -32001, message: err.message, data: { capability: capKey, resource } },
          }));
          return;
        }

        // Route to plugin worker if loaded, otherwise handle built-in methods
        if (pluginId && pluginManager.isPluginLoaded(pluginId)) {
          try {
            const result = await pluginManager.sendRequest(pluginId, method, params);
            socket.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
          } catch (err: any) {
            socket.send(JSON.stringify({
              jsonrpc: '2.0', id,
              error: { code: err.code || -32603, message: err.message },
            }));
          }
        } else {
          // Built-in method handling for plugins without a server-side worker
          try {
            const result = await handleBuiltinMethod(method, params, enforcer);
            socket.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
          } catch (err: any) {
            socket.send(JSON.stringify({
              jsonrpc: '2.0', id,
              error: { code: err.code || -32603, message: err.message },
            }));
          }
        }
      });

      socket.on('close', () => {
        if (pluginId) rateLimiters.delete(pluginId);
      });
    });
  });

  // Built-in method handlers (no plugin worker needed)
  async function handleBuiltinMethod(method: string, params: any, enforcer: CapabilityEnforcer): Promise<any> {
    switch (method) {
      case 'fs.read': {
        const p = path.resolve(params.path);
        enforcer.require('fs.read', p);
        const content = await fs.promises.readFile(p, 'utf8');
        return { content, encoding: 'utf8' };
      }
      case 'fs.write': {
        const p = path.resolve(params.path);
        enforcer.require('fs.write', p);
        await fs.promises.mkdir(path.dirname(p), { recursive: true });
        await fs.promises.writeFile(p, params.content, 'utf8');
        return { ok: true };
      }
      case 'fs.list': {
        const p = path.resolve(params.path);
        enforcer.require('fs.read', p);
        const entries = await fs.promises.readdir(p, { withFileTypes: true });
        return {
          entries: entries.map((e) => ({
            name: e.name,
            type: e.isDirectory() ? 'directory' : 'file',
            path: path.join(p, e.name),
          })),
        };
      }
      case 'exec.run': {
        const exe = path.basename(params.command).replace(/\.exe$/i, '');
        enforcer.require('exec', exe);
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        try {
          const { stdout, stderr } = await execFileAsync(params.command, params.args || [], {
            cwd: params.cwd,
            timeout: enforcer.limits.max_exec_timeout_ms,
            maxBuffer: 10 * 1024 * 1024,
            windowsHide: true,
          });
          return { stdout, stderr, code: 0 };
        } catch (err: any) {
          return { stdout: err.stdout || '', stderr: err.stderr || err.message, code: err.code ?? 1 };
        }
      }
      case 'clipboard.read': {
        enforcer.require('clipboard.read');
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        const { stdout } = await execFileAsync('powershell', ['-Command', 'Get-Clipboard'], {
          timeout: 5000, windowsHide: true,
        });
        return { text: stdout.trim() };
      }
      case 'clipboard.write': {
        enforcer.require('clipboard.write');
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        const escaped = params.text.replace(/'/g, "''");
        await execFileAsync('powershell', ['-Command', `Set-Clipboard -Value '${escaped}'`], {
          timeout: 5000, windowsHide: true,
        });
        return { ok: true };
      }
      default:
        throw { code: -32601, message: `Method not found: ${method}` };
    }
  }

  // --- Startup ---

  // Load registered plugins
  const registry = loadRegistry();
  for (const reg of registry) {
    const pluginDir = path.join(config.pluginsDir, reg.pluginId);
    if (fs.existsSync(path.join(pluginDir, 'plugin.json'))) {
      try {
        await pluginManager.loadPlugin(reg);
        app.log.info(`Loaded plugin: ${reg.pluginId} v${reg.version}`);
      } catch (err: any) {
        app.log.error(`Failed to load plugin ${reg.pluginId}: ${err.message}`);
      }
    }
  }

  // Start updater
  await updater.start();
  updater.on('update:installed', async (pluginId: string, version: string) => {
    const reg = loadRegistry().find((r) => r.pluginId === pluginId);
    if (reg) {
      try {
        await pluginManager.reloadPlugin(reg);
        app.log.info(`Hot-reloaded plugin: ${pluginId} v${version}`);
        broadcastLog('info', `Hot-reloaded plugin: ${pluginId} v${version}`);
      } catch (err: any) {
        app.log.error(`Failed to reload plugin ${pluginId}: ${err.message}`);
      }
    }
  });
  // Self-update: when a client connects with a newer SDK version, tell the supervisor
  updater.on('update:clientNewer', (pluginId: string, versions: { server: string; client: string }) => {
    app.log.info(`Client ${pluginId} has newer SDK v${versions.client} (server is v${versions.server})`);
    const platform = process.platform === 'win32' ? 'exe' : process.platform === 'darwin' ? 'macos' : 'linux';
    const url = `https://github.com/davwright/CRMPort/releases/download/v${versions.client}/crmport-${platform}`;
    if (process.send) {
      process.send({ type: 'self-update', version: versions.client, url });
    }
  });

  updater.on('update:fileChanged', async (pluginId: string) => {
    const reg = loadRegistry().find((r) => r.pluginId === pluginId);
    if (reg) {
      try {
        await pluginManager.reloadPlugin(reg);
        app.log.info(`Hot-reloaded plugin (file change): ${pluginId}`);
      } catch (err: any) {
        app.log.error(`Failed to reload plugin ${pluginId}: ${err.message}`);
      }
    }
  });

  // Graceful shutdown
  const shutdown = async () => {
    app.log.info('Shutting down...');
    await updater.stop();
    await pluginManager.shutdownAll();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('message', (msg) => {
    if (msg === 'shutdown') shutdown();
  });

  // Start listening
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`CRMPort server v${pkg.version} listening on ${config.host}:${config.port}`);
  broadcastLog('info', `Server v${pkg.version} listening on ${config.host}:${config.port}`);

  // Notify parent process (supervisor)
  if (process.send) {
    process.send({ type: 'started', port: config.port });
  }

  return app;
}

// Run if invoked directly
if (require.main === module) {
  createServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
