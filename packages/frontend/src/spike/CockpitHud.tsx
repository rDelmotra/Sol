import { useEffect, useMemo, useState } from 'react';
import './cockpit-hud.css';
import { useStore } from '../store/useStore';
import type { EnrichedTLEObject, ObjectCategory, ObjectType } from '../data/types';
import { useAnalyticAsk } from '../ui/useAnalyticAsk';

/* Cockpit-sim Space Situational Awareness HUD — WIRED to real OrbitWatch data.
 *
 * Ported from the Lovable design (Tailwind → inline styles), then wired to the
 * live engine via the Zustand store: the reticle + panes read `selectedSatellite`,
 * the contacts list is the real catalog (click = select + fly, same path as
 * SearchBar's selectByIndex), telemetry reads the sim clock / nav / counts, the
 * speed arc shows real orbital velocity, and the AI waveform drives the real Ask
 * (useAnalyticAsk). Still cockpit-first: search/filters/time-scrub from the old
 * UI aren't ported yet. `overlay` = transparent + click-through over the globe. */

/* Native <button> has no CSS reset here (no Tailwind preflight), so strip its
 * default chrome. pointerEvents 'auto' keeps hit targets clickable under the
 * click-through overlay root. */
const BUTTON_RESET: React.CSSProperties = {
  appearance: 'none',
  background: 'transparent',
  border: 'none',
  margin: 0,
  padding: 0,
  color: 'inherit',
  font: 'inherit',
  cursor: 'pointer',
  pointerEvents: 'auto',
  textAlign: 'left',
};

/* ---------------- real-data helpers ---------------- */

const EARTH_RADIUS_KM = 6371;
const MU_EARTH = 398600.4418; // km^3/s^2

const CATEGORY_LABEL: Record<ObjectCategory, string> = {
  active_satellite: 'Active satellite',
  inactive_satellite: 'Inactive satellite',
  rocket_body: 'Rocket body',
  debris: 'Debris',
  unknown: 'Unknown',
  deep_space: 'Deep space',
};

function kindCode(t: ObjectType): string {
  return t === 'satellite' ? 'SAT' : t === 'rocket_body' ? 'RKT' : t === 'debris' ? 'DEB' : 'UNK';
}

/** Circular-orbit speed at a given altitude — a real, honest approximation for the HUD. */
function orbitalVelocityKmS(altKm: number): number {
  return Math.sqrt(MU_EARTH / (EARTH_RADIUS_KM + altKm));
}

