// Clientes conectados na API (um por clientId) e contexto de retomada da voz
// de quem caiu. Substitui o antigo ws/hub.ts.

import type { ApiServerMessage, ClientKind, LocalOp } from '@assistant/shared';
import type { LiveTurn, LivePendingRequest } from '../voice/gemini-live.js';
import type { LocalBridge } from './local-bridge.js';

export type LiveRecoveryContext = {
  history?: LiveTurn[];
  pendingRequest?: LivePendingRequest;
  resumptionHandle?: string;
};

/** O que handler, registro e avisos usam da sessão de voz (voice-session.ts implementa). */
export type VoiceSessionHandle = {
  start(): { ok: boolean; reason?: string };
  stop(): void;
  detach(): LiveRecoveryContext | null;
  sendAudio(pcm16k: Buffer): void;
  endTurn(): void;
  sendText(text: string): boolean;
  sendInternal(text: string): boolean;
  isReady(): boolean;
};

export type ConnectedClient = {
  clientId: string;
  kind: ClientKind;
  localOps: LocalOp[];
  send(msg: ApiServerMessage): void;
  sendAudio(pcm: Buffer): void;
  close(code: number, reason: string): void;
  bridge: LocalBridge;
  session: VoiceSessionHandle | null;
  lastInteractionAt: number;
  connectedAt: number;
};

// Retomada é pra queda/sono curto. Depois disso a conversa velha atrapalha
// (e o handle de resumption do Gemini expira).
const RECOVERY_TTL_MS = 15 * 60_000;

export class ClientRegistry {
  private readonly clients = new Map<string, ConnectedClient>();
  private readonly recovery = new Map<string, { ctx: LiveRecoveryContext; savedAt: number }>();

  /** Registra o cliente; devolve o anterior com o mesmo clientId, se havia. */
  add(c: ConnectedClient): ConnectedClient | undefined {
    const prev = this.clients.get(c.clientId);
    this.clients.set(c.clientId, c);
    return prev;
  }

  /** Remove o clientId. Com `c`, só remove se o registrado ainda for ele. */
  remove(clientId: string, c?: ConnectedClient): void {
    if (c && this.clients.get(clientId) !== c) return;
    this.clients.delete(clientId);
  }

  get(clientId: string): ConnectedClient | undefined {
    return this.clients.get(clientId);
  }

  all(): ConnectedClient[] {
    return [...this.clients.values()];
  }

  count(): number {
    return this.clients.size;
  }

  touch(clientId: string): void {
    const c = this.clients.get(clientId);
    if (c) c.lastInteractionAt = Date.now();
  }

  /** Cliente que deve falar um aviso: voz pronta + interação mais recente. */
  pickSpeaker(): ConnectedClient | null {
    let best: ConnectedClient | null = null;
    for (const c of this.clients.values()) {
      if (!c.session?.isReady()) continue;
      if (
        !best ||
        c.lastInteractionAt > best.lastInteractionAt ||
        (c.lastInteractionAt === best.lastInteractionAt && c.connectedAt > best.connectedAt)
      ) {
        best = c;
      }
    }
    return best;
  }

  saveRecovery(clientId: string, ctx: LiveRecoveryContext): void {
    this.recovery.set(clientId, { ctx, savedAt: Date.now() });
  }

  takeRecovery(clientId: string): LiveRecoveryContext | undefined {
    const entry = this.recovery.get(clientId);
    this.recovery.delete(clientId);
    if (!entry || Date.now() - entry.savedAt > RECOVERY_TTL_MS) return undefined;
    return entry.ctx;
  }
}
