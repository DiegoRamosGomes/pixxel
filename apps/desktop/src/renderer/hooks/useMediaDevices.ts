import { useCallback, useEffect, useState } from 'react';

// Persiste a seleção do usuário entre execuções. label vem só pra fallback
// quando o deviceId muda entre boots (acontece em alguns drivers).
const KEY_AUDIO = 'pixxel.audioInputDeviceId';
const KEY_VIDEO = 'pixxel.videoInputDeviceId';
const KEY_AUDIO_LABEL = 'pixxel.audioInputDeviceLabel';
const KEY_VIDEO_LABEL = 'pixxel.videoInputDeviceLabel';

export type DeviceInfo = {
  deviceId: string;
  label: string;
};

export type MediaDevicesState = {
  audioInputs: DeviceInfo[];
  videoInputs: DeviceInfo[];
  selectedAudioId: string | null;
  selectedVideoId: string | null;
  selectAudio: (deviceId: string) => void;
  selectVideo: (deviceId: string) => void;
  refresh: () => Promise<void>;
};

function findFallback(
  list: DeviceInfo[],
  storedId: string | null,
  storedLabel: string | null,
): string | null {
  if (storedId && list.some((d) => d.deviceId === storedId)) return storedId;
  // Driver mudou o id mas o label persiste: tenta casar pelo label.
  if (storedLabel) {
    const byLabel = list.find((d) => d.label === storedLabel);
    if (byLabel) return byLabel.deviceId;
  }
  return null;
}

export function useMediaDevices(): MediaDevicesState {
  const [audioInputs, setAudioInputs] = useState<DeviceInfo[]>([]);
  const [videoInputs, setVideoInputs] = useState<DeviceInfo[]>([]);
  const [selectedAudioId, setSelectedAudioId] = useState<string | null>(
    () => localStorage.getItem(KEY_AUDIO),
  );
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(
    () => localStorage.getItem(KEY_VIDEO),
  );

  const refresh = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const audio = all
        .filter((d) => d.kind === 'audioinput')
        .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Microfone' }));
      const video = all
        .filter((d) => d.kind === 'videoinput')
        .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Câmera' }));
      setAudioInputs(audio);
      setVideoInputs(video);

      // Reconcilia seleção persistida com lista atual
      const audStoredLabel = localStorage.getItem(KEY_AUDIO_LABEL);
      const audId = findFallback(audio, localStorage.getItem(KEY_AUDIO), audStoredLabel);
      if (audId !== selectedAudioId) setSelectedAudioId(audId);

      const vidStoredLabel = localStorage.getItem(KEY_VIDEO_LABEL);
      const vidId = findFallback(video, localStorage.getItem(KEY_VIDEO), vidStoredLabel);
      if (vidId !== selectedVideoId) setSelectedVideoId(vidId);
    } catch (err) {
      console.warn('[devices] enumerate falhou:', err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refresh();
    // Re-enumera quando a lista muda (plug/unplug, app de bridge ligando etc).
    const handler = () => void refresh();
    navigator.mediaDevices.addEventListener?.('devicechange', handler);
    return () => {
      navigator.mediaDevices.removeEventListener?.('devicechange', handler);
    };
  }, [refresh]);

  const selectAudio = useCallback(
    (deviceId: string) => {
      setSelectedAudioId(deviceId);
      localStorage.setItem(KEY_AUDIO, deviceId);
      const label = audioInputs.find((d) => d.deviceId === deviceId)?.label;
      if (label) localStorage.setItem(KEY_AUDIO_LABEL, label);
    },
    [audioInputs],
  );

  const selectVideo = useCallback(
    (deviceId: string) => {
      setSelectedVideoId(deviceId);
      localStorage.setItem(KEY_VIDEO, deviceId);
      const label = videoInputs.find((d) => d.deviceId === deviceId)?.label;
      if (label) localStorage.setItem(KEY_VIDEO_LABEL, label);
    },
    [videoInputs],
  );

  return {
    audioInputs,
    videoInputs,
    selectedAudioId,
    selectedVideoId,
    selectAudio,
    selectVideo,
    refresh,
  };
}
