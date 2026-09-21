import { trimTrailingSlashes } from '@omni-fs/core';
import type { DirEntry, FileStat, FileType, ReadOptions, RemotePath } from '@omni-fs/core';

/**
 * What this provider needs from a listing entry, already translated out of
 * `basic-ftp`'s vocabulary. `mtime` is epoch millis, and `undefined` when the
 * listing format could not be trusted to carry one.
 */
export interface FtpEntry {
  readonly name: string;
  readonly type: FileType;
  readonly size: number;
  readonly mtime: number | undefined;
  readonly mode: number | undefined;
}

/**
 * The part of `basic-ftp`'s `FileInfo` this provider reads. Declared
 * structurally so the helpers stay free of the library and the tests can build
 * one with an object literal.
 */
export interface FileInfoLike {
  readonly name: string;
  readonly type: number;
  readonly size: number;
  readonly modifiedAt?: Date | undefined;
  readonly permissions?:
    { readonly user: number; readonly group: number; readonly world: number } | undefined;
}

/** `length` is enforced by this client: `RETR` has no end position. */
export interface FtpReadRange {
  readonly start: number;
  readonly length?: number | undefined;
}

/** `basic-ftp`'s `FileType` enum, which reaches us as a number on `FileInfo`. */
const FILE_TYPES: Readonly<Record<number, FileType>> = {
  0: 'unknown',
  1: 'file',
  2: 'directory',
  3: 'symlink',
};

export function toFileType(raw: number): FileType {
  return FILE_TYPES[raw] ?? 'unknown';
}

export function fromFileInfo(info: FileInfoLike): FtpEntry {
  return {
    name: info.name,
    type: toFileType(info.type),
    size: info.size,
    // Only MLSD guarantees a date that can be parsed with the right timezone.
    // `basic-ftp` leaves `modifiedAt` unset for LIST formats precisely so a
    // caller does not have to guess, and guessing is what we decline to do.
    mtime: info.modifiedAt?.getTime(),
    mode: toMode(info.permissions),
  };
}

/**
 * `etag` is left unset: FTP has no version token, which is what
 * `hasVersionTokens: false` declares. Synthesising one from size and mtime
 * would make `ifMatch` look atomic when it would be a racy re-stat.
 */
export function toFileStat(entry: FtpEntry): FileStat {
  return { type: entry.type, size: entry.size, mtime: entry.mtime, mode: entry.mode };
}

export function toDirEntry(entry: FtpEntry, parent: RemotePath): DirEntry {
  return { ...toFileStat(entry), name: entry.name, path: parent.join(entry.name) };
}

/**
 * Where this connection starts on the server.
 *
 * An empty prefix is the login directory, an absolute one is itself, and a
 * relative one sits below the login directory. The login directory comes from
 * `PWD` at connect, which is the only way to learn it.
 */
export function resolveBase(rootPrefix: string, loginDirectory: string): string {
  if (rootPrefix.startsWith('/')) return normalise(rootPrefix);
  if (rootPrefix === '') return normalise(loginDirectory);
  return normalise(`${loginDirectory}/${rootPrefix}`);
}

/** `RemotePath` is already absolute and normalised, so this is concatenation. */
export function joinRemote(base: string, path: RemotePath): string {
  if (path.isRoot) return base;
  return base === '/' ? path.value : `${base}${path.value}`;
}

/**
 * `ReadOptions` to an FTP range.
 *
 * `start` becomes `REST`. `length` has no wire representation at all — `RETR`
 * runs to end of file — so the channel counts bytes and cuts the transfer,
 * which costs the control channel. See spec decision 6.
 *
 * `'empty'` means the caller asked for no bytes: `{ offset: 5, length: 0 }`
 * would otherwise be indistinguishable from an open-ended read at 5.
 */
export function buildRange(options: ReadOptions | undefined): FtpReadRange | 'empty' | undefined {
  if (options?.offset === undefined) return undefined;
  const start = options.offset;
  if (options.length === undefined) return { start };
  return options.length <= 0 ? 'empty' : { start, length: options.length };
}

/**
 * Reads the fact line out of an `MLST` reply.
 *
 * `basic-ftp` parses MLSD listings but does not re-export the line parser
 * (`parseListMLSD.parseLine` is absent from `dist/index.d.ts`), and reaching
 * into `dist/` for it would pin this package to a private module path. RFC 3659
 * section 7 is a short grammar, so it is parsed here instead.
 *
 * The reply is three lines — `250-`, one space-prefixed fact line, `250 End` —
 * and `parseControlResponse` has already joined them with `\n` and normalised
 * CRLF. Anything unparseable returns `undefined`, and the caller falls back to
 * listing the parent: a slower answer rather than a failed one.
 */
export function parseMlstResponse(text: string): FtpEntry | undefined {
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/^\s+/, '');
    const space = trimmed.indexOf(' ');
    if (space <= 0) continue;

    const factText = trimmed.slice(0, space);
    if (!factText.includes('=')) continue;

    const pathname = trimmed.slice(space + 1).trim();
    if (pathname === '') continue;

    return toEntry(parseFacts(factText), pathname);
  }
  return undefined;
}

function parseFacts(factText: string): ReadonlyMap<string, string> {
  const facts = new Map<string, string>();
  for (const fact of factText.split(';')) {
    if (fact === '') continue;
    const equals = fact.indexOf('=');
    if (equals <= 0) continue;
    // RFC 3659: fact names are case-insensitive. `UNIX.mode` and `unix.mode`
    // are the same fact, and servers disagree about which to send.
    facts.set(fact.slice(0, equals).toLowerCase(), fact.slice(equals + 1));
  }
  return facts;
}

function toEntry(facts: ReadonlyMap<string, string>, pathname: string): FtpEntry {
  const size = Number(facts.get('size'));
  return {
    name: basename(pathname),
    type: factType(facts.get('type')),
    size: Number.isFinite(size) ? size : 0,
    mtime: parseMlsxDate(facts.get('modify')),
    mode: parseOctal(facts.get('unix.mode')),
  };
}

function factType(value: string | undefined): FileType {
  if (value === undefined) return 'unknown';
  const lowered = value.toLowerCase();
  if (lowered === 'file') return 'file';
  if (lowered === 'dir' || lowered === 'cdir' || lowered === 'pdir') return 'directory';
  // `type=OS.unix=slink:/target` is how a symlink arrives, when it arrives.
  if (lowered.startsWith('os.unix=slink')) return 'symlink';
  return 'unknown';
}

/** `YYYYMMDDHHMMSS[.sss]`, always UTC — RFC 3659 section 2.3. */
function parseMlsxDate(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,3}))?$/.exec(value);
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second, fraction] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    fraction === undefined ? 0 : Number(fraction.padEnd(3, '0')),
  );
}

function parseOctal(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 8);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function toMode(permissions: FileInfoLike['permissions']): number | undefined {
  if (permissions === undefined) return undefined;
  return (permissions.user << 6) | (permissions.group << 3) | permissions.world;
}

function basename(pathname: string): string {
  const slash = pathname.lastIndexOf('/');
  return slash === -1 ? pathname : pathname.slice(slash + 1);
}

function normalise(value: string): string {
  const collapsed = trimTrailingSlashes(`/${value}`.replace(/\/+/g, '/'));
  return collapsed === '' ? '/' : collapsed;
}
