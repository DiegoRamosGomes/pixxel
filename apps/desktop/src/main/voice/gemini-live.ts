import WebSocket from 'ws';

const ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const DEFAULT_MODEL = 'models/gemini-2.5-flash-native-audio-preview-12-2025';

const SYSTEM_INSTRUCTION =
  'Você é Jarvis, um assistente pessoal em português do Brasil. ' +
  'Responda de forma curta, direta e natural, como em uma conversa por voz. ' +
  'Evite listas longas.' +
  '\n\nREGRAS DE FUNÇÕES:\n' +
  '1. Quando o usuário pedir algo que tem função correspondente ' +
  '(clima, tasks do ClickUp, tocar vídeo, abrir app, controlar mídia, pesquisar), ' +
  'CHAME A FUNÇÃO. A chamada de função é o que abre o widget visual no app — ' +
  'sem chamar a função, o usuário não vê o card.\n' +
  '2. Mesmo se você já tiver a resposta do histórico da conversa, chame a função ' +
  'pra mostrar o widget. Pode usar dados anteriores na sua fala se quiser, mas a ' +
  'chamada é necessária pra UI.\n' +
  '3. Antes de funções que parecem demoradas, fale algo curto antes ' +
  '("um momento", "verificando").\n' +
  '4. Resposta verbal é resumida — não recite lista inteira ' +
  '(ex: "você tem 5 tasks, a mais urgente é X").';

export type GeminiLiveState =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'ready' }
  | { kind: 'speaking' }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'closed'; reason: string };

export type ToolDeclaration = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export type GeminiLiveListeners = {
  onState: (state: GeminiLiveState) => void;
  onAudio: (pcm24kMono: Buffer) => void;
  onTranscript?: (text: string, role: 'user' | 'model') => void;
  onToolCall?: (call: ToolCall) => void;
};

export type GeminiLiveOptions = {
  model?: string;
  tools?: ToolDeclaration[];
};

export class GeminiLiveClient {
  private ws: WebSocket | null = null;
  private setupDone = false;
  private modelSpeaking = false;
  private state: GeminiLiveState = { kind: 'idle' };
  private readonly model: string;
  private readonly tools: ToolDeclaration[];

