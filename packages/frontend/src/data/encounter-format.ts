// ============================================================
// encounter-format.ts — plain-number formatting for encounters (flybys).
// Pure: shared by the Encounters pane, the TCA countdown and the globe label.
// Numbers are shown as they are: no tiers, no severity wording.
// ============================================================

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Miss distance: metres under 1 km, kilometres above, with sensible precision. */
export function formatMiss(km: number | null | undefined): string {
  if (km === null || km === undefined || !Number.isFinite(km)) return '—';
  const metres = Math.round(km * 1000);
  if (metres < 1000) return `${metres} m`;
  if (km < 10) return `${km.toFixed(2)} km`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString('en-US')} km`;
}

/** Relative speed in km/s, two decimals. */
export function formatRelSpeed(kms: number | null | undefined): string {
  return kms === null || kms === undefined || !Number.isFinite(kms) ? '—' : `${kms.toFixed(2)} km/s`;
}

/** Probability of collision in scientific notation ("2.3e-5"); "—" when unknown. */
export function formatPc(pc: number | null | undefined): string {
  if (pc === null || pc === undefined || !Number.isFinite(pc)) return '—';
  if (pc === 0) return '0';
  return pc.toExponential(1);
}

/**
 * Countdown to TCA for a list row.
 *   ≥ 1 day  "in 1 d 4 h"      ≥ 1 h  "in 3 h 12 m"
 *   < 1 h    "T−00:01:45"      past   "passed"
 */
export function formatCountdown(tcaMs: number, nowMs: number): string {
  const dt = tcaMs - nowMs;
  if (!Number.isFinite(dt)) return '—';
  if (dt < 0) return 'passed';
  const totalS = Math.floor(dt / 1000);
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = totalS % 60;
  if (h >= 24) return `in ${Math.floor(h / 24)} d ${h % 24} h`;
  if (h >= 1) return `in ${h} h ${m} m`;
  return `T−${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

/** The on-screen flyby countdown: "TCA in 01:45" (h:mm:ss from an hour), "TCA passed" after. */
export function formatTcaClock(tcaMs: number, nowMs: number): string {
  const dt = tcaMs - nowMs;
  if (!Number.isFinite(dt)) return '—';
  if (dt < 0) return 'TCA passed';
  const totalS = Math.ceil(dt / 1000);
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = totalS % 60;
  return h >= 1 ? `TCA in ${h}:${pad2(m)}:${pad2(s)}` : `TCA in ${pad2(m)}:${pad2(s)}`;
}

/** "HH:MM:SS UTC" of an ISO instant. */
export function formatUtcClock(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(11, 19)} UTC` : '—';
}

/** The server's numbers as one line: "Closest approach 412 m at 14:03:22 UTC · Pc 2.3e-5". */
export function formatServerApproach(e: { tca: string; missKm: number; pc: number | null }): string {
  const pc = e.pc === null ? '' : ` · Pc ${formatPc(e.pc)}`;
  return `Closest approach ${formatMiss(e.missKm)} at ${formatUtcClock(e.tca)}${pc}`;
}

/** Separation drawn on the globe (client-computed from rendered positions), km. */
export function formatVisualSeparation(km: number): string {
  return `${formatMiss(km)} (visual)`;
}

/** "NAME (12345)" with the NORAD id; the id alone when the name is unknown. */
export function formatObjectLabel(o: { noradId: number; name: string | null }): string {
  return o.name ? `${o.name} (${o.noradId})` : String(o.noradId);
}

/**
 * "manoeuvred 2 d ago" for the time (ISO) of an object's latest observed orbit change, relative to `nowMs`. Plain, neutral wording.
 * Null when there is none, the time is unparseable, or `nowMs` is earlier than the change (browsing the sim clock backwards).
 */
export function formatManoeuvredAgo(iso: string | null | undefined, nowMs: number): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  const dt = nowMs - ms;
  if (!Number.isFinite(dt) || dt < 0) return null;
  const h = Math.floor(dt / 3_600_000);
  if (h >= 24) return `manoeuvred ${Math.floor(h / 24)} d ago`;
  if (h >= 1) return `manoeuvred ${h} h ago`;
  return 'manoeuvred < 1 h ago';
}

/**
 * The quiet tag under an encounter row, seen from the focused object `noradId`. The row already names the other object, so a
 * change by the other object reads "manoeuvred 2 d ago"; one by the focused object itself says so; both say which is which.
 * Null when neither has a recent orbit change on record.
 */
export function formatEncounterManoeuvre(
  e: { a: { noradId: number; lastManoeuvreAt?: string | null }; b: { noradId: number; lastManoeuvreAt?: string | null } },
  noradId: number,
  nowMs: number,
): string | null {
  const self = e.a.noradId === noradId ? e.a : e.b;
  const other = self === e.a ? e.b : e.a;
  const s = formatManoeuvredAgo(self.lastManoeuvreAt, nowMs);
  const o = formatManoeuvredAgo(other.lastManoeuvreAt, nowMs);
  if (s && o) return `this object ${s} · other ${o}`;
  if (s) return `this object ${s}`;
  return o;
}
