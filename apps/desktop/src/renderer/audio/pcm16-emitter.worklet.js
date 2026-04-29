// AudioWorkletProcessor que recebe Float32 mono e emite chunks PCM16 mono
// de 1024 samples (~64ms a 16kHz). É carregado como arquivo estático
// via Vite (?url) — não pode ser blob por causa da CSP do dev server.

class Pcm16Emitter extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Int16Array(1024);
    this._pos = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      let s = ch[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      this._buf[this._pos++] = (s * 0x7fff) | 0;
      if (this._pos === this._buf.length) {
        const out = new Int16Array(this._buf);
        this.port.postMessage(out.buffer, [out.buffer]);
        this._pos = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm16-emitter', Pcm16Emitter);
