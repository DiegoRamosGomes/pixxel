// Regras de entrega dos avisos proativos (spec, seção "Avisos"):
//   - widget: todos os clientes conectados
//   - fala: só o cliente com voz pronta e interação mais recente
//   - push (ntfy): e-mail sempre; ClickUp e Expo só sem nenhum cliente
//   - build do Expo sem ninguém pra falar fica na fila até uma voz ficar pronta,
//     e só é marcado entregue depois de falado

import { randomUUID } from 'node:crypto';
import type { Widget } from '@assistant/shared';
import type { ClientRegistry } from '../clients/client-registry.js';
import type { WebhookEventRow } from '../memory/db.js';
import { expoPhrase, expoSpeech, expoWidget, type Notice, type PushMessage } from './notices.js';

export type NoticeDispatcherDeps = {
  registry: Pick<ClientRegistry, 'all' | 'count' | 'pickSpeaker'>;
  sendPush(p: PushMessage): Promise<void>;
  markExpoDelivered(eventId: string): void;
  flushDelayMs?: number;
};

export class NoticeDispatcher {
  private readonly pendingExpo: Array<{ eventId: string; phrase: string }> = [];
  private readonly flushDelayMs: number;

  constructor(private readonly deps: NoticeDispatcherDeps) {
    this.flushDelayMs = deps.flushDelayMs ?? 500;
  }

  dispatch(n: Notice): void {
    if (n.widget) this.showWidget(n.widget.widget, n.widget.ttlMs);
    this.deps.registry.pickSpeaker()?.session?.sendInternal(n.speech);
    if (n.push && (n.kind === 'email' || this.deps.registry.count() === 0)) this.push(n.push);
  }

  enqueueExpo(row: WebhookEventRow, opts: { fromBoot?: boolean } = {}): void {
    const { widget, ttlMs } = expoWidget(row);
    this.showWidget(widget, ttlMs);
    const phrase = expoPhrase(row);
    if (!opts.fromBoot && this.deps.registry.count() === 0) {
      this.push({ title: 'Build do Expo', body: phrase, tags: ['expo'] });
    }
    this.pendingExpo.push({ eventId: row.id, phrase });
    this.tryFlushExpo();
  }

  /** Uma sessão de voz ficou pronta: dá prioridade ao briefing e depois fala os builds. */
  onSessionReady(): void {
    if (this.pendingExpo.length === 0) return;
    setTimeout(() => this.tryFlushExpo(), this.flushDelayMs);
  }

  private tryFlushExpo(): void {
    if (this.pendingExpo.length === 0) return;
    const speaker = this.deps.registry.pickSpeaker();
    if (!speaker?.session) return;
    const batch = this.pendingExpo.splice(0);
    if (!speaker.session.sendInternal(expoSpeech(batch.map((b) => b.phrase)))) {
      this.pendingExpo.unshift(...batch);
      return;
    }
    for (const b of batch) this.deps.markExpoDelivered(b.eventId);
  }

  private showWidget(widget: Widget, ttlMs: number): void {
    for (const c of this.deps.registry.all()) {
      c.send({ type: 'widget', id: randomUUID(), widget, ttlMs });
    }
  }

  private push(p: PushMessage): void {
    // Sem await — não segura o ciclo se o ntfy demorar.
    void this.deps.sendPush(p).catch((err) => console.warn('[notices] push falhou:', err));
  }
}
