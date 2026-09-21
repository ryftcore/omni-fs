import type { ProviderDefinition } from '@omni-fs/core';
import { FTP_CAPABILITIES, FtpFileSystem } from './ftp-file-system.js';
import { FTP_SECRET_SCHEMA, FTP_SETTINGS_SCHEMA } from './settings.js';

/**
 * What a host needs from this package: one definition object. Adding FTP
 * support is `registry.register(ftpProvider)`, and it teaches the host nothing
 * about control channels or TLS modes. The re-exports below expose the pieces
 * it is built from, for callers that construct or inspect them directly.
 */
export const ftpProvider: ProviderDefinition = {
  id: 'ftp',
  displayName: 'FTP / FTPS',
  schemes: ['ftp', 'ftps'],
  settingsSchema: FTP_SETTINGS_SCHEMA,
  secretSchema: FTP_SECRET_SCHEMA,
  defaultCapabilities: FTP_CAPABILITIES,
  create: (context) => new FtpFileSystem(context),
};

export { FTP_CAPABILITIES, FtpFileSystem } from './ftp-file-system.js';
export { FTP_SECRET_SCHEMA, FTP_SETTINGS_SCHEMA, readSettings } from './settings.js';
export type { FtpSecureMode, FtpSettings, FtpTlsMinVersion } from './settings.js';
