import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useStore } from '../store/useStore';
import type { ObjectCategory } from '../data/types';
import { PROGRAM_LABELS, type ObjectMetadataResponse } from '../data/metadata-types';
import { fetchObjectMetadata } from '../data/metadata-client';
import { ActionButton, Field, GlassPanel } from './primitives';
import { CATEGORY_COLOR } from './styles/tokens';

// ============================================================
// InfoCard — an instrument, not a table.
//
// Hierarchy: eyebrow (what kind of thing) → name (who) → the ORBIT drawn as a
// true-geometry glyph + one hero reading (live altitude) → a quiet stat grid →
// provenance compressed to a line → everything else behind a text reveal.
// Amber (--ow-physical) = physical/orbital fact; cyan = clickable pivot into
// search; violet stays reserved for the perceptor layer.
// ============================================================

const CATEGORY_LABELS: Record<ObjectCategory, string> = {
  active_satellite: 'Active Satellite',
  inactive_satellite: 'Inactive Satellite',
  rocket_body: 'Rocket Body',
  debris: 'Debris',
  unknown: 'Unknown',
  deep_space: 'Deep Space',
};

const MANEUVERABILITY_LABELS: Record<string, string> = {
  M: 'Maneuverable',
  D: 'Deorbit-capable',
};

const PHYSICAL = 'var(--ow-physical)';
const PIVOT = 'var(--ow-telemetry)';
const EARTH_RADIUS_KM = 6371;

// ── Orbit glyph ──────────────────────────────────────────────────────────────
// True ellipse geometry from apogee/perigee (planet at the focus), tilted by
// the real inclination against a faint equator reference line. LEO reads as a
// tight ring; Molniya as an eccentric loop; GEO as a distant circle.

function OrbitGlyph({
  apogeeKm,
  perigeeKm,
  inclinationDeg,
}: {
  apogeeKm: number;
  perigeeKm: number;
  inclinationDeg: number;
}) {
  const W = 104;
  const H = 84;
  const fx = W / 2;
  const fy = H / 2;

  const rApo = apogeeKm + EARTH_RADIUS_KM;
  const rPeri = perigeeKm + EARTH_RADIUS_KM;
  const a = (rApo + rPeri) / 2; // semi-major
  const b = Math.sqrt(rApo * rPeri); // semi-minor
  const cKm = a - rPeri; // focus → center

  // Scale so the farthest point (apoapsis from the focus) fits, at any tilt.
  const s = 32 / (a + cKm);
  const rx = a * s;
  const ry = b * s;
  const c = cKm * s;
  const planetR = Math.max(4.5, EARTH_RADIUS_KM * s);

  // Satellite marker at apoapsis (the far, slow, characteristic end).
  const satX = fx + c + rx;

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      style={{ flexShrink: 0, display: 'block' }}
      aria-hidden
    >
      {/* Equator reference */}
      <line
        x1={4}
        y1={fy}
        x2={W - 4}
        y2={fy}
        stroke="var(--ow-stroke-strong)"
        strokeWidth={1}
        strokeDasharray="1 4"
        strokeLinecap="round"
      />
      {/* Orbit plane, tilted by true inclination about the planet */}
      <g transform={`rotate(${-inclinationDeg} ${fx} ${fy})`}>
        <ellipse
          cx={fx + c}
          cy={fy}
          rx={rx}
          ry={ry}
          fill="none"
          stroke={PHYSICAL}
          strokeWidth={1.2}
          opacity={0.85}
        />
        <circle cx={satX} cy={fy} r={2.4} fill={PHYSICAL} />
        <circle cx={satX} cy={fy} r={5} fill={PHYSICAL} opacity={0.18} />
      </g>
      {/* Planet at the focus, above the far arc */}
      <circle
        cx={fx}
        cy={fy}
        r={planetR}
        fill="var(--ow-surface-3)"
        stroke="var(--ow-stroke-strong)"
        strokeWidth={1}
      />
    </svg>
  );
}

// ── Small pieces ─────────────────────────────────────────────────────────────

function Eyebrow({ dotColor, children }: { dotColor?: string; children: ReactNode }) {
  return (
    <div style={eyebrowStyle}>
      {dotColor && <span style={{ ...eyebrowDotStyle, background: dotColor }} />}
      {children}
    </div>
  );
}

