import type { WebSocket } from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import {
  ClientEventSchema,
  type ServerEvent,
} from '@assistant/shared';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  appendAssistantMessage,
  appendUserMessage,
  ensureSession,
  loadHistory,
} from '../memory/db.js';
import { dispatch, SYSTEM_PROMPT } from '../intent/dispatcher.js';
import type { ChatMessage } from '../llm/client.js';

function send(socket: WebSocket, event: ServerEvent): void {
  socket.send(JSON.stringify(event));
}

type ConnState = {
  authed: boolean;
  sessionId: string | null;
};

export function handleConnection(socket: WebSocket): void {
  const state: ConnState = { authed: false, sessionId: null };
  logger.info('ws client connected');

  socket.on('message', async (raw: Buffer) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      send(socket, { type: 'error', code: 'invalid_json', message: 'invalid json' });
      return;
    }

    const result = ClientEventSchema.safeParse(parsed);
    if (!result.success) {
      send(socket, {
        type: 'error',
        code: 'invalid_event',
        message: result.error.message,
      });
      return;
    }
    const event = result.data;

    if (event.type === 'hello') {
      if (event.token !== config.CLIENT_TOKEN) {
        send(socket, { type: 'error', code: 'unauthorized', message: 'bad token' });
        socket.close(1008, 'unauthorized');
        return;
      }
      state.authed = true;
      state.sessionId = event.sessionId;
      ensureSession(event.sessionId);
      send(socket, { type: 'hello_ok', sessionId: event.sessionId });
      logger.info({ sessionId: event.sessionId }, 'ws client authed');
      return;
    }

    if (!state.authed || !state.sessionId) {
      send(socket, { type: 'error', code: 'unauthorized', message: 'send hello first' });
      return;
    }

    if (event.type === 'user_message') {
      if (event.sessionId !== state.sessionId) {
        send(socket, {
          type: 'error',
          code: 'session_mismatch',
          message: 'sessionId differs from hello',
        });
        return;
      }

      appendUserMessage(state.sessionId, event.text, event.source);

      const history = loadHistory(state.sessionId);
      const messages: ChatMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history,
      ];

      const messageId = randomUUID();

      try {
        const outcome = await dispatch(messages, event.text, {
          onChatStart: (model) => {
            send(socket, { type: 'assistant_start', messageId, model });
          },
          onChatDelta: (delta) => {
            send(socket, { type: 'assistant_chunk', messageId, delta });
          },
          emitSupportMessage: (text, model) => {
            const supportId = randomUUID();
            send(socket, { type: 'assistant_start', messageId: supportId, model });
            send(socket, { type: 'assistant_chunk', messageId: supportId, delta: text });
            send(socket, {
              type: 'assistant_done',
              messageId: supportId,
              fullText: text,
            });
          },
        });

        if (outcome.kind === 'chat') {
          appendAssistantMessage(state.sessionId, outcome.fullText, outcome.model);
          send(socket, {
            type: 'assistant_done',
            messageId,
            fullText: outcome.fullText,
          });
        } else {
          // Comando: persiste descrição amigável no histórico pra contexto futuro
          appendAssistantMessage(
            state.sessionId,
            `[ação executada: ${outcome.spokenLabel}]`,
            outcome.source === 'regex' ? 'regex' : 'llm',
          );
          send(socket, {
            type: 'assistant_command',
            messageId,
            command: outcome.command,
            spokenLabel: outcome.spokenLabel,
            source: outcome.source,
          });
        }
      } catch (err) {
        logger.error({ err }, 'dispatch failed');
        send(socket, {
          type: 'error',
          code: 'dispatch_failed',
          message: err instanceof Error ? err.message : 'unknown',
        });
      }
    }
  });

  socket.on('close', () => {
    logger.info({ sessionId: state.sessionId }, 'ws client disconnected');
  });

  socket.on('error', (err: Error) => {
    logger.warn({ err }, 'ws error');
  });
}