function fmtMet(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

function ageString(launchDate: string | null): string | null {
  if (!launchDate) return null;
  const then = Date.parse(launchDate);
  if (Number.isNaN(then)) return null;
  const days = (Date.now() - then) / 86_400_000;
  if (days < 0) return null;
  const y = Math.floor(days / 365.25);
  const m = Math.floor((days - y * 365.25) / 30.44);
  return `${y}Y ${m}M`;
}

function finite(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

interface DerivedOrbit {
  period: number;
  apogee: number;
  perigee: number;
  inclination: number;
  altKm: number;
}

/** Orbit params, preferring the backend fields but falling back to the OMM when
 * they're absent (the CelesTrak fetch path omits apogee/perigee/period). */
function deriveOrbit(o: EnrichedTLEObject): DerivedOrbit {
  const omm = o.omm as Record<string, unknown>;
  const mm = Number(omm?.MEAN_MOTION); // rev/day
  const ecc = Number(omm?.ECCENTRICITY);
  let periodMin = NaN;
  let apogee = NaN;
  let perigee = NaN;
  if (finite(mm) && mm > 0) {
    periodMin = 1440 / mm;
    const nRad = (mm * 2 * Math.PI) / 86400;
    const semiMajor = Math.cbrt(MU_EARTH / (nRad * nRad));
    if (finite(ecc)) {
      apogee = semiMajor * (1 + ecc) - EARTH_RADIUS_KM;
      perigee = semiMajor * (1 - ecc) - EARTH_RADIUS_KM;
    }
  }
  const period = finite(o.period) ? o.period : periodMin;
  const apo = finite(o.apogee) ? o.apogee : apogee;
  const per = finite(o.perigee) ? o.perigee : perigee;
  const inclination = finite(o.inclination) ? o.inclination : Number(omm?.INCLINATION);
  const altKm = finite(apo) && finite(per) ? (apo + per) / 2 : NaN;
  return { period, apogee: apo, perigee: per, inclination, altKm };
}

const kmStr = (v: number | null | undefined) => (finite(v) ? `${Math.round(v).toLocaleString()} KM` : '—');
const degStr = (v: number | null | undefined) => (finite(v) ? `${v.toFixed(2)}°` : '—');
const minStr = (v: number | null | undefined) => (finite(v) ? `${v.toFixed(1)} MIN` : '—');
const velStr = (v: number | null | undefined) => (finite(v) ? `${v.toFixed(2)} KM/S` : '—');

/* ---------------- component ---------------- */

export default function CockpitHud({ overlay = false }: { overlay?: boolean } = {}) {
  // Real engine state.
  const catalogData = useStore((s) => s.catalogData);
  const selected = useStore((s) => s.selectedSatellite);
  const selectedIndex = useStore((s) => s.selectedIndex);
  const selectedAltitude = useStore((s) => s.selectedAltitude);
  const objectCount = useStore((s) => s.objectCount);
  const simTimeMs = useStore((s) => s.simTimeMs);
  const viewMode = useStore((s) => s.viewMode);
  const simRate = useStore((s) => s.simRate);
  const cameraMode = useStore((s) => s.cameraMode);
  const cameraGear = useStore((s) => s.cameraGear);
  const cameraGearCount = useStore((s) => s.cameraGearCount);
  const cameraSpeedMps = useStore((s) => s.cameraSpeedMps);
  const dataTimestamp = useStore((s) => s.dataTimestamp);
  const analyticAnswer = useStore((s) => s.analyticAnswer);
  const showOrbitTrail = useStore((s) => s.showOrbitTrail);
  const selectByIndex = useStore((s) => s.selectByIndex);
  const triggerFlyTo = useStore((s) => s.triggerFlyTo);
  const triggerJoyride = useStore((s) => s.triggerJoyride);
  const setShowOrbitTrail = useStore((s) => s.setShowOrbitTrail);

  const ask = useAnalyticAsk();

  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [asking, setAsking] = useState(false);

  // Derived real values (OMM-derived orbit as a fallback for lean catalog rows).
  const orbit = selected ? deriveOrbit(selected) : null;
  const altKm: number | null = finite(selectedAltitude)
    ? selectedAltitude
    : orbit && finite(orbit.altKm)
      ? orbit.altKm
      : null;
  const velKmS = altKm !== null ? orbitalVelocityKmS(altKm) : null;
  const orbitalFrac = velKmS !== null ? Math.min(1, velKmS / 7.9) : 0; // LEO ~7.6 km/s → near-full
  const contacts = useMemo(() => catalogData.slice(0, 12), [catalogData]);

  const selectContact = (index: number) => {
    selectByIndex?.(index);
    triggerFlyTo?.(index);
  };

  /* Keyboard: Q/E panes, Tab = next contact, Space = ask, Esc = close.
   * Ignores keys while a text field is focused so the ask box types freely. */
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      const k = e.key.toLowerCase();
      if (k === 'q') setLeftOpen((v) => !v);
      else if (k === 'e') setRightOpen((v) => !v);
      else if (k === ' ') {
        e.preventDefault();
        setAsking(true);
      } else if (k === 'tab') {
        e.preventDefault();
        if (catalogData.length > 0) {
          const next = ((selectedIndex ?? -1) + 1) % catalogData.length;
          selectByIndex?.(next);
        }
      } else if (k === 'escape') {
        setAsking(false);
        setLeftOpen(false);
        setRightOpen(false);
      }
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, [catalogData.length, selectedIndex, selectByIndex]);

  const rootStyle: React.CSSProperties = overlay
    ? {
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        userSelect: 'none',
        pointerEvents: 'none',
        color: 'var(--hud-text)',
        fontFamily: 'var(--font-hud-sans)',
      }
    : {
        position: 'relative',
        height: '100vh',
        width: '100vw',
        overflow: 'hidden',
        userSelect: 'none',
        background:
          'radial-gradient(ellipse at 50% 120%, oklch(0.20 0.04 240) 0%, var(--hud-sky) 35%, var(--hud-sky-deep) 100%)',
        color: 'var(--hud-text)',
        fontFamily: 'var(--font-hud-sans)',
      };

  return (
    <div style={rootStyle}>
      {!overlay && <Starfield />}
      {!overlay && <EarthHorizon />}
      <VignetteAndScan />

      <Reticle selected={selected} altKm={altKm} velKmS={velKmS} />

      <LeftArc open={leftOpen} onToggle={() => setLeftOpen((v) => !v)} />
      <RightArc open={rightOpen} gear={cameraGear} gearCount={cameraGearCount} speedMps={cameraSpeedMps} onToggle={() => setRightOpen((v) => !v)} />

      <AnalysisPanes open={leftOpen} selected={selected} orbit={orbit} altKm={altKm} velKmS={velKmS} />
      <FocusPanes
        open={rightOpen}
        selected={selected}
        selectedIndex={selectedIndex}
        orbit={orbit}
        altKm={altKm}
        velKmS={velKmS}
        speed={orbitalFrac}
        cameraMode={cameraMode}
        showOrbitTrail={showOrbitTrail}
        onFlyTo={(i) => triggerFlyTo?.(i)}
        onJoyride={(i) => triggerJoyride?.(i)}
        onToggleTrail={() => setShowOrbitTrail(!showOrbitTrail)}
      />

      <TelemetryTL simTimeMs={simTimeMs} viewMode={viewMode} simRate={simRate} objectCount={objectCount} />
      <TelemetryTR selected={selected} altKm={altKm} objectCount={objectCount} dataTimestamp={dataTimestamp} />
      <TelemetryBL cameraMode={cameraMode} answer={analyticAnswer} />
      <ContactList contacts={contacts} selectedIndex={selectedIndex} onPick={selectContact} />

      <AiBar
        asking={asking}
        answer={analyticAnswer}
        onOpen={() => setAsking(true)}
        onCancel={() => setAsking(false)}
        onAsk={(q) => {
          ask(q);
          setAsking(false);
        }}
      />

      <InputHints />

      <div
        style={{
          pointerEvents: 'none',
          position: 'absolute',
          left: '50%',
          top: 12,
          transform: 'translateX(-50%)',
          fontSize: 10,
          letterSpacing: '0.5em',
          color: 'var(--hud-text-dim)',
          fontFamily: 'var(--font-hud-mono)',
        }}
      >
        ORBITAL / SSA-01
      </div>
    </div>
  );
}

/* ---------------- pieces ---------------- */

function Starfield() {
  const layers = useMemo(() => {
    const mk = (n: number, seed: number, size: number, alpha: number) => {
      const out: { x: number; y: number; s: number; a: number }[] = [];
      let r = seed;
      for (let i = 0; i < n; i++) {
        r = (r * 9301 + 49297) % 233280;
        const rx = r / 233280;
        r = (r * 9301 + 49297) % 233280;
        const ry = r / 233280;
        r = (r * 9301 + 49297) % 233280;
        const rs = r / 233280;
        out.push({ x: rx * 100, y: ry * 100, s: size * (0.4 + rs * 0.9), a: alpha * (0.4 + rs) });
      }
      return out;
    };
    return { far: mk(220, 12345, 1, 0.55), mid: mk(90, 67891, 1.6, 0.75), near: mk(30, 24680, 2.4, 0.95) };
  }, []);

  return (
    <div style={{ pointerEvents: 'none', position: 'absolute', inset: 0, overflow: 'hidden' }}>
      {[layers.far, layers.mid, layers.near].map((data, li) => (
        <div key={li} style={{ position: 'absolute', inset: 0 }}>
          {data.map((p, i) => (
            <span
              key={i}
              style={{
                position: 'absolute',
                borderRadius: 9999,
                left: `${p.x}%`,
                top: `${p.y}%`,
                width: p.s,
                height: p.s,
                background: 'white',
                opacity: p.a,
                boxShadow: li === 2 ? '0 0 6px rgba(255,255,255,0.6)' : undefined,
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function EarthHorizon() {
  return (
    <div style={{ pointerEvents: 'none', position: 'absolute', left: 0, right: 0, bottom: 0, height: '62vh' }}>
      <div
        style={{
          position: 'absolute',
          left: '-20%',
          right: '-20%',
          bottom: '-70vh',
          height: '130vh',
          borderRadius: '50%',
          background:
            'radial-gradient(ellipse at 50% 20%, oklch(0.55 0.14 235) 0%, oklch(0.32 0.10 240) 32%, oklch(0.14 0.05 245) 55%, transparent 70%)',
          boxShadow:
            '0 -60px 160px 20px oklch(0.65 0.16 220 / 0.35), inset 0 40px 80px oklch(0.85 0.14 210 / 0.25)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 'calc(62vh - 2px)',
          height: '2px',
          background: 'linear-gradient(90deg, transparent, oklch(0.85 0.12 210 / 0.6), transparent)',
          filter: 'blur(1px)',
        }}
      />
    </div>
  );
}

function VignetteAndScan() {
  return (
    <>
      <div
        style={{
          pointerEvents: 'none',
          position: 'absolute',
          inset: 0,
          background: 'radial-gradient(ellipse at 50% 50%, transparent 55%, oklch(0.05 0.02 250 / 0.75) 100%)',
        }}
      />
      <div
        style={{
          pointerEvents: 'none',
          position: 'absolute',
          inset: 0,
          opacity: 0.06,
          mixBlendMode: 'overlay',
          backgroundImage:
            'repeating-linear-gradient(0deg, rgba(255,255,255,0.4) 0px, rgba(255,255,255,0.4) 1px, transparent 1px, transparent 3px)',
        }}
      />
    </>
  );
}

function Reticle({
  selected,
  altKm,
  velKmS,
}: {
  selected: EnrichedTLEObject | null;
  altKm: number | null;
  velKmS: number | null;
}) {
  return (
    <div style={{ pointerEvents: 'none', position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}>
      <div style={{ height: 4, width: 4, borderRadius: 9999, background: 'var(--hud-arc)', boxShadow: '0 0 12px var(--hud-arc-glow)' }} />
      <svg
        width="180"
        height="180"
        style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', animation: 'hud-pulse 4s ease-in-out infinite' }}
      >
        {['M 20 40 L 20 20 L 40 20', 'M 160 40 L 160 20 L 140 20', 'M 20 140 L 20 160 L 40 160', 'M 160 140 L 160 160 L 140 160'].map((d, i) => (
          <path key={i} d={d} fill="none" stroke="var(--hud-arc)" strokeWidth="1" opacity={selected ? 0.9 : 0.4} />
        ))}
        <circle cx="90" cy="90" r="46" fill="none" stroke="var(--hud-arc-dim)" strokeWidth="0.6" strokeDasharray="2 4" />
      </svg>
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: 110,
          transform: 'translateX(-50%)',
          whiteSpace: 'nowrap',
          fontSize: 10,
          letterSpacing: '0.3em',
          fontFamily: 'var(--font-hud-mono)',
          color: 'var(--hud-text-dim)',
          textAlign: 'center',
        }}
      >
        {selected ? (
          <>
            <div style={{ color: 'var(--hud-text)' }}>{selected.name}</div>
            <div style={{ marginTop: 4 }}>
              {kindCode(selected.objectType)}
              {altKm !== null ? ` · ${Math.round(altKm).toLocaleString()} KM` : ''}
              {velKmS !== null ? ` · ${velKmS.toFixed(2)} KM/S` : ''}
            </div>
          </>
        ) : (
          <>
            <div>NO LOCK</div>
            <div style={{ marginTop: 4, opacity: 0.7 }}>SELECT A CONTACT · CLICK GLOBE</div>
          </>
        )}
      </div>
    </div>
  );
}

/* ------ Arcs ------ */

function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const sx = cx + r * Math.cos(rad(startDeg));
  const sy = cy + r * Math.sin(rad(startDeg));
  const ex = cx + r * Math.cos(rad(endDeg));
  const ey = cy + r * Math.sin(rad(endDeg));
  const large = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;
  const sweep = endDeg > startDeg ? 1 : 0;
  return `M ${sx} ${sy} A ${r} ${r} 0 ${large} ${sweep} ${ex} ${ey}`;
}

function LeftArc({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const R = 320;
  const cx = 360;
  const cy = 180;
  const start = 180 - 17.5;
  const end = 180 + 17.5;
  return (
    <button
      onClick={onToggle}
      aria-label="Analysis panes"
      style={{ ...BUTTON_RESET, position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)', width: 60, height: 360 }}
    >
      <svg width="380" height="360" style={{ position: 'absolute', left: 0, top: 0 }}>
        <defs>
          <filter id="glowL" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <path
          d={arcPath(cx, cy, R, start, end)}
          fill="none"
          stroke="var(--hud-arc)"
          strokeWidth={open ? 1.6 : 1.1}
          opacity={open ? 1 : 0.85}
          filter="url(#glowL)"
          style={{ transition: 'all 240ms ease' }}
        />
        {Array.from({ length: 9 }).map((_, i) => {
          const t = start + (i / 8) * (end - start);
          const rad = (t * Math.PI) / 180;
          const r1 = R - 6;
          const r2 = R + 4;
          return (
            <line key={i} x1={cx + r1 * Math.cos(rad)} y1={cy + r1 * Math.sin(rad)} x2={cx + r2 * Math.cos(rad)} y2={cy + r2 * Math.sin(rad)} stroke="var(--hud-arc-dim)" strokeWidth="0.8" />
          );
        })}
      </svg>
      <div
        style={{
          position: 'absolute',
          left: 12,
          top: '50%',
          transform: 'translateY(-50%) rotate(180deg)',
          fontSize: 9,
          letterSpacing: '0.4em',
          writingMode: 'vertical-rl',
          fontFamily: 'var(--font-hud-mono)',
          color: open ? 'var(--hud-text)' : 'var(--hud-text-dim)',
        }}
      >
        ANALYSIS · {open ? 'OPEN' : 'Q / L1'}
      </div>
    </button>
  );
}

function RightArc({ open, gear, gearCount, speedMps, onToggle }: { open: boolean; gear: number; gearCount: number; speedMps: number; onToggle: () => void }) {
  const R = 320;
  const R2 = 336;
  const cx = 20;
  const cy = 180;
  const start = -17.5;
  const end = 17.5;
  const fill = gearCount > 1 ? gear / (gearCount - 1) : 0;
  const speedStart = start;
  const speedEnd = start + (end - start) * fill;
  const speedLabel = speedMps >= 1000 ? `${(speedMps / 1000).toLocaleString()} km/s` : `${speedMps} m/s`;

  return (
    <button
      onClick={onToggle}
      aria-label="Focus panes"
      style={{ ...BUTTON_RESET, position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)', width: 60, height: 360 }}
    >
      <svg width="380" height="360" style={{ position: 'absolute', right: 0, top: 0 }}>
        <defs>
          <filter id="glowR" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <linearGradient id="spd" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="oklch(0.85 0.12 200)" />
            <stop offset="100%" stopColor="oklch(0.85 0.16 55)" />
          </linearGradient>
        </defs>
        <path
          d={arcPath(cx, cy, R, start, end)}
          fill="none"
          stroke="var(--hud-arc)"
          strokeWidth={open ? 1.6 : 1.1}
          opacity={open ? 1 : 0.85}
          filter="url(#glowR)"
          style={{ transition: 'all 240ms ease' }}
        />
        <path d={arcPath(cx, cy, R2, start, end)} fill="none" stroke="var(--hud-arc-dim)" strokeWidth="0.6" />
        {fill > 0 && (
          <path
            d={arcPath(cx, cy, R2, speedStart, speedEnd)}
            fill="none"
            stroke="url(#spd)"
            strokeWidth="2.2"
            strokeLinecap="round"
            filter="url(#glowR)"
            style={{ transition: 'all 240ms ease' }}
          />
        )}
        {Array.from({ length: 9 }).map((_, i) => {
          const t = start + (i / 8) * (end - start);
          const rad = (t * Math.PI) / 180;
          const r1 = R - 4;
          const r2 = R + 6;
          return (
            <line key={i} x1={cx + r1 * Math.cos(rad)} y1={cy + r1 * Math.sin(rad)} x2={cx + r2 * Math.cos(rad)} y2={cy + r2 * Math.sin(rad)} stroke="var(--hud-arc-dim)" strokeWidth="0.8" />
          );
        })}
      </svg>
      <div
        style={{
          position: 'absolute',
          right: 12,
          top: '50%',
          transform: 'translateY(-50%)',
          fontSize: 9,
          letterSpacing: '0.4em',
          writingMode: 'vertical-rl',
          fontFamily: 'var(--font-hud-mono)',
          color: open ? 'var(--hud-text)' : 'var(--hud-text-dim)',
        }}
      >
        FOCUS · {open ? 'OPEN' : 'E / R1'}
      </div>
      <div
        style={{
          pointerEvents: 'none',
          position: 'absolute',
          right: 32,
          top: 'calc(50% - 14px)',
          textAlign: 'right',
          fontSize: 9,
          lineHeight: 1.25,
          fontFamily: 'var(--font-hud-mono)',
          color: 'var(--hud-text-dim)',
        }}
      >
        <div>SPD · G{gear + 1}</div>
        <div style={{ color: 'var(--hud-text)' }}>{speedLabel}</div>
      </div>
    </button>
  );
}

/* ------ Panes ------ */

function GlassPane({ children, fromLeft = true, delay = 0 }: { children: React.ReactNode; fromLeft?: boolean; delay?: number }) {
  return (
    <div
      style={
        {
          position: 'relative',
          borderRadius: 8,
          pointerEvents: 'auto',
          background: 'var(--hud-glass)',
          border: '1px solid var(--hud-glass-edge)',
          backdropFilter: 'blur(14px) saturate(120%)',
          WebkitBackdropFilter: 'blur(14px) saturate(120%)',
          boxShadow: '0 0 40px oklch(0.85 0.14 220 / 0.06) inset, 0 20px 60px oklch(0.05 0 0 / 0.4)',
          animation: `hud-pane-in 380ms ${delay}ms cubic-bezier(.2,.7,.2,1) both`,
          '--hud-pane-from': fromLeft ? '-16px' : '16px',
        } as React.CSSProperties
      }
    >
      {children}
    </div>
  );
}

function PaneHeader({ label, value }: { label: string; value?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--hud-glass-edge)', padding: '8px 12px' }}>
      <span style={{ fontSize: 9, letterSpacing: '0.4em', color: 'var(--hud-text-dim)', fontFamily: 'var(--font-hud-mono)' }}>{label}</span>
      {value && <span style={{ fontSize: 10, color: 'var(--hud-text)', fontFamily: 'var(--font-hud-mono)' }}>{value}</span>}
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '4px 0' }}>
      <span style={{ fontSize: 10, letterSpacing: '0.1em', color: 'var(--hud-text-dim)', fontFamily: 'var(--font-hud-mono)' }}>{k}</span>
      <span style={{ fontSize: 11, color: 'var(--hud-text)', fontFamily: 'var(--font-hud-mono)' }}>{v}</span>
    </div>
  );
}

function EmptyPane({ text }: { text: string }) {
  return (
    <GlassPane>
      <div style={{ padding: '18px 14px', fontSize: 10, letterSpacing: '0.15em', color: 'var(--hud-text-dim)', fontFamily: 'var(--font-hud-mono)', textAlign: 'center' }}>{text}</div>
    </GlassPane>
  );
}

function AnalysisPanes({ open, selected, orbit, altKm, velKmS }: { open: boolean; selected: EnrichedTLEObject | null; orbit: DerivedOrbit | null; altKm: number | null; velKmS: number | null }) {
  if (!open) return null;
  return (
    <div style={{ pointerEvents: 'none', position: 'absolute', left: 80, top: '50%', transform: 'translateY(-50%)', display: 'flex', flexDirection: 'column', gap: 12, width: 280 }}>
      {!selected ? (
        <EmptyPane text="NO OBJECT LOCKED" />
      ) : (
        <>
          <GlassPane delay={0}>
            <PaneHeader label="IDENTITY" value={`NORAD ${selected.noradId}`} />
            <div style={{ padding: '12px' }}>
              <div style={{ fontSize: 13, fontFamily: 'var(--font-hud-mono)' }}>{selected.name}</div>
              <div style={{ marginTop: 2, fontSize: 10, color: 'var(--hud-text-dim)' }}>
                {CATEGORY_LABEL[selected.category] ?? 'Unknown'}
                {selected.program ? ` · ${selected.program}` : ''}
              </div>
              <div style={{ marginTop: 12 }}>
                <KV k="CLASS" v={kindCode(selected.objectType)} />
                <KV k="RANGE" v={kmStr(altKm)} />
                <KV k="V-ORB" v={velStr(velKmS)} />
              </div>
            </div>
          </GlassPane>

          <GlassPane delay={60}>
            <PaneHeader label="ORBIT" value={selected.regime} />
            <div style={{ padding: '12px' }}>
              <KV k="APOGEE" v={kmStr(orbit?.apogee)} />
              <KV k="PERIGEE" v={kmStr(orbit?.perigee)} />
              <KV k="INCL" v={degStr(orbit?.inclination)} />
              <KV k="PERIOD" v={minStr(orbit?.period)} />
            </div>
          </GlassPane>

          <GlassPane delay={120}>
            <PaneHeader label="CATALOG" value={selected.countryCode || '—'} />
            <div style={{ padding: '12px' }}>
              <KV k="STATUS" v={(selected.status ?? 'unknown').replace(/_/g, ' ').toUpperCase()} />
              <KV k="LAUNCH" v={selected.launchDate ?? '—'} />
              <KV k="EPOCH" v={selected.epoch?.slice(0, 10) ?? '—'} />
              <KV k="RCS" v={selected.rcsSize ?? '—'} />
            </div>
          </GlassPane>
        </>
      )}
    </div>
  );
}

function ActionRow({ label, hint, active, disabled, onClick }: { label: string; hint: string; active?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...BUTTON_RESET,
        display: 'flex',
        width: '100%',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '5px 0',
        fontSize: 10,
        fontFamily: 'var(--font-hud-mono)',
        color: disabled ? 'oklch(0.94 0.01 240 / 0.3)' : active ? 'var(--hud-warn)' : 'var(--hud-text-dim)',
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      <span>{label}</span>
      <span style={{ color: disabled ? 'oklch(0.94 0.01 240 / 0.3)' : 'var(--hud-text)' }}>{hint}</span>
    </button>
  );
}

function FocusPanes({
  open,
  selected,
  selectedIndex,
  orbit,
  altKm,
  velKmS,
  speed,
  cameraMode,
  showOrbitTrail,
  onFlyTo,
  onJoyride,
  onToggleTrail,
}: {
  open: boolean;
  selected: EnrichedTLEObject | null;
  selectedIndex: number | null;
  orbit: DerivedOrbit | null;
  altKm: number | null;
  velKmS: number | null;
  speed: number;
  cameraMode: string;
  showOrbitTrail: boolean;
  onFlyTo: (i: number) => void;
  onJoyride: (i: number) => void;
  onToggleTrail: () => void;
}) {
  if (!open) return null;
  const tracking = cameraMode === 'flying' || cameraMode === 'following';
  return (
    <div style={{ pointerEvents: 'none', position: 'absolute', right: 80, top: '50%', transform: 'translateY(-50%)', display: 'flex', flexDirection: 'column', gap: 12, width: 300 }}>
      {!selected ? (
        <EmptyPane text="NO OBJECT LOCKED" />
      ) : (
        <>
          <GlassPane fromLeft={false} delay={0}>
            <PaneHeader label="OBJECT SCAN" value={`NORAD ${selected.noradId}`} />
            <div style={{ padding: '12px' }}>
              <div style={{ position: 'relative', margin: '0 auto', height: 128, width: '100%' }}>
                <svg viewBox="0 0 200 130" style={{ height: '100%', width: '100%' }}>
                  <ellipse cx="100" cy="65" rx="70" ry="18" fill="none" stroke="var(--hud-arc-dim)" strokeWidth="0.6" />
                  <ellipse cx="100" cy="65" rx="70" ry="45" fill="none" stroke="var(--hud-arc-dim)" strokeWidth="0.4" strokeDasharray="2 3" />
                  <circle cx="100" cy="65" r="10" fill="none" stroke="var(--hud-arc)" strokeWidth="0.8" />
                  <circle cx="100" cy="65" r="2" fill="var(--hud-arc)" />
                  <path d="M100 55 L 100 45 M100 75 L 100 85 M90 65 L 80 65 M110 65 L 120 65" stroke="var(--hud-arc)" strokeWidth="0.6" />
                </svg>
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background: 'linear-gradient(180deg, transparent 40%, oklch(0.85 0.14 220 / 0.06) 50%, transparent 60%)',
                    animation: 'hud-scan 3.4s linear infinite',
                  }}
                />
              </div>
              <div style={{ marginTop: 8 }}>
                <KV k="TYPE" v={kindCode(selected.objectType)} />
                <KV k="RCS" v={selected.rcsSize ?? '—'} />
                <KV k="AGE" v={ageString(selected.launchDate) ?? '—'} />
              </div>
            </div>
          </GlassPane>

          <GlassPane fromLeft={false} delay={60}>
            <PaneHeader label="TELEMETRY" value="LIVE" />
            <div style={{ padding: '12px' }}>
              <KV k="ALTITUDE" v={kmStr(altKm)} />
              <KV k="INCL" v={degStr(orbit?.inclination)} />
              <KV k="V-ORB" v={velStr(velKmS)} />
              <div style={{ marginTop: 8, height: 4, width: '100%', overflow: 'hidden', borderRadius: 9999, background: 'var(--hud-arc-dim)' }}>
                <div style={{ height: '100%', width: `${speed * 100}%`, background: 'linear-gradient(90deg, oklch(0.85 0.12 200), oklch(0.85 0.16 55))' }} />
              </div>
              <div style={{ marginTop: 4, display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--hud-text-dim)', fontFamily: 'var(--font-hud-mono)' }}>
                <span>ORBITAL VELOCITY</span>
                <span>{Math.round(speed * 100)}%</span>
              </div>
            </div>
          </GlassPane>

          <GlassPane fromLeft={false} delay={120}>
            <PaneHeader label="ACTIONS" />
            <div style={{ padding: '4px 12px 8px' }}>
              <ActionRow
                label={tracking ? 'FOLLOWING' : 'APPROACH'}
                hint={tracking ? 'ON' : '[F]'}
                active={tracking}
                disabled={selectedIndex === null}
                onClick={() => selectedIndex !== null && onFlyTo(selectedIndex)}
              />
              <ActionRow label="JOYRIDE" hint="[G]" disabled={selectedIndex === null} onClick={() => selectedIndex !== null && onJoyride(selectedIndex)} />
              <ActionRow label="ORBIT TRAIL" hint={showOrbitTrail ? 'ON' : '[H]'} active={showOrbitTrail} onClick={onToggleTrail} />
            </div>
          </GlassPane>
        </>
      )}
    </div>
  );
}

/* ------ Telemetry corners ------ */

function TelemetryTL({ simTimeMs, viewMode, simRate, objectCount }: { simTimeMs: number; viewMode: string; simRate: number; objectCount: number }) {
  return (
    <div style={{ pointerEvents: 'none', position: 'absolute', left: 24, top: 24, fontSize: 10, lineHeight: 1.625, fontFamily: 'var(--font-hud-mono)', color: 'var(--hud-text-dim)' }}>
      <div style={{ color: 'var(--hud-text)' }}>MET {fmtMet(simTimeMs)}</div>
      <div>MODE {viewMode.toUpperCase()} · {simRate}×</div>
      <div>TRACKING {objectCount.toLocaleString()} OBJ</div>
    </div>
  );
}

function TelemetryTR({ selected, altKm, objectCount, dataTimestamp }: { selected: EnrichedTLEObject | null; altKm: number | null; objectCount: number; dataTimestamp: number | null }) {
  const sync = dataTimestamp ? new Date(dataTimestamp).toISOString().slice(11, 19) + 'Z' : '—';
  return (
    <div style={{ pointerEvents: 'none', position: 'absolute', right: 24, top: 24, textAlign: 'right', fontSize: 10, lineHeight: 1.625, fontFamily: 'var(--font-hud-mono)', color: 'var(--hud-text-dim)' }}>
      <div style={{ color: 'var(--hud-text)' }}>
        {selected ? `${selected.regime} · ${altKm !== null ? Math.round(altKm).toLocaleString() + ' KM' : '—'}` : `SSA · ${objectCount.toLocaleString()} OBJ`}
      </div>
      <div>{selected ? `LOCK ${kindCode(selected.objectType)} ${selected.noradId}` : 'LOCK —'}</div>
      <div>SYNC {sync}</div>
    </div>
  );
}

function TelemetryBL({ cameraMode, answer }: { cameraMode: string; answer: ReturnType<typeof useStore.getState>['analyticAnswer'] }) {
  const aiLabel = answer ? answer.status.toUpperCase() : 'IDLE';
  const aiColor = answer?.status === 'error' ? 'var(--hud-warn)' : answer?.status === 'compiling' ? 'var(--hud-warn)' : 'var(--hud-good)';
  return (
    <div style={{ pointerEvents: 'none', position: 'absolute', bottom: 96, left: 24, fontSize: 10, lineHeight: 1.625, fontFamily: 'var(--font-hud-mono)', color: 'var(--hud-text-dim)' }}>
      <div>
        <span style={{ marginRight: 8, display: 'inline-block', height: 6, width: 6, borderRadius: 9999, verticalAlign: 'middle', background: 'var(--hud-good)' }} />
        NAV {cameraMode.toUpperCase()}
      </div>
      <div>
        <span style={{ marginRight: 8, display: 'inline-block', height: 6, width: 6, borderRadius: 9999, verticalAlign: 'middle', background: aiColor }} />
        AI {aiLabel}
      </div>
    </div>
  );
}

function ContactList({ contacts, selectedIndex, onPick }: { contacts: EnrichedTLEObject[]; selectedIndex: number | null; onPick: (index: number) => void }) {
  return (
    <div style={{ pointerEvents: 'auto', position: 'absolute', bottom: 96, right: 24, width: 220, fontFamily: 'var(--font-hud-mono)' }}>
      <div style={{ marginBottom: 4, fontSize: 9, letterSpacing: '0.4em', color: 'var(--hud-text-dim)' }}>CONTACTS · TAB</div>
      <div style={{ borderRadius: 8, background: 'var(--hud-glass)', border: '1px solid var(--hud-glass-edge)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', overflow: 'hidden' }}>
        {contacts.length === 0 ? (
          <div style={{ padding: '10px 12px', fontSize: 10, color: 'var(--hud-text-dim)' }}>ACQUIRING CATALOG…</div>
        ) : (
          contacts.map((c, i) => {
            const on = i === selectedIndex;
            return (
              <button
                key={c.noradId}
                onClick={() => onPick(i)}
                style={{
                  ...BUTTON_RESET,
                  fontFamily: 'inherit',
                  display: 'flex',
                  width: '100%',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '6px 12px',
                  fontSize: 10,
                  transition: 'background-color 150ms, color 150ms',
                  color: on ? 'var(--hud-text)' : 'var(--hud-text-dim)',
                  borderTop: i === 0 ? 'none' : '1px solid var(--hud-glass-edge)',
                  background: on ? 'oklch(0.85 0.14 220 / 0.06)' : 'transparent',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
                  <span style={{ flexShrink: 0, height: 4, width: 4, borderRadius: 9999, background: on ? 'var(--hud-arc)' : 'var(--hud-arc-dim)', boxShadow: on ? '0 0 8px var(--hud-arc-glow)' : undefined }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                </span>
                <span style={{ flexShrink: 0, marginLeft: 8 }}>{kindCode(c.objectType)}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ------ AI Waveform ------ */

function AiBar({
  asking,
  answer,
  onOpen,
  onCancel,
  onAsk,
}: {
  asking: boolean;
  answer: ReturnType<typeof useStore.getState>['analyticAnswer'];
  onOpen: () => void;
  onCancel: () => void;
  onAsk: (q: string) => void;
}) {
  const bars = 48;
  const active = asking || answer?.status === 'compiling';

  let transcript = '“ask the catalog…” · press SPACE';
  if (answer?.status === 'compiling') transcript = 'COMPILING…';
  else if (answer?.status === 'ready') transcript = `“${answer.question}” → ${answer.interpretation ?? 'ready'}`;
  else if (answer?.status === 'error') transcript = answer.message ?? 'Ask failed';

  return (
    <div style={{ pointerEvents: 'none', position: 'absolute', left: 0, right: 0, bottom: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      {asking ? (
        <input
          autoFocus
          placeholder="ask about the catalog… (Enter)"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const v = (e.target as HTMLInputElement).value.trim();
              if (v) onAsk(v);
            } else if (e.key === 'Escape') {
              onCancel();
            }
          }}
          style={{
            pointerEvents: 'auto',
            width: 'min(560px, 60vw)',
            padding: '6px 14px',
            background: 'oklch(0.05 0.02 250 / 0.6)',
            border: '1px solid var(--hud-glass-edge)',
            borderRadius: 9999,
            outline: 'none',
            textAlign: 'center',
            fontSize: 11,
            letterSpacing: '0.15em',
            color: 'var(--hud-text)',
            fontFamily: 'var(--font-hud-mono)',
          }}
        />
      ) : (
        <div
          style={{ maxWidth: '70vw', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, letterSpacing: '0.2em', color: answer?.status === 'error' ? 'var(--hud-warn)' : 'var(--hud-text-dim)', fontFamily: 'var(--font-hud-mono)' }}
        >
          {transcript}
        </div>
      )}
      <button
        onClick={asking ? onCancel : onOpen}
        aria-label="Ask the onboard AI"
        style={{
          ...BUTTON_RESET,
          display: 'flex',
          height: 32,
          width: 'min(560px, 60vw)',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 3,
          borderRadius: 9999,
          padding: '0 16px',
          background: 'var(--hud-glass)',
          border: '1px solid var(--hud-glass-edge)',
          backdropFilter: 'blur(14px)',
          WebkitBackdropFilter: 'blur(14px)',
        }}
      >
        {Array.from({ length: bars }).map((_, i) => {
          const mid = (i - bars / 2) / (bars / 2);
          const envelope = Math.cos(mid * Math.PI * 0.5);
          const base = 4 + envelope * 14;
          const delay = (i * 40) % 900;
          return (
            <span
              key={i}
              style={{
                display: 'inline-block',
                width: 2,
                height: base,
                borderRadius: 2,
                background: active ? 'linear-gradient(180deg, oklch(0.9 0.14 210), oklch(0.85 0.14 55))' : 'var(--hud-arc-dim)',
                transformOrigin: 'center',
                animation: `hud-breathe ${active ? 700 : 1600}ms ease-in-out ${delay}ms infinite`,
              }}
            />
          );
        })}
      </button>
    </div>
  );
}

/* ------ Input hints ------ */

function InputHints() {
  const Key = ({ children }: { children: React.ReactNode }) => (
    <span
      style={{
        display: 'inline-flex',
        height: 16,
        minWidth: 16,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 3,
        padding: '0 4px',
        fontSize: 9,
        border: '1px solid var(--hud-glass-edge)',
        color: 'var(--hud-text)',
        fontFamily: 'var(--font-hud-mono)',
      }}
    >
      {children}
    </span>
  );
  const Ps = ({ children }: { children: React.ReactNode }) => (
    <span
      style={{
        display: 'inline-flex',
        height: 16,
        minWidth: 16,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 9999,
        padding: '0 4px',
        fontSize: 9,
        border: '1px solid var(--hud-glass-edge)',
        color: 'var(--hud-text-dim)',
        fontFamily: 'var(--font-hud-mono)',
      }}
    >
      {children}
    </span>
  );
  const group: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4 };
  return (
    <div
      style={{
        pointerEvents: 'none',
        position: 'absolute',
        bottom: 8,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        fontSize: 9,
        color: 'var(--hud-text-dim)',
        fontFamily: 'var(--font-hud-mono)',
      }}
    >
      <span style={group}>
        <Key>W</Key>
        <Key>A</Key>
        <Key>S</Key>
        <Key>D</Key> fly
      </span>
      <span style={group}>
        <Key>R</Key>
        <Key>F</Key> up/down
      </span>
      <span style={group}>
        <Key>[</Key>
        <Key>]</Key> gear
      </span>
      <span style={group}>
        <Key>G</Key> fly-to
      </span>
      <span style={group}>
        <Key>Q</Key>
        <Ps>L1</Ps> analysis
      </span>
      <span style={group}>
        <Key>E</Key>
        <Ps>R1</Ps> focus
      </span>
      <span style={group}>
        <Key>⇥</Key> next
      </span>
      <span style={group}>
        <Key>␣</Key> ask
      </span>
    </div>
  );
}
