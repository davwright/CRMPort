export interface DetectResult {
  found: boolean;
  version?: string;
  fingerprint?: string;
}

export interface DetectOptions {
  port?: number;
  host?: string;
  timeout?: number;
}

/**
 * Probe localhost for a running CRMPort server.
 */
export async function detectServer(options?: DetectOptions): Promise<DetectResult> {
  const port = options?.port ?? 7700;
  const host = options?.host ?? '127.0.0.1';
  const timeout = options?.timeout ?? 2000;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(`http://${host}:${port}/health`, {
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) return { found: false };

    const data = await response.json() as { version?: string };
    return {
      found: true,
      version: data.version,
    };
  } catch {
    return { found: false };
  }
}

/**
 * Poll for server availability with retries.
 */
export async function waitForServer(options?: DetectOptions & { maxRetries?: number; intervalMs?: number }): Promise<DetectResult> {
  const maxRetries = options?.maxRetries ?? 30;
  const interval = options?.intervalMs ?? 2000;

  for (let i = 0; i < maxRetries; i++) {
    const result = await detectServer(options);
    if (result.found) return result;
    await new Promise((r) => setTimeout(r, interval));
  }

  return { found: false };
}

/**
 * Get the installer download URL for the current platform.
 */
export function getInstallerUrl(options?: {
  platform?: string;
  baseUrl?: string;
  version?: string;
}): string {
  const platform = options?.platform ?? detectPlatform();
  const base = options?.baseUrl ?? 'https://github.com/davwright/CRMPort/releases/latest/download';
  const version = options?.version ?? 'latest';

  switch (platform) {
    case 'win32':
      return `${base}/CRMPort-setup-${version}.msi`;
    case 'darwin':
      return `${base}/CRMPort-${version}.pkg`;
    case 'linux':
      return `${base}/CRMPort-${version}.deb`;
    default:
      return `${base}/CRMPort-setup-${version}.msi`;
  }
}

function detectPlatform(): string {
  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('win')) return 'win32';
    if (ua.includes('mac')) return 'darwin';
    if (ua.includes('linux')) return 'linux';
  }
  return 'win32';
}
