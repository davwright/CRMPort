import { CapabilityClaims, checkCapability } from './security.js';

export class CapabilityEnforcer {
  constructor(private claims: CapabilityClaims) {}

  get pluginId(): string {
    return this.claims.sub;
  }

  get limits() {
    return this.claims.limits;
  }

  check(capability: string, resource?: string): boolean {
    return checkCapability(this.claims, capability, resource);
  }

  require(capability: string, resource?: string): void {
    if (!this.check(capability, resource)) {
      throw new PermissionDeniedError(capability, resource, this.claims.cap.allow);
    }
  }

  get allowedCapabilities(): string[] {
    return [...this.claims.cap.allow];
  }

  get deniedPatterns(): string[] {
    return [...this.claims.cap.deny];
  }

  isExpired(): boolean {
    return this.claims.exp < Date.now() / 1000;
  }
}

export class PermissionDeniedError extends Error {
  readonly code = -32001;

  constructor(
    public readonly capability: string,
    public readonly resource: string | undefined,
    public readonly allowed: string[],
  ) {
    super(`Permission denied: ${capability}${resource ? `:${resource}` : ''}`);
    this.name = 'PermissionDeniedError';
  }
}

// Rate limiter per plugin
export class RateLimiter {
  private timestamps: number[] = [];

  constructor(private maxPerMinute: number) {}

  check(): boolean {
    const now = Date.now();
    const windowStart = now - 60_000;
    this.timestamps = this.timestamps.filter((t) => t > windowStart);
    if (this.timestamps.length >= this.maxPerMinute) return false;
    this.timestamps.push(now);
    return true;
  }

  reset(): void {
    this.timestamps = [];
  }
}
