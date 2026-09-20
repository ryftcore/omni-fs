import { createHash, createHmac } from 'node:crypto';
import { expandHome, readLocalFile } from './local-files.js';

export type HostKeyVerdict = 'match' | 'mismatch' | 'unknown';

export interface KnownHostEntry {
  /** Patterns as written, including `[host]:port` forms, wildcards and `!` negations. */
  readonly patterns: readonly string[];
  /** Set instead of `patterns` for `|1|salt|hash` lines, which hide the hostname. */
  readonly hashed: { readonly salt: string; readonly hash: string } | undefined;
  /** Base64 of the key blob, exactly as the file spells it. */
  readonly keyBase64: string;
  /** `@revoked`: the key is known and must never be accepted. */
  readonly revoked: boolean;
}

/**
 * Parses `known_hosts`, skipping anything it does not understand rather than
 * failing. A line we cannot read is one host we do not know about, which
 * degrades to trust-on-first-use; refusing to parse the file would instead
 * refuse every connection, which is a worse answer to a stray line.
 *
 * `@cert-authority` lines are dropped: certificate authentication is a non-goal,
 * and keeping them would make a CA line look like a host key and produce a
 * spurious mismatch.
 */
export function parseKnownHosts(text: string): readonly KnownHostEntry[] {
  const entries: KnownHostEntry[] = [];

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const fields = line.split(/\s+/);
    let revoked = false;
    let certAuthority = false;
    while (fields[0]?.startsWith('@') === true) {
      const marker = fields.shift();
      if (marker === '@revoked') revoked = true;
      if (marker === '@cert-authority') certAuthority = true;
    }
    if (certAuthority) continue;

    const [hosts, , keyBase64] = fields;
    if (hosts === undefined || keyBase64 === undefined || keyBase64 === '') continue;

    if (hosts.startsWith('|1|')) {
      const [, , salt, hash] = hosts.split('|');
      if (salt === undefined || hash === undefined) continue;
      entries.push({ patterns: [], hashed: { salt, hash }, keyBase64, revoked });
    } else {
      entries.push({ patterns: hosts.split(','), hashed: undefined, keyBase64, revoked });
    }
  }

  return entries;
}

/**
 * What `known_hosts` says about the key this server just offered.
 *
 * `mismatch` is reserved for the case that actually means an attack: the host is
 * listed with a *different* key **of the same type*, or the key is `@revoked`. A
 * host listed only under another key type is `unknown`, because a server
 * legitimately holds one key per algorithm and offering its ed25519 key when the
 * file records its RSA one is not evidence of anything.
 */
export function verifyHostKey(
  entries: readonly KnownHostEntry[],
  host: string,
  port: number,
  key: Buffer,
): HostKeyVerdict {
  const offered = key.toString('base64');
  const offeredType = keyType(key);
  const matching = entries.filter((entry) => matchesHost(entry, host, port));

  for (const entry of matching) {
    if (entry.keyBase64 === offered) return entry.revoked ? 'mismatch' : 'match';
  }
  for (const entry of matching) {
    if (keyType(Buffer.from(entry.keyBase64, 'base64')) === offeredType) return 'mismatch';
  }
  return 'unknown';
}

/** The key as OpenSSH prints it: `SHA256:` plus unpadded base64. */
export function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/**
 * Reads and parses `known_hosts`, defaulting to `~/.ssh/known_hosts`. A file
 * that is absent or unreadable is no entries, which means every host is unseen.
 */
export async function readKnownHosts(path: string | undefined): Promise<readonly KnownHostEntry[]> {
  try {
    const file = await readLocalFile(expandHome(path ?? '~/.ssh/known_hosts'));
    return parseKnownHosts(file.toString('utf8'));
  } catch {
    return [];
  }
}

/**
 * OpenSSH writes a non-default port as `[host]:port` and a default one bare, so
 * both spellings are offered for port 22 and only the bracketed one otherwise.
 */
function matchesHost(entry: KnownHostEntry, host: string, port: number): boolean {
  const candidates = port === 22 ? [host, `[${host}]:22`] : [`[${host}]:${port}`];

  if (entry.hashed !== undefined) {
    const { salt, hash } = entry.hashed;
    const key = Buffer.from(salt, 'base64');
    return candidates.some(
      (candidate) => createHmac('sha1', key).update(candidate).digest('base64') === hash,
    );
  }

  let matched = false;
  for (const pattern of entry.patterns) {
    const negated = pattern.startsWith('!');
    const glob = negated ? pattern.slice(1) : pattern;
    if (!candidates.some((candidate) => globMatches(glob, candidate))) continue;
    if (negated) return false;
    matched = true;
  }
  return matched;
}

function globMatches(pattern: string, value: string): boolean {
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${expression}$`, 'i').test(value);
}

/** The algorithm name from the front of an SSH wire-format key blob. */
function keyType(key: Buffer): string {
  if (key.length < 4) return '';
  const length = key.readUInt32BE(0);
  return length > 0 && length <= key.length - 4 ? key.toString('utf8', 4, 4 + length) : '';
}
