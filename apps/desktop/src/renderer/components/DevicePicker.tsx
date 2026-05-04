import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MediaDevicesState } from '../hooks/useMediaDevices.js';

type Props = {
  devices: MediaDevicesState;
};

/**
 * Botão na topbar que abre popover com dois selects: microfone e câmera.
 * Sem permissão concedida ainda, os labels vêm vazios — orienta o usuário a
 * autorizar uma vez.
 */
export function DevicePicker({ devices }: Props) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const reposition = () => {
      const btn = buttonRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const W = 320;
      const margin = 8;
      let left = r.left;
      if (left + W + margin > window.innerWidth) {
        left = Math.max(margin, window.innerWidth - W - margin);
      }
      setPos({ top: r.bottom + margin, left });
    };
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (buttonRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const noLabels =
    devices.audioInputs.some((d) => !d.label) ||
    devices.videoInputs.some((d) => !d.label);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="winbtn"
        onClick={() => {
          setOpen((v) => !v);
          // Força refresh quando abrir (labels só aparecem após permissão)
          void devices.refresh();
        }}
        title="Selecionar microfone e câmera"
        aria-label="Dispositivos de áudio e vídeo"
      >
        ⚙
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popoverRef}
            className="device-picker"
            style={{ top: pos.top, left: pos.left }}
            role="dialog"
            aria-label="Dispositivos"
          >
            <div className="device-picker__title">Dispositivos</div>

            <label className="device-picker__row">
              <span className="device-picker__label">Microfone</span>
              <select
                value={devices.selectedAudioId ?? ''}
                onChange={(e) => devices.selectAudio(e.target.value)}
              >
                <option value="">— Padrão do sistema —</option>
                {devices.audioInputs.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="device-picker__row">
              <span className="device-picker__label">Câmera</span>
              <select
                value={devices.selectedVideoId ?? ''}
                onChange={(e) => devices.selectVideo(e.target.value)}
              >
                <option value="">— Padrão do sistema —</option>
                {devices.videoInputs.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>

            {noLabels && (
              <div className="device-picker__hint">
                Os nomes só aparecem depois que você autorizar mic/câmera uma vez.
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
