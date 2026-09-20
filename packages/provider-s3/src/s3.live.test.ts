import { describe, expect, it } from 'vitest';
import { NOOP_LOGGER, OmniFsError, RemotePath } from '@omni-fs/core';
import type { ConnectionConfig, DirEntry, RemoteFileSystem } from '@omni-fs/core';
import { runConformanceSuite } from '@omni-fs/testing';
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
  type ObjectIdentifier,
} from '@aws-sdk/client-s3';
import { S3FileSystem } from './s3-file-system.js';

const ENDPOINT = process.env['OMNI_FS_S3_ENDPOINT'] ?? 'http://localhost:9000';
const BUCKET = process.env['OMNI_FS_S3_BUCKET'] ?? 'omni-fs-test';
const EMPTY_BUCKET = process.env['OMNI_FS_S3_EMPTY_BUCKET'] ?? 'omni-fs-empty';
const REGION = process.env['OMNI_FS_S3_REGION'] ?? 'us-east-1';
const ACCESS_KEY = process.env['OMNI_FS_S3_ACCESS_KEY'] ?? 'omnifs';
const SECRET_KEY = process.env['OMNI_FS_S3_SECRET_KEY'] ?? 'omnifs-dev-secret';

/**
 * `settings` is merged over the defaults so a case can vary one key without
 * restating the connection. `rootPrefix` and `bucket` both need it: each is
 * read once in the constructor, so there is no setter to reach afterwards.
 */
export function connect(settings: Readonly<Record<string, unknown>> = {}): S3FileSystem {
  const config: ConnectionConfig = {
    id: 'live',
    providerId: 's3',
    label: 'live',
    settings: {
      bucket: BUCKET,
      region: REGION,
      endpoint: ENDPOINT,
      // MinIO does not serve virtual-hosted-style requests on localhost.
      forcePathStyle: true,
      ...settings,
    },
  };
  return new S3FileSystem({
    config,
    getSecret: async () => ({ accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY }),
    logger: NOOP_LOGGER,
  });
}

function rawClient(): S3Client {
  return new S3Client({
    region: REGION,
    endpoint: ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  });
}

/**
 * Cleanup goes through the raw SDK on purpose: it must still work when the
 * method under test does not, or one failing `delete` would leave a
 * `conformance-*` prefix behind for every run after it.
 */
async function removeTree(prefix: string, bucket: string = BUCKET): Promise<void> {
  const client = rawClient();
  try {
    let continuationToken: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ...(continuationToken !== undefined ? { ContinuationToken: continuationToken } : {}),
        }),
      );
      const objects = (page.Contents ?? [])
        .map((object): ObjectIdentifier | undefined =>
          object.Key === undefined ? undefined : { Key: object.Key },
        )
        .filter((object): object is ObjectIdentifier => object !== undefined);

      if (objects.length > 0) {
        await client.send(
          new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }),
        );
      }
      continuationToken = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);
  } finally {
    client.destroy();
  }
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

async function listAll(fs: RemoteFileSystem, path: RemotePath): Promise<DirEntry[]> {
  const entries: DirEntry[] = [];
  for await (const entry of fs.list(path)) entries.push(entry);
  return entries;
}

/**
 * The shared behavioural contract, run against a live MinIO. This is what
 * decides the provider is finished: the cases below it are this package's own,
 * and drift between the four providers is exactly what they cannot catch.
 *
 * Declared ahead of them on purpose. The suite creates and removes a prefix per
 * case, and `leaves the seeded tree exactly as it found it` at the bottom of
 * this file then runs after all of them and proves nothing survived. That
 * ordering rests on vitest's default of running suites in declaration order:
 * turn on `sequence.shuffle` or mark either suite `.concurrent` and the
 * cross-check stops holding silently, with no failure pointing at the cause.
 *
 * `runConformanceSuite` calls `setup()` inside *every* case rather than once
 * per run, so each gets a root of its own. A timestamp alone would not keep
 * them apart — two cases can enter the same millisecond — hence the counter.
 * And `teardown` is handed only the filesystem, never the root, so the pairing
 * has to be remembered here or nothing could ever delete them.
 */
