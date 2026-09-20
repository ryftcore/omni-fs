import { describe, expect, it } from 'vitest';
import { OmniFsError } from '@omni-fs/core';
import { buildAuth, type AuthSources } from './auth.js';
import { readSettings, type SftpSettings } from './settings.js';

function settings(over: Readonly<Record<string, unknown>> = {}): SftpSettings {
  return readSettings({ host: 'sftp.example.com', username: 'alice', ...over });
}

function sources(over: Partial<AuthSources> = {}): AuthSources {
  return {
    readFile: async () => Buffer.from('PRIVATE KEY'),
    env: {},
    platform: 'linux',
    ...over,
  };
}

async function codeOf(body: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await body();
    return undefined;
  } catch (error) {
    return OmniFsError.is(error) ? error.code : 'not-an-OmniFsError';
  }
}

describe('buildAuth', () => {
  it('uses the stored password for password authentication', async () => {
    const auth = await buildAuth(settings(), { password: 'hunter2' }, sources());
    expect(auth).toEqual({ password: 'hunter2' });
  });

  it('refuses password authentication with no password stored', async () => {
    expect(await codeOf(() => buildAuth(settings(), {}, sources()))).toBe('AuthenticationFailed');
  });

  it('reads the private key from the path in the settings', async () => {
    const read: string[] = [];
    const auth = await buildAuth(
      settings({ authMethod: 'privateKey', privateKeyPath: '~/.ssh/id_ed25519' }),
      {},
      sources({
        readFile: async (path) => {
          read.push(path);
          return Buffer.from('PRIVATE KEY');
        },
      }),
    );

    expect(read).toEqual(['~/.ssh/id_ed25519']);
    expect(auth.privateKey?.toString('utf8')).toBe('PRIVATE KEY');
    expect('passphrase' in auth).toBe(false);
  });

  it('passes the passphrase through when the key is encrypted', async () => {
    const auth = await buildAuth(
      settings({ authMethod: 'privateKey', privateKeyPath: '/keys/id' }),
      { passphrase: 'open sesame' },
      sources(),
    );
    expect(auth.passphrase).toBe('open sesame');
  });

  it('refuses private key authentication with no key path', async () => {
    expect(
      await codeOf(() => buildAuth(settings({ authMethod: 'privateKey' }), {}, sources())),
    ).toBe('AuthenticationFailed');
  });

  it('reports an unreadable key file as AuthenticationFailed, not as Unknown', async () => {
    const code = await codeOf(() =>
      buildAuth(
        settings({ authMethod: 'privateKey', privateKeyPath: '/keys/absent' }),
        {},
        sources({
          readFile: async () => {
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          },
        }),
      ),
    );
    expect(code).toBe('AuthenticationFailed');
  });

  it('takes the agent socket from the environment', async () => {
    const auth = await buildAuth(
      settings({ authMethod: 'agent' }),
      {},
      sources({ env: { SSH_AUTH_SOCK: '/tmp/agent.sock' } }),
    );
    expect(auth).toEqual({ agent: '/tmp/agent.sock' });
  });

  it('falls back to pageant on Windows', async () => {
    const auth = await buildAuth(
      settings({ authMethod: 'agent' }),
      {},
      sources({ platform: 'win32' }),
    );
    expect(auth).toEqual({ agent: 'pageant' });
  });

  it('refuses agent authentication when no agent is reachable', async () => {
    expect(await codeOf(() => buildAuth(settings({ authMethod: 'agent' }), {}, sources()))).toBe(
      'AuthenticationFailed',
    );
  });
});
