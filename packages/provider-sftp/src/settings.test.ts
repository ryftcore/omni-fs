import { describe, expect, it } from 'vitest';
import { OmniFsError } from '@omni-fs/core';
import { SFTP_SETTINGS_SCHEMA, readSettings } from './settings.js';

const base = { host: 'sftp.example.com', username: 'alice' };

describe('SFTP_SETTINGS_SCHEMA', () => {
  it('offers a known_hosts override as a file field', () => {
    const field = SFTP_SETTINGS_SCHEMA.fields.find((f) => f.key === 'knownHostsPath');
    expect(field?.kind).toBe('file');
  });

  it('shows an absolute root prefix in the placeholder, because that is the common form here', () => {
    const field = SFTP_SETTINGS_SCHEMA.fields.find((f) => f.key === 'rootPrefix');
    expect(field).toMatchObject({ kind: 'text', label: 'Root prefix', placeholder: '/var/www' });
  });
});

describe('readSettings', () => {
  it('defaults the port to 22 and the auth method to password', () => {
    const settings = readSettings(base);
    expect(settings.port).toBe(22);
    expect(settings.authMethod).toBe('password');
  });

  it('keeps a leading slash on rootPrefix, unlike every other provider', () => {
    expect(readSettings({ ...base, rootPrefix: '/var/www' }).rootPrefix).toBe('/var/www');
  });

  it('keeps a relative rootPrefix relative', () => {
    expect(readSettings({ ...base, rootPrefix: 'projects' }).rootPrefix).toBe('projects');
  });

  it('strips trailing slashes and collapses a repeated leading slash', () => {
    expect(readSettings({ ...base, rootPrefix: '//var/www/' }).rootPrefix).toBe('/var/www');
  });

  it('treats a blank rootPrefix as the login directory', () => {
    expect(readSettings({ ...base, rootPrefix: '   ' }).rootPrefix).toBe('');
  });

  it('rejects a connection with no host', () => {
    expect(() => readSettings({ username: 'alice' })).toThrowError(OmniFsError);
    try {
      readSettings({ username: 'alice' });
    } catch (error) {
      expect(OmniFsError.is(error) && error.code).toBe('ProtocolError');
    }
  });

  it('rejects a connection with no username', () => {
    try {
      readSettings({ host: 'sftp.example.com' });
      expect.unreachable('readSettings should have thrown');
    } catch (error) {
      expect(OmniFsError.is(error) && error.code).toBe('ProtocolError');
    }
  });

  it('rejects an unknown authentication method', () => {
    try {
      readSettings({ ...base, authMethod: 'kerberos' });
      expect.unreachable('readSettings should have thrown');
    } catch (error) {
      expect(OmniFsError.is(error) && error.code).toBe('ProtocolError');
    }
  });

  it('rejects a port outside the legal range', () => {
    try {
      readSettings({ ...base, port: 70000 });
      expect.unreachable('readSettings should have thrown');
    } catch (error) {
      expect(OmniFsError.is(error) && error.code).toBe('ProtocolError');
    }
  });
});
