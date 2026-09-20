import { OmniFsError, trimSlashes, trimTrailingSlashes } from '@omni-fs/core';
import type { SettingsSchema } from '@omni-fs/core';

export const WEBDAV_SETTINGS_SCHEMA: SettingsSchema = {
  fields: [
    {
      kind: 'text',
      key: 'baseUrl',
      label: 'Server URL',
      required: true,
      placeholder: 'https://cloud.example.com/remote.php/dav/files/alice',
    },
    {
      kind: 'select',
      key: 'authType',
      label: 'Authentication',
      required: true,
      default: 'password',
      options: [
        { value: 'password', label: 'Username and password' },
        { value: 'token', label: 'Bearer token' },
        { value: 'none', label: 'None (public share)' },
      ],
    },
    { kind: 'text', key: 'username', label: 'Username' },
    {
      kind: 'text',
      key: 'rootPrefix',
      label: 'Root prefix',
      placeholder: 'Documents',
      help: 'Optional. Scopes the connection to a subfolder of the server URL.',
    },
  ],
};

export const WEBDAV_SECRET_SCHEMA: SettingsSchema = {
  fields: [
    { kind: 'password', key: 'password', label: 'Password / app password' },
    { kind: 'password', key: 'token', label: 'Bearer token' },
  ],
};

export type WebdavAuthType = 'password' | 'token' | 'none';

export interface WebdavSettings {
  readonly baseUrl: string;
  readonly authType: WebdavAuthType;
  readonly username: string | undefined;
  /** Path segment treated as the connection root. No leading or trailing slash. */
  readonly rootPrefix: string;
}

const AUTH_TYPES: readonly WebdavAuthType[] = ['password', 'token', 'none'];

export function readSettings(raw: Readonly<Record<string, unknown>>): WebdavSettings {
  const baseUrl = readString(raw, 'baseUrl');
  if (baseUrl === undefined) {
    throw new OmniFsError({
      code: 'ProtocolError',
      message: 'WebDAV connection is missing a server URL.',
      providerId: 'webdav',
    });
  }

  const authType = readString(raw, 'authType') ?? 'password';
  if (!AUTH_TYPES.includes(authType as WebdavAuthType)) {
    throw new OmniFsError({
      code: 'ProtocolError',
      message: `Unknown WebDAV authentication type: ${authType}`,
      providerId: 'webdav',
    });
  }

  return {
    baseUrl: trimTrailingSlashes(baseUrl),
    authType: authType as WebdavAuthType,
    username: readString(raw, 'username'),
    rootPrefix: trimSlashes(readString(raw, 'rootPrefix') ?? ''),
  };
}

function readString(raw: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
