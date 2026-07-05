import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import type { ObjectCategory } from '../data/types';
import { PROGRAM_LABELS, type ObjectMetadata } from '../data/metadata-types';
import { fetchObjectMetadata } from '../data/metadata-client';

const CATEGORY_LABELS: Record<ObjectCategory, string> = {
  active_satellite: 'Active Satellite',
  inactive_satellite: 'Inactive Satellite',
  rocket_body: 'Rocket Body',
  debris: 'Debris',
  unknown: 'Unknown',
  deep_space: 'Deep Space',
};

const panelStyle: React.CSSProperties = {
  width: '100%',
  padding: '14px 16px',
  background: 'rgba(0, 0, 0, 0.7)',
  backdropFilter: 'blur(4px)',
  border: '1px solid rgba(255, 255, 255, 0.1)',
  borderTop: 'none',
  borderRadius: '0 0 8px 8px',
  fontFamily: 'monospace',
  fontSize: '12px',
  color: 'rgba(255, 255, 255, 0.85)',
  pointerEvents: 'auto',
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  padding: '3px 0',
};

const labelStyle: React.CSSProperties = {
  color: 'rgba(255, 255, 255, 0.45)',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  marginBottom: 10,
  paddingBottom: 8,
  borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
};

const closeStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'rgba(255, 255, 255, 0.5)',
  cursor: 'pointer',
  fontSize: '16px',
  padding: '0 0 0 8px',
  lineHeight: 1,
};


