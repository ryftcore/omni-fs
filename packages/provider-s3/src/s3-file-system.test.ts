import { describe, expect, it } from 'vitest';
import { NOOP_LOGGER, OmniFsError, RemotePath, collectStream, streamFrom } from '@omni-fs/core';
import type { ConnectionConfig, DirEntry } from '@omni-fs/core';
import type { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import { S3FileSystem } from './s3-file-system.js';

/**
 * S3 has no directories. Everything that makes a bucket look like a file tree
 * is emulation living in this class — `stat` probing for a prefix when there is
 * no object, `list` reading `CommonPrefixes` as folders and hiding the
 * placeholder keys other tools leave behind, `delete` sweeping a prefix.
 *
 * The live conformance run proves that emulation against MinIO. These tests
 * reach the branches a real server will not produce on demand: a 403 arriving
 * where a 404 was expected, a placeholder key, a truncated page.
 */

/** One command the provider sent, reduced to what a test cares about. */
interface Sent {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/** Answers one command. Returning an `Error` makes the fake client throw it. */
type Responder = (command: Sent) => unknown;

/** A failure shaped the way the AWS SDK throws one. */
function sdkError(name: string): Error {
  return Object.assign(new Error(`${name} occurred`), { name });
}

interface Harness {
  readonly fs: S3FileSystem;
  /** Every command sent, in order. */
  readonly sent: Sent[];
  /** Every client configuration built, so a test can check what `connect` asked for. */
  readonly configs: S3ClientConfig[];
  destroyed(): number;
}

function harness(
  responder: Responder = () => ({}),
  settings: Readonly<Record<string, unknown>> = {},
  secret: Readonly<Record<string, unknown>> = { accessKeyId: 'key', secretAccessKey: 'secret' },
): Harness {
  const sent: Sent[] = [];
  const configs: S3ClientConfig[] = [];
  let destroyed = 0;

  const client = {
    // The command's class name is how a test says which call it is answering.
    // The SDK's own commands carry their input on `.input`.
    send: async (command: { input: Readonly<Record<string, unknown>> }): Promise<unknown> => {
      const record: Sent = { name: command.constructor.name, input: command.input };
      sent.push(record);
      const answer = responder(record);
      if (answer instanceof Error) throw answer;
      return answer ?? {};
    },
    destroy: () => {
      destroyed += 1;
    },
  };

  const config: ConnectionConfig = {
    id: 'unit',
    providerId: 's3',
    label: 'unit',
    settings: { bucket: 'omni-fs-test', region: 'us-east-1', forcePathStyle: true, ...settings },
  };

  const fs = new S3FileSystem(
    { config, getSecret: async () => secret, logger: NOOP_LOGGER },
    {
      createClient: (built) => {
        configs.push(built);
        return client as unknown as S3Client;
      },
    },
  );

  return { fs, sent, configs, destroyed: () => destroyed };
}

/** Connects a harness, so a test can go straight to the call it is about. */
async function connected(
  responder?: Responder,
  settings?: Readonly<Record<string, unknown>>,
): Promise<Harness> {
  const h = harness(responder, settings);
  await h.fs.connect();
  h.sent.length = 0;
  return h;
}

async function collectList(fs: S3FileSystem, path: RemotePath): Promise<DirEntry[]> {
  const entries: DirEntry[] = [];
  for await (const entry of fs.list(path)) entries.push(entry);
  return entries;
}

async function codeOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    if (OmniFsError.is(error)) return error.code;
    throw error;
  }
  throw new Error('Expected the call to reject, but it resolved.');
}

const p = (value: string): RemotePath => RemotePath.parse(value);

