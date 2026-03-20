import { parentPort, workerData } from 'node:worker_threads';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface WorkerConfig {
  pluginId: string;
  pluginDir: string;
  entryFile: string;
  capabilities: string[];
  deniedCapabilities: string[];
  limits: {
    max_file_size_bytes: number;
    max_exec_timeout_ms: number;
  };
}

const config: WorkerConfig = workerData;

// Capability check (simplified — main thread does full JWT check,
// worker does path-level enforcement as defense in depth)
function matchGlob(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/\?/g, '[^/\\\\]')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

function checkCap(capability: string, resource?: string): boolean {
  // Check deny
  for (const deny of config.deniedCapabilities) {
    const colonIdx = deny.indexOf(':');
    const denyCap = colonIdx === -1 ? deny : deny.substring(0, colonIdx);
    const denyRes = colonIdx === -1 ? undefined : deny.substring(colonIdx + 1);
    if (denyCap === capability && (!denyRes || !resource || matchGlob(denyRes, resource))) {
      return false;
    }
  }
  // Check allow
  for (const allow of config.capabilities) {
    const colonIdx = allow.indexOf(':');
    const allowCap = colonIdx === -1 ? allow : allow.substring(0, colonIdx);
    const allowRes = colonIdx === -1 ? undefined : allow.substring(colonIdx + 1);
    if (allowCap === capability) {
      if (!allowRes) return true;
      if (resource && matchGlob(allowRes, resource)) return true;
    }
  }
  return false;
}

// Sandboxed API handlers
const handlers: Record<string, (params: any) => Promise<any>> = {
  'fs.read': async (params: { path: string }) => {
    const p = path.resolve(params.path);
    if (!checkCap('fs.read', p)) throw { code: -32001, message: `fs.read denied: ${p}` };
    const content = await fs.promises.readFile(p, 'utf8');
    return { content, encoding: 'utf8' };
  },

  'fs.write': async (params: { path: string; content: string }) => {
    const p = path.resolve(params.path);
    if (!checkCap('fs.write', p)) throw { code: -32001, message: `fs.write denied: ${p}` };
    const buf = Buffer.from(params.content);
    if (buf.length > config.limits.max_file_size_bytes) {
      throw { code: -32006, message: `File exceeds size limit (${config.limits.max_file_size_bytes} bytes)` };
    }
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, params.content, 'utf8');
    return { ok: true };
  },

  'fs.list': async (params: { path: string }) => {
    const p = path.resolve(params.path);
    if (!checkCap('fs.read', p)) throw { code: -32001, message: `fs.read denied: ${p}` };
    const entries = await fs.promises.readdir(p, { withFileTypes: true });
    return {
      entries: entries.map((e) => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
        path: path.join(p, e.name),
      })),
    };
  },

  'exec.run': async (params: { command: string; args?: string[]; cwd?: string }) => {
    const exe = path.basename(params.command).replace(/\.exe$/i, '');
    if (!checkCap('exec', exe)) throw { code: -32001, message: `exec denied: ${exe}` };
    try {
      const { stdout, stderr } = await execFileAsync(params.command, params.args || [], {
        cwd: params.cwd,
        timeout: config.limits.max_exec_timeout_ms,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        windowsHide: true,
      });
      return { stdout, stderr, code: 0 };
    } catch (err: any) {
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || err.message,
        code: err.code ?? 1,
      };
    }
  },

  'clipboard.read': async () => {
    if (!checkCap('clipboard.read')) throw { code: -32001, message: 'clipboard.read denied' };
    // Windows-specific clipboard read via PowerShell
    const { stdout } = await execFileAsync('powershell', ['-Command', 'Get-Clipboard'], {
      timeout: 5000,
      windowsHide: true,
    });
    return { text: stdout.trim() };
  },

  'clipboard.write': async (params: { text: string }) => {
    if (!checkCap('clipboard.write')) throw { code: -32001, message: 'clipboard.write denied' };
    await execFileAsync('powershell', ['-Command', `Set-Clipboard -Value '${params.text.replace(/'/g, "''")}'`], {
      timeout: 5000,
      windowsHide: true,
    });
    return { ok: true };
  },
};

// Load plugin entry file (it can register additional handlers)
try {
  const entryPath = path.join(config.pluginDir, config.entryFile);
  const pluginModule = require(entryPath);
  if (pluginModule && typeof pluginModule.init === 'function') {
    pluginModule.init({
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        handlers[`plugin.${config.pluginId}.${method}`] = handler;
      },
      pluginId: config.pluginId,
      pluginDir: config.pluginDir,
    });
  }
} catch (err: any) {
  parentPort?.postMessage({ type: 'error', error: `Failed to load plugin: ${err.message}` });
}

// Message handler
parentPort?.on('message', async (msg: { id: string; method: string; params: any }) => {
  const handler = handlers[msg.method];
  if (!handler) {
    parentPort?.postMessage({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    return;
  }

  try {
    const result = await handler(msg.params || {});
    parentPort?.postMessage({ id: msg.id, result });
  } catch (err: any) {
    parentPort?.postMessage({
      id: msg.id,
      error: { code: err.code || -32603, message: err.message || 'Internal error' },
    });
  }
});

parentPort?.postMessage({ type: 'ready', pluginId: config.pluginId });
