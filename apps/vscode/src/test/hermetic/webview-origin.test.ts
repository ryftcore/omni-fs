import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

/**
 * Who is allowed to speak for the extension host.
 *
 * `WebviewBackend` resolves a pending call the moment a `message` event
 * carries a matching id, and `window` is a shared bus: any frame holding a
 * handle to this one can post into it. Without a check, a stranger could
 * answer `listConnections` — or fail a `test` with a message the user would
 * read as the server's. The panel's CSP (`default-src 'none'`) means no such
 * frame can exist today, which makes this a second lock rather than the only
 * one; CodeQL's `js/missing-origin-check` is right that the lock should be
 * there either way.
 *
 * This asks a real VS Code webview what a real host message looks like, so the
 * guard rests on the editor's behaviour rather than on an assumption about it
 * — and an assumption is what it would have been: the first version of the
 * guard also required `event.source === window.parent`, and this test is what
 * showed that the source arrives as a `Window` which is neither `parent`,
 * `top` nor the frame itself. There is nothing there to name, so the origin is
 * the whole check.
 */

interface Report {
  readonly kind: 'report';
  readonly origin: string;
  readonly selfOrigin: string;
  readonly data: unknown;
}

suite('a real host message, seen from inside a real webview', () => {
  test('arrives at the webview’s own vscode-webview:// origin', async () => {
    const panel = vscode.window.createWebviewPanel(
      'omniFs.originProbe',
      'origin probe',
      vscode.ViewColumn.One,
      { enableScripts: true },
    );

    try {
      const next = (): Promise<unknown> =>
        new Promise((resolve) => {
          const sub = panel.webview.onDidReceiveMessage((message: unknown) => {
            sub.dispose();
            resolve(message);
          });
        });

      const ready = next();
      panel.webview.html = PROBE_HTML;
      assert.deepEqual(await ready, { kind: 'ready' });

      const reported = next();
      assert.equal(await panel.webview.postMessage({ kind: 'probe' }), true);
      const report = (await reported) as Report;

      assert.equal(report.kind, 'report');
      assert.deepEqual(report.data, { kind: 'probe' });
      // The rule itself: a host message carries this frame's own origin, so
      // the guard in `backend.ts` lets the real thing through.
      assert.equal(report.origin, report.selfOrigin);
      // And that origin is the per-webview scheme VS Code documents, so the
      // comparison is not accidentally accepting everything.
      assert.ok(
        report.selfOrigin.startsWith('vscode-webview://'),
        `unexpected webview origin: ${report.selfOrigin}`,
      );
    } finally {
      panel.dispose();
    }
  });
});

const PROBE_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /></head>
  <body>
    <script>
      const api = acquireVsCodeApi();
      window.addEventListener('message', (event) => {
        api.postMessage({
          kind: 'report',
          origin: event.origin,
          selfOrigin: window.origin,
          data: event.data,
        });
      });
      api.postMessage({ kind: 'ready' });
    </script>
  </body>
</html>`;
