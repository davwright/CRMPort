export interface ClientOptions {
  /** Plugin identifier */
  pluginId: string;
  /** Capability token from registration */
  token?: string;
  /** Server port (default: 7700) */
  port?: number;
  /** Server host (default: 127.0.0.1) */
  host?: string;
  /** Plugin version (sent during auth for version negotiation) */
  version?: string;
  /** Auto-reconnect settings */
  reconnect?: ReconnectOptions;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
}

export interface ReconnectOptions {
  enabled: boolean;
  backoff?: 'linear' | 'exponential';
  maxRetries?: number;
  initialDelayMs?: number;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface ServerInfo {
  version: string;
  uptime: number;
  plugins: PluginInfo[];
}

export interface PluginInfo {
  pluginId: string;
  version: string;
  displayName: string;
  status: 'running' | 'stopped' | 'error';
}

export interface FileContent {
  content: string;
  encoding: string;
}

export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  path: string;
}

export interface FileEvent {
  watchId: string;
  type: 'change' | 'add' | 'unlink';
  path: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ExecStreamHandle {
  onStdout(cb: (chunk: string) => void): void;
  onStderr(cb: (chunk: string) => void): void;
  done: Promise<{ code: number }>;
  kill(): void;
}

export interface RegisterOptions {
  pluginId: string;
  version: string;
  displayName?: string;
  extensionIds?: string[];
  requestedCapabilities: string[];
  source?: {
    type: 'git' | 'filesystem';
    url?: string;
    path?: string;
    branch?: string;
  };
  publicKeyFingerprint?: string;
}

export interface RegisterResult {
  ok: boolean;
  pluginId: string;
  authToken: string;
  capabilityToken: string | null;
  fingerprint: string | null;
}

export interface Disposable {
  dispose(): void;
}

// JSON-RPC types
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: any;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string;
  result?: any;
  error?: JsonRpcError;
  method?: string; // for notifications
  params?: any;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: any;
}
