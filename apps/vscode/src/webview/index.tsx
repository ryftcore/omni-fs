import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectionManagerApp } from '@omni-fs/ui';
import '@omni-fs/ui/tokens.css';
import './theme-vscode.css';
import { WebviewBackend } from './backend.js';

// One instance, created once: `useConnectionManager`'s effect depends on the
// backend's identity, so a new object per render would re-subscribe forever.
const backend = new WebviewBackend();

const container = document.getElementById('root');
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <ConnectionManagerApp backend={backend} />
    </StrictMode>,
  );
}
