import { describe, expect, it } from 'vitest';
import { OmniFsError } from '@omni-fs/core';
import { S3_SECRET_SCHEMA, S3_SETTINGS_SCHEMA } from './index.js';
import { readSettings } from './settings.js';

/**
 * Everything here comes out of a saved `omniFs.connections` entry, which is
 * committable JSON a team shares. It can therefore be hand-edited, arrive from
 * an older version of the form, or be missing keys entirely — so `readSettings`
 * is the boundary that has to hold, not the form that usually fills it.
 */

describe('S3_SETTINGS_SCHEMA', () => {
  it('scopes the connection with a rootPrefix field, spelled as WebDAV spells it', () => {
    // Both hosts render these schemas generically, so two providers spelling
    // the same concept differently shows up as two differently-worded fields
    // in one dialog.
    const field = S3_SETTINGS_SCHEMA.fields.find((candidate) => candidate.key === 'rootPrefix');
    expect(field).toBeDefined();
    expect(field?.label).toBe('Root prefix');
  });

  it('requires only the two settings that have no sane default', () => {
    const required = S3_SETTINGS_SCHEMA.fields
      .filter((field) => field.required === true)
      .map((field) => field.key);
    expect(required).toEqual(['bucket', 'region']);
  });
});

describe('S3_SECRET_SCHEMA', () => {
  it('declares every credential field as a password', () => {
    // The kind is what stops a host rendering a credential as readable text,
    // and it is the only signal the host gets.
    expect(S3_SECRET_SCHEMA.fields.every((field) => field.kind === 'password')).toBe(true);
  });

  it('requires the long-lived key pair but not the session token', () => {
    const required = S3_SECRET_SCHEMA.fields
      .filter((field) => field.required === true)
      .map((field) => field.key);
    // A session token is only present for temporary STS credentials; demanding
    // one would lock out every ordinary access key.
    expect(required).toEqual(['accessKeyId', 'secretAccessKey']);
  });
});

describe('readSettings', () => {
  it('reads a complete configuration', () => {
    const settings = readSettings({
      bucket: 'omni-fs-test',
      region: 'eu-west-1',
      endpoint: 'http://localhost:9000',
      forcePathStyle: true,
      rootPrefix: 'projects/site',
      storageClass: 'STANDARD_IA',
    });

    expect(settings).toEqual({
      bucket: 'omni-fs-test',
      region: 'eu-west-1',
      endpoint: 'http://localhost:9000',
      forcePathStyle: true,
      rootPrefix: 'projects/site',
      storageClass: 'STANDARD_IA',
      serverSideEncryption: undefined,
    });
  });

  it('throws a ProtocolError naming the provider when the bucket is missing', () => {
    try {
      readSettings({ region: 'us-east-1' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(OmniFsError.is(error)).toBe(true);
      expect(OmniFsError.is(error) && error.code).toBe('ProtocolError');
      expect(OmniFsError.is(error) && error.providerId).toBe('s3');
    }
  });

  it('treats a blank bucket as missing rather than as a bucket named ""', () => {
    expect(() => readSettings({ bucket: '   ' })).toThrow(OmniFsError);
  });

  it('defaults the region to us-east-1', () => {
    // Required by the SDK even when the endpoint is a MinIO box that ignores
    // it, so an absent region has to become something rather than fail.
    expect(readSettings({ bucket: 'b' }).region).toBe('us-east-1');
  });

  it('leaves the endpoint undefined for real AWS', () => {
    expect(readSettings({ bucket: 'b' }).endpoint).toBeUndefined();
    expect(readSettings({ bucket: 'b', endpoint: '' }).endpoint).toBeUndefined();
  });

  it('trims surrounding whitespace from text settings', () => {
    const settings = readSettings({ bucket: '  b  ', region: ' us-east-2 ' });
    expect(settings.bucket).toBe('b');
    expect(settings.region).toBe('us-east-2');
  });

  it('strips surrounding slashes from the root prefix', () => {
    // `#key` joins this with a slash, so a stored "/docs/" would address
    // "/docs//a.txt" — a different object from "docs/a.txt", and a confusing
    // one, because S3 accepts it happily.
    expect(readSettings({ bucket: 'b', rootPrefix: '/docs/' }).rootPrefix).toBe('docs');
    expect(readSettings({ bucket: 'b', rootPrefix: '///a/b///' }).rootPrefix).toBe('a/b');
  });

  it('defaults an absent root prefix to empty, meaning the whole bucket', () => {
    expect(readSettings({ bucket: 'b' }).rootPrefix).toBe('');
    expect(readSettings({ bucket: 'b', rootPrefix: '   ' }).rootPrefix).toBe('');
  });

  it('reads forcePathStyle only from a real boolean', () => {
    expect(readSettings({ bucket: 'b', forcePathStyle: true }).forcePathStyle).toBe(true);
    expect(readSettings({ bucket: 'b' }).forcePathStyle).toBe(false);
    // A host that serialised the checkbox as a string would silently get
    // virtual-hosted addressing, which most self-hosted servers reject. The
    // strictness is deliberate; this pins it so the failure is loud if a host
    // ever starts sending strings.
    expect(readSettings({ bucket: 'b', forcePathStyle: 'true' }).forcePathStyle).toBe(false);
  });

  it('reads the schema default storage class as no storage class at all', () => {
    // `S3_SETTINGS_SCHEMA` defaults this field to `''`, so a form the user
    // never touched sends an empty string. Sending `StorageClass: ''` to S3 is
    // a 400; absent is what "default" has to mean.
    expect(readSettings({ bucket: 'b', storageClass: '' }).storageClass).toBeUndefined();
    expect(readSettings({ bucket: 'b' }).storageClass).toBeUndefined();
  });

  it('reads serverSideEncryption even though no form field offers it', () => {
    // Deliberately not in `S3_SETTINGS_SCHEMA`: it is reachable only by editing
    // the `omniFs.connections` JSON by hand. Reading it keeps that escape hatch
    // working for a team whose bucket policy requires SSE.
    expect(readSettings({ bucket: 'b', serverSideEncryption: 'AES256' }).serverSideEncryption).toBe(
      'AES256',
    );
  });

  it('ignores settings of the wrong type instead of passing them to the SDK', () => {
    const settings = readSettings({ bucket: 'b', region: 42, endpoint: null, rootPrefix: [] });
    expect(settings.region).toBe('us-east-1');
    expect(settings.endpoint).toBeUndefined();
    expect(settings.rootPrefix).toBe('');
  });
});