describe('connect', () => {
  it('builds the client from the connection settings and the stored credentials', async () => {
    const h = harness(() => ({}), { endpoint: 'http://localhost:9000', region: 'eu-west-1' });
    await h.fs.connect();

    const config = h.configs[0];
    expect(config?.region).toBe('eu-west-1');
    expect(config?.endpoint).toBe('http://localhost:9000');
    expect(config?.forcePathStyle).toBe(true);
    expect(config?.credentials).toEqual({ accessKeyId: 'key', secretAccessKey: 'secret' });
  });

  it('omits the endpoint entirely for real AWS rather than sending undefined', async () => {
    const h = harness();
    await h.fs.connect();
    expect(h.configs[0] && 'endpoint' in h.configs[0]).toBe(false);
  });

  it('is idempotent, so a second caller does not open a second client', async () => {
    const h = harness();
    await h.fs.connect();
    await h.fs.connect();

    expect(h.configs).toHaveLength(1);
    expect(h.fs.isAlive()).toBe(true);
  });

  it('names the missing field when a credential is absent', async () => {
    const h = harness(() => ({}), {}, { accessKeyId: 'key' });

    await expect(h.fs.connect()).rejects.toSatisfy(
      (error: unknown) =>
        OmniFsError.is(error) &&
        error.code === 'AuthenticationFailed' &&
        error.message.includes('secretAccessKey'),
    );
  });

  it('passes a session token through only when one was stored', async () => {
    const withToken = harness(
      () => ({}),
      {},
      {
        accessKeyId: 'key',
        secretAccessKey: 'secret',
        sessionToken: 'temporary',
      },
    );
    await withToken.fs.connect();
    expect(withToken.configs[0]?.credentials).toEqual({
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      sessionToken: 'temporary',
    });
  });

  it('releases the client on dispose', async () => {
    const h = harness();
    await h.fs.connect();
    await h.fs[Symbol.asyncDispose]();

    expect(h.destroyed()).toBe(1);
    expect(h.fs.isAlive()).toBe(false);
  });

  it('reports a call made before connect as ConnectionFailed, not as a crash', async () => {
    const h = harness();
    // Reaching a method first is a wiring mistake; it has to arrive in the
    // shared vocabulary like everything else, not as a TypeError on undefined.
    expect(await codeOf(h.fs.stat(p('/a.txt')))).toBe('ConnectionFailed');
  });
});

describe('stat', () => {
  it('reads a file from the object metadata', async () => {
    const modified = new Date('2026-01-02T03:04:05Z');
    const h = await connected(() => ({
      ContentLength: 42,
      LastModified: modified,
      ETag: '"abc"',
      ContentType: 'text/plain',
    }));

    const stat = await h.fs.stat(p('/docs/guide.md'));

    expect(stat.type).toBe('file');
    expect(stat.size).toBe(42);
    expect(stat.mtime).toBe(modified.getTime());
    expect(stat.etag).toBe('"abc"');
    expect(h.sent[0]?.input['Key']).toBe('docs/guide.md');
  });

  it('answers the bucket root as a directory without asking the server', async () => {
    // There is no object to head, and every connection's tree starts here, so
    // a round trip per connection is a round trip for nothing.
    const h = await connected();

    expect((await h.fs.stat(RemotePath.ROOT)).type).toBe('directory');
    expect(h.sent).toHaveLength(0);
  });

  it('falls back to a one-key prefix probe when there is no object', async () => {
    const h = await connected((command) =>
      command.name === 'HeadObjectCommand' ? sdkError('NotFound') : { KeyCount: 1 },
    );

    expect((await h.fs.stat(p('/docs'))).type).toBe('directory');
    const probe = h.sent[1];
    expect(probe?.name).toBe('ListObjectsV2Command');
    // The trailing slash is what keeps `/docs` from matching `/docs-archive`,
    // and one key is all the question needs.
    expect(probe?.input['Prefix']).toBe('docs/');
    expect(probe?.input['MaxKeys']).toBe(1);
  });

  it('reports NotFound when the path is neither an object nor a prefix', async () => {
    const h = await connected((command) =>
      command.name === 'HeadObjectCommand' ? sdkError('NotFound') : { KeyCount: 0 },
    );

    expect(await codeOf(h.fs.stat(p('/nope')))).toBe('NotFound');
  });

  it('does not disguise a permission failure as a missing path', async () => {
    // The fallback exists for "no such object". Letting anything else through
    // it turns a 403 into NotFound, which the VS Code adapter reads as
    // create-on-save — so a file the user cannot read gets silently replaced
    // by whatever the editor had in its buffer.
    const h = await connected(() => sdkError('AccessDenied'));

    expect(await codeOf(h.fs.stat(p('/secret.txt')))).toBe('PermissionDenied');
    // And no probe was attempted: the question was already answered.
    expect(h.sent).toHaveLength(1);
  });
});

