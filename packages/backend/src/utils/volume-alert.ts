import { alertSentOn, markAlertSent, type AlertKind } from '../cache/alert-state.js';
import { sendAlert, type AlertMessage, type AlertSender } from './alert.js';
import { logDiskUsage, type DiskLevel, type DiskUsage, type StatfsFn } from './disk-usage.js';
import { logger } from './logger.js';

// ============================================================
// Volume (disk) alerts
//
// The data volume (CACHE_DIR, 500 MB on Railway, about 444 MB usable) fills slowly:
// the raw history archive adds about 4.6 MB a day and is never pruned. The disk report
// (utils/disk-usage.ts) already logs at boot and after each archive write. This module
// turns the report into an alert through the same path as every other alert
// (sendAlert: log line, optional webhook such as ntfy, optional email):
//
//   - level warn (>= 75%) or critical (>= 90%, called "error" in the alert text)
//   - at most once per UTC day PER LEVEL, remembered in alert-state.json so a restart
//     does not repeat it; a worse level (warn -> error) alerts at once
//   - no alert at level ok
//
// Checked at boot, after each raw archive write and once a day after the 02:00 cycle,
// so a slow fill is caught even when the archive write does not run. Fire and forget:
// nothing here throws and nothing waits for the network.
// ============================================================

/** About how much the raw history archive grows per day (see state/SRE_FINDINGS.md). */
export const VOLUME_GROWTH_HINT_MB_PER_DAY = 4.6;

const MB = 1_048_576;

type AlertLevel = Exclude<DiskLevel, 'ok'>;

const KIND: Record<AlertLevel, AlertKind> = { warn: 'volumeWarn', critical: 'volumeError' };
const LABEL: Record<AlertLevel, string> = { warn: 'warn', critical: 'error' };

/** Title and plain-English body. No secrets: only sizes, a percent and advice. */
export function buildVolumeAlert(usage: DiskUsage, level: AlertLevel): AlertMessage {
  const used = (usage.usedBytes / MB).toFixed(1);
  const total = (usage.totalBytes / MB).toFixed(1);
  const left = Math.max(0, usage.totalBytes - usage.usedBytes) / MB;
  const days = left / VOLUME_GROWTH_HINT_MB_PER_DAY;
  return {
    title: `OrbitWatch VOLUME ${LABEL[level]}: data volume ${usage.percent}% full`,
    body:
      `The data volume is ${usage.percent}% full: ${used} MB used of ${total} MB (level: ${LABEL[level]}). ` +
      `The raw history archive grows about ${VOLUME_GROWTH_HINT_MB_PER_DAY} MB a day, so about ` +
      `${Math.max(0, Math.floor(days))} days are left at that rate. ` +
      `Resize the Railway volume (service Volumes tab) before it fills; a full volume stops all cache and archive writes.`,
  };
}

export interface VolumeAlertDeps {
  sendAlert: AlertSender;
  now: () => number;
}

const defaultDeps: VolumeAlertDeps = { sendAlert, now: () => Date.now() };

export type VolumeAlertResult = 'sent' | 'already-sent' | 'ok' | 'unavailable';

/**
 * Decide and (fire and forget) send. `usage` is the result of a disk report, or null when
 * the platform could not tell. Never throws.
 */
export function maybeSendVolumeAlert(
  usage: DiskUsage | null,
  overrides: Partial<VolumeAlertDeps> = {},
): VolumeAlertResult {
  try {
    if (!usage) return 'unavailable';
    if (usage.level === 'ok') return 'ok';
    const deps = { ...defaultDeps, ...overrides };
    const level: AlertLevel = usage.level;
    const day = new Date(deps.now()).toISOString().slice(0, 10);
    const kind = KIND[level];
    if (alertSentOn(kind, day)) return 'already-sent';

    // Mark first: a crash or a failed send must not turn one alert into one per cycle.
    markAlertSent(kind, day);
    const alert = buildVolumeAlert(usage, level);
    try {
      Promise.resolve(deps.sendAlert(alert)).catch((err) =>
        logger.warn(`Volume alert sender failed (${(err as Error)?.name ?? 'error'})`),
      );
    } catch (err) {
      logger.warn(`Volume alert sender failed (${(err as Error)?.name ?? 'error'})`);
    }
    return 'sent';
  } catch (err) {
    logger.warn(`Volume alert check failed: ${(err as Error)?.message ?? String(err)}`);
    return 'unavailable';
  }
}

/**
 * The disk report plus the volume alert. Logs like logDiskUsage (INFO / WARN / ERROR)
 * and returns the usage. The alert is not awaited. Never throws.
 */
export async function reportDiskAndAlert(
  context: string,
  opts: { dir?: string; statfs?: StatfsFn; deps?: Partial<VolumeAlertDeps> } = {},
): Promise<DiskUsage | null> {
  const usage = await logDiskUsage(context, opts.dir, opts.statfs);
  maybeSendVolumeAlert(usage, opts.deps);
  return usage;
}
