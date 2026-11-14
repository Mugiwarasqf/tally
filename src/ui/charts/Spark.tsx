/** Tiny trend line for stat tiles: de-emphasised grey, with the current point in the accent colour. */
export function Spark({ values, width = 96, height = 32, label }: { values: number[]; width?: number; height?: number; label: string }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const px = (i: number) => 3 + (i / (values.length - 1)) * (width - 6);
  const py = (v: number) => height - 4 - ((v - lo) / span) * (height - 8);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join('');
  const last = values.length - 1;
  return (
    <svg width={width} height={height} role="img" aria-label={label} className="spark">
      <path d={d} className="spark__line" />
      <circle cx={px(last)} cy={py(values[last]!)} r={4} className="spark__dot" />
    </svg>
  );
}
