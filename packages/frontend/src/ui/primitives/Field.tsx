import type { CSSProperties, ReactNode } from 'react';

/**
 * A label→value row for detail panels (InfoCard). The value slot is monospace
 * by default (telemetry), overridable. Renders nothing when `value` is empty so
 * callers can list every possible field without guarding each one.
 */
export function Field({
  label,
  value,
  mono = true,
  valueColor,
  onClick,
  title,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  valueColor?: string;
  onClick?: () => void;
  title?: string;
}) {
  if (value === null || value === undefined || value === '') return null;
  const valueStyle: CSSProperties = {
    fontFamily: mono ? 'var(--ow-font-mono)' : 'var(--ow-font-display)',
    color: valueColor ?? 'var(--ow-text-hi)',
    fontSize: 12,
    cursor: onClick ? 'pointer' : undefined,
    textAlign: 'right',
  };
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{label}</span>
      <span style={valueStyle} onClick={onClick} title={title}>
        {value}
      </span>
    </div>
  );
}

const rowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  gap: 12,
  padding: '3px 0',
};

const labelStyle: CSSProperties = {
  color: 'var(--ow-text-lo)',
  fontFamily: 'var(--ow-font-display)',
  fontSize: 12,
};