/** Tiny label-over-value cell for the stat grid. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={statLabelStyle}>{label}</div>
      <div style={statValueStyle}>{value}</div>
    </div>
  );
}

function formatKg(kg: number | null | undefined): string | null {
  return kg ? `${kg.toLocaleString()} kg` : null;
}

/** "L × Ø m (span S m)" from whichever dimensions GCAT has. */
function formatDimensions(m: ObjectMetadataResponse): string | null {
  const body = m.lengthM && m.diameterM ? `${m.lengthM} × ${m.diameterM} m` : null;
  const span = m.spanM ? `span ${m.spanM} m` : null;
  if (body && span) return `${body} (${span})`;
  return body ?? span;
}

/** Lazy /api/metadata/:noradId fetch — session-cached in metadata-client. */
function useObjectMetadata(noradId: number | null): ObjectMetadataResponse | null {
  const [meta, setMeta] = useState<ObjectMetadataResponse | null>(null);
  useEffect(() => {
    setMeta(null);
    if (noradId === null) return;
    let cancelled = false;
    void fetchObjectMetadata(noradId).then((m) => {
      if (!cancelled) setMeta(m);
    });
    return () => {
      cancelled = true;
    };
  }, [noradId]);
  return meta;
}

/** GCAT+UCS rows — the long tail, shown only inside the reveal. */
function MetadataRows({
  meta,
  onPivot,
}: {
  meta: ObjectMetadataResponse;
  onPivot: ((text: string) => void) | null;
}) {
  const launch = meta.launch;
  const operatorName = meta.ownerOrg?.name ?? meta.operatorOrg;
  const operatorPivot = meta.ownerOrg?.name;
  return (
    <>
      <Field label="Series" value={meta.gcatProgram ?? null} mono={false} />
      <Field
        label="Operator"
        value={operatorName ?? null}
        mono={false}
        valueColor={onPivot && operatorPivot ? PIVOT : undefined}
        onClick={onPivot && operatorPivot ? () => onPivot(operatorPivot) : undefined}
        title={operatorPivot ? `Show all ${operatorName}` : undefined}
      />
      <Field label="Launch mass" value={formatKg(meta.launchMassKg)} />
      <Field label="Dry mass" value={formatKg(meta.dryMassKg)} />
      <Field label="Size" value={formatDimensions(meta)} />
      <Field label="Bus" value={meta.bus ?? null} mono={false} />
      <Field label="Shape" value={meta.shape ?? null} mono={false} />
      <Field
        label="Propulsion"
        value={meta.maneuverability ? MANEUVERABILITY_LABELS[meta.maneuverability] : null}
        mono={false}
      />
      <Field label="Last active" value={meta.lastActiveDate ?? null} />
      <Field label="Ops ended" value={meta.endOpDate ?? null} />
      {launch && (
        <>
          <Field
            label="Vehicle"
            value={launch.lvType || null}
            mono={false}
            valueColor={onPivot && launch.lvFamily ? PIVOT : undefined}
            onClick={onPivot && launch.lvFamily ? () => onPivot(launch.lvFamily!) : undefined}
            title={launch.lvFamily ? `Show all ${launch.lvType}` : undefined}
          />
          <Field
            label="Launch site"
            value={launch.siteName ?? launch.site ?? null}
            mono={false}
            valueColor={onPivot && launch.siteName ? PIVOT : undefined}
            onClick={onPivot && launch.siteName ? () => onPivot(launch.siteName!) : undefined}
            title={launch.siteName ? `Show all ${launch.siteName}` : undefined}
          />
          <Field
            label="Launch agency"
            value={launch.agencyNames?.join(', ') || null}
            mono={false}
            valueColor={onPivot && launch.agencyNames?.[0] ? PIVOT : undefined}
            onClick={
              onPivot && launch.agencyNames?.[0] ? () => onPivot(launch.agencyNames![0]) : undefined
            }
            title={launch.agencyNames?.[0] ? `Show all ${launch.agencyNames[0]}` : undefined}
          />
          <Field
            label="Outcome"
            value={launch.success === false ? 'Launch failure' : null}
            mono={false}
            valueColor="var(--ow-warn)"
          />
        </>
      )}
      {meta.sources.includes('gcat') && (
        <div style={{ marginTop: 8, fontSize: 10, color: 'var(--ow-text-faint)' }}>
          Catalog data: GCAT / J. McDowell (CC-BY)
        </div>
      )}
    </>
  );
}

