import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fingerprint, parseKnownHosts, readKnownHosts, verifyHostKey } from './known-hosts.js';

/** An SSH wire-format public key blob: length-prefixed type, then the body. */
function keyBlob(type: string, body: string): Buffer {
  const typeBuf = Buffer.from(type, 'utf8');
  const bodyBuf = Buffer.from(body, 'utf8');
  const out = Buffer.alloc(4 + typeBuf.length + 4 + bodyBuf.length);
  out.writeUInt32BE(typeBuf.length, 0);
  typeBuf.copy(out, 4);
  out.writeUInt32BE(bodyBuf.length, 4 + typeBuf.length);
  bodyBuf.copy(out, 8 + typeBuf.length);
  return out;
}

const ours = keyBlob('ssh-ed25519', 'the-real-server');
const theirs = keyBlob('ssh-ed25519', 'the-impostor');
const rsa = keyBlob('ssh-rsa', 'a-different-key-type');

function line(hosts: string, key: Buffer, type = 'ssh-ed25519'): string {
  return `${hosts} ${type} ${key.toString('base64')}`;
}

describe('verifyHostKey', () => {
  it('matches a host listed with this exact key', () => {
    const entries = parseKnownHosts(line('sftp.example.com', ours));
    expect(verifyHostKey(entries, 'sftp.example.com', 22, ours)).toBe('match');
  });

  it('refuses a host listed with a different key of the same type', () => {
    const entries = parseKnownHosts(line('sftp.example.com', theirs));
    expect(verifyHostKey(entries, 'sftp.example.com', 22, ours)).toBe('mismatch');
  });

  it('treats a host listed only under another key type as unseen, not as an attack', () => {
    const entries = parseKnownHosts(line('sftp.example.com', rsa, 'ssh-rsa'));
    expect(verifyHostKey(entries, 'sftp.example.com', 22, ours)).toBe('unknown');
  });

  it('knows nothing about a host that is not listed', () => {
    const entries = parseKnownHosts(line('other.example.com', ours));
    expect(verifyHostKey(entries, 'sftp.example.com', 22, ours)).toBe('unknown');
  });

  it('matches a non-default port written as [host]:port', () => {
    const entries = parseKnownHosts(line('[localhost]:2222', ours));
    expect(verifyHostKey(entries, 'localhost', 2222, ours)).toBe('match');
    expect(verifyHostKey(entries, 'localhost', 22, ours)).toBe('unknown');
  });

  it('matches a wildcard pattern', () => {
    const entries = parseKnownHosts(line('*.example.com', ours));
    expect(verifyHostKey(entries, 'sftp.example.com', 22, ours)).toBe('match');
  });

  it('honours a negated pattern', () => {
    const entries = parseKnownHosts(line('!secret.example.com,*.example.com', ours));
    expect(verifyHostKey(entries, 'secret.example.com', 22, ours)).toBe('unknown');
    expect(verifyHostKey(entries, 'public.example.com', 22, ours)).toBe('match');
  });

  it('matches a hashed entry', () => {
    const salt = randomBytes(20);
    const hash = createHmac('sha1', salt).update('sftp.example.com').digest('base64');
    const entries = parseKnownHosts(
      `|1|${salt.toString('base64')}|${hash} ssh-ed25519 ${ours.toString('base64')}`,
    );
    expect(verifyHostKey(entries, 'sftp.example.com', 22, ours)).toBe('match');
    expect(verifyHostKey(entries, 'elsewhere.example.com', 22, ours)).toBe('unknown');
  });

  it('refuses a revoked key even when it is the one on offer', () => {
    const entries = parseKnownHosts(`@revoked ${line('sftp.example.com', ours)}`);
    expect(verifyHostKey(entries, 'sftp.example.com', 22, ours)).toBe('mismatch');
  });

  it('refuses a revoked key even when a stale plain line for it comes first', () => {
    const text = [
      line('sftp.example.com', ours),
      `@revoked ${line('sftp.example.com', ours)}`,
    ].join('\n');
    const entries = parseKnownHosts(text);
    expect(verifyHostKey(entries, 'sftp.example.com', 22, ours)).toBe('mismatch');
  });

  it('refuses a revoked key when the revocation line comes first', () => {
    const text = [
      `@revoked ${line('sftp.example.com', ours)}`,
      line('sftp.example.com', ours),
    ].join('\n');
    const entries = parseKnownHosts(text);
    expect(verifyHostKey(entries, 'sftp.example.com', 22, ours)).toBe('mismatch');
  });

  it('recognises a revocation marker regardless of case', () => {
    const entries = parseKnownHosts(`@Revoked ${line('sftp.example.com', ours)}`);
    expect(verifyHostKey(entries, 'sftp.example.com', 22, ours)).toBe('mismatch');
  });

  it('drops a line with a marker it does not recognise, rather than trusting the rest of it', () => {
    const entries = parseKnownHosts(`@bogus ${line('sftp.example.com', theirs)}`);
    expect(entries).toHaveLength(0);
    expect(verifyHostKey(entries, 'sftp.example.com', 22, ours)).toBe('unknown');
  });

  it('ignores a certificate authority line, since certificates are out of scope', () => {
    const entries = parseKnownHosts(`@cert-authority ${line('*.example.com', theirs)}`);
    expect(entries).toHaveLength(0);
    expect(verifyHostKey(entries, 'sftp.example.com', 22, ours)).toBe('unknown');
  });

  it('skips comments, blank lines and anything too short to be an entry', () => {
    const text = ['# a comment', '', '   ', 'broken-line', line('sftp.example.com', ours)].join(
      '\n',
    );
    const entries = parseKnownHosts(text);
    expect(entries).toHaveLength(1);
    expect(verifyHostKey(entries, 'sftp.example.com', 22, ours)).toBe('match');
  });
});

describe('fingerprint', () => {
  it('formats the key the way OpenSSH prints it, with no padding', () => {
    // A known vector, not a shape. This string is the only thing a user can hold
    // up against what a server's operator published before accepting an unseen
    // host, so the digest has to be the right digest: a prefix-and-padding check
    // passes just as happily for SHA-1 or MD5 under a `SHA256:` label.
    expect(fingerprint(ours)).toBe('SHA256:SbqH4jcMnwXLFpW7tqVEzGdqTMq2WO8Yv+tAgCVyuI8');
  });
});

describe('readKnownHosts', () => {
  it('reads and parses a real file from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omni-fs-sftp-known-hosts-'));
    const path = join(dir, 'known_hosts');
    await writeFile(path, line('sftp.example.com', ours));

    const entries = await readKnownHosts(path);
    expect(verifyHostKey(entries, 'sftp.example.com', 22, ours)).toBe('match');
  });

  it('treats a missing file as no entries rather than throwing', async () => {
    const entries = await readKnownHosts(
      join(tmpdir(), 'omni-fs-sftp-known-hosts-definitely-absent'),
    );
    expect(entries).toEqual([]);
  });
});
