import { S3FileSystem } from './s3-file-system.js';
import { S3_SECRET_SCHEMA, S3_SETTINGS_SCHEMA } from './settings.js';
import type { ProviderDefinition } from '@omni-fs/core';

/**
 * The whole public surface of this package: one definition object. A host adds
 * S3 support with `registry.register(s3Provider)` and learns nothing about the
 * AWS SDK in the process.
 */
export const s3Provider: ProviderDefinition = {
  id: 's3',
  displayName: 'S3 / S3-compatible',
  schemes: ['s3'],
  settingsSchema: S3_SETTINGS_SCHEMA,
  secretSchema: S3_SECRET_SCHEMA,
  defaultCapabilities: {
    canWrite: true,
    canRename: false,
    canCopyServerSide: true,
    canCreateDirectory: false,
    canDeleteRecursive: true,
    canAppend: false,
    canReadRange: true,
    canStreamWrite: true,
    canWatch: false,
    hasRealDirectories: false,
    preservesMTime: false,
    hasVersionTokens: true,
    maxConcurrency: 16,
    listIsPaginated: true,
  },
  create: (context) => new S3FileSystem(context),
};

export { S3FileSystem } from './s3-file-system.js';
export { S3_SECRET_SCHEMA, S3_SETTINGS_SCHEMA } from './settings.js';
export type { S3Settings } from './settings.js';
