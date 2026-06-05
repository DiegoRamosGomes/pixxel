import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { File, Paths } from 'expo-file-system';

let audioModeReady: Promise<void> | null = null;
function ensureAudioMode(): Promise<void> {
  if (!audioModeReady) {
    audioModeReady = setAudioModeAsync({ playsInSilentMode: true }).catch((err) => {
      console.warn('[audio] setAudioModeAsync failed', err);
    });
  }
  return audioModeReady;
}

function buildWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const dataSize = pcm.length;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  new Uint8Array(buffer, 44).set(pcm);
  return new Uint8Array(buffer);
}

const queue: Array<{ pcm: Uint8Array; sampleRate: number }> = [];
let playing = false;

async function playOne(pcm: Uint8Array, sampleRate: number): Promise<void> {
  await ensureAudioMode();
  const wav = buildWav(pcm, sampleRate);
  const file = new File(Paths.cache, `pixxel-${Date.now()}.wav`);
  file.create();
  file.write(wav);
  console.log('[audio] play', file.uri, 'pcm', pcm.length, 'rate', sampleRate);

  return new Promise<void>((resolve) => {
    const player = createAudioPlayer({ uri: file.uri });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        sub.remove();
      } catch {
        /* ignore */
      }
      try {
        player.remove();
      } catch {
        /* ignore */
      }
      try {
        file.delete();
      } catch {
        /* ignore */
      }
      resolve();
    };
    const sub = player.addListener('playbackStatusUpdate', (status) => {
      console.log(
        '[audio] status playing=', status.playing,
        'isLoaded=', status.isLoaded,
        'duration=', status.duration,
        'currentTime=', status.currentTime,
        'didJustFinish=', status.didJustFinish,
      );
      if (status.didJustFinish) finish();
    });
    player.play();
  });
}

export function enqueueAudioTurn(pcm: Uint8Array, sampleRate: number): void {
  queue.push({ pcm, sampleRate });
  if (playing) return;
  void drain();
}

async function drain(): Promise<void> {
  playing = true;
  while (queue.length > 0) {
    const { pcm, sampleRate } = queue.shift()!;
    try {
      await playOne(pcm, sampleRate);
    } catch (err) {
      console.warn('[audio] playback failed', err);
    }
  }
  playing = false;
}
