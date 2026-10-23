// Player de PCM16 mono 24kHz vindo do Gemini Live.
// Cada chunk vira um AudioBuffer e é agendado em sequência pra rolar sem gap.

export class PcmStreamPlayer {
  private ctx: AudioContext | null = null;
  private nextStart = 0;
  // Fontes agendadas que ainda não terminaram (pra poder cortar na interrupção).
  private sources: AudioBufferSourceNode[] = [];

  constructor(
    private readonly sampleRate: number,
    private readonly createContext: (sampleRate: number) => AudioContext = (rate) =>
      new AudioContext({ sampleRate: rate }),
  ) {}

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = this.createContext(this.sampleRate);
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

    this.sources.push(src);
    src.onended = () => {
      this.sources = this.sources.filter((s) => s !== src);
    };

    const now = ctx.currentTime;
    const start = Math.max(now, this.nextStart);
    src.start(start);
    this.nextStart = start + buf.duration;
  }

  /** Áudio ainda na fila (agendado e não tocado), em ms. 0 sem contexto. */
  backlogMs(): number {
    if (!this.ctx) return 0;
    return Math.max(0, (this.nextStart - this.ctx.currentTime) * 1000);
  }

  /** Para as fontes já agendadas e zera a fila — usado na interrupção. */
  stopAll(): void {
    for (const src of this.sources) {
      try {
        src.stop();
      } catch {
        /* já parou */
      }
    }
    this.sources = [];
    if (this.ctx) this.nextStart = this.ctx.currentTime;
  }

  /** Corta o que estiver tocando ou agendado (interrupção ou troca de turno). */
  reset(): void {
    this.stopAll();
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
    this.sources = [];
    this.nextStart = 0;
  }
}
