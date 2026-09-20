import { OmniFsError } from '@omni-fs/core';
import { readLocalFile } from './local-files.js';
import type { SftpSettings } from './settings.js';

/** The credential half of an `ssh2` connect config. */
export interface SftpAuth {
  readonly password?: string | undefined;
  readonly privateKey?: Buffer | undefined;
  readonly passphrase?: string | undefined;
  readonly agent?: string | undefined;
}

export interface AuthSources {
  readonly readFile: (path: string) => Promise<Buffer>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
}

const DEFAULT_SOURCES: AuthSources = {
  readFile: readLocalFile,
  env: process.env,
  platform: process.platform,
};

/**
 * Turns settings plus stored secrets into the credentials `ssh2` wants.
 *
 * Every failure here is `AuthenticationFailed` rather than `Unknown`, because
 * every one of them is answered the same way by a host: re-prompt for the
 * credential, which is exactly what that code exists to distinguish
 * (`packages/core/src/errors.ts`). A missing key file is a credential problem
 * even though it presents as an `ENOENT`.
 */
export async function buildAuth(
  settings: SftpSettings,
  secret: Readonly<Record<string, unknown>>,
  sources: AuthSources = DEFAULT_SOURCES,
): Promise<SftpAuth> {
  switch (settings.authMethod) {
    case 'password':
      return { password: requireSecret(secret, 'password') };

    case 'privateKey': {
      const path = settings.privateKeyPath;
      if (path === undefined) {
        throw failed('SFTP private key authentication needs a private key file.');
      }
      let privateKey: Buffer;
      try {
        privateKey = await sources.readFile(path);
      } catch (cause) {
        throw failed(`Could not read the SFTP private key at ${path}`, cause);
      }
      const passphrase = readSecret(secret, 'passphrase');
      return { privateKey, ...(passphrase !== undefined ? { passphrase } : {}) };
    }

    case 'agent': {
      const socket =
        sources.env['SSH_AUTH_SOCK'] ?? (sources.platform === 'win32' ? 'pageant' : undefined);
      if (socket === undefined) {
        throw failed('No SSH agent found: SSH_AUTH_SOCK is not set.');
      }
      return { agent: socket };
    }
  }
}

function requireSecret(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = readSecret(record, key);
  if (value === undefined) throw failed(`Missing credential field: ${key}`);
  return value;
}

function readSecret(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function failed(message: string, cause?: unknown): OmniFsError {
  return new OmniFsError({ code: 'AuthenticationFailed', message, providerId: 'sftp', cause });
}
