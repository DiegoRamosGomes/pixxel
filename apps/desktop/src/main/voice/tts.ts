import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

/**
 * Wrapper do Piper TTS local. Pipe direto: piper produz PCM raw no stdout,
 * e mandamos pra `aplay` (alsa-utils, vem instalado em qualquer Linux com som).
 * Fallback: `paplay` (PulseAudio) caso aplay falhe.
 *
 * Setup manual (uma vez): ver apps/desktop/resources/piper/README.md
 */

function resourcesDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'piper');
  return join(app.getAppPath(), 'resources', 'piper');
}

function findBinary(): string | null {
  const dir = resourcesDir();
  const candidates = [join(dir, 'piper'), join(dir, 'piper', 'piper')];
  for (const p of candidates) {
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

function findModel(): { onnx: string; sampleRate: number } | null {
  const dir = resourcesDir();
  const voiceName = process.env.PIPER_VOICE || 'pt_BR-faber-medium';
  const onnx = join(dir, `${voiceName}.onnx`);
  const meta = join(dir, `${voiceName}.onnx.json`);
  if (!existsSync(onnx) || !existsSync(meta)) return null;
  let sampleRate = 22050;
  try {
    const j = JSON.parse(readFileSync(meta, 'utf-8')) as {
      audio?: { sample_rate?: number };
    };
    if (j.audio?.sample_rate) sampleRate = j.audio.sample_rate;
  } catch {
    /* ignore */
  }
  return { onnx, sampleRate };
}

function piperFlags(modelOnnx: string): string[] {
  const flags = ['--model', modelOnnx, '--output-raw'];
  const length = process.env.PIPER_LENGTH_SCALE;
  if (length) flags.push('--length-scale', length);
  const silence = process.env.PIPER_SENTENCE_SILENCE;
  if (silence) flags.push('--sentence-silence', silence);
  return flags;
}

export function isTtsAvailable(): boolean {
  return findBinary() !== null && findModel() !== null;
}

type Listeners = {
  onSpeakingChange: (speaking: boolean) => void;
};

const PLAYERS: Array<{ cmd: string; args: (sr: number) => string[] }> = [
  {
    // aplay (alsa-utils): -r samplerate, -f formato, -t tipo, -c canais
    cmd: 'aplay',
    args: (sr) => ['-q', '-r', String(sr), '-f', 'S16_LE', '-t', 'raw', '-c', '1'],
  },
  {
    // paplay (PulseAudio)
    cmd: 'paplay',
    args: (sr) => [
      '--raw',
      `--rate=${sr}`,
      '--format=s16le',
      '--channels=1',
    ],
  },
];

export class TtsEngine {
  private queue: string[] = [];
  private playing = false;
  private enabled = false;
  private currentChild: ReturnType<typeof spawn> | null = null;
  private currentPlayer: ReturnType<typeof spawn> | null = null;
  private playerIdx = 0;

  constructor(private readonly listeners: Listeners) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.cancel();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  enqueue(text: string): void {
    if (!this.enabled) return;
    const clean = text.trim();
    if (!clean) return;
    this.queue.push(clean);
    void this.pump();
  }

  cancel(): void {
    this.queue = [];
    if (this.currentChild) {
      try {
        this.currentChild.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      this.currentChild = null;
    }
    if (this.currentPlayer) {
      try {
        this.currentPlayer.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      this.currentPlayer = null;
    }
    if (this.playing) {
      this.playing = false;
      this.listeners.onSpeakingChange(false);
    }
  }

  private async pump(): Promise<void> {
    if (this.playing) return;
    const text = this.queue.shift();
    if (!text) return;

    const bin = findBinary();
    const model = findModel();
    if (!bin || !model) {
      console.warn('[tts] missing piper binary or model');
      return;
    }

    this.playing = true;
    this.listeners.onSpeakingChange(true);

    await this.playOne(bin, model, text);

    this.playing = false;
    if (this.queue.length === 0) {
      this.listeners.onSpeakingChange(false);
    } else {
      void this.pump();
    }
  }

  private playOne(
    bin: string,
    model: { onnx: string; sampleRate: number },
    text: string,
  ): Promise<void> {
    return new Promise((resolve) => {
      const player = PLAYERS[this.playerIdx];

      const piper = spawn(bin, piperFlags(model.onnx), {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const out = spawn(player.cmd, player.args(model.sampleRate), {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.currentChild = piper;
      this.currentPlayer = out;

      piper.stdout.pipe(out.stdin);
      piper.stderr.on('data', () => {
        /* piper logs no stderr; silenciar */
      });
      out.stderr.on('data', () => {
        /* aplay/paplay logs */
      });

      piper.stdin.write(text + '\n');
      piper.stdin.end();

      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        this.currentChild = null;
        this.currentPlayer = null;
        resolve();
      };

      out.on('close', finish);
      out.on('error', (err) => {
        // Player não encontrado/falhou — tenta próximo player na próxima chamada
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          console.warn(`[tts] player ${player.cmd} not found, will try next`);
          if (this.playerIdx < PLAYERS.length - 1) {
            this.playerIdx += 1;
          }
        } else {
          console.warn('[tts] player error', err);
        }
        finish();
      });
      piper.on('error', (err) => {
        console.warn('[tts] piper error', err);
        finish();
      });
    });
  }
}
