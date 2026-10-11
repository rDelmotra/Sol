/** Screen vignette plus faint scanlines over the globe. Static, no store. */
export function VignetteAndScan() {
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
