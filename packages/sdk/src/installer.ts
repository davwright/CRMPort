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
 * Poll for server availability indefinitely until it appears.
 * Fires `onWaiting` once when the first poll fails, so the caller
 * can show a download link or status message.
 */
export async function waitForServer(options?: DetectOptions & { intervalMs?: number; onWaiting?: () => void }): Promise<DetectResult> {
  const interval = options?.intervalMs ?? 2000;
  let waitingFired = false;

  while (true) {
    const result = await detectServer(options);
    if (result.found) return result;

    if (!waitingFired) {
      waitingFired = true;
      options?.onWaiting?.();
    }

    await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * Get the installer download URL for the current platform.
 *
 * When `version` is provided the URL points to a specific GitHub release tag:
 *   `.../download/v{version}/CRMPort-{version}-setup.msi`
 *
 * When `version` is omitted the URL uses the `latest` redirect:
 *   `.../releases/latest/download/CRMPort-latest-setup.msi`
 */
export function getInstallerUrl(options?: {
  platform?: string;
  baseUrl?: string;
  version?: string;
}): string {
  const platform = options?.platform ?? detectPlatform();
  const repo = options?.baseUrl ?? 'https://github.com/davwright/CRMPort/releases';
  const version = options?.version;

  const base = version
    ? `${repo}/download/v${version}`
    : `${repo}/latest/download`;

  const tag = version ?? 'latest';

  switch (platform) {
    case 'win32':
      return `${base}/CRMPort-${tag}-setup.msi`;
    case 'darwin':
      return `${base}/CRMPort-${tag}.pkg`;
    case 'linux':
      return `${base}/CRMPort-${tag}.deb`;
    default:
      return `${base}/CRMPort-${tag}-setup.msi`;
  }
}

/**
 * Ensure CRMPort is reachable. If not, logs the download URL and polls
 * silently until the server appears. Returns the server version.
 *
 * This is the main entry point for browser extension service workers.
 * The extension doesn't need to handle "not found" — this function does it.
 *
 * @param requiredVersion - The CRMPort version this extension was built for.
 *                          Used to build the download URL.
 * @param log - Logging function (defaults to console.log)
 */
export async function ensureServer(
  requiredVersion?: string,
  log: (...args: any[]) => void = console.log,
): Promise<DetectResult> {
  const result = await detectServer();
  if (result.found) return result;

  const url = getInstallerUrl({ version: requiredVersion });
  log(`CRMPort not found — install from: ${url}`);
  log('Waiting for CRMPort to start...');

  return waitForServer({
    intervalMs: 3000,
    onWaiting: () => {},  // already logged above
  });
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
