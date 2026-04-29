// Player de PCM16 mono 24kHz vindo do Gemini Live.
// Cada chunk vira um AudioBuffer e é agendado em sequência pra rolar sem gap.

export class PcmStreamPlayer {
  private ctx: AudioContext | null = null;
  private nextStart = 0;

  constructor(private readonly sampleRate: number) {}

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: this.sampleRate });
    }
    return this.ctx;
  }

  async resume(): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
  }

  /** chunk = ArrayBuffer com PCM16 mono no sampleRate configurado */
  enqueue(chunk: ArrayBuffer): void {
    const ctx = this.ensureContext();
    const i16 = new Int16Array(chunk);
    if (i16.length === 0) return;
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 0x8000;

    const buf = ctx.createBuffer(1, f32.length, this.sampleRate);
    buf.copyToChannel(f32, 0);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);

    const now = ctx.currentTime;
    const start = Math.max(now, this.nextStart);
    src.start(start);
    this.nextStart = start + buf.duration;
  }

  /** Limpa o backlog — útil quando o usuário interrompe ou troca de turno. */
  reset(): void {
    if (!this.ctx) return;
    this.nextStart = this.ctx.currentTime;
  }

  async close(): Promise<void> {
    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch {
        /* ignore */
      }
      this.ctx = null;
    }
    this.nextStart = 0;
  }
}
