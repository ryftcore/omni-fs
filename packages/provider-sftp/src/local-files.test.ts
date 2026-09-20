import { mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandHome, readLocalFile } from './local-files.js';

describe('expandHome', () => {
  it('expands a bare tilde', () => {
    expect(expandHome('~')).toBe(homedir());
  });

  it('expands a tilde prefix', () => {
    expect(expandHome('~/.ssh/id_ed25519')).toBe(join(homedir(), '.ssh/id_ed25519'));
  });

  it('leaves an absolute path alone', () => {
    expect(expandHome('/etc/ssh/key')).toBe('/etc/ssh/key');
  });

  it('leaves a tilde inside the path alone', () => {
    expect(expandHome('/keys/~backup/id')).toBe('/keys/~backup/id');
  });
});

describe('readLocalFile', () => {
  it('reads a file from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omni-fs-sftp-'));
    const path = join(dir, 'key');
    await writeFile(path, 'PRIVATE KEY');

    expect((await readLocalFile(path)).toString('utf8')).toBe('PRIVATE KEY');
  });

  it('rejects when the file is not there', async () => {
    await expect(readLocalFile(join(tmpdir(), 'omni-fs-sftp-definitely-absent'))).rejects.toThrow();
  });
});
