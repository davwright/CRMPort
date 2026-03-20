import type { Transport } from '../transport.js';

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface FetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export class NetOperations {
  constructor(private transport: Transport) {}

  async fetch(url: string, options?: FetchOptions): Promise<FetchResult> {
    return this.transport.request<FetchResult>('net.fetch', {
      url,
      method: options?.method || 'GET',
      headers: options?.headers,
      body: options?.body,
    });
  }
}
