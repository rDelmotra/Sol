import { Component, type ReactNode } from 'react';

/**
 * One per HUD region. A render error hides only that region; the globe and
 * every other region keep working. Ported from the spike's CockpitOverlayApp.
 */
export class HudErrorBoundary extends Component<{ region: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(err: unknown) {
    console.error(`[cockpit HUD] ${this.props.region} render error, region hidden:`, err);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