let conformanceRuns = 0;
const conformanceRoots = new WeakMap<RemoteFileSystem, RemotePath>();

runConformanceSuite({
  name: 'S3 (MinIO)',
  setup: async () => {
    const fs = connect();
    await fs.connect();
    conformanceRuns += 1;
    // No directory to create: on an object store the root is simply a prefix
    // nothing has been written under yet. That is the whole difference this
    // provider exists to absorb.
    const root = RemotePath.parse(`/conformance-${String(Date.now())}-${String(conformanceRuns)}`);
    conformanceRoots.set(fs, root);
    return { fs, root };
  },
  teardown: async (fs) => {
    const root = conformanceRoots.get(fs);
    conformanceRoots.delete(fs);
    if (root !== undefined) await removeTree(`${root.toKey()}/`);
    await fs[Symbol.asyncDispose]();
  },
});

describe('S3FileSystem against a live MinIO', () => {
  it('connects and stats the root as a directory', async () => {
    const fs = connect();
    try {
      await fs.connect();
      // Local state only — `connect()` builds a client and does no I/O. The
      // listing below is what proves the server is reachable and the
      // credentials work.
      expect(fs.isAlive()).toBe(true);
      expect((await fs.stat(RemotePath.ROOT)).type).toBe('directory');
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('lists the seeded bucket, reporting prefixes as directories', async () => {
    const fs = connect();
    try {
      await fs.connect();
      const byName = new Map((await listAll(fs, RemotePath.ROOT)).map((e) => [e.name, e]));

      // `docs` and `data` are not objects. They exist only because keys share
      // that prefix, and the provider is what makes them look like folders.
      expect(byName.get('docs')?.type).toBe('directory');
      expect(byName.get('data')?.type).toBe('directory');
      expect(byName.get('readme.txt')?.type).toBe('file');
      // Entry paths must be absolute and resolvable, not bare names.
      expect(byName.get('readme.txt')?.path.value).toBe('/readme.txt');
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('stats a prefix as a directory although no object has that key', async () => {
    const fs = connect();
    try {
      await fs.connect();
      // The centrepiece of the emulation: HeadObject 404s here, and the
      // one-key probe is what turns that into "it is a folder".
      expect((await fs.stat(RemotePath.parse('/docs'))).type).toBe('directory');
      expect((await fs.stat(RemotePath.parse('/docs/nested/deep'))).type).toBe('directory');
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('does not list grandchildren as direct children', async () => {
    const fs = connect();
    try {
      await fs.connect();
      const names = (await listAll(fs, RemotePath.parse('/docs'))).map((entry) => entry.name);

      // `docs/nested/deep/deep.txt` is three levels down. Without a delimiter
      // the whole bucket would arrive flattened into this one listing.
      expect(names).toContain('guide.md');
      expect(names).toContain('nested');
      expect(names).not.toContain('deep.txt');
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('reads an object three levels down where no directory exists', async () => {
    const fs = connect();
    try {
      await fs.connect();
      const bytes = await fs.readFile(RemotePath.parse('/docs/nested/deep/deep.txt'));
      expect(decode(bytes)).toContain('three levels down');
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('reports a missing key as NotFound', async () => {
    const fs = connect();
    try {
      await fs.connect();
      await expect(fs.stat(RemotePath.parse('/definitely-not-here.txt'))).rejects.toSatisfy(
        (error: unknown) => OmniFsError.is(error) && error.code === 'NotFound',
      );
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('errors the stream from createReadStream with a translated NotFound', async () => {
    const fs = connect();
    try {
      await fs.connect();
      await expect(
        fs.createReadStream(RemotePath.parse('/definitely-not-here.txt')),
      ).rejects.toSatisfy((error: unknown) => OmniFsError.is(error) && error.code === 'NotFound');
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('reads a byte range out of the middle of a large object', async () => {
    const fs = connect();
    try {
      await fs.connect();
      // The seed writes 3 MB of random bytes here precisely so a range read is
      // reading a range rather than incidentally reading everything.
      const slice = await fs.readFile(RemotePath.parse('/data/large.bin'), {
        offset: 1_000_000,
        length: 16,
      });
      expect(slice.byteLength).toBe(16);
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('reads no bytes for a zero-length range, but still checks the key exists', async () => {
    const fs = connect();
    try {
      await fs.connect();
      const empty = await fs.readFile(RemotePath.parse('/readme.txt'), { offset: 3, length: 0 });
      expect(empty.byteLength).toBe(0);

      // There is no Range spelling for zero bytes, so the read is answered
      // without one — but existence stays the server's to decide, or a read of
      // a missing key would come back as an empty success. `MemoryFileSystem`
      // raises NotFound here.
      await expect(
        fs.readFile(RemotePath.parse('/definitely-not-here.txt'), { offset: 0, length: 0 }),
      ).rejects.toSatisfy((error: unknown) => OmniFsError.is(error) && error.code === 'NotFound');
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('scopes a connection to a root prefix', async () => {
    const fs = connect({ rootPrefix: 'docs' });
    try {
      await fs.connect();
      const names = (await listAll(fs, RemotePath.ROOT)).map((entry) => entry.name);

      // The prefix is invisible above this line: the connection's root *is*
      // `docs/`, so `guide.md` is a top-level entry and `readme.txt` is out of
      // reach entirely.
      expect(names).toContain('guide.md');
      expect(names).not.toContain('readme.txt');
      expect(decode(await fs.readFile(RemotePath.parse('/guide.md')))).toContain('# Guide');
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('lists an empty bucket as empty rather than failing', async () => {
    const fs = connect({ bucket: EMPTY_BUCKET });
    try {
      await fs.connect();
      // A bucket with no keys returns no CommonPrefixes and no Contents, which
      // is a successful empty listing and not a missing directory.
      expect(await listAll(fs, RemotePath.ROOT)).toEqual([]);
      expect((await fs.stat(RemotePath.ROOT)).type).toBe('directory');
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('streams a write past the multipart threshold and reassembles it', async () => {
    const fs = connect();
    const path = RemotePath.parse(`/multipart-${String(Date.now())}.bin`);
    try {
      await fs.connect();

      // `createWriteStream` uses lib-storage with an 8 MB part size, so this is
      // the only case that exercises the multipart path at all: create, upload
      // parts, complete. A single-part upload proves none of it.
      const total = 9 * 1024 * 1024;
      const chunk = new Uint8Array(256 * 1024).fill(7);
      const stream = await fs.createWriteStream(path);
      const writer = stream.getWriter();
      for (let written = 0; written < total; written += chunk.byteLength) {
        await writer.write(chunk);
      }
      await writer.close();

      const stat = await fs.stat(path);
      expect(stat.size).toBe(total);
      // Read the last bytes rather than the whole object: if the final part
      // never completed, the tail is what is missing.
      const tail = await fs.readFile(path, { offset: total - 8, length: 8 });
      expect([...tail]).toEqual([7, 7, 7, 7, 7, 7, 7, 7]);
    } finally {
      await fs.delete(path).catch(() => undefined);
      await fs[Symbol.asyncDispose]();
    }
  });

  it('leaves the seeded tree exactly as it found it', async () => {
    const fs = connect();
    try {
      await fs.connect();
      const names = (await listAll(fs, RemotePath.ROOT)).map((entry) => entry.name).sort();

      // Runs last, and is the cross-check on every case above: a conformance
      // root that survived teardown, or a test object never cleaned up, shows
      // up here as an extra entry.
      expect(names).toEqual(['data', 'docs', 'readme.txt']);
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });
});
