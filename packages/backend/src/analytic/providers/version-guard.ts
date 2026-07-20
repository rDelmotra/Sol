// Shared throttled version-change guard — used by every provider that reloads
// its in-memory state from the TLE cache when readVersion() changes. Catalog
// flips at most daily via cron; this keeps a full-spine scan from stat-ing
// version.json once per object.

const VERSION_CHECK_INTERVAL_MS = 1000;

export interface VersionGuard {
  /** true on first call, or when the version changed after the throttle window. */
  shouldReload(): boolean;
  /** The version string as of the last reload (null before the first reload). */
  currentVersion(): string | null;
}

export function createVersionGuard(readVersion: () => { version: string } | null): VersionGuard {
  let cachedVersion: string | null = null;
  let lastCheckMs = 0;
  let loaded = false;

  function shouldReload(): boolean {
    const now = Date.now();
    if (loaded && now - lastCheckMs < VERSION_CHECK_INTERVAL_MS) return false;
    lastCheckMs = now;
    const v = readVersion()?.version ?? null;
    if (loaded && v === cachedVersion) return false;
    cachedVersion = v;
    loaded = true;
    return true;
  }

  return { shouldReload, currentVersion: () => cachedVersion };
}
