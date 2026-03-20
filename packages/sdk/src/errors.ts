export class CRMPortError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly data?: any,
  ) {
    super(message);
    this.name = 'CRMPortError';
  }
}

export class PermissionDeniedError extends CRMPortError {
  constructor(
    public readonly capability: string,
    public readonly resource: string | undefined,
    public readonly allowed: string[] = [],
  ) {
    super(
      `Permission denied: ${capability}${resource ? `:${resource}` : ''}`,
      -32001,
      { capability, resource, allowed },
    );
    this.name = 'PermissionDeniedError';
  }
}

export class NotConnectedError extends CRMPortError {
  constructor() {
    super('Not connected to CRMPort server', -32002);
    this.name = 'NotConnectedError';
  }
}

export class ServerNotFoundError extends CRMPortError {
  constructor(port: number) {
    super(`CRMPort server not found on port ${port}`, -32003);
    this.name = 'ServerNotFoundError';
  }
}

export class TokenExpiredError extends CRMPortError {
  constructor() {
    super('Capability token has expired', -32005);
    this.name = 'TokenExpiredError';
  }
}

export class RateLimitedError extends CRMPortError {
  constructor() {
    super('Rate limited — too many requests per minute', -32006);
    this.name = 'RateLimitedError';
  }
}

export function errorFromCode(code: number, message: string, data?: any): CRMPortError {
  switch (code) {
    case -32001: return new PermissionDeniedError(data?.capability ?? '', data?.resource, data?.allowed);
    case -32002: return new NotConnectedError();
    case -32005: return new TokenExpiredError();
    case -32006: return new RateLimitedError();
    default: return new CRMPortError(message, code, data);
  }
}
