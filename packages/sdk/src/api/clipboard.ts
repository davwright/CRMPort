import type { Transport } from '../transport.js';

export class ClipboardOperations {
  constructor(private transport: Transport) {}

  async read(): Promise<string> {
    const result = await this.transport.request<{ text: string }>('clipboard.read');
    return result.text;
  }

  async write(text: string): Promise<void> {
    await this.transport.request('clipboard.write', { text });
  }
}
