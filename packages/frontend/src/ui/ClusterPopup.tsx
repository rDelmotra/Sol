import { useStore } from '../store/useStore';
import type { ObjectCategory } from '@orbitwatch/contracts';

const CATEGORY_DOT: Record<ObjectCategory, string> = {
  active_satellite: '#4CAF50',
  inactive_satellite: '#9E9E9E',
  rocket_body: '#FFC107',
  debris: '#F44336',
  unknown: '#757575',
  deep_space: '#00BCD4',
};

const panelStyle: React.CSSProperties = {
  position: 'fixed',
  padding: '6px 0',
  background: 'rgba(0, 0, 0, 0.85)',
  backdropFilter: 'blur(6px)',
  border: '1px solid rgba(255, 255, 255, 0.15)',
  borderRadius: 6,
  fontFamily: 'monospace',
  fontSize: '11px',
  color: 'rgba(255, 255, 255, 0.85)',
  pointerEvents: 'auto',
  zIndex: 950,
  maxHeight: 240,
  overflowY: 'auto',
  minWidth: 200,
};

const itemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '5px 12px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const itemHoverBg = 'rgba(255, 255, 255, 0.08)';

export function ClusterPopup() {
  const items = useStore((s) => s.clusterItems);
  const screenX = useStore((s) => s.clusterScreenX);
  const screenY = useStore((s) => s.clusterScreenY);
  const setSelectedSatellite = useStore((s) => s.setSelectedSatellite);
  const clearCluster = useStore((s) => s.clearCluster);

  if (items.length === 0) return null;

  const handleSelect = (item: (typeof items)[0]) => {
    setSelectedSatellite(item.index, item.data, item.altitude);
    clearCluster();
  };

  return (
    <div
      style={{
        ...panelStyle,
        left: screenX + 10,
        top: screenY - 10,
      }}
    >
      <div
        style={{
          padding: '2px 12px 6px',
          fontSize: '10px',
          color: 'rgba(255,255,255,0.35)',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          marginBottom: 2,
        }}
      >
        {items.length} objects at this location
      </div>
      {items.map((item) => (
        <div
          key={item.index}
          style={itemStyle}
          onClick={() => handleSelect(item)}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = itemHoverBg;
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = 'transparent';
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: CATEGORY_DOT[item.data.category] ?? CATEGORY_DOT.unknown,
              flexShrink: 0,
            }}
          />
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {item.data.name}
          </span>
          <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: '10px', marginLeft: 8 }}>
            {item.data.noradId}
          </span>
        </div>
      ))}
    </div>
  );
}
