// Polling de emails em background. A cada N minutos roda um ciclo. Quando
// achar email importante novo, chama o callback pro main avisar (voz/widget).

import { runEmailCycle, isGmailAvailable, type ProcessedEmail } from './index.js';

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000; // 10min

export type PollerOptions = {
  intervalMs?: number;
  onImportant: (emails: ProcessedEmail[]) => void;
};

export function startEmailPoller(opts: PollerOptions): () => void {
  if (!isGmailAvailable()) {
    console.log('[email/poller] não configurado (faltando GMAIL_USER ou GMAIL_APP_PASS)');
    return () => {};
  }
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  let cancelled = false;
  let running = false;

  async function tick(): Promise<void> {
    if (cancelled || running) return;
    running = true;
    try {
      const r = await runEmailCycle();
      if (r.errors?.length) {
        console.warn('[email/poller] erros no ciclo:', r.errors.join('; '));
      }
      if (r.fetched > 0) {
        console.log(
          `[email/poller] ${r.fetched} email(s); importantes=${r.important.length} outros=${r.notImportant.length}`,
        );
      }
      if (r.important.length > 0) {
        try {
          opts.onImportant(r.important);
        } catch (err) {
          console.warn('[email/poller] onImportant callback falhou:', err);
        }
      }
    } catch (err) {
      console.warn('[email/poller] tick falhou:', err);
    } finally {
      running = false;
    }
  }

  console.log(`[email/poller] iniciado (intervalo ${Math.round(intervalMs / 1000)}s)`);
  // Primeiro tick depois de 30s pra não atrasar startup.
  const startTimer = setTimeout(() => void tick(), 30_000);
  const interval = setInterval(() => void tick(), intervalMs);

  return () => {
    cancelled = true;
    clearTimeout(startTimer);
    clearInterval(interval);
  };
}
