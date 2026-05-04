import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d';
import { useDragHandle } from './widgets/useDragHandle.js';

type NodeType = 'user' | 'feedback' | 'project' | 'reference' | 'hub';

type GraphNode = {
  id: string;
  label: string;
  type: NodeType;
  description?: string;
};

type GraphEdge = { source: string; target: string; kind: 'link' | 'type' };

type Props = {
  initialX: number;
  initialY: number;
  onClose: () => void;
  onActivate?: () => void;
};

const TYPE_COLORS: Record<NodeType, string> = {
  user: '#6ec1ff',
  feedback: '#ffb86b',
  project: '#a78bfa',
  reference: '#5dd6a8',
  hub: '#e7e7ee',
};

const WIDTH = 640;
const HEIGHT = 460;

export function MemoryGraphPanel({ initialX, initialY, onClose, onActivate }: Props) {
  const [data, setData] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] }>({
    nodes: [],
    edges: [],
  });
  const [hover, setHover] = useState<GraphNode | null>(null);
  const [loaded, setLoaded] = useState(false);
  const fgRef = useRef<ForceGraphMethods<GraphNode, GraphEdge> | undefined>(undefined);
  const { pos, dragging, handleProps } = useDragHandle({
    initialX,
    initialY,
    headSelector: '.memgraph-panel__head',
    ignoreSelector: '.memgraph-panel__btn',
    onActivate,
  });

  useEffect(() => {
    let cancelled = false;
    void window.assistant
      .memoryGraph()
      .then((g) => {
        if (cancelled) return;
        setData(g as { nodes: GraphNode[]; edges: GraphEdge[] });
        setLoaded(true);
      })
      .catch((err) => {
        console.warn('[memgraph] falhou ao buscar:', err);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // O lib espera links com { source, target } — nossos edges já têm. Mas o
  // lib mutaciona os objetos durante a simulação, então passamos cópias.
  const graphData = useMemo(
    () => ({
      nodes: data.nodes.map((n) => ({ ...n })),
      links: data.edges.map((e) => ({ ...e })),
    }),
    [data],
  );

  useEffect(() => {
    if (!loaded || !fgRef.current) return;
    // Pequeno zoom-to-fit assim que a simulação estabiliza.
    const t = setTimeout(() => fgRef.current?.zoomToFit(400, 40), 600);
    return () => clearTimeout(t);
  }, [loaded, graphData]);

  const empty = loaded && data.nodes.filter((n) => n.type !== 'hub').length === 0;

  return (
    <div
      className="memgraph-panel"
      style={{
        position: 'absolute',
        left: pos.x,
        top: pos.y,
        width: WIDTH,
        cursor: dragging ? 'grabbing' : 'auto',
      }}
      onMouseDown={() => onActivate?.()}
    >
      <div className="memgraph-panel__head" {...handleProps}>
        <span className="memgraph-panel__title">Memória — grafo</span>
        <span className="memgraph-panel__count">
          {data.nodes.filter((n) => n.type !== 'hub').length} entradas
        </span>
        <button className="memgraph-panel__btn" onClick={onClose} title="Fechar">
          ×
        </button>
      </div>

      <div
        className="memgraph-panel__legend"
        style={{ display: 'flex', gap: 12, padding: '6px 12px', fontSize: 11 }}
      >
        {(['user', 'feedback', 'project', 'reference'] as NodeType[]).map((t) => (
          <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                background: TYPE_COLORS[t],
                display: 'inline-block',
              }}
            />
            {t}
          </span>
        ))}
      </div>

      <div
        style={{
          width: WIDTH,
          height: HEIGHT,
          position: 'relative',
          background: '#0d0f14',
          borderTop: '1px solid #1f2330',
          borderBottom: '1px solid #1f2330',
        }}
      >
        {empty ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#7c8493',
              fontSize: 13,
              padding: 20,
              textAlign: 'center',
            }}
          >
            Nada na memória ainda. Diga "lembra disso" pra começar a popular.
          </div>
        ) : (
          <ForceGraph2D
            ref={fgRef}
            graphData={graphData}
            width={WIDTH}
            height={HEIGHT}
            backgroundColor="#0d0f14"
            nodeRelSize={5}
            linkColor={(link) =>
              (link as unknown as GraphEdge).kind === 'type' ? '#262a36' : '#3b4356'
            }
            linkWidth={(link) => ((link as unknown as GraphEdge).kind === 'type' ? 0.5 : 1.2)}
            linkDirectionalParticles={(link) =>
              (link as unknown as GraphEdge).kind === 'link' ? 2 : 0
            }
            linkDirectionalParticleSpeed={0.005}
            linkDirectionalParticleWidth={1.5}
            nodeCanvasObject={(node, ctx, globalScale) => {
              const n = node as GraphNode & { x?: number; y?: number };
              if (n.x === undefined || n.y === undefined) return;
              const isHub = n.type === 'hub';
              const r = isHub ? 8 : 5;
              ctx.beginPath();
              ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
              ctx.fillStyle = TYPE_COLORS[n.type];
              ctx.fill();
              if (isHub) {
                ctx.strokeStyle = '#0d0f14';
                ctx.lineWidth = 2;
                ctx.stroke();
              }
              const label = isHub ? n.label.toUpperCase() : n.label;
              const fontSize = (isHub ? 11 : 10) / Math.max(globalScale, 0.8);
              ctx.font = `${isHub ? '600' : '400'} ${fontSize}px sans-serif`;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'top';
              ctx.fillStyle = isHub ? '#e7e7ee' : '#b6bcc9';
              ctx.fillText(label, n.x, n.y + r + 2);
            }}
            onNodeHover={(node) => setHover((node as GraphNode) ?? null)}
            cooldownTicks={120}
            onEngineStop={() => fgRef.current?.zoomToFit(400, 40)}
          />
        )}

        {hover && hover.type !== 'hub' && hover.description && (
          <div
            style={{
              position: 'absolute',
              left: 8,
              bottom: 8,
              right: 8,
              background: 'rgba(13,15,20,0.94)',
              border: '1px solid #2a2f3d',
              borderRadius: 6,
              padding: '6px 10px',
              fontSize: 12,
              color: '#cdd3df',
              pointerEvents: 'none',
            }}
          >
            <strong style={{ color: TYPE_COLORS[hover.type] }}>{hover.label}</strong>
            <span style={{ color: '#7c8493' }}> · {hover.type}</span>
            <div style={{ marginTop: 2 }}>{hover.description}</div>
          </div>
        )}
      </div>
    </div>
  );
}
