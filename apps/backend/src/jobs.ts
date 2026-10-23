// Tarefas de fundo da API: o que antes subia no boot do Electron. Pollers
// geram avisos proativos que o NoticeDispatcher entrega aos clientes.

import type { MemoryVault } from './vault/memory-vault.js';
import type { NoticeDispatcher } from './notices/notice-dispatcher.js';
import { clickupNotice, emailNotice } from './notices/notices.js';
import { initializeEmbeddings } from './integrations/embeddings.js';
import {
  applyKamilaCuratedVideos,
  getStudyPlanStore,
  seedKamilaPlanIfMissing,
} from './integrations/study-plans.js';
import { getActiveWorkStore } from './integrations/active-work.js';
import { backfillEmails, hasBackfilled, isGmailAvailable } from './integrations/email/index.js';
import { startEmailPoller } from './integrations/email/poller.js';
import { startClickupNotificationsPoller } from './integrations/clickup-notifications.js';
import { listPendingWebhookEvents } from './memory/db.js';
import { logger } from './logger.js';

export async function startJobs(deps: {
  memory: MemoryVault;
  notices: NoticeDispatcher;
}): Promise<() => void> {
  // Índice semântico (Gemini Embedding). Roda em background.
  initializeEmbeddings(deps.memory);

  // Planos de estudo persistentes — semeia o da Kamila na 1ª execução.
  const studyStore = getStudyPlanStore();
  await studyStore.load();
  await seedKamilaPlanIfMissing(studyStore);
  await applyKamilaCuratedVideos(studyStore);
  // Tracker de sessões de trabalho (start_work/end_work).
  await getActiveWorkStore().load();

  // Backfill dos últimos 100 e-mails na primeira execução (busca semântica).
  let backfillTimer: NodeJS.Timeout | null = null;
  if (isGmailAvailable()) {
    void (async () => {
      if (await hasBackfilled()) return;
      // Espera 1 min pra não competir com o resto do boot.
      backfillTimer = setTimeout(async () => {
        try {
          logger.info('[email] backfill inicial — indexando últimos 100 emails');
          const r = await backfillEmails(100);
          logger.info({ indexed: r.indexed, skipped: r.skipped, reason: r.reason }, '[email] backfill');
        } catch (err) {
          logger.warn({ err }, '[email] backfill falhou');
        }
      }, 60_000);
    })();
  }

  const stops = [
    startEmailPoller({ onImportant: (emails) => deps.notices.dispatch(emailNotice(emails)) }),
    startClickupNotificationsPoller({ onBatch: (batch) => deps.notices.dispatch(clickupNotice(batch)) }),
  ];

  // Builds do Expo que chegaram e ainda não foram falados.
  for (const row of listPendingWebhookEvents()) deps.notices.enqueueExpo(row, { fromBoot: true });

  return () => {
    if (backfillTimer) clearTimeout(backfillTimer);
    for (const stop of stops) stop();
  };
}
