import { describe, expect, it } from 'vitest';
import { OmniFsError } from '@omni-fs/core';
import { openUploadStream, type UploadLike } from './upload-stream.js';

/** An `Upload` whose `done()` we settle by hand, mid-test. */
function controllableUpload(): {
  upload: UploadLike;
  succeed: () => void;
  fail: (error: unknown) => void;
  aborted: () => boolean;
} {
  let succeed!: () => void;
  let fail!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    succeed = resolve;
    fail = reject;
  });
  let didAbort = false;
  return {
    upload: {
      done: () => done,
      abort: async () => {
        didAbort = true;
      },
    },
    succeed,
    fail,
    aborted: () => didAbort,
  };
}

function accessDenied(): Error {
  return Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('openUploadStream', () => {
  it('rejects close() when the upload fails after the last chunk is written', async () => {
    const { upload, fail } = controllableUpload();
    const stream = openUploadStream(upload, new WritableStream<Uint8Array>(), '/reports/q3.csv');

    const writer = stream.getWriter();
    await writer.write(bytes('row-1\n'));
    const closing = writer.close();
    fail(accessDenied());

    await expect(closing).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'PermissionDenied',
    );
  });

  it('holds close() open until the upload has finished', async () => {
    const { upload, succeed } = controllableUpload();
    const stream = openUploadStream(upload, new WritableStream<Uint8Array>(), '/reports/q3.csv');

    const writer = stream.getWriter();
    await writer.write(bytes('row-1\n'));

    let closed = false;
    const closing = writer.close().then(() => {
      closed = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(false);

    succeed();
    await closing;
    expect(closed).toBe(true);
  });

  it('reports a failure that lands while writing as an OmniFsError, never a bare Error', async () => {
    const { upload } = controllableUpload();
    // lib-storage destroys the body stream when the upload fails early, which
    // is what the caller's `write()` runs into.
    const destroyed = new WritableStream<Uint8Array>({
      write() {
        throw accessDenied();
      },
    });
    const stream = openUploadStream(upload, destroyed, '/reports/q3.csv');

    await expect(stream.getWriter().write(bytes('row-1\n'))).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'PermissionDenied',
    );
  });

  it('raises no unhandled rejection when a failed upload is never awaited', async () => {
    const rejections: unknown[] = [];
    const record = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', record);
    try {
      const { upload, fail } = controllableUpload();
      openUploadStream(upload, new WritableStream<Uint8Array>(), '/reports/q3.csv');
      fail(accessDenied());
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', record);
    }

    expect(rejections).toEqual([]);
  });

  it('leaves the upload alone when the caller aborts the stream', async () => {
    const { upload, aborted } = controllableUpload();
    const stream = openUploadStream(upload, new WritableStream<Uint8Array>(), '/reports/q3.csv');

    await stream.abort(new Error('caller gave up'));

    // The AbortSignal drives `upload.abort()` in the provider; the stream's own
    // abort must not race it into a second, unasked-for abort call.
    expect(aborted()).toBe(false);
  });
});
