import type { ConnectionStatus, JsonRpcRequest, JsonRpcResponse, ReconnectOptions } from './types.js';
import { NotConnectedError, errorFromCode } from './errors.js';

type StatusCallback = (status: ConnectionStatus) => void;
type NotificationCallback = (method: string, params: any) => void;

export class Transport {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = 'disconnected';
  private statusCallbacks: StatusCallback[] = [];
  private notificationCallbacks: NotificationCallback[] = [];
  private pendingRequests = new Map<string, {
    resolve: (value: any) => void;
    reject: (error: any) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private retryCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private idCounter = 0;
  private url = '';
  private reconnectOpts: ReconnectOptions = { enabled: false };
  private timeout: number;

  constructor(timeout = 30_000) {
    this.timeout = timeout;
  }

  async connect(url: string, reconnect?: ReconnectOptions): Promise<void> {
    this.url = url;
    this.reconnectOpts = reconnect || { enabled: false };
    return this._connect();
  }

  private _connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.setStatus('connecting');

      try {
        this.ws = new WebSocket(this.url);
      } catch (err) {
        this.setStatus('disconnected');
        reject(err);
        return;
      }

      this.ws.onopen = () => {
        this.retryCount = 0;
        this.setStatus('connected');
        this.startHeartbeat();
        resolve();
      };

      this.ws.onclose = () => {
        this.stopHeartbeat();
        this.rejectAllPending('Connection closed');
        if (this.status !== 'disconnected') {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = (event) => {
        if (this.status === 'connecting') {
          reject(new Error('WebSocket connection failed'));
        }
      };

      this.ws.onmessage = (event) => {
        let msg: JsonRpcResponse;
        try {
          msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
        } catch {
          return;
        }

        // Notification (no id)
        if (!msg.id && msg.method) {
          for (const cb of this.notificationCallbacks) {
            cb(msg.method, msg.params);
          }
          return;
        }

        // Response
        if (msg.id) {
          const pending = this.pendingRequests.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(msg.id);
            if (msg.error) {
              pending.reject(errorFromCode(msg.error.code, msg.error.message, msg.error.data));
            } else {
              pending.resolve(msg.result);
            }
          }
        }
      };
    });
  }

  disconnect(): void {
    this.setStatus('disconnected');
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectAllPending('Disconnected');
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  async request<T = any>(method: string, params?: any): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new NotConnectedError();
    }

    const id = `${++this.idCounter}`;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, this.timeout);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify(msg));
    });
  }

  onStatusChange(cb: StatusCallback): () => void {
    this.statusCallbacks.push(cb);
    return () => {
      this.statusCallbacks = this.statusCallbacks.filter((c) => c !== cb);
    };
  }

  onNotification(cb: NotificationCallback): () => void {
    this.notificationCallbacks.push(cb);
    return () => {
      this.notificationCallbacks = this.notificationCallbacks.filter((c) => c !== cb);
    };
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const cb of this.statusCallbacks) cb(status);
  }

  private scheduleReconnect(): void {
    if (!this.reconnectOpts.enabled) {
      this.setStatus('disconnected');
      return;
    }

    const maxRetries = this.reconnectOpts.maxRetries ?? 10;
    if (this.retryCount >= maxRetries) {
      this.setStatus('disconnected');
      return;
    }

    this.setStatus('reconnecting');
    const initialDelay = this.reconnectOpts.initialDelayMs ?? 1000;
    const delay = this.reconnectOpts.backoff === 'exponential'
      ? Math.min(initialDelay * Math.pow(2, this.retryCount), 30_000)
      : initialDelay * (this.retryCount + 1);

    this.retryCount++;
    this.reconnectTimer = setTimeout(() => {
      this._connect().catch(() => {
        // Will trigger onclose → scheduleReconnect
      });
    }, delay);
  }

  private startHeartbeat(): void {
    // Send ping every 20s to keep MV3 service worker alive
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'ping' }));
      }
    }, 20_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }
}
