import type { ProviderDefinition } from '@omni-fs/core';
import { SFTP_CAPABILITIES, SftpFileSystem } from './sftp-file-system.js';
import { SFTP_SECRET_SCHEMA, SFTP_SETTINGS_SCHEMA } from './settings.js';

/**
 * The whole public surface of this package: one definition object. A host adds
 * SFTP support with `registry.register(sftpProvider)` and learns nothing about
 * SSH or the `ssh2` client in the process.
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
