import { OmniFsError, trimLeadingSlashes, trimTrailingSlashes } from '@omni-fs/core';
import type { SettingsSchema } from '@omni-fs/core';

export const FTP_SETTINGS_SCHEMA: SettingsSchema = {
  fields: [
    { kind: 'text', key: 'host', label: 'Host', required: true, placeholder: 'ftp.example.com' },
    { kind: 'number', key: 'port', label: 'Port', default: 21, min: 1, max: 65535 },
    { kind: 'text', key: 'username', label: 'Username', required: true, placeholder: 'anonymous' },
    {
      kind: 'select',
      key: 'secure',
      label: 'Encryption',
      required: true,
      default: 'explicit',
      options: [
        { value: 'explicit', label: 'FTPS — explicit TLS (AUTH TLS, recommended)' },
        { value: 'implicit', label: 'FTPS — implicit TLS (port 990)' },
        { value: 'none', label: 'Plain FTP — unencrypted' },
      ],
    },
    {
      kind: 'select',
      key: 'tlsMinVersion',
      label: 'Minimum TLS version',
      default: 'auto',
      options: [
        { value: 'auto', label: 'Automatic (recommended)' },
        { value: 'TLSv1.3', label: 'TLS 1.3' },
        { value: 'TLSv1.2', label: 'TLS 1.2' },
        { value: 'TLSv1.1', label: 'TLS 1.1 — legacy servers only' },
        { value: 'TLSv1', label: 'TLS 1.0 — legacy servers only' },
      ],
      help: 'For reaching an old server, not for hardening a good one. Anything below TLS 1.2 also relaxes the cipher policy, because those servers offer key sizes modern OpenSSL refuses outright. Ignored for plain FTP.',
    },
    {
      kind: 'boolean',
      key: 'allowSelfSigned',
      label: 'Allow self-signed certificates',
      default: false,
      help: 'Disables TLS certificate verification. Only for servers you control.',
    },
    {
      kind: 'number',
      key: 'maxConnections',
      label: 'Maximum connections',
      default: 1,
      min: 1,
      max: 8,
      help: 'FTP carries one command per connection, so browsing waits behind a transfer. Raising this opens more logins; lower it if the server refuses them.',
    },
    {
      kind: 'text',
      key: 'rootPrefix',
      label: 'Root prefix',
      placeholder: 'public_html',
      help: 'Optional. Scopes the connection to a subfolder of the login directory. Begin with / for an absolute server path, e.g. /srv/ftp/shared.',
    },
  ],
};

export const FTP_SECRET_SCHEMA: SettingsSchema = {
  fields: [{ kind: 'password', key: 'password', label: 'Password', required: true }],
};

export type FtpSecureMode = 'explicit' | 'implicit' | 'none';

/** `auto` means Node's own floor, which moves with Node. See spec decision 8. */
export type FtpTlsMinVersion = 'auto' | 'TLSv1.3' | 'TLSv1.2' | 'TLSv1.1' | 'TLSv1';

export interface FtpSettings {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly secure: FtpSecureMode;
  readonly allowSelfSigned: boolean;
  readonly tlsMinVersion: FtpTlsMinVersion;
  /** The pool ceiling, and therefore this connection's `maxConcurrency`. */
  readonly maxConnections: number;
  /**
   * Where the connection starts. `''` is the login directory, `public_html`
   * sits below it, `/srv/ftp/shared` is an absolute server path, and `/` is the
   * server's filesystem root.
   *
   * This and `provider-sftp` are the two `readSettings` in the repo that keep a
   * leading slash. `provider-s3` and `provider-webdav` strip theirs, rightly:
   * the absolute part of their location already lives in the Bucket or Server
   * URL field. Here the server's filesystem root is a real, reachable place
   * that no other setting names, so the slash is load-bearing. Never has a
   * trailing slash.
   */
  readonly rootPrefix: string;
}

const SECURE_MODES: readonly FtpSecureMode[] = ['explicit', 'implicit', 'none'];
const TLS_MIN_VERSIONS: readonly FtpTlsMinVersion[] = [
  'auto',
  'TLSv1.3',
  'TLSv1.2',
  'TLSv1.1',
  'TLSv1',
];

export function readSettings(raw: Readonly<Record<string, unknown>>): FtpSettings {
  const host = readString(raw, 'host');
  if (host === undefined) throw invalid('FTP connection is missing a host.');

  const username = readString(raw, 'username');
  if (username === undefined) throw invalid('FTP connection is missing a username.');

  const secure = readString(raw, 'secure') ?? 'explicit';
  if (!SECURE_MODES.includes(secure as FtpSecureMode)) {
    throw invalid(`Unknown FTP encryption mode: ${secure}`);
  }

  const tlsMinVersion = readString(raw, 'tlsMinVersion') ?? 'auto';
  if (!TLS_MIN_VERSIONS.includes(tlsMinVersion as FtpTlsMinVersion)) {
    throw invalid(`Unknown minimum TLS version: ${tlsMinVersion}`);
  }

  return {
    host,
    username,
    secure: secure as FtpSecureMode,
    tlsMinVersion: tlsMinVersion as FtpTlsMinVersion,
    allowSelfSigned: raw['allowSelfSigned'] === true,
    port: readBoundedInteger(raw, 'port', 21, 1, 65535, 'FTP port'),
    maxConnections: readBoundedInteger(raw, 'maxConnections', 1, 1, 8, 'FTP maximum connections'),
    rootPrefix: normaliseRootPrefix(readString(raw, 'rootPrefix')),
  };
}

/**
 * Trailing slashes go, because `RemotePath` never has one and joining would
 * double it. A repeated leading slash collapses to one: `//srv` and `/srv` name
 * the same directory, and keeping both spellings would make two connections
 * that differ only in a typo look different in logs.
 *
 * A prefix that is nothing but slashes is the exception: it stays `/`, the
 * server's filesystem root. Stripping it to `''` would silently move the
 * connection to the login directory — a different place, which the user already
 * has a way to ask for.
 */
function normaliseRootPrefix(value: string | undefined): string {
  if (value === undefined) return '';
  const trimmed = trimTrailingSlashes(value);
  if (!value.startsWith('/')) return trimmed;
  return trimmed === '' ? '/' : `/${trimLeadingSlashes(trimmed)}`;
}

function readBoundedInteger(
  raw: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  const value = raw[key] === undefined ? fallback : Number(raw[key]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw invalid(`${label} is not between ${min} and ${max}: ${String(raw[key])}`);
  }
  return value;
}

function invalid(message: string): OmniFsError {
  return new OmniFsError({ code: 'ProtocolError', message, providerId: 'ftp' });
}

function readString(raw: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
