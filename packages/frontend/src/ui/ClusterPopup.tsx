import { useStore } from '../store/useStore';
import { CATEGORY_COLOR } from './styles/tokens';

const CATEGORY_DOT = CATEGORY_COLOR;

const panelStyle: React.CSSProperties = {
  position: 'fixed',
  padding: '6px 0',
  fontFamily: 'var(--ow-font-display)',
  fontSize: '12px',
  color: 'var(--ow-text-mid)',
  pointerEvents: 'auto',
  zIndex: 950,
  maxHeight: 260,
  overflowY: 'auto',
  minWidth: 208,
};

const itemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '5px 12px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const itemHoverBg = 'var(--ow-surface-hover)';

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
      className="ow-glass ow-scroll"
      data-elev="3"
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
          color: 'var(--ow-text-faint)',
          borderBottom: '1px solid var(--ow-stroke)',
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
          <span style={{ color: 'var(--ow-text-faint)', fontFamily: 'var(--ow-font-mono)', fontSize: '10px', marginLeft: 8 }}>
            {item.data.noradId}
          </span>
        </div>
      ))}
    </div>
  );
}
