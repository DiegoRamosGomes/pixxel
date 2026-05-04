import { useEffect, useRef, useState } from 'react';
import type { HandLandmarker as HandLandmarkerType } from '@mediapipe/tasks-vision';

const WASM_BASE =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/wasm';
const HAND_MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const TICK_MS = 66; // ~15 fps — equilíbrio entre latência e CPU
const SMOOTH_ALPHA = 0.2; // EMA: maior = mais responsivo, menor = mais estável

// Pinch polegar+indicador (4↔8) = clique. Hysteresis evita flicker.
const PINCH_ENTER = 0.18; // razão dist / palm_width pra ativar
const PINCH_EXIT = 0.30; // razão pra desativar
// Drag: pinch sustentado por mais que esse tempo vira mousedown (não click).
const DRAG_HOLD_MS = 500;
// Pinch polegar+médio (4↔12) = modo scroll. Mesma família de gesto, menos
// natural que o índice — evita disparo acidental durante apontar.
const SCROLL_ENTER = 0.20;
const SCROLL_EXIT = 0.32;
// Quanto de movimento vertical (em fração do frame) emite um tick de scroll.
const SCROLL_TICK_DY = 0.025;

// Mapeamento: usa os 60% centrais do frame da câmera como área ativa.
// Movimento dentro disso cobre a tela toda — não precisa esticar braço.
const ACTIVE_RATIO = 0.6;

type Landmark = { x: number; y: number; z: number };

type Props = {
  enabled: boolean;
  /** Tamanho da tela (vem do main quando ativa). */
  screen: { width: number; height: number } | null;
  /** Device ID da câmera. null = padrão do sistema. */
  videoDeviceId?: string | null;
  onError?: (msg: string) => void;
};

