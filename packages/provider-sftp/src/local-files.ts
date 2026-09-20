import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The only module in this package that touches the local disk.
 *
 * SFTP is the one protocol here whose credentials live on the client machine: a
 * private key at a path the user picked, and `known_hosts`. The boundary rule
 * bans `vscode` and `electron` from `packages/`, not Node, and the design
 * already assumed a path — the settings field is `kind: 'file'` and
 * `packages/ui` grew `pickFile()` for it. Concentrating the access here means
 * that if a `LocalFiles` port ever arrives with the download/upload work, it
 * replaces one file instead of being threaded through the provider.
 */
export function expandHome(path: string): string {
  if (path === '~') return homedir();
  return /^~[\\/]/.test(path) ? join(homedir(), path.slice(2)) : path;
}

export async function readLocalFile(path: string): Promise<Buffer> {
  return readFile(expandHome(path));
}
