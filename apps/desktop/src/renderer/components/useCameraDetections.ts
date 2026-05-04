import { useEffect, useRef, useState, type RefObject } from 'react';
import type { FaceDetector as FaceDetectorType } from '@mediapipe/tasks-vision';

const WASM_BASE =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/wasm';
const FACE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';

const FACE_TICK_MS = 500; // 2 fps — suficiente pra presença, leve no CPU
const ABSENT_AFTER_MS = 2000;

export type Box = {
  /** Coordenadas em pixels no espaço do video.videoWidth × videoHeight. */
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  label?: string;
};

type Options = {
  videoRef: RefObject<HTMLVideoElement | null>;
  enabled: boolean;
  /** Callback no momento da transição de presença (true = entrou, false = saiu). */
  onPresenceChange?: (present: boolean) => void;
};

export type CameraDetections = {
  present: boolean;
  faces: Box[];
  objects: Box[]; // sempre vazio — object detection foi removido (sob demanda no futuro)
  error: string | null;
};

export function useCameraDetections({
  videoRef,
  enabled,
  onPresenceChange,
}: Options): CameraDetections {
  const [present, setPresent] = useState(true);
  const [faces, setFaces] = useState<Box[]>([]);
  const [error, setError] = useState<string | null>(null);
  const onChangeRef = useRef(onPresenceChange);
  onChangeRef.current = onPresenceChange;

  useEffect(() => {
    if (!enabled) {
      setPresent(true);
      setFaces([]);
      return;
    }

    let cancelled = false;
    let faceDet: FaceDetectorType | null = null;
    let faceInt: ReturnType<typeof setInterval> | null = null;
    let lastSeenAt: number | null = null;
    let lastEmitted: boolean | null = null;

    (async () => {
      try {
        const { FilesetResolver, FaceDetector } = await import(
          '@mediapipe/tasks-vision'
        );
        const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
        if (cancelled) return;

        const fd = await FaceDetector.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'CPU' },
          runningMode: 'VIDEO',
          // 0.75 reduz falso-positivo em padrões circulares (quadros,
          // mandalas, relógios) sem perder rosto real.
          minDetectionConfidence: 0.75,
        });
        if (cancelled) {
          fd.close();
          return;
        }
        faceDet = fd;

        faceInt = setInterval(() => {
          const video = videoRef.current;
          if (!video || video.readyState < 2 || !video.videoWidth || !faceDet) return;
          let result;
          try {
            result = faceDet.detectForVideo(video, performance.now());
          } catch (err) {
            console.warn('[detections] face detect falhou:', err);
            return;
          }
          const now = performance.now();
          const vw = video.videoWidth;
          const vh = video.videoHeight;
          const all: Box[] = result.detections.map((d) => {
            const bb = d.boundingBox;
            return {
              x: bb?.originX ?? 0,
              y: bb?.originY ?? 0,
              w: bb?.width ?? 0,
              h: bb?.height ?? 0,
              score: d.categories?.[0]?.score ?? 1,
            };
          });
          // Filtros geométricos pra remover falso-positivo em padrões
          // simétricos (quadros, círculos): rosto humano tem proporção
          // largura/altura ~0.65–1.0 (cabeça mais alta que larga) e ocupa
          // pelo menos ~6% da largura do frame em distância de webcam.
          const boxes = all.filter((b) => {
            if (b.h <= 0 || b.w <= 0) return false;
            const aspect = b.w / b.h;
            if (aspect < 0.55 || aspect > 1.25) return false;
            if (b.w < vw * 0.06) return false;
            if (b.h < vh * 0.08) return false;
            return true;
          });
          setFaces(boxes);

          if (boxes.length > 0) {
            lastSeenAt = now;
            if (lastEmitted !== true) {
              setPresent(true);
              if (lastEmitted !== null) onChangeRef.current?.(true);
              lastEmitted = true;
            }
          } else if (lastSeenAt !== null) {
            const dt = now - lastSeenAt;
            if (dt > ABSENT_AFTER_MS && lastEmitted !== false) {
              setPresent(false);
              onChangeRef.current?.(false);
              lastEmitted = false;
            }
          }
        }, FACE_TICK_MS);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[detections] init falhou:', msg);
        setError(msg);
      }
    })();

    return () => {
      cancelled = true;
      if (faceInt) clearInterval(faceInt);
      faceDet?.close();
    };
  }, [enabled, videoRef]);

  return { present, faces, objects: [], error };
}
