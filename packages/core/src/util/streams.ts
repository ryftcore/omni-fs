/**
 * Stream helpers.
 *
 * Core deliberately targets the ES2023 lib without DOM types, so `Response` and
 * `BodyInit` are not available to buffer a stream. Doing it by hand is a dozen
 * lines and keeps the package free of a DOM lib dependency it does not
 * otherwise need — which matters because the desktop renderer, the extension
 * host and Node tests all load this code under different global sets.
 */
export async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  return concat(chunks, total);
}

export function concat(chunks: readonly Uint8Array[], total?: number): Uint8Array {
  const size = total ?? chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** Wraps a buffer as a single-chunk readable stream. */
export function streamFrom(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
}
