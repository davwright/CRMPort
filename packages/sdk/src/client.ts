import { Transport } from './transport.js';
import { FileOperations } from './api/files.js';
import { ExecOperations } from './api/exec.js';
import { ClipboardOperations } from './api/clipboard.js';
import { NetOperations } from './api/net.js';
import type {
  ClientOptions,
  ConnectionStatus,
  ServerInfo,
  RegisterOptions,
  RegisterResult,
} from './types.js';

export class CRMPortClient {
  private transport: Transport;
  private options: Required<Pick<ClientOptions, 'pluginId' | 'port' | 'host' | 'timeout'>> & ClientOptions;

  readonly files: FileOperations;
  readonly exec: ExecOperations;
  readonly clipboard: ClipboardOperations;
  readonly net: NetOperations;

  constructor(options: ClientOptions) {
    this.options = {
      port: 7700,
      host: '127.0.0.1',
      timeout: 30_000,
      ...options,
    };
    this.transport = new Transport(this.options.timeout);
    this.files = new FileOperations(this.transport);
    this.exec = new ExecOperations(this.transport);
    this.clipboard = new ClipboardOperations(this.transport);
    this.net = new NetOperations(this.transport);
  }

  async connect(): Promise<void> {
    const url = `ws://${this.options.host}:${this.options.port}/ws`;
    await this.transport.connect(url, this.options.reconnect);

    // Authenticate with capability token
    if (this.options.token) {
      await this.transport.request('auth', {
        token: this.options.token,
        version: this.options.version,
        pluginId: this.options.pluginId,
      });
    }
  }

  disconnect(): void {
    this.transport.disconnect();
  }

  isConnected(): boolean {
    return this.transport.getStatus() === 'connected';
  }

  onStatusChange(callback: (status: ConnectionStatus) => void): () => void {
    return this.transport.onStatusChange(callback);
  }

  onNotification(callback: (method: string, params: any) => void): () => void {
    return this.transport.onNotification(callback);
  }

  async version(): Promise<ServerInfo> {
    return this.transport.request<ServerInfo>('server.version');
  }

  async register(opts: RegisterOptions): Promise<RegisterResult> {
    const url = `http://${this.options.host}:${this.options.port}/api/register`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pluginId: opts.pluginId,
        displayName: opts.displayName,
        version: opts.version,
        extensionIds: opts.extensionIds,
        capabilities: opts.requestedCapabilities,
        source: opts.source,
        publicKeyFingerprint: opts.publicKeyFingerprint,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Registration failed' })) as { error?: string };
      throw new Error(err.error || 'Registration failed');
    }

    return response.json() as Promise<RegisterResult>;
  }
}