describe('list', () => {
  it('reads CommonPrefixes as directories and Contents as files', async () => {
    const h = await connected(() => ({
      CommonPrefixes: [{ Prefix: 'docs/' }, { Prefix: 'data/' }],
      Contents: [{ Key: 'readme.txt', Size: 19, ETag: '"e"' }],
    }));

    const entries = await collectList(h.fs, RemotePath.ROOT);

    expect(entries.map((entry) => [entry.name, entry.type])).toEqual([
      ['docs', 'directory'],
      ['data', 'directory'],
      ['readme.txt', 'file'],
    ]);
    // Entry paths have to be absolute and resolvable, not bare names, or the
    // caller cannot act on what it just listed.
    expect(entries[0]?.path.value).toBe('/docs');
    expect(entries[2]?.path.value).toBe('/readme.txt');
  });

  it('asks for a delimited listing, which is what makes folders appear at all', async () => {
    const h = await connected(() => ({}));
    await collectList(h.fs, p('/docs'));

    expect(h.sent[0]?.input['Delimiter']).toBe('/');
    expect(h.sent[0]?.input['Prefix']).toBe('docs/');
  });

  it('hides the placeholder key that stands for the folder itself', async () => {
    // Console uploads and `aws s3 sync` leave a zero-byte object named exactly
    // like the prefix. It is this folder, not a child of it, and listing it
    // would show an unopenable empty entry with no name.
    const h = await connected(() => ({
      Contents: [
        { Key: 'docs/', Size: 0 },
        { Key: 'docs/guide.md', Size: 7 },
      ],
    }));

    const entries = await collectList(h.fs, p('/docs'));

    expect(entries.map((entry) => entry.name)).toEqual(['guide.md']);
  });

  it('hides a nested placeholder key ending in a slash', async () => {
    const h = await connected(() => ({
      Contents: [
        { Key: 'docs/nested/', Size: 0 },
        { Key: 'docs/a.txt', Size: 1 },
      ],
    }));

    expect((await collectList(h.fs, p('/docs'))).map((entry) => entry.name)).toEqual(['a.txt']);
  });

  it('follows the continuation token until the listing is complete', async () => {
    // A bucket with more than a thousand keys in one folder is ordinary, and a
    // reader that stops at the first page silently shows a truncated tree.
    let page = 0;
    const h = await connected(() => {
      page += 1;
      return page === 1
        ? { Contents: [{ Key: 'one.txt' }], IsTruncated: true, NextContinuationToken: 'next' }
        : { Contents: [{ Key: 'two.txt' }], IsTruncated: false };
    });

    const entries = await collectList(h.fs, RemotePath.ROOT);

    expect(entries.map((entry) => entry.name)).toEqual(['one.txt', 'two.txt']);
    expect(h.sent[0]?.input['ContinuationToken']).toBeUndefined();
    expect(h.sent[1]?.input['ContinuationToken']).toBe('next');
  });

  it('scopes the listing to the connection root prefix', async () => {
    const h = await connected(() => ({ Contents: [{ Key: 'projects/site/a.txt' }] }), {
      rootPrefix: 'projects/site',
    });

    const entries = await collectList(h.fs, RemotePath.ROOT);

    expect(h.sent[0]?.input['Prefix']).toBe('projects/site/');
    // The prefix is an implementation detail of the connection: the path the
    // caller gets back is relative to the connection root, not to the bucket.
    expect(entries[0]?.path.value).toBe('/a.txt');
  });
});

describe('createReadStream', () => {
  it('spells a counted range inclusively', async () => {
    const h = await connected(() => ({
      Body: { transformToWebStream: () => streamFrom(new TextEncoder().encode('omni-fs')) },
    }));

    await h.fs.createReadStream(p('/readme.txt'), { offset: 0, length: 7 });

    expect(h.sent[0]?.input['Range']).toBe('bytes=0-6');
  });

  it('answers a zero-length read without fetching, but still proves the path exists', async () => {
    // There is no Range spelling for zero bytes. Sending the arithmetic's
    // `bytes=0--1` gets a 416 from S3, or gets ignored and returns the whole
    // object to a caller that asked for none of it.
    const h = await connected((command) =>
      command.name === 'HeadObjectCommand' ? { ContentLength: 19 } : {},
    );

    const stream = await h.fs.createReadStream(p('/readme.txt'), { offset: 3, length: 0 });

    expect((await collectStream(stream)).byteLength).toBe(0);
    expect(h.sent.map((command) => command.name)).toEqual(['HeadObjectCommand']);
  });

  it('still reports a missing path on a zero-length read', async () => {
    // Without the existence check this would be an empty success, where
    // `MemoryFileSystem` — the contract's reference — raises NotFound.
    const h = await connected(() => sdkError('NotFound'));

    expect(await codeOf(h.fs.createReadStream(p('/gone.txt'), { offset: 0, length: 0 }))).toBe(
      'NotFound',
    );
  });
});