function Row({ label, value }: { label: string; value: string | number | null }) {
  if (value === null || value === '') return null;
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

/** Lazy /api/metadata/:noradId fetch — session-cached in metadata-client. */
function useObjectMetadata(noradId: number | null): ObjectMetadata | null {
  const [meta, setMeta] = useState<ObjectMetadata | null>(null);
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

const MANEUVERABILITY_LABELS: Record<string, string> = {
  M: 'Maneuverable',
  D: 'Deorbit-capable',
};

function formatKg(kg: number | null | undefined): string | null {
  return kg ? `${kg.toLocaleString()} kg` : null;
}

/** "L × Ø m (span S m)" from whichever dimensions GCAT has. */
function formatDimensions(m: ObjectMetadata): string | null {
  const body =
    m.lengthM && m.diameterM ? `${m.lengthM} × ${m.diameterM} m` : null;
  const span = m.spanM ? `span ${m.spanM} m` : null;
  if (body && span) return `${body} (${span})`;
  return body ?? span;
}

/** GCAT+UCS detail rows for the selected TLE object (lazy-fetched). */
function MetadataRows({ meta }: { meta: ObjectMetadata | null }) {
  if (!meta) return null;
  return (
    <>
      <Row label="Series" value={meta.gcatProgram ?? null} />
      <Row label="Operator" value={meta.operatorOrg} />
      <Row label="Launch mass" value={formatKg(meta.launchMassKg)} />
      <Row label="Dry mass" value={formatKg(meta.dryMassKg)} />
      <Row label="Size" value={formatDimensions(meta)} />
      <Row label="Bus" value={meta.bus ?? null} />
      <Row label="Shape" value={meta.shape ?? null} />
      <Row
        label="Propulsion"
        value={meta.maneuverability ? MANEUVERABILITY_LABELS[meta.maneuverability] : null}
      />
      <Row label="Last active" value={meta.lastActiveDate ?? null} />
      <Row label="Ops ended" value={meta.endOpDate ?? null} />
      {meta.sources.includes('gcat') && (
        <div style={{ marginTop: 6, fontSize: '10px', color: 'rgba(255,255,255,0.3)' }}>
          Catalog data: GCAT / J. McDowell (CC-BY)
        </div>
      )}
    </>
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
  const meta = useObjectMetadata(selectedSatellite?.noradId ?? null);

  if (!selectedSatellite && !selectedDso) return null;

  if (selectedDso) {
    const dso = selectedDso;
    const isTracking = cameraMode === 'flying' || cameraMode === 'following';
    const followActive = isTracking && trackingStyle === 'follow';
    const joyrideActive = isTracking && trackingStyle === 'joyride';
    return (
      <div style={panelStyle}>
        <div style={headerStyle}>
          <div>
            <div style={{ fontSize: '13px', fontWeight: 600, color: '#fff', marginBottom: 2 }}>
              {dso.name}
            </div>
            <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)' }}>
              {dso.mission}
            </div>
          </div>
          <button
            style={closeStyle}
            onClick={() => setSelectedDso(null)}
            title="Close"
          >
            ×
          </button>
        </div>

        <Row label="Type" value="Deep Space Mission" />
        <Row label="Mission" value={dso.mission} />
        <Row label="Target" value={dso.targetBody} />
        <Row label="Regime" value={dso.regime} />
        <Row label="Provider" value={dso.provider} />
        <Row label="Freshness" value={dso.freshnessState} />

        <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
          <button
            onClick={() => {
              if (cameraMode === 'returning') {
                setCameraMode('free');
              } else if (followActive) {
                setCameraMode('returning');
              } else {
                triggerFlyToDso?.(dso.dsoId);
              }
            }}
            style={{
              flex: 1,
              padding: '6px 0',
              background: followActive ? 'rgba(0, 229, 255, 0.2)' : 'rgba(255, 255, 255, 0.06)',
              border: `1px solid ${followActive ? 'rgba(0, 229, 255, 0.5)' : 'rgba(255, 255, 255, 0.12)'}`,
              borderRadius: 4,
              color: followActive ? '#00E5FF' : 'rgba(255, 255, 255, 0.7)',
              fontFamily: 'monospace',
              fontSize: '11px',
              cursor: 'pointer',
            }}
          >
            {cameraMode === 'returning'
              ? 'Stop'
              : (followActive ? (cameraMode === 'flying' ? 'Cancel' : 'Unfollow') : 'Go to')}
          </button>
          <button
            onClick={() => {
              if (cameraMode === 'returning') {
                setCameraMode('free');
              } else if (joyrideActive) {
                setCameraMode('returning');
              } else {
                triggerJoyrideDso?.(dso.dsoId);
              }
            }}
            style={{
              flex: 1,
              padding: '6px 0',
              background: joyrideActive ? 'rgba(0, 229, 255, 0.2)' : 'rgba(255, 255, 255, 0.06)',
              border: `1px solid ${joyrideActive ? 'rgba(0, 229, 255, 0.5)' : 'rgba(255, 255, 255, 0.12)'}`,
              borderRadius: 4,
              color: joyrideActive ? '#00E5FF' : 'rgba(255, 255, 255, 0.7)',
              fontFamily: 'monospace',
              fontSize: '11px',
              cursor: 'pointer',
            }}
          >
            {joyrideActive ? (cameraMode === 'flying' ? 'Cancel ride' : 'Exit ride') : 'Joyride'}
          </button>
          <button
            onClick={() => setShowOrbitTrail(!showOrbitTrail)}
            style={{
              flex: 1,
              padding: '6px 0',
              background: showOrbitTrail ? 'rgba(0, 229, 255, 0.15)' : 'rgba(255, 255, 255, 0.06)',
              border: `1px solid ${showOrbitTrail ? 'rgba(0, 229, 255, 0.4)' : 'rgba(255, 255, 255, 0.12)'}`,
              borderRadius: 4,
              color: showOrbitTrail ? '#00E5FF' : 'rgba(255, 255, 255, 0.7)',
              fontFamily: 'monospace',
              fontSize: '11px',
              cursor: 'pointer',
            }}
          >
            {showOrbitTrail ? 'Hide orbit' : 'Show orbit'}
          </button>
        </div>
      </div>
    );
  }

  const s = selectedSatellite!;
  const isTracking = cameraMode === 'flying' || cameraMode === 'following';
  const followActive = isTracking && trackingStyle === 'follow';
  const joyrideActive = isTracking && trackingStyle === 'joyride';

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <div>
          <div style={{ fontSize: '13px', fontWeight: 600, color: '#fff', marginBottom: 2 }}>
            {s.name}
          </div>
          <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)' }}>
            NORAD {s.noradId}
          </div>
        </div>
        <button
          style={closeStyle}
          onClick={() => setSelectedSatellite(null, null)}
          title="Close"
        >
          ×
        </button>
      </div>

      <Row label="Status" value={CATEGORY_LABELS[s.category]} />
      <Row label="Type" value={s.objectType} />
      <Row label="Regime" value={s.regime} />
      <Row label="Altitude" value={selectedAltitude !== null ? `${selectedAltitude.toLocaleString()} km` : null} />
      <Row label="Period" value={`${s.period.toFixed(1)} min`} />
      <Row label="Inclination" value={`${s.inclination.toFixed(1)}°`} />
      <Row label="Apogee" value={`${Math.round(s.apogee).toLocaleString()} km`} />
      <Row label="Perigee" value={`${Math.round(s.perigee).toLocaleString()} km`} />
      <Row label="Program" value={s.program ? (PROGRAM_LABELS[s.program] ?? s.program) : null} />
      <Row label="Country" value={s.countryCode} />
      <Row label="Launch" value={s.launchDate} />
      <Row label="Epoch" value={s.epoch?.slice(0, 10) ?? null} />
      <MetadataRows meta={meta} />

      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        <button
          onClick={() => {
            if (cameraMode === 'returning') {
              setCameraMode('free');
            } else if (followActive) {
              setCameraMode('returning');
            } else {
              if (selectedIndex !== null) {
                triggerFlyTo?.(selectedIndex);
              }
            }
          }}
          style={{
            flex: 1,
            padding: '6px 0',
            background: followActive ? 'rgba(0, 229, 255, 0.2)' : 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${followActive ? 'rgba(0, 229, 255, 0.5)' : 'rgba(255, 255, 255, 0.12)'}`,
            borderRadius: 4,
            color: followActive ? '#00E5FF' : 'rgba(255, 255, 255, 0.7)',
            fontFamily: 'monospace',
            fontSize: '11px',
            cursor: 'pointer',
          }}
        >
          {cameraMode === 'returning'
            ? 'Stop'
            : (followActive ? (cameraMode === 'flying' ? 'Cancel' : 'Unfollow') : 'Go to')}
        </button>
        <button
          onClick={() => {
            if (cameraMode === 'returning') {
              setCameraMode('free');
            } else if (joyrideActive) {
              setCameraMode('returning');
            } else {
              if (selectedIndex !== null) {
                triggerJoyride?.(selectedIndex);
              }
            }
          }}
          style={{
            flex: 1,
            padding: '6px 0',
            background: joyrideActive ? 'rgba(0, 229, 255, 0.2)' : 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${joyrideActive ? 'rgba(0, 229, 255, 0.5)' : 'rgba(255, 255, 255, 0.12)'}`,
            borderRadius: 4,
            color: joyrideActive ? '#00E5FF' : 'rgba(255, 255, 255, 0.7)',
            fontFamily: 'monospace',
            fontSize: '11px',
            cursor: 'pointer',
          }}
        >
          {joyrideActive ? (cameraMode === 'flying' ? 'Cancel ride' : 'Exit ride') : 'Joyride'}
        </button>
        <button
          onClick={() => setShowOrbitTrail(!showOrbitTrail)}
          style={{
            flex: 1,
            padding: '6px 0',
            background: showOrbitTrail ? 'rgba(0, 229, 255, 0.15)' : 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${showOrbitTrail ? 'rgba(0, 229, 255, 0.4)' : 'rgba(255, 255, 255, 0.12)'}`,
            borderRadius: 4,
            color: showOrbitTrail ? '#00E5FF' : 'rgba(255, 255, 255, 0.7)',
            fontFamily: 'monospace',
            fontSize: '11px',
            cursor: 'pointer',
          }}
        >
          {showOrbitTrail ? 'Hide orbit' : 'Show orbit'}
        </button>
      </div>
    </div>
  );
}
