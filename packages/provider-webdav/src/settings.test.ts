import { describe, expect, it } from 'vitest';
import { WEBDAV_SETTINGS_SCHEMA } from './index.js';

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