  constructor(
    private readonly apiKey: string,
    private readonly listeners: GeminiLiveListeners,
    options: GeminiLiveOptions = {},
  ) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.tools = options.tools ?? [];
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  start(): void {
    if (this.ws) return;
    this.setupDone = false;
    this.modelSpeaking = false;
    this.setState({ kind: 'connecting' });

    const url = `${ENDPOINT}?key=${encodeURIComponent(this.apiKey)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      const setup: Record<string, unknown> = {
        model: this.model,
        generationConfig: { responseModalities: ['AUDIO'] },
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        outputAudioTranscription: {},
        inputAudioTranscription: {},
      };
      if (this.tools.length > 0) {
        setup.tools = [{ functionDeclarations: this.tools }];
      }
      ws.send(JSON.stringify({ setup }));
    });

    ws.on('message', (raw: Buffer) => this.handleMessage(raw));

    // Captura o código HTTP do upgrade-handshake quando o servidor rejeita
    // (chave inválida, URL errada, etc). Sem isso, só sobra "closed before
    // established" que não diz nada.
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (c: Buffer) => {
        body += c.toString();
      });
      res.on('end', () => {
        const head = `HTTP ${res.statusCode} ${res.statusMessage ?? ''}`.trim();
        const trimmed = body.length > 400 ? body.slice(0, 400) + '…' : body;
        console.warn('[gemini-live] handshake rejected:', head, trimmed);
        this.setState({
          kind: 'error',
          code: `http_${res.statusCode}`,
          message: `${head}: ${trimmed || 'sem corpo'}`,
        });
      });
    });

    ws.on('error', (err) => {
      console.warn('[gemini-live] ws error:', err.message);
      // Se já reportamos via unexpected-response, o close vem depois — não sobrescreve.
      if (this.state.kind !== 'error') {
        this.setState({ kind: 'error', code: 'ws_error', message: err.message });
      }
    });

    ws.on('close', (code, reason) => {
      this.ws = null;
      this.setupDone = false;
      const r = reason.toString() || `code ${code}`;
      console.warn(`[gemini-live] closed code=${code} reason=${r}`);
      // Se já estamos em estado de erro, não sobrescreve com 'closed'.
      if (this.state.kind !== 'error') {
        this.setState({ kind: 'closed', reason: r });
      }
    });
  }

  stop(): void {
    if (!this.ws) return;
    try {
      this.ws.close(1000, 'client_stop');
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.setupDone = false;
    this.setState({ kind: 'idle' });
  }

  /** PCM 16-bit mono 16kHz, qualquer tamanho. Vira base64 e vai pro Live. */
  sendAudioChunk(pcm16k: Buffer): void {
    if (!this.isOpen() || !this.setupDone) return;
    const payload = {
      realtimeInput: {
        audio: {
          mimeType: 'audio/pcm;rate=16000',
          data: pcm16k.toString('base64'),
        },
      },
    };
    this.ws!.send(JSON.stringify(payload));
  }

  /** Avisa o servidor que o usuário terminou de falar (encerra o turno). */
  endTurn(): void {
    if (!this.isOpen() || !this.setupDone) return;
    this.ws!.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
  }

  /** Envia uma mensagem de texto como turno do usuário; resposta vem em áudio. */
  sendText(text: string): boolean {
    if (!this.isOpen() || !this.setupDone) return false;
    this.ws!.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text }] }],
          turnComplete: true,
        },
      }),
    );
    return true;
  }

  /** Devolve o resultado de uma tool call pro Gemini; ele continua o turno. */
  sendToolResponse(id: string, name: string, response: Record<string, unknown>): void {
    if (!this.isOpen() || !this.setupDone) return;
    this.ws!.send(
      JSON.stringify({
        toolResponse: {
          functionResponses: [{ id, name, response }],
        },
      }),
    );
  }

  private handleMessage(raw: Buffer): void {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    if (obj.setupComplete) {
      this.setupDone = true;
      this.setState({ kind: 'ready' });
      return;
    }

    // Tool calls vêm em mensagens próprias (toolCall), não dentro de serverContent.
    const tc = obj.toolCall as ToolCallMessage | undefined;
    if (tc?.functionCalls?.length) {
      for (const fc of tc.functionCalls) {
        if (!fc.name) continue;
        this.listeners.onToolCall?.({
          id: fc.id ?? '',
          name: fc.name,
          args: fc.args ?? {},
        });
      }
      return;
    }

    const sc = obj.serverContent as ServerContent | undefined;
    if (!sc) return;

    if (sc.modelTurn?.parts) {
      for (const part of sc.modelTurn.parts) {
        // áudio inline
        const inline = part.inlineData;
        if (inline?.data && inline.mimeType?.startsWith('audio/pcm')) {
          if (!this.modelSpeaking) {
            this.modelSpeaking = true;
            this.setState({ kind: 'speaking' });
          }
          const audio = Buffer.from(inline.data, 'base64');
          this.listeners.onAudio(audio);
        }
        // transcript opcional (input/output transcription)
        if (part.text && !part.thought) {
          this.listeners.onTranscript?.(part.text, 'model');
        }
      }
    }

    if (sc.inputTranscription?.text) {
      this.listeners.onTranscript?.(sc.inputTranscription.text, 'user');
    }
    if (sc.outputTranscription?.text) {
      this.listeners.onTranscript?.(sc.outputTranscription.text, 'model');
    }

    if (sc.interrupted || sc.turnComplete) {
      if (this.modelSpeaking) {
        this.modelSpeaking = false;
        this.setState({ kind: 'ready' });
      }
    }
  }

  private setState(state: GeminiLiveState): void {
    this.state = state;
    this.listeners.onState(state);
  }
}

type ServerContent = {
  modelTurn?: {
    parts?: Array<{
      text?: string;
      thought?: boolean;
      inlineData?: { mimeType?: string; data?: string };
    }>;
  };
  inputTranscription?: { text?: string };
  outputTranscription?: { text?: string };
  turnComplete?: boolean;
  interrupted?: boolean;
  generationComplete?: boolean;
};

type ToolCallMessage = {
  functionCalls?: Array<{
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  }>;
};
