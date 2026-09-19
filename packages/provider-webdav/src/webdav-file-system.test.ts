import { describe, expect, it } from 'vitest';
import { NOOP_LOGGER, OmniFsError } from '@omni-fs/core';
import type { ConnectionConfig } from '@omni-fs/core';
import { WebdavFileSystem } from './webdav-file-system.js';

function build(raw: Readonly<Record<string, unknown>>): WebdavFileSystem {
  const config: ConnectionConfig = {
    id: 'unit',
    providerId: 'webdav',
    label: 'unit',
    settings: { baseUrl: 'https://dav.example.com', ...raw },
  };
  return new WebdavFileSystem({
    config,
    getSecret: async () => ({ password: 'secret', token: 'bearer-token' }),
    logger: NOOP_LOGGER,
  });
}

describe('WebdavFileSystem.connect', () => {
  it('rejects password auth with no username instead of deferring to a 401', async () => {
    const fs = build({ authType: 'password' });
    await expect(fs.connect()).rejects.toSatisfy(
      (error: unknown) =>
        OmniFsError.is(error) &&
        error.code === 'AuthenticationFailed' &&
        error.message.includes('username'),
    );
    expect(fs.isAlive()).toBe(false);
  });

  it('does not require a username for token or anonymous auth', async () => {
    // Neither sends one, so demanding it would lock out valid configurations.
    for (const authType of ['token', 'none']) {
      const fs = build({ authType });
      await fs.connect();
      expect(fs.isAlive()).toBe(true);
      await fs[Symbol.asyncDispose]();
    }
  });

  it('is idempotent', async () => {
    const fs = build({ authType: 'password', username: 'omnifs' });
    await fs.connect();
    await fs.connect();
    expect(fs.isAlive()).toBe(true);
    await fs[Symbol.asyncDispose]();
    expect(fs.isAlive()).toBe(false);
  });
});
