import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import CockpitOverlayApp from './CockpitOverlayApp';

const root = document.getElementById('cockpit-root');
if (!root) throw new Error('No #cockpit-root element found');

createRoot(root).render(
  <StrictMode>
    <CockpitOverlayApp />
  </StrictMode>,
);