function dist(a: Landmark, b: Landmark): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function HandMouseController({ enabled, screen, videoDeviceId, onError }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState<'off' | 'starting' | 'on' | 'error'>('off');

  useEffect(() => {
    if (!enabled || !screen) {
      setStatus('off');
      return;
    }

    setStatus('starting');
    let cancelled = false;
    let stream: MediaStream | null = null;
    let detector: HandLandmarkerType | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;

    // Estado do gesto/cursor — refs locais ao effect, não state (não re-renderiza).
    let smoothedX: number | null = null;
    let smoothedY: number | null = null;
    let pinching = false;
    let pinchStartedAt = 0;
    let dragActive = false;
    // Modo scroll: ativo enquanto polegar+médio pinçados. Congela cursor e
    // converte movimento vertical da palma em ticks de scroll.
    let scrolling = false;
    let scrollAnchorY = 0; // Y normalizado do palm no momento do último tick
    // Diagnóstico: amostra do ratio pra calibrar threshold
    let frameCount = 0;
    let minRatio = Infinity;
    let maxRatio = -Infinity;

    (async () => {
      try {
        // 1. Stream da webcam (escondido — não tem <video> visível na tela)
        const videoConstraints: MediaTrackConstraints = {
          width: 640,
          height: 480,
          frameRate: { ideal: 30 },
        };
        if (videoDeviceId) videoConstraints.deviceId = { exact: videoDeviceId };
        stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();

        // 2. Carrega HandLandmarker
        const { FilesetResolver, HandLandmarker } = await import(
          '@mediapipe/tasks-vision'
        );
        const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
        if (cancelled) return;

        const det = await HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'CPU' },
          runningMode: 'VIDEO',
          numHands: 1,
          minHandDetectionConfidence: 0.6,
          minHandPresenceConfidence: 0.6,
          minTrackingConfidence: 0.6,
        });
        if (cancelled) {
          det.close();
          return;
        }
        detector = det;
        setStatus('on');

        // 3. Loop de detecção
        interval = setInterval(() => {
          if (!detector || !video || video.readyState < 2) return;
          let result;
          try {
            result = detector.detectForVideo(video, performance.now());
          } catch (err) {
            console.warn('[hand-mouse] detect falhou:', err);
            return;
          }

          const hands = result.landmarks;
          if (!hands || hands.length === 0) {
            // Sem mão — solta drag se estava ativo
            if (dragActive) {
              window.assistant.handMouseUp(1);
              dragActive = false;
            }
            pinching = false;
            return;
          }

          const lm = hands[0]; // 21 pontos
          const indexTip = lm[8];
          const middleTip = lm[12];
          const thumbTip = lm[4];
          const wrist = lm[0];
          const middleMcp = lm[9]; // base do dedo médio — centro da palma

          if (!indexTip || !middleTip || !thumbTip || !wrist || !middleMcp) return;

          // === Referência da palma ===
          // Normaliza distâncias pela distância wrist↔middleMcp pra ser
          // invariante a distância da câmera.
          const palmRef = dist(wrist, middleMcp);
          if (palmRef <= 0) return;
          const pinchRatio = dist(thumbTip, indexTip) / palmRef;
          const scrollRatio = dist(thumbTip, middleTip) / palmRef;

          // Câmera mirrorada (selfie). Coordenada do centro da palma.
          const rawX = 1 - middleMcp.x;
          const rawY = middleMcp.y;

          // === Modo scroll (polegar+médio) ===
          // Tem prioridade: enquanto scrolling, cursor congela e clique fica off.
          if (!scrolling && scrollRatio < SCROLL_ENTER) {
            scrolling = true;
            scrollAnchorY = rawY;
            console.log('[hand-mouse] SCROLL START');
          } else if (scrolling && scrollRatio > SCROLL_EXIT) {
            scrolling = false;
            console.log('[hand-mouse] SCROLL END');
          }

          if (scrolling) {
            const dy = rawY - scrollAnchorY;
            if (Math.abs(dy) >= SCROLL_TICK_DY) {
              const ticks = Math.floor(Math.abs(dy) / SCROLL_TICK_DY);
              // Mão sobe (rawY diminui) → scroll up; desce → scroll down
              const direction: 'up' | 'down' = dy < 0 ? 'up' : 'down';
              window.assistant.handMouseScroll(direction, ticks);
              // Avança a âncora pelos ticks consumidos (mantém resto)
              const consumed = ticks * SCROLL_TICK_DY * (dy < 0 ? -1 : 1);
              scrollAnchorY += consumed;
            }
            return; // não move cursor nem processa click
          }

          // === Movimento normal do cursor ===
          // Mapeia [centro ± ACTIVE_RATIO/2] → [0..1] da tela.
          const margin = (1 - ACTIVE_RATIO) / 2;
          const mappedX = (rawX - margin) / ACTIVE_RATIO;
          const mappedY = (rawY - margin) / ACTIVE_RATIO;
          const clampedX = Math.max(0, Math.min(1, mappedX));
          const clampedY = Math.max(0, Math.min(1, mappedY));

          // EMA pra reduzir jitter
          smoothedX = smoothedX == null
            ? clampedX
            : smoothedX + SMOOTH_ALPHA * (clampedX - smoothedX);
          smoothedY = smoothedY == null
            ? clampedY
            : smoothedY + SMOOTH_ALPHA * (clampedY - smoothedY);

          const px = Math.round(smoothedX * screen.width);
          const py = Math.round(smoothedY * screen.height);
          window.assistant.handMouseMove(px, py);

          // Diag: amostra ratio a cada ~2s
          frameCount += 1;
          if (pinchRatio < minRatio) minRatio = pinchRatio;
          if (pinchRatio > maxRatio) maxRatio = pinchRatio;
          if (frameCount % 30 === 0) {
            console.log(
              `[hand-mouse] ratio: cur=${pinchRatio.toFixed(3)} min=${minRatio.toFixed(3)} max=${maxRatio.toFixed(3)} (enter<${PINCH_ENTER} exit>${PINCH_EXIT})`,
            );
            minRatio = Infinity;
            maxRatio = -Infinity;
          }

          const now = performance.now();
          if (!pinching && pinchRatio < PINCH_ENTER) {
            pinching = true;
            pinchStartedAt = now;
            console.log(`[hand-mouse] PINCH START ratio=${pinchRatio.toFixed(3)}`);
          } else if (pinching && pinchRatio > PINCH_EXIT) {
            pinching = false;
            const heldMs = now - pinchStartedAt;
            // Soltou: se virou drag, libera; senão, foi click curto
            if (dragActive) {
              window.assistant.handMouseUp(1);
              dragActive = false;
              console.log(`[hand-mouse] DRAG END (held ${heldMs.toFixed(0)}ms)`);
            } else {
              window.assistant.handMouseClick(1);
              console.log(`[hand-mouse] CLICK (held ${heldMs.toFixed(0)}ms)`);
            }
          } else if (pinching && !dragActive && now - pinchStartedAt > DRAG_HOLD_MS) {
            // Pinch sustentado virou drag: pressiona botão e mantém
            dragActive = true;
            window.assistant.handMouseDown(1);
            console.log('[hand-mouse] DRAG START');
          }
        }, TICK_MS);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[hand-mouse] init falhou:', msg);
        setStatus('error');
        onError?.(msg);
      }
    })();

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
      if (dragActive) {
        try {
          window.assistant.handMouseUp(1);
        } catch {
          /* ignore */
        }
      }
      detector?.close();
      stream?.getTracks().forEach((t) => t.stop());
      const v = videoRef.current;
      if (v) v.srcObject = null;
    };
  }, [enabled, screen, videoDeviceId, onError]);

  // Vídeo invisível mas renderizado (precisa do elemento real pro getUserMedia
  // alimentar e o landmarker amostrar — display:none costuma pausar o stream
  // em algumas plataformas, então deixamos 1×1 transparente).
  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted
      style={{
        position: 'fixed',
        bottom: 0,
        right: 0,
        width: 1,
        height: 1,
        opacity: 0,
        pointerEvents: 'none',
      }}
      data-hand-mouse-status={status}
    />
  );
}
