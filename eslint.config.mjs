// @ts-check
// Named .mjs so Node does not have to guess the module type; the root
// package.json is intentionally not "type": "module".
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  // Generated or downloaded, never authored. `out-test/**` is the extension
  // test bundle (esbuild.mjs --tests); `.vscode-test/**` is the editor that
  // `vscode-test` downloads into apps/vscode, which ships its own tsconfigs
  // and would otherwise make typescript-eslint's project root ambiguous.
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/out-test/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/.vscode-test/**',
    ],
  },

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
    files: ['packages/**/*.ts', 'packages/**/*.tsx'],
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

  // packages/ui renders the connection editor for every host, so it must not
  // reach a host's transport — not through an import (the block above) and not
  // through a global. The seam is the ConnectionsBackend port and nothing else.
  //
  // It also gets the react-hooks rules. `use-connection-manager.ts` has
  // hand-written effect cleanup, several `useCallback` dependency arrays and a
  // `cancelled` guard, with no jsdom and no component tests by design
  // (packages/ui is tested through its pure reducer and fieldView instead) —
  // `exhaustive-deps` is the only automated coverage that code gets.
  {
    files: ['packages/ui/**/*.ts', 'packages/ui/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'no-restricted-globals': [
        'error',
        {
          name: 'acquireVsCodeApi',
          message:
            'packages/ui must stay transport-agnostic. Implement ConnectionsBackend in apps/vscode instead.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='window'][property.name='parent']",
          message: 'packages/ui must stay transport-agnostic. Use the ConnectionsBackend port.',
        },
      ],
    },
  },
);
