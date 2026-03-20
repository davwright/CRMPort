import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { verifyFile } from './security.js';
import type { ServerConfig, PluginRegistration } from './config.js';
import type * as crypto from 'node:crypto';

export interface PluginInfo {
  pluginId: string;
  version: string;
  displayName: string;
  status: 'running' | 'stopped' | 'error';
  error?: string;
}

interface PluginManifest {
  name: string;
  version: string;
  displayName?: string;
  description?: string;
  entry?: string;
  capabilities?: string[];
  source?: {
    type: 'git' | 'filesystem';
    url?: string;
    path?: string;
    branch?: string;
  };
  extensionIds?: string[];
}

interface ActivePlugin {
  worker: Worker;
  manifest: PluginManifest;
  registration: PluginRegistration;
  pendingRequests: Map<string, { resolve: (v: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout }>;
}

export class PluginManager extends EventEmitter {
  private plugins = new Map<string, ActivePlugin>();
  private codeSigningKey: crypto.KeyObject | null = null;

  constructor(private config: ServerConfig) {
    super();
  }

  setCodeSigningKey(key: crypto.KeyObject): void {
    this.codeSigningKey = key;
  }

  async loadPlugin(registration: PluginRegistration): Promise<void> {
    const pluginDir = path.join(this.config.pluginsDir, registration.pluginId);
    const manifestPath = path.join(pluginDir, 'plugin.json');

    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Plugin manifest not found: ${manifestPath}`);
    }

    const manifest: PluginManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const entryFile = manifest.entry || 'index.js';
    const entryPath = path.join(pluginDir, entryFile);

    if (!fs.existsSync(entryPath)) {
      throw new Error(`Plugin entry not found: ${entryPath}`);
    }

    // Verify code signature if we have a signing key
    if (this.codeSigningKey) {
      if (!verifyFile(entryPath, this.codeSigningKey)) {
        throw new Error(`Signature verification failed for plugin: ${registration.pluginId}`);
      }
    }

    // Terminate existing worker if reloading
    if (this.plugins.has(registration.pluginId)) {
      await this.unloadPlugin(registration.pluginId);
    }

    const workerPath = path.join(__dirname, 'plugin-worker.js');
    const worker = new Worker(workerPath, {
      workerData: {
        pluginId: registration.pluginId,
        pluginDir,
        entryFile,
        capabilities: registration.capabilities,
        deniedCapabilities: registration.deniedCapabilities,
        limits: {
          max_file_size_bytes: 10 * 1024 * 1024, // 10MB
          max_exec_timeout_ms: 30_000,
        },
      },
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
        codeRangeSizeMb: 16,
        stackSizeMb: 4,
      },
    });

    const plugin: ActivePlugin = {
      worker,
      manifest,
      registration,
      pendingRequests: new Map(),
    };

    worker.on('message', (msg: any) => {
      if (msg.type === 'ready') {
        this.emit('plugin:ready', registration.pluginId);
        return;
      }
      if (msg.type === 'error') {
        this.emit('plugin:error', registration.pluginId, msg.error);
        return;
      }
      // JSON-RPC response
      if (msg.id) {
        const pending = plugin.pendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          plugin.pendingRequests.delete(msg.id);
          if (msg.error) pending.reject(msg.error);
          else pending.resolve(msg.result);
        }
      }
    });

    worker.on('error', (err) => {
      this.emit('plugin:error', registration.pluginId, err.message);
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        this.emit('plugin:crashed', registration.pluginId, code);
      }
      this.plugins.delete(registration.pluginId);
    });

    this.plugins.set(registration.pluginId, plugin);
  }

  async unloadPlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return;

    // Reject all pending requests
    for (const [, pending] of plugin.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject({ code: -32603, message: 'Plugin unloaded' });
    }
    plugin.pendingRequests.clear();

    await plugin.worker.terminate();
    this.plugins.delete(pluginId);
    this.emit('plugin:unloaded', pluginId);
  }

  async reloadPlugin(registration: PluginRegistration): Promise<void> {
    const oldVersion = this.plugins.get(registration.pluginId)?.manifest.version;
    await this.loadPlugin(registration);
    this.emit('plugin:reloaded', registration.pluginId, oldVersion, registration.version);
  }

  async sendRequest(pluginId: string, method: string, params: any, timeoutMs = 30_000): Promise<any> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) throw { code: -32603, message: `Plugin not loaded: ${pluginId}` };

    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        plugin.pendingRequests.delete(id);
        reject({ code: -32603, message: `Request timeout: ${method}` });
      }, timeoutMs);

      plugin.pendingRequests.set(id, { resolve, reject, timer });
      plugin.worker.postMessage({ id, method, params });
    });
  }

  getPluginInfo(): PluginInfo[] {
    const infos: PluginInfo[] = [];
    for (const [id, plugin] of this.plugins) {
      infos.push({
        pluginId: id,
        version: plugin.manifest.version || plugin.registration.version,
        displayName: plugin.manifest.displayName || id,
        status: 'running',
      });
    }
    return infos;
  }

  isPluginLoaded(pluginId: string): boolean {
    return this.plugins.has(pluginId);
  }

  getLoadedPluginIds(): string[] {
    return [...this.plugins.keys()];
  }

  async shutdownAll(): Promise<void> {
    const ids = [...this.plugins.keys()];
    await Promise.all(ids.map((id) => this.unloadPlugin(id)));
  }
}
