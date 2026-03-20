import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ServerConfig, PluginRegistration } from './config.js';
import { loadRegistry, saveRegistry } from './config.js';

export class Updater extends EventEmitter {
  private pollTimer: NodeJS.Timeout | null = null;
  private watchers: Map<string, any> = new Map(); // chokidar watchers

  constructor(private config: ServerConfig) {
    super();
  }

  async start(): Promise<void> {
    // Poll git-based sources on interval
    this.pollTimer = setInterval(() => this.checkGitUpdates(), this.config.updateIntervalMs);

    // Set up file watchers for filesystem-based sources
    await this.setupFileWatchers();
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const [, watcher] of this.watchers) {
      await watcher.close();
    }
    this.watchers.clear();
  }

  private async checkGitUpdates(): Promise<void> {
    const registry = loadRegistry();

    for (const reg of registry) {
      if (reg.source?.type !== 'git' || !reg.source.url) continue;

      try {
        const { simpleGit } = await import('simple-git');
        const pluginDir = path.join(this.config.pluginsDir, reg.pluginId);

        if (!fs.existsSync(path.join(pluginDir, '.git'))) continue;

        const git = simpleGit(pluginDir);
        await git.fetch();
        const status = await git.status();

        if (status.behind > 0) {
          this.emit('update:available', reg.pluginId, {
            behind: status.behind,
            source: 'git',
          });

          await git.pull();

          // Check if package.json changed (may need npm install)
          const diff = await git.diff(['HEAD~1', 'HEAD', '--', 'package.json']);
          if (diff) {
            this.emit('update:dependencies', reg.pluginId);
          }

          // Update version in registry
          const manifestPath = path.join(pluginDir, 'plugin.json');
          if (fs.existsSync(manifestPath)) {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            reg.version = manifest.version || reg.version;
            reg.updatedAt = new Date().toISOString();
            saveRegistry(registry);
          }

          this.emit('update:installed', reg.pluginId, reg.version);
        }
      } catch (err: any) {
        this.emit('update:error', reg.pluginId, err.message);
      }
    }
  }

  private async setupFileWatchers(): Promise<void> {
    const registry = loadRegistry();

    for (const reg of registry) {
      if (reg.source?.type !== 'filesystem' || !reg.source.path) continue;
      await this.watchPlugin(reg);
    }
  }

  async watchPlugin(reg: PluginRegistration): Promise<void> {
    if (!reg.source?.path) return;
    if (this.watchers.has(reg.pluginId)) return;

    try {
      const chokidar = await import('chokidar');
      const watcher = chokidar.watch(reg.source.path, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
        ignored: /(node_modules|\.git)/,
      });

      watcher.on('change', (filePath: string) => {
        this.emit('update:fileChanged', reg.pluginId, filePath);
      });

      this.watchers.set(reg.pluginId, watcher);
    } catch (err: any) {
      this.emit('update:error', reg.pluginId, `Failed to watch: ${err.message}`);
    }
  }

  unwatchPlugin(pluginId: string): void {
    const watcher = this.watchers.get(pluginId);
    if (watcher) {
      watcher.close();
      this.watchers.delete(pluginId);
    }
  }

  async checkClientVersion(pluginId: string, clientVersion: string): Promise<boolean> {
    const registry = loadRegistry();
    const reg = registry.find((r) => r.pluginId === pluginId);
    if (!reg) return false;

    try {
      const semver = await import('semver');
      if (semver.gt(clientVersion, reg.version)) {
        this.emit('update:clientNewer', pluginId, { server: reg.version, client: clientVersion });
        return true;
      }
    } catch {
      // semver not available or version not semver
    }

    return false;
  }
}
