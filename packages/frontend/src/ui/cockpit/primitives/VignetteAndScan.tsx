/** Screen vignette over the globe. Static, no store. (The scanline stripes were removed: they looked like a dirty screen.) */
export function VignetteAndScan() {
  return (
    <div
      style={{
        pointerEvents: 'none',
        position: 'absolute',
        inset: 0,
        background: 'radial-gradient(ellipse at 50% 50%, transparent 55%, oklch(0.05 0.02 250 / 0.75) 100%)',
      }}
    />
  );
}