/** The follow / joyride / orbit cluster — one definition for both branches. */
function TrackingActions({
  cameraMode,
  followActive,
  joyrideActive,
  showOrbitTrail,
  onGo,
  onJoyride,
  onToggleOrbit,
}: {
  cameraMode: string;
  followActive: boolean;
  joyrideActive: boolean;
  showOrbitTrail: boolean;
  onGo: () => void;
  onJoyride: () => void;
  onToggleOrbit: () => void;
}) {
  const goLabel =
    cameraMode === 'returning'
      ? 'Stop'
      : followActive
      ? cameraMode === 'flying'
        ? 'Cancel'
        : 'Unfollow'
      : 'Go to';
  const joyrideLabel = joyrideActive ? (cameraMode === 'flying' ? 'Cancel ride' : 'Exit ride') : 'Joyride';
  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 14 }}>
      <ActionButton on={followActive} onClick={onGo}>
        {goLabel}
      </ActionButton>
      <ActionButton on={joyrideActive} onClick={onJoyride}>
        {joyrideLabel}
      </ActionButton>
      <ActionButton on={showOrbitTrail} onClick={onToggleOrbit}>
        {showOrbitTrail ? 'Hide orbit' : 'Show orbit'}
      </ActionButton>
    </div>
  );
}

export function InfoCard() {
  const selectedSatellite = useStore((s) => s.selectedSatellite);
  const selectedDso = useStore((s) => s.selectedDso);
  const selectedAltitude = useStore((s) => s.selectedAltitude);
  const selectedIndex = useStore((s) => s.selectedIndex);
  const setSelectedSatellite = useStore((s) => s.setSelectedSatellite);
  const setSelectedDso = useStore((s) => s.setSelectedDso);
  const showOrbitTrail = useStore((s) => s.showOrbitTrail);
  const setShowOrbitTrail = useStore((s) => s.setShowOrbitTrail);
  const triggerFlyTo = useStore((s) => s.triggerFlyTo);
  const triggerJoyride = useStore((s) => s.triggerJoyride);
  const triggerFlyToDso = useStore((s) => s.triggerFlyToDso);
  const triggerJoyrideDso = useStore((s) => s.triggerJoyrideDso);
  const cameraMode = useStore((s) => s.cameraMode);
  const setCameraMode = useStore((s) => s.setCameraMode);
  const trackingStyle = useStore((s) => s.trackingStyle);
  const injectSearchQuery = useStore((s) => s.injectSearchQuery);
  const meta = useObjectMetadata(selectedSatellite?.noradId ?? null);

  const [showMore, setShowMore] = useState(false);
  // Collapse the reveal whenever the selection changes.
  useEffect(() => setShowMore(false), [selectedSatellite?.noradId, selectedDso?.dsoId]);

  if (!selectedSatellite && !selectedDso) return null;

  const isTracking = cameraMode === 'flying' || cameraMode === 'following';
  const followActive = isTracking && trackingStyle === 'follow';
  const joyrideActive = isTracking && trackingStyle === 'joyride';

  if (selectedDso) {
    const dso = selectedDso;
    return (
      <GlassPanel elev={2} className="ow-rise" style={panelStyle}>
        <div style={headerStyle}>
          <div style={{ minWidth: 0 }}>
            <Eyebrow dotColor={CATEGORY_COLOR.deep_space}>Deep Space · {dso.regime}</Eyebrow>
            <div style={nameStyle}>{dso.name}</div>
            <div style={subStyle}>{dso.mission}</div>
          </div>
          <button style={ghostCloseStyle} onClick={() => setSelectedDso(null)} title="Close">
            ×
          </button>
        </div>

        <div style={statGridStyle}>
          <Stat label="Target" value={dso.targetBody} />
          <Stat label="Provider" value={dso.provider} />
          <Stat label="Freshness" value={dso.freshnessState} />
        </div>

        <TrackingActions
          cameraMode={cameraMode}
          followActive={followActive}
          joyrideActive={joyrideActive}
          showOrbitTrail={showOrbitTrail}
          onGo={() => {
            if (cameraMode === 'returning') setCameraMode('free');
            else if (followActive) setCameraMode('returning');
            else triggerFlyToDso?.(dso.dsoId);
          }}
          onJoyride={() => {
            if (cameraMode === 'returning') setCameraMode('free');
            else if (joyrideActive) setCameraMode('returning');
            else triggerJoyrideDso?.(dso.dsoId);
          }}
          onToggleOrbit={() => setShowOrbitTrail(!showOrbitTrail)}
        />
      </GlassPanel>
    );
  }

  const s = selectedSatellite!;
  const programLabel = s.program ? (PROGRAM_LABELS[s.program] ?? s.program) : null;
  const launchYear = s.launchDate ? s.launchDate.slice(0, 4) : null;
  // Space-Track dropped OPS_STATUS_CODE, so active/inactive often can't be
  // proven and category falls to 'unknown' — but the object TYPE is still
  // known. Headline the type instead of an alarming "Unknown".
  const eyebrowLabel =
    s.category !== 'unknown'
      ? CATEGORY_LABELS[s.category]
      : s.objectType === 'satellite'
      ? 'Payload'
      : s.objectType === 'rocket_body'
      ? 'Rocket Body'
      : s.objectType === 'debris'
      ? 'Debris'
      : 'Object';

  return (
    <GlassPanel elev={2} className="ow-rise" style={panelStyle}>
      <div style={headerStyle}>
        <div style={{ minWidth: 0 }}>
          <Eyebrow dotColor={CATEGORY_COLOR[s.category]}>
            {eyebrowLabel} · {s.regime}
          </Eyebrow>
          <div style={nameStyle}>{s.name}</div>
          <div style={subStyle}>NORAD {s.noradId}</div>
        </div>
        <button
          style={ghostCloseStyle}
          onClick={() => setSelectedSatellite(null, null)}
          title="Close"
        >
          ×
        </button>
      </div>

      {/* The orbit itself: geometry left, live hero reading right. */}
      <div style={heroRowStyle}>
        <OrbitGlyph apogeeKm={s.apogee} perigeeKm={s.perigee} inclinationDeg={s.inclination} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={heroValueStyle}>
            {selectedAltitude !== null ? selectedAltitude.toLocaleString() : '—'}
            <span style={heroUnitStyle}> km</span>
          </div>
          <div style={heroLabelStyle}>altitude now</div>
        </div>
      </div>

      <div style={statGridStyle}>
        <Stat label="Period" value={`${s.period.toFixed(1)} min`} />
        <Stat label="Inclination" value={`${s.inclination.toFixed(1)}°`} />
        <Stat label="Apogee" value={`${Math.round(s.apogee).toLocaleString()} km`} />
        <Stat label="Perigee" value={`${Math.round(s.perigee).toLocaleString()} km`} />
      </div>

      {/* Provenance, compressed to a line. The program is a live pivot. */}
      {(programLabel || s.countryCode || launchYear) && (
        <div style={provenanceStyle}>
          {[
            programLabel &&
              (injectSearchQuery ? (
                <span
                  key="program"
                  style={{ color: PIVOT, cursor: 'pointer' }}
                  onClick={() => injectSearchQuery(programLabel)}
                  title={`Show all ${programLabel}`}
                >
                  {programLabel}
                </span>
              ) : (
                <span key="program" style={{ color: 'var(--ow-text-mid)' }}>{programLabel}</span>
              )),
            s.countryCode && <span key="country">{s.countryCode}</span>,
            launchYear && <span key="launch">launched {launchYear}</span>,
          ]
            .filter(Boolean)
            .map((part, i) => (
              <span key={i}>
                {i > 0 && <span style={{ color: 'var(--ow-text-faint)' }}> · </span>}
                {part}
              </span>
            ))}
        </div>
      )}

      <button style={revealStyle} onClick={() => setShowMore((v) => !v)}>
        {showMore ? '− less detail' : '+ full record'}
      </button>

      {showMore && (
        <div style={{ marginTop: 6 }}>
          <Field label="Status" value={CATEGORY_LABELS[s.category]} mono={false} />
          <Field label="Launch" value={s.launchDate} />
          <Field label="Epoch" value={s.epoch?.slice(0, 10) ?? null} />
          {meta && <MetadataRows meta={meta} onPivot={injectSearchQuery} />}
          {injectSearchQuery && meta && (meta.launch?.tag || (meta.ownerOrg?.name && s.owner)) && (
            <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
              {meta.launch?.tag && (
                <ActionButton
                  onClick={() => injectSearchQuery(meta.launch!.tag)}
                  title="Show every object from this launch"
                >
                  Same launch
                </ActionButton>
              )}
              {meta.ownerOrg?.name && s.owner && (
                <ActionButton
                  onClick={() => injectSearchQuery(meta.ownerOrg!.name)}
                  title="Show every object by this operator"
                >
                  Same operator
                </ActionButton>
              )}
            </div>
          )}
        </div>
      )}

      <TrackingActions
        cameraMode={cameraMode}
        followActive={followActive}
        joyrideActive={joyrideActive}
        showOrbitTrail={showOrbitTrail}
        onGo={() => {
          if (cameraMode === 'returning') setCameraMode('free');
          else if (followActive) setCameraMode('returning');
          else if (selectedIndex !== null) triggerFlyTo?.(selectedIndex);
        }}
        onJoyride={() => {
          if (cameraMode === 'returning') setCameraMode('free');
          else if (joyrideActive) setCameraMode('returning');
          else if (selectedIndex !== null) triggerJoyride?.(selectedIndex);
        }}
        onToggleOrbit={() => setShowOrbitTrail(!showOrbitTrail)}
      />
    </GlassPanel>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const panelStyle: CSSProperties = {
  width: '100%',
  padding: '16px 16px 14px',
  borderRadius: 'var(--ow-r-lg)',
  fontSize: 12,
  color: 'var(--ow-text-mid)',
  pointerEvents: 'auto',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: 8,
};

const eyebrowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontFamily: 'var(--ow-font-display)',
  fontSize: 9.5,
  fontWeight: 500,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--ow-text-lo)',
  marginBottom: 5,
};

const eyebrowDotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  flexShrink: 0,
};

const nameStyle: CSSProperties = {
  fontFamily: 'var(--ow-font-display)',
  fontSize: 17,
  fontWeight: 600,
  color: 'var(--ow-text-hi)',
  lineHeight: 1.15,
  overflowWrap: 'break-word',
};

const subStyle: CSSProperties = {
  fontFamily: 'var(--ow-font-mono)',
  fontSize: 10.5,
  color: 'var(--ow-text-faint)',
  letterSpacing: '0.04em',
  marginTop: 3,
};

const ghostCloseStyle: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: '0 0 4px 8px',
  color: 'var(--ow-text-lo)',
  fontSize: 17,
  lineHeight: 1,
  cursor: 'pointer',
  flexShrink: 0,
};

const heroRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  marginTop: 12,
  paddingTop: 12,
  borderTop: '1px solid var(--ow-stroke)',
};

const heroValueStyle: CSSProperties = {
  fontFamily: 'var(--ow-font-mono)',
  fontSize: 24,
  fontWeight: 600,
  color: PHYSICAL,
  letterSpacing: '0.01em',
  lineHeight: 1,
};

const heroUnitStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 400,
  color: 'var(--ow-text-lo)',
};

const heroLabelStyle: CSSProperties = {
  fontFamily: 'var(--ow-font-display)',
  fontSize: 10,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--ow-text-faint)',
  marginTop: 5,
};

const statGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: '10px 12px',
  marginTop: 12,
};

const statLabelStyle: CSSProperties = {
  fontFamily: 'var(--ow-font-display)',
  fontSize: 9.5,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--ow-text-faint)',
  marginBottom: 2,
};

const statValueStyle: CSSProperties = {
  fontFamily: 'var(--ow-font-mono)',
  fontSize: 12.5,
  color: 'var(--ow-text-hi)',
};

const provenanceStyle: CSSProperties = {
  marginTop: 12,
  fontFamily: 'var(--ow-font-display)',
  fontSize: 11.5,
  color: 'var(--ow-text-lo)',
  lineHeight: 1.5,
};

const revealStyle: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  marginTop: 8,
  fontFamily: 'var(--ow-font-mono)',
  fontSize: 10.5,
  letterSpacing: '0.05em',
  color: 'var(--ow-text-faint)',
  cursor: 'pointer',
};
