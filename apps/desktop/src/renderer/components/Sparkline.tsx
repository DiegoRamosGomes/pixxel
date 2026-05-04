// Mini-chart de linha SVG. Recebe array de samples (0..max) e renderiza
// um polyline. Sem libs — viewBox 100x40, escala automática.

type Props = {
  samples: number[];
  max?: number;
  width?: number;
  height?: number;
  className?: string;
};

export function Sparkline({
  samples,
  max = 100,
  width = 100,
  height = 28,
  className,
}: Props) {
  if (samples.length < 2) {
    return (
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className={`spark ${className ?? ''}`}
        preserveAspectRatio="none"
      >
        <line
          x1={0}
          x2={width}
          y1={height - 1}
          y2={height - 1}
          stroke="currentColor"
          strokeWidth={1}
          strokeOpacity={0.3}
        />
      </svg>
    );
  }
  const stepX = width / (samples.length - 1);
  const points = samples
    .map((v, i) => {
      const clamped = Math.max(0, Math.min(max, v));
      const x = i * stepX;
      // Pad 1px top/bottom pra linha não cortar nas bordas.
      const y = height - 1 - (clamped / max) * (height - 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  // Polígono fechado pro fill leve embaixo da linha.
  const fillPoints = `0,${height} ${points} ${width},${height}`;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={`spark ${className ?? ''}`}
      preserveAspectRatio="none"
    >
      <polygon points={fillPoints} className="spark__fill" />
      <polyline points={points} className="spark__line" />
    </svg>
  );
}
