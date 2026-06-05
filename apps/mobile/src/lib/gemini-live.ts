const ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const MODEL = 'models/gemini-2.5-flash-native-audio-latest';
const VOICE = 'Charon';
const LANGUAGE = 'pt-BR';

export type LiveStatus = 'idle' | 'connecting' | 'ready' | 'error' | 'closed';

export type LiveListeners = {
  onStatus?: (status: LiveStatus, info?: string) => void;
  onTextChunk?: (text: string) => void;
  onTurnComplete?: () => void;
  onAudioChunk?: (base64Pcm: string, sampleRate: number) => void;
  onInterrupted?: () => void;
};

function parseSampleRate(mimeType: string | undefined): number {
  const match = mimeType?.match(/rate=(\d+)/);
  return match ? parseInt(match[1], 10) : 24000;
}

function stripControlTokens(text: string): string {
  const stripped = text.replace(/<ctrl\d+>/g, '');
  return stripped.trim() === '' ? '' : stripped;
}

export class GeminiLiveClient {
  private ws: WebSocket | null = null;
  private setupDone = false;

  constructor(
    private readonly apiKey: string,
    private readonly listeners: LiveListeners = {},
  ) {}

  start(systemInstruction: string): void {
    if (this.ws) return;
    this.listeners.onStatus?.('connecting');

    const url = `${ENDPOINT}?key=${encodeURIComponent(this.apiKey)}`;
    console.log('[live] connecting', ENDPOINT, 'keyLen=', this.apiKey.length);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      const setup = {
        model: MODEL,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } },
            languageCode: LANGUAGE,
          },
        },
        systemInstruction: { parts: [{ text: systemInstruction }] },
        outputAudioTranscription: {},
      };
      console.log('[live] open — sending setup', JSON.stringify({ model: MODEL }));
      ws.send(JSON.stringify({ setup }));
    };

    ws.onmessage = (event) => {
      this.handleMessage(event.data).catch((err) => {
        console.warn('[live] handleMessage error', err);
      });
    };

    ws.onerror = (event) => {
      const err = event as unknown as { message?: string; error?: unknown };
      console.warn('[live] ws error', err.message, err.error);
      this.listeners.onStatus?.('error', err.message ?? 'ws error');
    };

    ws.onclose = (event) => {
      console.warn('[live] ws closed', event.code, event.reason);
      this.setupDone = false;
      this.ws = null;
      this.listeners.onStatus?.('closed', `${event.code} ${event.reason ?? ''}`.trim());
    };
  }

  private async handleMessage(data: unknown): Promise<void> {
    let raw: string;
    if (typeof data === 'string') {
      raw = data;
    } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
      raw = await data.text();
    } else if (data instanceof ArrayBuffer) {
      raw = new TextDecoder().decode(data);
    } else if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView;
      raw = new TextDecoder().decode(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
    } else {
      raw = String(data);
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw);
    } catch {
      console.warn('[live] JSON parse fail; raw head:', raw.slice(0, 120));
      return;
    }

    if (payload.setupComplete) {
      this.setupDone = true;
      this.listeners.onStatus?.('ready');
      return;
    }

    const serverContent = payload.serverContent as
      | {
          modelTurn?: {
            parts?: Array<{
              text?: string;
              inlineData?: { mimeType?: string; data?: string };
            }>;
          };
          outputTranscription?: { text?: string };
          turnComplete?: boolean;
          interrupted?: boolean;
        }
      | undefined;

    if (!serverContent) return;

    for (const part of serverContent.modelTurn?.parts ?? []) {
      const inline = part.inlineData;
      if (inline?.data && inline.mimeType?.startsWith('audio/pcm')) {
        this.listeners.onAudioChunk?.(inline.data, parseSampleRate(inline.mimeType));
      }
    }

    const transcript = serverContent.outputTranscription?.text;
    if (typeof transcript === 'string') {
      const cleaned = stripControlTokens(transcript);
      if (cleaned) this.listeners.onTextChunk?.(cleaned);
    }

    if (serverContent.interrupted) {
      this.listeners.onInterrupted?.();
    }

    if (serverContent.turnComplete) {
      this.listeners.onTurnComplete?.();
    }
  }

  sendText(text: string): boolean {
    if (!this.ws || this.ws.readyState !== 1 || !this.setupDone) return false;
    this.ws.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text }] }],
          turnComplete: true,
        },
      }),
    );
    return true;
  }

  stop(): void {
    if (this.ws) {
      try {
        this.ws.close(1000, 'client_stop');
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.setupDone = false;
    this.listeners.onStatus?.('idle');
  }
}
