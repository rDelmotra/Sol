import CockpitOverlayApp from './spike/CockpitOverlayApp';

/* UI spike: the app now boots straight into the cockpit HUD overlaid on the real
 * engine (real Earth + live catalog + selection). The previous overlay UI
 * (HUD/SearchBar/Lens/TimeScrubber/InfoCard) is preserved verbatim in
 * App.original.tsx — restore it by swapping this file back. */
export default function App() {
  return <CockpitOverlayApp />;
}