describe('writeFile and copy', () => {
  it('refuses to overwrite without sending anything when the object is there', async () => {
    const h = await connected(() => ({ ContentLength: 1 }));

    expect(
      await codeOf(h.fs.writeFile(p('/a.txt'), new Uint8Array([1]), { overwrite: false })),
    ).toBe('AlreadyExists');
    expect(h.sent.map((command) => command.name)).toEqual(['HeadObjectCommand']);
  });

  it('names the source bucket and key on a server-side copy', async () => {
    const h = await connected(() => ({}));

    await h.fs.copy(p('/docs/guide.md'), p('/docs/copy.md'));

    const copy = h.sent[0];
    expect(copy?.name).toBe('CopyObjectCommand');
    expect(copy?.input['CopySource']).toBe('omni-fs-test/docs/guide.md');
    expect(copy?.input['Key']).toBe('docs/copy.md');
  });

  it('refuses a copy onto an existing destination without sending one', async () => {
    const h = await connected(() => ({ ContentLength: 1 }));

    expect(await codeOf(h.fs.copy(p('/a.txt'), p('/b.txt'), { overwrite: false }))).toBe(
      'AlreadyExists',
    );
    expect(h.sent.every((command) => command.name !== 'CopyObjectCommand')).toBe(true);
  });
});

describe('delete', () => {
  it('sweeps a whole prefix on a recursive delete', async () => {
    const h = await connected((command) =>
      command.name === 'ListObjectsV2Command'
        ? { Contents: [{ Key: 'docs/a.txt' }, { Key: 'docs/nested/b.txt' }], IsTruncated: false }
        : {},
    );

    await h.fs.delete(p('/docs'), { recursive: true });

    const batch = h.sent.find((command) => command.name === 'DeleteObjectsCommand');
    expect(batch?.input['Delete']).toEqual({
      Objects: [{ Key: 'docs/a.txt' }, { Key: 'docs/nested/b.txt' }],
      Quiet: true,
    });
  });

  it('lists a recursive delete without a delimiter, so it reaches every level', async () => {
    // A delimited listing stops at the first level and leaves the whole tree
    // below it behind.
    const h = await connected(() => ({ Contents: [], IsTruncated: false }));
    await h.fs.delete(p('/docs'), { recursive: true });

    const listing = h.sent.find((command) => command.name === 'ListObjectsV2Command');
    expect(listing?.input['Delimiter']).toBeUndefined();
  });

  it('follows pagination so a large tree is fully removed', async () => {
    let page = 0;
    const h = await connected((command) => {
      if (command.name !== 'ListObjectsV2Command') return {};
      page += 1;
      return page === 1
        ? { Contents: [{ Key: 'docs/a.txt' }], IsTruncated: true, NextContinuationToken: 'next' }
        : { Contents: [{ Key: 'docs/b.txt' }], IsTruncated: false };
    });

    await h.fs.delete(p('/docs'), { recursive: true });

    const batches = h.sent.filter((command) => command.name === 'DeleteObjectsCommand');
    expect(batches).toHaveLength(2);
  });

  it('succeeds when the folder has no placeholder key to remove', async () => {
    // The trailing single delete is a sweep for the placeholder object some
    // tools leave. Most folders do not have one, so its absence is the normal
    // case and must not fail a delete that already did its work.
    const h = await connected((command) => {
      if (command.name === 'ListObjectsV2Command') {
        return { Contents: [{ Key: 'docs/a.txt' }], IsTruncated: false };
      }
      return command.name === 'DeleteObjectCommand' ? sdkError('NoSuchKey') : {};
    });

    await expect(h.fs.delete(p('/docs'), { recursive: true })).resolves.toBeUndefined();
  });

  it('deletes a single object when the caller did not ask for recursion', async () => {
    const h = await connected(() => ({}));

    await h.fs.delete(p('/docs/a.txt'));

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.name).toBe('DeleteObjectCommand');
    expect(h.sent[0]?.input['Key']).toBe('docs/a.txt');
  });
});
