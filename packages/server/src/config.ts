import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface ServerConfig {
  port: number;
  host: string;
  updateIntervalMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  autostart: boolean;
  pluginsDir: string;
  keysDir: string;
  dataDir: string;
}

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.crmport');

const DEFAULTS: ServerConfig = {
  port: 7700,
  host: '127.0.0.1',
  updateIntervalMs: 60_000,
  logLevel: 'info',
  autostart: true,
  pluginsDir: path.join(DEFAULT_DATA_DIR, 'plugins'),
  keysDir: path.join(DEFAULT_DATA_DIR, 'keys'),
  dataDir: DEFAULT_DATA_DIR,
};

export function getConfigPath(): string {
  return path.join(DEFAULT_DATA_DIR, 'config.json');
}

export function loadConfig(): ServerConfig {
  const configPath = getConfigPath();
  let userConfig: Partial<ServerConfig> = {};

  if (fs.existsSync(configPath)) {
    try {
      userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      // Ignore parse errors, use defaults
    }
  }

  const config = { ...DEFAULTS, ...userConfig };

  // Ensure directories exist
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.pluginsDir, { recursive: true });
  fs.mkdirSync(config.keysDir, { recursive: true });

  return config;
}

export function saveConfig(config: ServerConfig): void {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

// Plugin registry persisted to disk
export interface PluginRegistration {
  pluginId: string;
  displayName: string;
  version: string;
  extensionIds: string[];
  capabilities: string[];
  deniedCapabilities: string[];
  source?: {
    type: 'git' | 'filesystem';
    url?: string;
    path?: string;
    branch?: string;
  };
  authToken: string;
  installedAt: string;
  updatedAt: string;
}

export function getRegistryPath(): string {
  return path.join(DEFAULT_DATA_DIR, 'registry.json');
}

export function loadRegistry(): PluginRegistration[] {
  const regPath = getRegistryPath();
  if (!fs.existsSync(regPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(regPath, 'utf8'));
  } catch {
    return [];
  }
}

export function saveRegistry(registry: PluginRegistration[]): void {
  const regPath = getRegistryPath();
  fs.mkdirSync(path.dirname(regPath), { recursive: true });
  fs.writeFileSync(regPath, JSON.stringify(registry, null, 2), 'utf8');
}
