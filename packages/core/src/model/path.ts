/**
 * Every provider speaks a POSIX-shaped, forward-slash path rooted at the
 * connection. S3 keys, FTP paths and WebDAV hrefs are all normalised into this
 * one shape at the provider boundary so nothing above it has to care.
 *
 * Invariants of a `RemotePath`:
 *  - always absolute (leading `/`)
 *  - never has a trailing slash, except the root itself which is exactly `/`
 *  - `.` and `..` are resolved away
 *  - never empty
 */
export class RemotePath {
  static readonly ROOT = new RemotePath('/');

  private constructor(readonly value: string) {}

  static parse(raw: string): RemotePath {
    const normalised = normalise(raw);
    return normalised === '/' ? RemotePath.ROOT : new RemotePath(normalised);
  }

  /** Joins segments onto this path, normalising the result. */
  join(...segments: readonly string[]): RemotePath {
    return RemotePath.parse([this.value, ...segments].join('/'));
  }

  /** The parent directory. The root is its own parent. */
  get parent(): RemotePath {
    if (this.isRoot) return this;
    const idx = this.value.lastIndexOf('/');
    return idx <= 0 ? RemotePath.ROOT : RemotePath.parse(this.value.slice(0, idx));
  }

  /** Final segment. `''` for the root. */
  get basename(): string {
    if (this.isRoot) return '';
    return this.value.slice(this.value.lastIndexOf('/') + 1);
  }

  /** Lowercased extension including the dot, or `''`. Ignores dotfiles. */
  get extension(): string {
    const name = this.basename;
    const idx = name.lastIndexOf('.');
    return idx > 0 ? name.slice(idx).toLowerCase() : '';
  }

  get isRoot(): boolean {
    return this.value === '/';
  }

  /** Path segments with the leading slash stripped. `[]` for the root. */
  get segments(): readonly string[] {
    return this.isRoot ? [] : this.value.slice(1).split('/');
  }

  /**
   * The S3-style key for this path: no leading slash. The root is `''`.
   * Providers that address objects rather than paths use this.
   */
  toKey(): string {
    return this.isRoot ? '' : this.value.slice(1);
  }

  /**
   * The S3-style prefix for listing *inside* this path: trailing slash, or `''`
   * for the root. Distinct from `toKey()` because `a/b` and `a/b/` mean
   * different things to an object store.
   */
  toPrefix(): string {
    return this.isRoot ? '' : `${this.value.slice(1)}/`;
  }

  /** True when `other` is this path or lives beneath it. */
  contains(other: RemotePath): boolean {
    if (this.isRoot) return true;
    return other.value === this.value || other.value.startsWith(`${this.value}/`);
  }

  /** Path of `other` relative to this one, or `undefined` if not contained. */
  relative(other: RemotePath): string | undefined {
    if (!this.contains(other)) return undefined;
    if (other.value === this.value) return '';
    return other.value.slice(this.isRoot ? 1 : this.value.length + 1);
  }

  equals(other: RemotePath): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }

  toJSON(): string {
    return this.value;
  }
}

function normalise(raw: string): string {
  const out: string[] = [];
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.length === 0 ? '/' : `/${out.join('/')}`;
}
