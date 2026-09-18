import { describe, expect, it } from 'vitest';
import { mergeSecret } from './secret-merge.js';
import type { SettingsSchema } from '../provider.js';

const schema: SettingsSchema = {
  fields: [
    { kind: 'password', key: 'accessKeyId', label: 'Access key ID', required: true },
    { kind: 'password', key: 'secretAccessKey', label: 'Secret access key', required: true },
    { kind: 'password', key: 'sessionToken', label: 'Session token' },
  ],
};

describe('mergeSecret', () => {
  it('keeps stored values that the patch does not mention', () => {
    const merged = mergeSecret({ accessKeyId: 'A', secretAccessKey: 'B' }, {}, schema);
    expect(merged).toEqual({ accessKeyId: 'A', secretAccessKey: 'B' });
  });

  it('overwrites a stored value when the patch sets it', () => {
    const merged = mergeSecret(
      { accessKeyId: 'A', secretAccessKey: 'B' },
      { accessKeyId: { set: 'NEW' } },
      schema,
    );
    expect(merged).toEqual({ accessKeyId: 'NEW', secretAccessKey: 'B' });
  });

  it('removes a value the patch clears', () => {
    const merged = mergeSecret(
      { accessKeyId: 'A', sessionToken: 'T' },
      { sessionToken: { clear: true } },
      schema,
    );
    expect(merged).toEqual({ accessKeyId: 'A' });
  });

  it('drops stored keys the schema no longer declares', () => {
    // A provider dropped a field in an upgrade; the stale credential should
    // not be written back to the keychain forever.
    const merged = mergeSecret({ accessKeyId: 'A', legacyToken: 'stale' }, {}, schema);
    expect(merged).toEqual({ accessKeyId: 'A' });
  });

  it('builds the whole secret for a brand-new connection', () => {
    const merged = mergeSecret(
      undefined,
      { accessKeyId: { set: 'A' }, secretAccessKey: { set: 'B' } },
      schema,
    );
    expect(merged).toEqual({ accessKeyId: 'A', secretAccessKey: 'B' });
  });
});
