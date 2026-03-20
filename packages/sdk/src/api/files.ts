import type { Transport } from '../transport.js';
import type { FileContent, FileEntry, FileEvent, Disposable } from '../types.js';

export class FileOperations {
  constructor(private transport: Transport) {}

  async read(path: string): Promise<FileContent> {
    return this.transport.request<FileContent>('fs.read', { path });
  }

  async write(path: string, content: string): Promise<void> {
    await this.transport.request('fs.write', { path, content });
  }

  async list(path: string): Promise<FileEntry[]> {
    const result = await this.transport.request<{ entries: FileEntry[] }>('fs.list', { path });
    return result.entries;
  }

  watch(path: string, callback: (event: FileEvent) => void): Disposable {
    // Subscribe via JSON-RPC
    let watchId: string | null = null;

    const unsub = this.transport.onNotification((method, params) => {
      if (method === 'fs.watch.event' && params.watchId === watchId) {
        callback(params as FileEvent);
      }
    });

    // Initiate watch
    this.transport.request<{ watchId: string }>('fs.watch', { path })
      .then((result) => { watchId = result.watchId; })
      .catch(() => { /* watch failed silently */ });

    return {
      dispose: () => {
        unsub();
        if (watchId) {
          this.transport.request('fs.unwatch', { watchId }).catch(() => {});
        }
      },
    };
  }
}
