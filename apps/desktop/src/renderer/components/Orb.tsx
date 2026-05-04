export type OrbState = 'idle' | 'thinking' | 'speaking';

const STATE_LABEL: Record<OrbState, string> = {
  idle: 'pronto',
  thinking: 'pensando',
  speaking: 'falando',
};

type Props = { state: OrbState; present?: boolean };

// Flor da vida: 1 círculo central + 6 ao redor (hex), + 12 outros (camada 2).
// Distância entre centros = R, raio dos círculos = R.
const R = 22;
const SQRT3_2 = Math.sqrt(3) / 2;

function buildFlowerOfLife(): Array<{ cx: number; cy: number }> {
  const out: Array<{ cx: number; cy: number }> = [{ cx: 0, cy: 0 }];
  // Camada 1: 6 vizinhos hexagonais
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    out.push({ cx: R * Math.cos(a), cy: R * Math.sin(a) });
  }
  // Camada 2: 12 ao redor — alternando vértice (2R distância) e meio (R√3)
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    out.push({ cx: 2 * R * Math.cos(a), cy: 2 * R * Math.sin(a) });
  }
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3 + Math.PI / 6;
    const d = R * Math.sqrt(3);
    out.push({ cx: d * Math.cos(a), cy: d * Math.sin(a) });
  }
  return out;
}

const FLOWER = buildFlowerOfLife();

// 60 marcas (tipo mostrador) — cada 30° é uma marca grossa.
const TICKS = Array.from({ length: 60 }, (_, i) => i * 6);

// Caminho ondulado (rosáceo) ao redor do centro (200,200).
// `lobes` controla quantas cristas, `amp` a amplitude da ondulação.
function buildWavyPath(baseR: number, amp: number, lobes: number, phase = 0): string {
  const cx = 200;
  const cy = 200;
  const steps = 180;
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const r = baseR + amp * Math.sin(lobes * t + phase);
    const x = cx + r * Math.cos(t);
    const y = cy + r * Math.sin(t);
    d += i === 0 ? `M${x.toFixed(2)} ${y.toFixed(2)}` : `L${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return d + 'Z';
}

const FLOATING_WAVES = [
  { d: buildWavyPath(150, 10, 6, 0), cls: 'orb__fw--1' },
  { d: buildWavyPath(162, 7, 9, Math.PI / 4), cls: 'orb__fw--2' },
  { d: buildWavyPath(174, 5, 12, Math.PI / 2), cls: 'orb__fw--3' },
  { d: buildWavyPath(184, 4, 15, Math.PI / 3), cls: 'orb__fw--4' },
];

export function Orb({ state, present = true }: Props) {
  return (
    <>
      <div
        className={`orb orb--${state}${present ? '' : ' orb--away'}`}
        aria-label={`assistente ${STATE_LABEL[state]}${present ? '' : ' (usuário ausente)'}`}
      >
        <svg
          viewBox="0 0 400 400"
          preserveAspectRatio="xMidYMid meet"
          className="orb__svg"
        >
          <defs>
            <radialGradient id="orb-bg" cx="0.5" cy="0.5" r="0.55">
              <stop offset="0%" stopColor="rgba(0, 212, 255, 0.32)" />
              <stop offset="40%" stopColor="rgba(0, 130, 200, 0.14)" />
              <stop offset="100%" stopColor="transparent" />
            </radialGradient>
            <radialGradient id="orb-core" cx="0.5" cy="0.45" r="0.55">
              <stop offset="0%" stopColor="rgba(180, 240, 255, 0.55)" />
              <stop offset="55%" stopColor="rgba(0, 168, 230, 0.18)" />
              <stop offset="100%" stopColor="rgba(2, 14, 28, 0.0)" />
            </radialGradient>
            <filter id="orb-soft-glow" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="1.2" />
            </filter>
          </defs>

          {/* Glow de fundo */}
          <circle cx="200" cy="200" r="195" fill="url(#orb-bg)" />

          {/* Ondas flutuantes — só visíveis em "speaking" */}
          <g className="orb__floating-waves" aria-hidden="true">
            {FLOATING_WAVES.map((w, i) => (
              <path
                key={i}
                d={w.d}
                className={`orb__fw ${w.cls}`}
                fill="none"
              />
            ))}
          </g>

          {/* Ticks (mostrador) */}
          <g className="orb__ticks">
            {TICKS.map((angle) => {
              const major = angle % 30 === 0;
              const len = major ? 12 : 6;
              return (
                <line
                  key={angle}
                  x1="200"
                  y1="40"
                  x2="200"
                  y2={40 + len}
                  stroke={major ? 'rgba(0,212,255,0.85)' : 'rgba(0,212,255,0.32)'}
                  strokeWidth={major ? 1.4 : 0.6}
                  transform={`rotate(${angle} 200 200)`}
                />
              );
            })}
          </g>

          {/* Anel decorativo girando devagar */}
          <g className="orb__rot orb__rot--slow">
            <circle
              cx="200"
              cy="200"
              r="148"
              fill="none"
              stroke="rgba(0, 212, 255, 0.42)"
              strokeWidth="0.7"
              strokeDasharray="3 7"
            />
          </g>

          {/* Anel girando ao contrário */}
          <g className="orb__rot orb__rot--rev">
            <circle
              cx="200"
              cy="200"
              r="132"
              fill="none"
              stroke="rgba(0, 212, 255, 0.55)"
              strokeWidth="0.9"
              strokeDasharray="1 4"
            />
          </g>

          {/* Anel sólido fino interno */}
          <circle
            cx="200"
            cy="200"
            r="116"
            fill="none"
            stroke="rgba(0, 212, 255, 0.62)"
            strokeWidth="1.2"
          />

          {/* Núcleo: gradiente radial com pulso */}
          <circle
            cx="200"
            cy="200"
            r="100"
            fill="url(#orb-core)"
            className="orb__core"
          />

          {/* Flor da vida no centro */}
          <g
            className="orb__flower"
            transform="translate(200 200)"
            filter="url(#orb-soft-glow)"
          >
            {FLOWER.map(({ cx, cy }, i) => (
              <circle
                key={i}
                cx={cx}
                cy={cy}
                r={R}
                fill="none"
                stroke="rgba(120, 230, 255, 0.55)"
                strokeWidth="0.55"
              />
            ))}
          </g>

          {/* Borda final do núcleo (define limite circular do padrão) */}
          <circle
            cx="200"
            cy="200"
            r="80"
            fill="none"
            stroke="rgba(140, 230, 255, 0.7)"
            strokeWidth="0.9"
          />
        </svg>
      </div>
      <div className={`orb-state orb-state--${state}`}>{STATE_LABEL[state]}</div>
    </>
  );
}
