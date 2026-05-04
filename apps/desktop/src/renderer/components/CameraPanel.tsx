import { useEffect, useRef, useState } from 'react';
import { useDragHandle } from './widgets/useDragHandle.js';
import { useCameraDetections, type Box } from './useCameraDetections.js';

type Props = {
  initialX: number;
  initialY: number;
  onClose: () => void;
  onActivate?: () => void;
  onPresenceChange?: (present: boolean) => void;
  /** Device ID da câmera. null = padrão do sistema. */
  videoDeviceId?: string | null;
};

const WIDTH = 480;
const HEIGHT = 360;

export function CameraPanel({
  initialX,
  initialY,
  onClose,
  onActivate,
  onPresenceChange,
  videoDeviceId,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const { present, faces, objects, error: presenceError } = useCameraDetections({
    videoRef,
    enabled: ready && !error,
    onPresenceChange,
  });
  const overlayRef = useRef<HTMLCanvasElement | null>(null);

  // Desenha as boxes (rostos + objetos) sobre o vídeo. Espelha junto com o
  // CSS scaleX(-1) do <video> pra ficar visualmente alinhado.
  useEffect(() => {
    const video = videoRef.current;
    const canvas = overlayRef.current;
    if (!video || !canvas) return;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, cw, ch);
    if (!video.videoWidth || !video.videoHeight) return;

    const sx = cw / video.videoWidth;
    const sy = ch / video.videoHeight;

    const drawBox = (b: Box, color: string, label?: string) => {
      const x = b.x * sx;
      const y = b.y * sy;
      const w = b.w * sx;
      const h = b.h * sy;
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      ctx.strokeRect(x, y, w, h);
      ctx.shadowBlur = 0;
      if (label) {
        // Texto sai espelhado por causa do scaleX(-1) do canvas — desfaz só
        // pro texto, salvando/restaurando o estado.
        ctx.save();
        ctx.translate(cw, 0);
        ctx.scale(-1, 1);
        const mirroredX = cw - x - w;
        const text = label;
        ctx.font = '600 11px var(--mono, monospace)';
        const tw = ctx.measureText(text).width + 8;
        ctx.fillStyle = color;
        ctx.fillRect(mirroredX, y - 16, tw, 16);
        ctx.fillStyle = '#0d0f14';
        ctx.fillText(text, mirroredX + 4, y - 4);
        ctx.restore();
      }
    };

    for (const f of faces) drawBox(f, '#5dd6a8', 'rosto');
    for (const o of objects) {
      const pct = Math.round(o.score * 100);
      drawBox(o, '#00d4ff', `${o.label ?? 'objeto'} ${pct}%`);
    }
  }, [faces, objects]);
  const { pos, dragging, handleProps } = useDragHandle({
    initialX,
    initialY,
    headSelector: '.camera-panel__head',
    ignoreSelector: '.camera-panel__btn',
    onActivate,
  });

  useEffect(() => {
    const off = window.assistant.onEvent(async (event) => {
      if (event.type !== 'request_camera_frame') return;
      // Espera o video estar pronto — cobre o caso "abre a câmera e olha"
      // que dispara antes do stream entregar frame.
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const v = videoRef.current;
        if (v && v.readyState >= 2 && v.videoWidth > 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const video = videoRef.current;
      if (!video || video.readyState < 2 || !video.videoWidth) {
        window.assistant.cameraFrame(event.requestId, null);
        return;
      }
      try {
        const canvas = document.createElement('canvas');
        // Reduz pra 640px de largura no máximo — economiza tokens e banda.
        const maxW = 640;
        const scale = Math.min(1, maxW / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          window.assistant.cameraFrame(event.requestId, null);
          return;
        }
        // NÃO espelha o frame enviado pra IA — o scaleX(-1) é só CSS.
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
        window.assistant.cameraFrame(event.requestId, dataUrl);
      } catch (err) {
        console.warn('[camera] capture falhou:', err);
        window.assistant.cameraFrame(event.requestId, null);
      }
    });
    return off;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    const videoConstraints: MediaTrackConstraints | true = videoDeviceId
      ? { deviceId: { exact: videoDeviceId } }
      : true;
    navigator.mediaDevices
      .getUserMedia({ video: videoConstraints, audio: false })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        if (videoRef.current) {
          videoRef.current.srcObject = s;
          setReady(true);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('[camera] getUserMedia falhou:', err);
        setError(err?.message ?? 'Falha ao abrir a câmera');
      });
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [videoDeviceId]);

  return (
    <div
      className="camera-panel"
      style={{
        position: 'absolute',
        left: pos.x,
        top: pos.y,
        width: WIDTH,
        cursor: dragging ? 'grabbing' : 'auto',
      }}
      onMouseDown={() => onActivate?.()}
    >
      <div className="camera-panel__head" {...handleProps}>
        <span className="camera-panel__title">Câmera</span>
        {ready && !error && !presenceError && (
          <span
            className="camera-panel__presence"
            title={present ? 'Rosto detectado' : 'Sem rosto na câmera'}
            style={{
              fontSize: 11,
              color: present ? '#5dd6a8' : '#7c8493',
              fontFamily: 'var(--mono)',
            }}
          >
            {present ? '● presente' : '○ ausente'}
          </span>
        )}
        <span className="camera-panel__status">{error ? 'erro' : ready ? 'ao vivo' : '...'}</span>
        <button className="camera-panel__btn" onClick={onClose} title="Fechar">
          ×
        </button>
      </div>
      <div
        style={{
          width: WIDTH,
          height: HEIGHT,
          background: '#0d0f14',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#7c8493',
          fontSize: 13,
          padding: 20,
          textAlign: 'center',
        }}
      >
        {error ? (
          <span>Não consegui abrir a câmera: {error}</span>
        ) : (
          <div style={{ position: 'relative', width: '100%', height: '100%' }}>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                transform: 'scaleX(-1)',
                display: 'block',
              }}
            />
            <canvas
              ref={overlayRef}
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
                transform: 'scaleX(-1)',
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
