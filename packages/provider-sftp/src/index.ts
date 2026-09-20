import type { ProviderDefinition } from '@omni-fs/core';
import { SFTP_CAPABILITIES, SftpFileSystem } from './sftp-file-system.js';
import { SFTP_SECRET_SCHEMA, SFTP_SETTINGS_SCHEMA } from './settings.js';

/**
 * What a host needs from this package: one definition object. Adding SFTP
 * support is `registry.register(sftpProvider)`, and it teaches the host nothing
 * about SSH or the `ssh2` client. The re-exports below expose the pieces it is
 * built from, for callers that construct or inspect them directly.
 */
export const sftpProvider: ProviderDefinition = {
  id: 'sftp',
  displayName: 'SFTP (SSH)',
  schemes: ['sftp'],
  settingsSchema: SFTP_SETTINGS_SCHEMA,
  secretSchema: SFTP_SECRET_SCHEMA,
  defaultCapabilities: SFTP_CAPABILITIES,
  create: (context) => new SftpFileSystem(context),
};

export { SFTP_CAPABILITIES, SftpFileSystem } from './sftp-file-system.js';
export { SFTP_SECRET_SCHEMA, SFTP_SETTINGS_SCHEMA, readSettings } from './settings.js';
export type { SftpAuthMethod, SftpSettings } from './settings.js';
