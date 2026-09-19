import { describe, expect, it } from 'vitest';
import { OmniFsError } from '@omni-fs/core';
import { WEBDAV_SETTINGS_SCHEMA } from './index.js';
import { readSettings } from './settings.js';

describe('WEBDAV_SETTINGS_SCHEMA', () => {
  it('has no field labelled "Root path", which would collide with the connection-level one', () => {
    const labels = WEBDAV_SETTINGS_SCHEMA.fields.map((field) => field.label);
    expect(labels).not.toContain('Root path');
  });

  it('scopes the connection with a rootPrefix field, spelled as S3 spells it', () => {
    const field = WEBDAV_SETTINGS_SCHEMA.fields.find((candidate) => candidate.key === 'rootPrefix');
    expect(field).toBeDefined();
    expect(field?.label).toBe('Root prefix');
  });
});

describe('readSettings', () => {
  it('reads a complete configuration', () => {
    const settings = readSettings({
      baseUrl: 'http://localhost:8081',
      authType: 'password',
      username: 'omnifs',
      rootPrefix: 'docs',
    });
    expect(settings.baseUrl).toBe('http://localhost:8081');
    expect(settings.authType).toBe('password');
    expect(settings.username).toBe('omnifs');
    expect(settings.rootPrefix).toBe('docs');
  });

  it('strips surrounding slashes from the root prefix', () => {
    expect(readSettings({ baseUrl: 'http://h', rootPrefix: '/docs/' }).rootPrefix).toBe('docs');
  });

  it('defaults an absent root prefix to empty', () => {
    expect(readSettings({ baseUrl: 'http://h' }).rootPrefix).toBe('');
  });

  it('drops a trailing slash from the base url so paths do not double up', () => {
    expect(readSettings({ baseUrl: 'http://h/dav/' }).baseUrl).toBe('http://h/dav');
  });

  it('defaults authType to password', () => {
    expect(readSettings({ baseUrl: 'http://h' }).authType).toBe('password');
  });

  it('rejects an unknown authType rather than guessing', () => {
    expect(() => readSettings({ baseUrl: 'http://h', authType: 'kerberos' })).toThrow(OmniFsError);
  });

  it('throws a ProtocolError when the server url is missing', () => {
    try {
      readSettings({});
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(OmniFsError.is(error) && error.code).toBe('ProtocolError');
    }
  });
});
