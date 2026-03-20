export { CRMPortClient } from './client.js';
export type {
  ClientOptions,
  ConnectionStatus,
  ReconnectOptions,
  ServerInfo,
  PluginInfo,
  FileContent,
  FileEntry,
  FileEvent,
  ExecResult,
  ExecStreamHandle,
  RegisterOptions,
  RegisterResult,
  Disposable,
} from './types.js';
export {
  CRMPortError,
  PermissionDeniedError,
  NotConnectedError,
  ServerNotFoundError,
  TokenExpiredError,
  RateLimitedError,
} from './errors.js';

import { CRMPortClient } from './client.js';
import type { ClientOptions } from './types.js';

/**
 * Create a CRMPort client.
 *
 * @example
 * ```ts
 * import { createClient } from '@crmport/sdk';
 *
 * const crm = createClient({ pluginId: 'my-extension', token: '...' });
 * await crm.connect();
 * const content = await crm.files.read('C:/Projects/config.json');
 * ```
 */
export function createClient(options: ClientOptions): CRMPortClient {
  return new CRMPortClient(options);
}
