import type { Transport } from '../transport.js';
import type { ExecResult, ExecStreamHandle } from '../types.js';

export interface ExecOptions {
  cwd?: string;
  timeout?: number;
}

export class ExecOperations {
  constructor(private transport: Transport) {}

  async run(command: string, args: string[] = [], options?: ExecOptions): Promise<ExecResult> {
    return this.transport.request<ExecResult>('exec.run', {
      command,
      args,
      cwd: options?.cwd,
    });
  }

  stream(command: string, args: string[] = [], options?: ExecOptions): ExecStreamHandle {
    let stdoutCb: ((chunk: string) => void) | null = null;
    let stderrCb: ((chunk: string) => void) | null = null;
    let streamId: string | null = null;
    let resolveExit: ((result: { code: number }) => void) | null = null;

    const done = new Promise<{ code: number }>((resolve) => {
      resolveExit = resolve;
    });

    // Listen for stream events
    const unsub = this.transport.onNotification((method, params) => {
      if (!streamId || params.streamId !== streamId) return;
      if (method === 'exec.stream.data') {
        if (params.fd === 1 && stdoutCb) stdoutCb(params.chunk);
        if (params.fd === 2 && stderrCb) stderrCb(params.chunk);
      }
      if (method === 'exec.stream.exit') {
        resolveExit?.({ code: params.code });
        unsub();
      }
    });

    // Start stream
    this.transport.request<{ streamId: string }>('exec.stream', {
      command,
      args,
      cwd: options?.cwd,
    }).then((result) => {
      streamId = result.streamId;
    }).catch(() => {
      resolveExit?.({ code: -1 });
      unsub();
    });

    return {
      onStdout(cb) { stdoutCb = cb; },
      onStderr(cb) { stderrCb = cb; },
      done,
      kill() {
        if (streamId) {
          // Fire and forget
          void done; // already awaiting
        }
      },
    };
  }
}
