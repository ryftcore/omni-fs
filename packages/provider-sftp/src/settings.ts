import { OmniFsError, trimLeadingSlashes, trimTrailingSlashes } from '@omni-fs/core';
import type { SettingsSchema } from '@omni-fs/core';

export const SFTP_SETTINGS_SCHEMA: SettingsSchema = {
  fields: [
    { kind: 'text', key: 'host', label: 'Host', required: true, placeholder: 'sftp.example.com' },
    { kind: 'number', key: 'port', label: 'Port', default: 22, min: 1, max: 65535 },
    { kind: 'text', key: 'username', label: 'Username', required: true },
    {
      kind: 'select',
      key: 'authMethod',
      label: 'Authentication',
      required: true,
      default: 'password',
      options: [
        { value: 'password', label: 'Password' },
        { value: 'privateKey', label: 'Private key' },
        { value: 'agent', label: 'SSH agent' },
      ],
    },
    {
      kind: 'file',
      key: 'privateKeyPath',
      label: 'Private key file',
      help: 'Used when authentication is set to Private key. e.g. ~/.ssh/id_ed25519',
    },
    {
      kind: 'file',
      key: 'knownHostsPath',
      label: 'known_hosts file',
      help: 'Optional. Defaults to ~/.ssh/known_hosts. A host listed there with a different key of the same type is refused.',
    },
    {
      kind: 'text',
      key: 'rootPrefix',
      label: 'Root prefix',
      placeholder: '/var/www',
      help: 'Optional. Scopes the connection to a subfolder of the login directory. Begin with / for an absolute server path, e.g. /var/www.',
    },
  ],
};

export const SFTP_SECRET_SCHEMA: SettingsSchema = {
  fields: [
    { kind: 'password', key: 'password', label: 'Password', help: 'For password authentication.' },
    {
      kind: 'password',
      key: 'passphrase',
      label: 'Key passphrase',
      help: 'For an encrypted private key.',
    },
  ],
};

export type SftpAuthMethod = 'password' | 'privateKey' | 'agent';

export interface SftpSettings {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly authMethod: SftpAuthMethod;
  readonly privateKeyPath: string | undefined;
  readonly knownHostsPath: string | undefined;
  /**
   * Where the connection starts. `''` is the login directory, `projects` sits
   * below it, `/var/www` is an absolute server path, and `/` is the server's
   * filesystem root.
   *
   * This is the one `readSettings` in the repo that keeps a leading slash.
   * `provider-s3` and `provider-webdav` strip theirs, rightly: the absolute
   * part of the location already lives in their Bucket or Server URL field, so
   * `rootPrefix` has no absolute form left to express. Here the server's
   * filesystem root is a real, reachable place that no other setting names, so
   * the slash is load-bearing. Never has a trailing slash.
   */
  readonly rootPrefix: string;
}

const AUTH_METHODS: readonly SftpAuthMethod[] = ['password', 'privateKey', 'agent'];

export function readSettings(raw: Readonly<Record<string, unknown>>): SftpSettings {
  const host = readString(raw, 'host');
  if (host === undefined) throw invalid('SFTP connection is missing a host.');

  const username = readString(raw, 'username');
  if (username === undefined) throw invalid('SFTP connection is missing a username.');

  const authMethod = readString(raw, 'authMethod') ?? 'password';
  if (!AUTH_METHODS.includes(authMethod as SftpAuthMethod)) {
    throw invalid(`Unknown SFTP authentication method: ${authMethod}`);
  }

  const port = raw['port'] === undefined ? 22 : Number(raw['port']);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw invalid(`SFTP port is not a valid port number: ${String(raw['port'])}`);
  }

  return {
    host,
    port,
    username,
    authMethod: authMethod as SftpAuthMethod,
    privateKeyPath: readString(raw, 'privateKeyPath'),
    knownHostsPath: readString(raw, 'knownHostsPath'),
    rootPrefix: normaliseRootPrefix(readString(raw, 'rootPrefix')),
  };
}

/**
 * Trailing slashes go, because `RemotePath` never has one and joining would
 * double it. A repeated leading slash collapses to one: `//var` and `/var` name
 * the same directory, and keeping both spellings would make two connections
 * that differ only in a typo look different in logs.
 *
 * A prefix that is nothing but slashes is the exception: it stays `/`, the
 * server's filesystem root. Stripping it to `''` would silently move the
 * connection to the login directory — a different place, which the user already
 * has a way to ask for, and the one absolute path they would otherwise have no
 * spelling for.
 */
function normaliseRootPrefix(value: string | undefined): string {
  if (value === undefined) return '';
  const trimmed = trimTrailingSlashes(value);
  if (!value.startsWith('/')) return trimmed;
  return trimmed === '' ? '/' : `/${trimLeadingSlashes(trimmed)}`;
}

function invalid(message: string): OmniFsError {
  return new OmniFsError({ code: 'ProtocolError', message, providerId: 'sftp' });
}

function readString(raw: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
