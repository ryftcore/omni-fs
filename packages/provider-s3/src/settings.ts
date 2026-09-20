import { OmniFsError, trimSlashes } from '@omni-fs/core';
import type { SettingsSchema } from '@omni-fs/core';

export interface S3Settings {
  readonly bucket: string;
  readonly region: string;
  /** Custom endpoint for MinIO, R2, B2, Spaces. Absent means real AWS. */
  readonly endpoint: string | undefined;
  /** Required by most S3-compatible servers; AWS prefers virtual-hosted style. */
  readonly forcePathStyle: boolean;
  /** Key prefix treated as the connection root. Never starts or ends with `/`. */
  readonly rootPrefix: string;
  readonly storageClass: string | undefined;
  readonly serverSideEncryption: string | undefined;
}

/** Non-secret connection settings, rendered as a form by whichever host is running. */
export const S3_SETTINGS_SCHEMA: SettingsSchema = {
  fields: [
    { kind: 'text', key: 'bucket', label: 'Bucket', required: true, placeholder: 'my-bucket' },
    { kind: 'text', key: 'region', label: 'Region', required: true, placeholder: 'us-east-1' },
    {
      kind: 'text',
      key: 'endpoint',
      label: 'Endpoint',
      placeholder: 'https://s3.example.com',
      help: 'Leave empty for AWS. Set for MinIO, Cloudflare R2, Backblaze B2 or DigitalOcean Spaces.',
    },
    {
      kind: 'boolean',
      key: 'forcePathStyle',
      label: 'Force path-style addressing',
      default: false,
      help: 'Required by most self-hosted S3-compatible servers.',
    },
    {
      kind: 'text',
      key: 'rootPrefix',
      label: 'Root prefix',
      placeholder: 'projects/site',
      help: 'Optional. Scopes the connection to a subfolder of the bucket.',
    },
    {
      kind: 'select',
      key: 'storageClass',
      label: 'Storage class',
      options: [
        { value: '', label: 'Default' },
        { value: 'STANDARD', label: 'Standard' },
        { value: 'INTELLIGENT_TIERING', label: 'Intelligent-Tiering' },
        { value: 'STANDARD_IA', label: 'Standard-IA' },
        { value: 'GLACIER_IR', label: 'Glacier Instant Retrieval' },
      ],
      default: '',
    },
  ],
};

/** Credential fields. Never persisted alongside the settings above. */
export const S3_SECRET_SCHEMA: SettingsSchema = {
  fields: [
    { kind: 'password', key: 'accessKeyId', label: 'Access key ID', required: true },
    { kind: 'password', key: 'secretAccessKey', label: 'Secret access key', required: true },
    {
      kind: 'password',
      key: 'sessionToken',
      label: 'Session token',
      help: 'Only for temporary STS credentials.',
    },
  ],
};

export function readSettings(raw: Readonly<Record<string, unknown>>): S3Settings {
  const bucket = readString(raw, 'bucket');
  if (bucket === undefined) {
    throw new OmniFsError({
      code: 'ProtocolError',
      message: 'S3 connection is missing a bucket.',
      providerId: 's3',
    });
  }

  return {
    bucket,
    region: readString(raw, 'region') ?? 'us-east-1',
    endpoint: readString(raw, 'endpoint'),
    forcePathStyle: raw['forcePathStyle'] === true,
    rootPrefix: trimSlashes(readString(raw, 'rootPrefix') ?? ''),
    storageClass: readString(raw, 'storageClass'),
    serverSideEncryption: readString(raw, 'serverSideEncryption'),
  };
}

function readString(raw: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
