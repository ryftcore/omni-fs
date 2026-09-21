/**
 * Trimming slashes off a path-shaped string, without a regular expression.
 *
 * Every provider normalises a `rootPrefix` and a base URL this way, and the
 * obvious spelling — `value.replace(/\/+$/, '')` — is quadratic. The engine
 * starts `\/+` at each position of a run of slashes and walks to the end of
 * the run before `$` fails, so a prefix of 200_000 slashes followed by one
 * other character takes about a minute. That value arrives from a
 * connection's settings, which live in `omniFs.connections` and are meant to
 * be committed and shared across a team, so it is not always typed by the
 * person who pays for it.
 *
 * Scanning in from the end is linear and needs no engine at all.
 */

/** `/a/b/` and `/a/b//` become `/a/b`; the separators between segments stay. */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

/** `//a/b` becomes `a/b`. */
export function trimLeadingSlashes(value: string): string {
  let start = 0;
  while (start < value.length && value[start] === '/') start += 1;
  return value.slice(start);
}

/** Both ends, leaving the separators between segments. */
export function trimSlashes(value: string): string {
  return trimLeadingSlashes(trimTrailingSlashes(value));
}
