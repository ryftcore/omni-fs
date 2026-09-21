import { describe, expect, it } from 'vitest';
import { OmniFsError } from '@omni-fs/core';
import { FTP_SETTINGS_SCHEMA, readSettings } from './settings.js';

const base = { host: 'ftp.example.com', username: 'alice' };

describe('FTP_SETTINGS_SCHEMA', () => {
  it('offers the three encryption modes, defaulting to explicit', () => {
    const field = FTP_SETTINGS_SCHEMA.fields.find((f) => f.key === 'secure');
    expect(field).toMatchObject({ kind: 'select', default: 'explicit' });
    const values =
      field?.kind === 'select' ? field.options.map((option) => option.value) : undefined;
    expect(values).toEqual(['explicit', 'implicit', 'none']);
  });

  it('offers a TLS floor that defaults to auto', () => {
    const field = FTP_SETTINGS_SCHEMA.fields.find((f) => f.key === 'tlsMinVersion');
    expect(field).toMatchObject({ kind: 'select', default: 'auto' });
    const values =
      field?.kind === 'select' ? field.options.map((option) => option.value) : undefined;
    expect(values).toEqual(['auto', 'TLSv1.3', 'TLSv1.2', 'TLSv1.1', 'TLSv1']);
  });

  it('says in the help text that a low TLS floor also relaxes the cipher policy', () => {
    // The coupling is the whole reason the setting works rather than merely
    // existing (spec decision 8). A user who is not told will report the
    // weakened crypto as a bug, or worse, never learn of it.
    const field = FTP_SETTINGS_SCHEMA.fields.find((f) => f.key === 'tlsMinVersion');
    expect(field?.kind === 'select' ? field.help : undefined).toMatch(/cipher/i);
  });

  it('bounds the connection count at 8, which is more than any shared host allows', () => {
    const field = FTP_SETTINGS_SCHEMA.fields.find((f) => f.key === 'maxConnections');
    expect(field).toMatchObject({ kind: 'number', default: 1, min: 1, max: 8 });
  });
});

describe('readSettings', () => {
  it('defaults the port, the mode, the TLS floor and the pool size', () => {
    const settings = readSettings(base);
    expect(settings).toMatchObject({
      port: 21,
      secure: 'explicit',
      tlsMinVersion: 'auto',
      maxConnections: 1,
      allowSelfSigned: false,
      rootPrefix: '',
    });
  });

  it('keeps a leading slash on rootPrefix, as provider-sftp does and the other two do not', () => {
    expect(readSettings({ ...base, rootPrefix: '/srv/ftp/shared' }).rootPrefix).toBe(
      '/srv/ftp/shared',
    );
  });

  it('keeps a relative rootPrefix relative', () => {
    expect(readSettings({ ...base, rootPrefix: 'public_html' }).rootPrefix).toBe('public_html');
  });

  it('strips trailing slashes and collapses a repeated leading slash', () => {
    expect(readSettings({ ...base, rootPrefix: '//srv/ftp/' }).rootPrefix).toBe('/srv/ftp');
  });

  it('keeps a lone slash, which is the server filesystem root and not the login directory', () => {
    expect(readSettings({ ...base, rootPrefix: '/' }).rootPrefix).toBe('/');
  });

  it('rejects a missing host', () => {
    expect(() => readSettings({ username: 'alice' })).toThrowError(OmniFsError);
  });

  it('rejects a missing username', () => {
    expect(() => readSettings({ host: 'ftp.example.com' })).toThrowError(OmniFsError);
  });

  it('rejects an unknown encryption mode', () => {
    expect(() => readSettings({ ...base, secure: 'sometimes' })).toThrowError(/sometimes/);
  });

  it('rejects an unknown TLS floor', () => {
    expect(() => readSettings({ ...base, tlsMinVersion: 'SSLv3' })).toThrowError(/SSLv3/);
  });

  it('rejects a port outside the valid range', () => {
    expect(() => readSettings({ ...base, port: 0 })).toThrowError(/port/i);
    expect(() => readSettings({ ...base, port: 70000 })).toThrowError(/port/i);
  });

  it('rejects a pool size outside 1 to 8', () => {
    expect(() => readSettings({ ...base, maxConnections: 0 })).toThrowError(/connection/i);
    expect(() => readSettings({ ...base, maxConnections: 9 })).toThrowError(/connection/i);
  });

  it('raises ProtocolError, so a typo is caught here and not reported in the server words', () => {
    try {
      readSettings({ username: 'alice' });
      expect.unreachable('readSettings should have thrown');
    } catch (error) {
      expect(OmniFsError.is(error) && error.code).toBe('ProtocolError');
      expect(OmniFsError.is(error) && error.providerId).toBe('ftp');
    }
  });

  it('reads allowSelfSigned as a boolean', () => {
    expect(readSettings({ ...base, allowSelfSigned: true }).allowSelfSigned).toBe(true);
  });
});
