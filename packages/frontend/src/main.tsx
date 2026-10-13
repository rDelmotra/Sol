import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { startCatalogPrefetch } from './data/catalog-prefetch';

// Start the satellite catalog download now, before React mounts and before the lazy
// Engine/three.js chunks arrive. The Earth textures wait for it (see data/load-gate.ts).
startCatalogPrefetch(import.meta.env.VITE_API_URL ?? '');

const root = document.getElementById('root');
if (!root) throw new Error('No #root element found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// Register the asset Service Worker (prod only — keeps Vite HMR untouched in dev).
// It runtime-caches the heavy Earth textures + Basis transcoder so revisits and
// offline loads skip re-downloading ~6.5 MB. Registered on `load` so it never
// competes with first paint. See public/sw.js.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Best-effort: the app works fine without it (HTTP cache still applies).
    });
  });
}
