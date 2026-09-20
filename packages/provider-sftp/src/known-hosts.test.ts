import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fingerprint, parseKnownHosts, verifyHostKey } from './known-hosts.js';

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
    const printed = fingerprint(ours);
    expect(printed.startsWith('SHA256:')).toBe(true);
    expect(printed).not.toContain('=');
  });
});
