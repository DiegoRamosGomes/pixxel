// Conexão WebSocket de um cliente (desktop, celular) com a API.
//
// Primeira mensagem tem que ser `hello` (token + operações locais que o
// cliente sabe fazer). Depois disso: controle da sessão de voz em JSON,
// áudio do microfone em frames binários e respostas das funções locais.

import type { WebSocket } from '@fastify/websocket';
import {
  ApiClientMessageSchema,
  PROTOCOL_VERSION,
  type ApiClientMessage,
  type ApiServerMessage,
} from '@assistant/shared';
import { logger } from '../logger.js';
import { LocalBridge } from '../clients/local-bridge.js';
import type {
  ClientRegistry,
  ConnectedClient,
  LiveRecoveryContext,
  VoiceSessionHandle,
} from '../clients/client-registry.js';

export type HandlerDeps = {
  token: string;
  registry: ClientRegistry;
  localToolTimeoutMs: number;
  helloTimeoutMs?: number;
  /** Intervalo do ping. Sem pong até o ping seguinte, a conexão é derrubada. */
  heartbeatIntervalMs?: number;
  createSession(client: ConnectedClient, recovery: LiveRecoveryContext | undefined): VoiceSessionHandle;
  onPresentationAbort(): void;
};

const DISCONNECTED = 'O dispositivo desconectou.';

function buildExplainTaskText(taskId: string): string {
  return (
    `[evento interno — não é fala do usuário] Usuário clicou na notificação ` +
    `da task ${taskId}. Use a tool clickup_explain_task com taskId="${taskId}" ` +
    `e fale sobre a task de forma natural.`
  );
}

export function handleConnection(socket: WebSocket, deps: HandlerDeps): void {
  let client: ConnectedClient | null = null;

  const send = (msg: ApiServerMessage): void => {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(msg));
  };
  const fail = (code: string, message: string): void => send({ type: 'error', code, message });

  const helloTimer = setTimeout(() => {
    if (!client) socket.close(1008, 'hello timeout');
  }, deps.helloTimeoutMs ?? 10_000);

  // Heartbeat: o Mac dormindo não manda FIN — sem isso a API acharia o cliente
  // presente por muitos minutos (avisos "falados" pra ninguém, sem push, e a
  // sessão do Gemini gastando cota). Sem pong até o próximo ping → terminate,
  // e o 'close' abaixo faz a limpeza normal.
  let alive = true;
  socket.on('pong', () => {
    alive = true;
  });
  const heartbeat = setInterval(() => {
    if (!alive) {
      logger.warn({ clientId: client?.clientId }, 'ws sem pong — derrubando conexão');
      socket.terminate();
      return;
    }
    alive = false;
    try {
      socket.ping();
    } catch {
      /* socket já fechando */
    }
  }, deps.heartbeatIntervalMs ?? 15_000);

  function onHello(msg: Extract<ApiClientMessage, { type: 'hello' }>): void {
    if (msg.token !== deps.token) {
      fail('unauthorized', 'bad token');
      socket.close(1008, 'unauthorized');
      return;
    }
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      fail('protocol_mismatch', `esperado protocolo ${PROTOCOL_VERSION}`);
      socket.close(1008, 'protocol mismatch');
      return;
    }
    clearTimeout(helloTimer);
    const now = Date.now();
    const c: ConnectedClient = {
      clientId: msg.clientId,
      kind: msg.clientKind,
      localOps: msg.localOps,
      send,
      sendAudio: (pcm) => {
        if (socket.readyState === socket.OPEN) socket.send(pcm, { binary: true });
      },
      close: (code, reason) => socket.close(code, reason),
      bridge: new LocalBridge(send, deps.localToolTimeoutMs),
      session: null,
      lastInteractionAt: now,
      connectedAt: now,
    };
    const prev = deps.registry.add(c);
    if (prev) {
      // Mesmo dispositivo reconectou com a conexão antiga ainda aberta
      // (Mac acordou do sleep): a antiga sai e a voz dela vira contexto de retomada.
      prev.bridge.rejectAll(DISCONNECTED);
      const recovery = prev.session?.detach();
      if (recovery) deps.registry.saveRecovery(prev.clientId, recovery);
      prev.session = null;
      prev.close(1000, 'replaced');
    }
    client = c;
    send({ type: 'hello_ok', clientId: c.clientId });
    logger.info({ clientId: c.clientId, kind: c.kind, localOps: c.localOps }, 'ws client authed');
  }

  function onMessage(c: ConnectedClient, msg: ApiClientMessage): void {
    switch (msg.type) {
      case 'hello':
        fail('already_authed', 'hello já recebido');
        return;
      case 'voice_start':
        if (!c.session) c.session = deps.createSession(c, deps.registry.takeRecovery(c.clientId));
        c.session.start();
        return;
      case 'voice_stop':
        c.session?.stop();
        return;
      case 'voice_text':
        if (!c.session?.sendText(msg.text)) fail('voice_not_ready', 'sessão de voz não está pronta');
        return;
      case 'voice_end_turn':
        c.session?.endTurn();
        return;
      case 'local_tool_result':
        c.bridge.resolve(msg.callId, msg.result);
        return;
      case 'explain_clickup_task': {
        const taskId = msg.taskId.replace(/[^A-Za-z0-9-]/g, '');
        if (taskId) c.session?.sendInternal(buildExplainTaskText(taskId));
        return;
      }
      case 'presentation_abort':
        deps.onPresentationAbort();
        return;
    }
  }

  socket.on('message', (raw: Buffer, isBinary: boolean) => {
    if (isBinary) {
      // Áudio do microfone. Antes do hello é ignorado.
      client?.session?.sendAudio(raw);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      fail('invalid_json', 'invalid json');
      return;
    }
    const result = ApiClientMessageSchema.safeParse(parsed);
    if (!result.success) {
      fail('invalid_message', result.error.message);
      return;
    }
    const msg = result.data;
    if (!client) {
      if (msg.type === 'hello') onHello(msg);
      else fail('unauthorized', 'send hello first');
      return;
    }
    onMessage(client, msg);
  });

  socket.on('close', () => {
    clearTimeout(helloTimer);
    clearInterval(heartbeat);
    const c = client;
    if (!c) return;
    c.bridge.rejectAll(DISCONNECTED);
    // Substituído por uma conexão nova do mesmo clientId: quem substituiu já
    // guardou o contexto e o registro aponta pra conexão nova.
    if (deps.registry.get(c.clientId) !== c) return;
    const recovery = c.session?.detach();
    if (recovery) deps.registry.saveRecovery(c.clientId, recovery);
    deps.registry.remove(c.clientId, c);
    logger.info({ clientId: c.clientId }, 'ws client disconnected');
  });

  socket.on('error', (err: Error) => {
    logger.warn({ err }, 'ws error');
  });
}
