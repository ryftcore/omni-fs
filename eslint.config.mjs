// @ts-check
// Named .mjs so Node does not have to guess the module type; the root
// package.json is intentionally not "type": "module".
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/out/**', '**/node_modules/**', '**/.turbo/**', '**/coverage/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Build scripts run under Node directly, outside any TS project.
  {
    files: ['**/*.mjs', '**/*.config.js', '**/*.config.ts'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', __dirname: 'readonly' },
    },
  },

  {
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // THE BOUNDARY RULE.
  //
  // Everything under packages/ is host-agnostic and must stay that way, or the
  // desktop app (MVP 2) cannot reuse it. This is not a style preference; it is
  // the single constraint the whole architecture rests on. See ADR-0001.
  // ---------------------------------------------------------------------------
  {
    files: ['packages/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'vscode',
              message:
                'packages/* must stay host-agnostic. Move this to apps/vscode, or express the need as a Port in @omni-fs/core/ports.',
            },
            {
              name: 'electron',
              message:
                'packages/* must stay host-agnostic. Move this to apps/desktop, or express the need as a Port in @omni-fs/core/ports.',
            },
          ],
          patterns: [
            {
              group: ['electron/*', 'vscode/*', '@omni-fs/vscode*', '@omni-fs/desktop*'],
              message: 'packages/* must not depend on a host application.',
            },
          ],
        },
      ],
    },
  },

  // @omni-fs/core is stricter still: it may not know any concrete protocol.
  // Protocol SDKs belong in packages/provider-*, behind the RemoteFileSystem
  // interface. If core imports an SDK, the contract has leaked.
  {
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@aws-sdk/*',
                'basic-ftp',
                'ssh2*',
                'webdav',
                'vscode',
                'electron',
                '@omni-fs/provider-*',
              ],
              message:
                '@omni-fs/core defines contracts only: no host APIs (vscode/electron) and no protocol SDKs. Protocol code belongs in packages/provider-*; host code belongs in apps/*. If core genuinely needs this, express it as a Port instead.',
            },
          ],
        },
      ],
    },
  },
);
