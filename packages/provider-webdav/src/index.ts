import type { ProviderDefinition } from '@omni-fs/core';
import { WEBDAV_CAPABILITIES, WebdavFileSystem } from './webdav-file-system.js';
import { WEBDAV_SECRET_SCHEMA, WEBDAV_SETTINGS_SCHEMA } from './settings.js';

/**
 * The whole public surface of this package: one definition object. A host adds
 * WebDAV support with `registry.register(webdavProvider)` and learns nothing
 * about HTTP or the `webdav` client in the process.
 */
export const webdavProvider: ProviderDefinition = {
  id: 'webdav',
  displayName: 'WebDAV',
  schemes: ['webdav', 'dav'],
  settingsSchema: WEBDAV_SETTINGS_SCHEMA,
  secretSchema: WEBDAV_SECRET_SCHEMA,
  defaultCapabilities: WEBDAV_CAPABILITIES,
  create: (context) => new WebdavFileSystem(context),
};

export { WEBDAV_CAPABILITIES, WebdavFileSystem } from './webdav-file-system.js';
export { WEBDAV_SECRET_SCHEMA, WEBDAV_SETTINGS_SCHEMA } from './settings.js';
