// Captura mic via getUserMedia, força AudioContext a 16kHz e carrega um
// AudioWorkletProcessor (arquivo estático servido pelo Vite) pra emitir
// chunks PCM16 mono de ~64ms. Não pode ser blob por causa da CSP.

import workletUrl from './pcm16-emitter.worklet.js?url';

const WORKLET_NAME = 'pcm16-emitter';

export type MicCaptureHandle = {
  stop: () => Promise<void>;
};

export async function startMicCapture(
  onChunk: (pcm16k: ArrayBuffer) => void,
  audioDeviceId?: string | null,
): Promise<MicCaptureHandle> {
  const audio: MediaTrackConstraints = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  if (audioDeviceId) audio.deviceId = { exact: audioDeviceId };
  const stream = await navigator.mediaDevices.getUserMedia({ audio });

  // Força sample rate a 16kHz — Chromium resampleia o mic pra esse rate.
  const ctx = new AudioContext({ sampleRate: 16000 });
  console.log(
    '[mic] AudioContext sampleRate =',
    ctx.sampleRate,
    '(esperado 16000), workletUrl =',
    workletUrl,
  );

  await ctx.audioWorklet.addModule(workletUrl);

  const source = ctx.createMediaStreamSource(stream);
  // 1 output (default) — sem isso o Chromium pode não processar inputs.
  const node = new AudioWorkletNode(ctx, WORKLET_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
  });
  let received = 0;
  node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    received += 1;
    if (received === 1 || received % 50 === 0) {
      console.log(
        `[mic] worklet chunks recebidos=${received} bytes=${e.data.byteLength}`,
      );
    }
    onChunk(e.data);
  };
  source.connect(node);
  // Liga o worklet a um gain mudo conectado ao destination — garante que
  // o nó faz parte do grafo de áudio ativo e portanto é processado.
  const muteGain = ctx.createGain();
  muteGain.gain.value = 0;
  node.connect(muteGain).connect(ctx.destination);

  return {
    stop: async () => {
      try {
        node.port.onmessage = null;
        node.disconnect();
        muteGain.disconnect();
        source.disconnect();
        for (const track of stream.getTracks()) track.stop();
        await ctx.close();
      } catch {
        /* ignore */
      }
    },
  };
}
