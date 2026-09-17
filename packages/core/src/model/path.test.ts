import { describe, expect, it } from 'vitest';
import { RemotePath } from './path.js';

describe('RemotePath', () => {
  it('normalises to an absolute path without a trailing slash', () => {
    expect(RemotePath.parse('a/b/').value).toBe('/a/b');
    expect(RemotePath.parse('/a//b///c').value).toBe('/a/b/c');
    expect(RemotePath.parse('').value).toBe('/');
    expect(RemotePath.parse('///').value).toBe('/');
  });

  it('resolves . and .. segments', () => {
    expect(RemotePath.parse('/a/b/../c').value).toBe('/a/c');
    expect(RemotePath.parse('/a/./b').value).toBe('/a/b');
    // Escaping above the connection root is clamped, not an error: a provider
    // must never be handed a path outside the root it was configured with.
    expect(RemotePath.parse('/../../etc/passwd').value).toBe('/etc/passwd');
  });

  it('derives parent and basename', () => {
    const path = RemotePath.parse('/bucket/assets/logo.png');
    expect(path.parent.value).toBe('/bucket/assets');
    expect(path.basename).toBe('logo.png');
    expect(path.extension).toBe('.png');
    expect(RemotePath.ROOT.parent.isRoot).toBe(true);
    expect(RemotePath.parse('/top').parent.isRoot).toBe(true);
  });

  it('treats a leading dot as part of the name, not an extension', () => {
    expect(RemotePath.parse('/.gitignore').extension).toBe('');
    expect(RemotePath.parse('/.env.local').extension).toBe('.local');
  });

  it('converts to object-store keys and prefixes', () => {
    const dir = RemotePath.parse('/assets/img');
    expect(dir.toKey()).toBe('assets/img');
    expect(dir.toPrefix()).toBe('assets/img/');
    expect(RemotePath.ROOT.toKey()).toBe('');
    expect(RemotePath.ROOT.toPrefix()).toBe('');
  });

  it('tests containment without matching sibling prefixes', () => {
    const dir = RemotePath.parse('/assets');
    expect(dir.contains(RemotePath.parse('/assets/logo.png'))).toBe(true);
    expect(dir.contains(dir)).toBe(true);
    // The bug this guards: '/assets-backup' must not count as inside '/assets'.
    expect(dir.contains(RemotePath.parse('/assets-backup/logo.png'))).toBe(false);
    expect(RemotePath.ROOT.contains(RemotePath.parse('/anything'))).toBe(true);
  });

  it('computes relative paths', () => {
    const dir = RemotePath.parse('/assets');
    expect(dir.relative(RemotePath.parse('/assets/img/logo.png'))).toBe('img/logo.png');
    expect(dir.relative(dir)).toBe('');
    expect(dir.relative(RemotePath.parse('/other'))).toBeUndefined();
    expect(RemotePath.ROOT.relative(RemotePath.parse('/a/b'))).toBe('a/b');
  });

  it('joins segments', () => {
    expect(RemotePath.ROOT.join('a', 'b').value).toBe('/a/b');
    expect(RemotePath.parse('/a').join('../b').value).toBe('/b');
  });
});
