import { fetchWeather } from './weather.js';
import {
  buildTaskBriefing,
  formatTasksList,
  getTaskDetails,
  isClickupAvailable,
  listMyHighPriorityTasks,
  listMyInProgressTasks,
  taskDetailToWidget,
  tasksToWidget,
} from './clickup.js';
import {
  isYoutubeAvailable,
  resolveYoutube,
  searchYoutubeMany,
  type YoutubePrefer,
} from './youtube.js';
import { summarizeYoutubeVideo, isYoutubeSummaryAvailable } from './youtube-summary.js';
import { search as semanticSearch } from './embeddings.js';
import { buildMorningBriefing } from './briefing.js';
import { pollClickupNotificationsOnce } from './clickup-notifications.js';
import { listWorkLogs, readWorkLog } from './work-log-view.js';
import { isWebSearchAvailable, searchWeb, formatSearchForVoice } from './web-search.js';
import {
  getStudyPlanStore,
  type TopicStatus,
} from './study-plans.js';
import { getActiveWorkStore, formatRelativeAge, type WorkEntry } from './active-work.js';
import {
  addChecklist,
  addCommentToCard,
  addLabelToCard,
  archiveCard,
  cardDetailToWidget,
  cardsToWidget,
  checkChecklistItem,
  createCard,
  formatCardDetailForVoice,
  formatCardsForVoice,
  getCard,
  getChecklists,
  getComments,
  getLockedBoard,
  isTrelloAvailable,
  listCardsInBoard,
  listCardsInList,
  listLabelsForBoard,
  listListsForBoard,
  moveCard,
  removeLabelFromCard,
  resolveBoard,
  resolveCard,
  unarchiveCard,
  updateCard,
} from './trello.js';

function shortSender(from: string): string {
  // "Nome <email@host>" → "Nome" se houver, senão domínio.
  const m = from.match(/^(.+?)\s*<(.+)>$/);
  if (m && m[1].trim()) return m[1].replace(/"/g, '').trim();
  const email = (m?.[2] ?? from).trim();
  return email.split('@')[0] || email;
}

function stripVector(e: ProcessedEmail): Omit<ProcessedEmail, 'vector'> {
  const { vector: _vector, ...rest } = e;
  return rest;
}

export function formatImportantSummary(
  important: ProcessedEmail[],
  fetchedTotal: number,
): string {
  if (important.length === 0) {
    return `Vi ${fetchedTotal} email(s) novo(s), nenhum importante.`;
  }
  const lines = important.slice(0, 5).map((e) => {
    return `• ${shortSender(e.from)} — ${e.subject}`;
  });
  const more = important.length > 5 ? `\n…e mais ${important.length - 5}.` : '';
  const head =
    important.length === 1
      ? `1 email importante de ${fetchedTotal} novos:`
      : `${important.length} emails importantes de ${fetchedTotal} novos:`;
  return `${head}\n${lines.join('\n')}${more}`;
}

function deriveStatusForDisplay(e: WorkEntry): string {
  const s = e.status ?? (e.endedAt ? 'completed' : 'running');
  if (s === 'completed') return 'concluída';
  if (s === 'failed') return 'falhou';
  if (s === 'interrupted') return 'interrompida';
  if (s === 'paused') return 'pausada';
  return 'em andamento';
}
import {
  backfillEmails,
  findRecentEmail,
  getCorpusStats,
  getRecentImportant,
  isGmailAvailable,
  labelEmail,
  runEmailCycle,
  searchEmails,
  type ProcessedEmail,
} from './email/index.js';
import {
  formatMediaList,
  formatProfileSummary,
  getMediaInsights,
  getProfile,
  isInstagramAvailable,
  listLatestMedia,
} from './instagram.js';
import type { Widget } from '@assistant/shared/widgets';

export type IntegrationResult =
  | {
      ok: true;
      text: string;
      /** Widget único — atalho. Use widgets[] quando quiser mais de um. */
      widget?: Widget;
      /** Múltiplos widgets pra integrações compostas (ex: morning_briefing). */
      widgets?: Widget[];
      /** Delay por widget (index-aligned com `widgets`). 0/ausente = imediato. */
      widgetDelaysMs?: number[];
      meta?: Record<string, unknown>;
    }
  | { ok: false; reason: string; text?: string };

/**
 * Roteador das tool calls que NÃO são ClientCommand (open_app etc).
 * Recebe nome da função e args, executa a integração, retorna texto pronto
 * pra o Gemini Live vocalizar.
 *
 * Retorno SEMPRE inclui um `text` quando ok — esse texto é o que o modelo
 * vai usar pra construir a resposta falada. Manter curto e direto.
 */
export async function executeIntegration(
  name: string,
  args: Record<string, unknown>,
): Promise<IntegrationResult | null> {
  switch (name) {
    case 'weather': {
      const when = (args.when as 'today' | 'tomorrow' | undefined) ?? 'today';
      const r = await fetchWeather(when);
      return { ok: true, text: r.text, widget: r.widget };
    }

    case 'play_youtube': {
      if (!isYoutubeAvailable()) {
        return { ok: false, reason: 'YOUTUBE_API_KEY não configurada' };
      }
      const query = String(args.query ?? '').trim();
      if (!query) return { ok: false, reason: 'query vazia' };
      const prefer = (args.prefer as YoutubePrefer | undefined) ?? 'top';
      const result = await resolveYoutube(query, prefer);
      if (!result) return { ok: false, reason: 'nada encontrado pra essa query' };
      // Quem abre a URL é o cliente (executor da API chama open_url).
      return {
        ok: true,
        text: `Tocando "${result.title}"${result.channel ? ` de ${result.channel}` : ''}.`,
        widget: {
          kind: 'youtube',
          videoId: result.videoId,
          title: result.title,
          channel: result.channel,
          thumbnailUrl: `https://i.ytimg.com/vi/${result.videoId}/mqdefault.jpg`,
          url: result.url,
        },
        meta: { videoId: result.videoId, url: result.url, openUrl: result.url },
      };
    }

    case 'clickup_tasks_in_progress': {
      if (!isClickupAvailable()) {
        return { ok: false, reason: 'CLICKUP_TOKEN não configurado' };
      }
      const tasks = await listMyInProgressTasks();
      if (tasks == null) return { ok: false, reason: 'falhou ao consultar ClickUp' };
      return {
        ok: true,
        text: formatTasksList(tasks, 'Você não tem tasks em progresso agora.'),
        widget: tasksToWidget('Em progresso', tasks),
      };
    }

    case 'clickup_tasks_high_priority': {
      if (!isClickupAvailable()) {
        return { ok: false, reason: 'CLICKUP_TOKEN não configurado' };
      }
      const tasks = await listMyHighPriorityTasks();
      if (tasks == null) return { ok: false, reason: 'falhou ao consultar ClickUp' };
      return {
        ok: true,
        text: formatTasksList(tasks, 'Você não tem tasks de prioridade urgente ou alta.'),
        widget: tasksToWidget('Prioridade alta/urgente', tasks),
      };
    }

    case 'clickup_explain_task': {
      if (!isClickupAvailable()) {
        return { ok: false, reason: 'CLICKUP_TOKEN não configurado' };
      }
      const taskId = String(args.taskId ?? '').trim();
      if (!taskId) return { ok: false, reason: 'taskId vazio' };
      const data = await getTaskDetails(taskId);
      if (!data) return { ok: false, reason: `task ${taskId} não encontrada` };
      return {
        ok: true,
        text: buildTaskBriefing(data.task, data.comments),
        widget: taskDetailToWidget(data.task, data.comments),
      };
    }

    case 'email_check_now': {
      if (!isGmailAvailable()) {
        return { ok: false, reason: 'GMAIL_USER/GMAIL_APP_PASS não configurados' };
      }
      const r = await runEmailCycle();
      if (r.errors?.length) {
        return { ok: false, reason: r.errors.join('; ') };
      }
      if (r.fetched === 0) {
        return { ok: true, text: 'Sem emails novos.' };
      }
      const text = formatImportantSummary(r.important, r.fetched);
      return { ok: true, text, meta: { important: r.important.map(stripVector) } };
    }

    case 'email_recent_important': {
      if (!isGmailAvailable()) {
        return { ok: false, reason: 'GMAIL_USER/GMAIL_APP_PASS não configurados' };
      }
      const limit = Math.min(Number(args.limit ?? 5), 15);
      const items = await getRecentImportant(limit);
      if (items.length === 0) {
        return { ok: true, text: 'Não tem emails importantes recentes.' };
      }
      const lines = items.map((e) => {
        const senderShort = shortSender(e.from);
        return `• ${senderShort} — ${e.subject}`;
      });
      return {
        ok: true,
        text: `${items.length} email(s) importante(s) recentes:\n${lines.join('\n')}`,
        meta: { important: items.map(stripVector) },
      };
    }

    case 'email_backfill': {
      if (!isGmailAvailable()) {
        return { ok: false, reason: 'GMAIL_USER/GMAIL_APP_PASS não configurados' };
      }
      const limit = Math.min(Number(args.limit ?? 100), 500);
      const r = await backfillEmails(limit);
      if (!r.ok) return { ok: false, reason: r.reason ?? 'falhou' };
      return {
        ok: true,
        text: `Indexei ${r.indexed} email(s) novo(s), pulei ${r.skipped} já indexado(s).`,
      };
    }

    case 'email_search': {
      if (!isGmailAvailable()) {
        return { ok: false, reason: 'GMAIL_USER/GMAIL_APP_PASS não configurados' };
      }
      const query = String(args.query ?? '').trim();
      if (!query) return { ok: false, reason: 'query vazia' };
      const limit = Math.min(Number(args.limit ?? 3), 10);
      const hits = await searchEmails(query, limit);
      if (hits.length === 0) {
        return {
          ok: true,
          text: `Não achei email relevante pra "${query}".`,
        };
      }
      const lines = hits.map((h) => {
        const dateStr = h.date
          ? new Date(h.date).toLocaleDateString('pt-BR')
          : '?';
        return `• ${dateStr} — ${shortSender(h.from)} — ${h.subject}`;
      });
      return {
        ok: true,
        text: `Achei ${hits.length} email(s) sobre "${query}":\n${lines.join('\n')}`,
        meta: { hits },
      };
    }

    case 'email_mark_important':
    case 'email_mark_not_important': {
      if (!isGmailAvailable()) {
        return { ok: false, reason: 'GMAIL_USER/GMAIL_APP_PASS não configurados' };
      }
      const label = name === 'email_mark_important' ? 'important' : 'not';
      const query = String(args.query ?? '').trim();
      if (!query) return { ok: false, reason: 'query vazia' };
      const target = await findRecentEmail(query);
      if (!target) {
        return { ok: false, reason: `não achei email recente pra "${query}"` };
      }
      const r = await labelEmail(target.id, label);
      if (!r.ok) return { ok: false, reason: r.reason ?? 'falhou' };
      const stats = await getCorpusStats();
      const verb = label === 'important' ? 'importante' : 'não importante';
      return {
        ok: true,
        text: `Anotado: "${target.subject}" como ${verb}. Corpus agora: ${stats.important} importantes / ${stats.not} não.`,
      };
    }

    case 'instagram_profile': {
      if (!isInstagramAvailable()) {
        return { ok: false, reason: 'INSTAGRAM_API_KEY não configurada' };
      }
      const p = await getProfile();
      if (!p) return { ok: false, reason: 'falhou ao consultar Instagram' };
      return { ok: true, text: formatProfileSummary(p), meta: { profile: p } };
    }

    case 'instagram_latest_posts': {
      if (!isInstagramAvailable()) {
        return { ok: false, reason: 'INSTAGRAM_API_KEY não configurada' };
      }
      const limit = Math.min(Number(args.limit ?? 5), 10);
      const items = await listLatestMedia(limit);
      if (items == null) return { ok: false, reason: 'falhou ao consultar Instagram' };
      if (items.length === 0) {
        return { ok: true, text: 'Você não tem posts no Instagram ainda.' };
      }
      return {
        ok: true,
        text: formatMediaList(items),
        meta: { posts: items },
      };
    }

    case 'instagram_post_insights': {
      if (!isInstagramAvailable()) {
        return { ok: false, reason: 'INSTAGRAM_API_KEY não configurada' };
      }
      const mediaId = String(args.mediaId ?? '').trim();
      if (!mediaId) return { ok: false, reason: 'mediaId vazio' };
      const insights = await getMediaInsights(mediaId);
      if (!insights) return { ok: false, reason: 'falhou ao buscar métricas' };
      const lines = insights.map((i) => `${i.name}: ${i.values[0]?.value ?? 0}`);
      return { ok: true, text: lines.join(', '), meta: { insights } };
    }

    case 'morning_briefing': {
      const r = await buildMorningBriefing();
      return {
        ok: true,
        text: r.text,
        widgets: r.widgets,
        widgetDelaysMs: r.widgetDelaysMs,
        meta: r.meta,
      };
    }

    case 'check_clickup_notifications': {
      const batch = await pollClickupNotificationsOnce();
      if (!batch) {
        return {
          ok: true,
          text: 'Nada de novo no ClickUp desde a última checagem. Tudo em dia.',
        };
      }
      return {
        ok: true,
        text: batch.summary,
        widgets: [
          {
            kind: 'notifications',
            source: 'clickup',
            items: batch.items,
          },
        ],
        widgetDelaysMs: [0],
      };
    }

    case 'list_work_logs': {
      const limit = Number(args.limit ?? 10);
      const r = await listWorkLogs(limit);
      if (!r.ok) return r;
      return { ok: true, text: r.text, meta: { entries: r.entries } };
    }

    case 'read_work_log': {
      const query = String(args.query ?? '').trim();
      const r = await readWorkLog(query);
      if (!r.ok) return r;
      return { ok: true, text: r.text, meta: { filename: r.filename } };
    }

    case 'create_study_plan': {
      const store = getStudyPlanStore();
      const owner = String(args.owner ?? '').trim();
      const topic = String(args.topic ?? '').trim();
      const goal = String(args.goal ?? '').trim();
      const planId = args.plan_id ? String(args.plan_id) : undefined;
      const modulesRaw = Array.isArray(args.modules) ? args.modules : [];
      const modules = modulesRaw
        .map((m) => {
          const mm = (m ?? {}) as Record<string, unknown>;
          const topicsRaw = Array.isArray(mm.topics) ? mm.topics : [];
          return {
            title: String(mm.title ?? ''),
            objective: String(mm.objective ?? ''),
            topics: topicsRaw.map((t) => {
              const tt = (t ?? {}) as Record<string, unknown>;
              return { title: String(tt.title ?? '') };
            }),
          };
        })
        .filter((m) => m.title && m.topics.length > 0);
      const r = await store.create({ planId, owner, topic, goal, modules });
      if (!r.ok) return { ok: false, reason: r.reason ?? 'falhou' };
      const sum = store.summarize(r.plan!);
      return {
        ok: true,
        text:
          `Plano criado: "${sum.topic}" pra ${sum.owner}, ${sum.totalTopics} ` +
          `tópicos em ${r.plan!.modules.length} módulos. Quando quiser começar, ` +
          `me peça o próximo passo.`,
        meta: { planId: sum.planId },
      };
    }

    case 'list_study_plans': {
      const store = getStudyPlanStore();
      const list = store.list();
      if (list.length === 0) {
        return { ok: true, text: 'Nenhum plano de estudo cadastrado.' };
      }
      const text = list
        .map((p) => {
          const pct =
            p.totalTopics > 0
              ? Math.round((p.doneTopics / p.totalTopics) * 100)
              : 0;
          return (
            `- "${p.planId}" (${p.owner}): ${p.topic} — ` +
            `${p.doneTopics}/${p.totalTopics} (${pct}%) · status=${p.status}`
          );
        })
        .join('\n');
      return { ok: true, text };
    }

    case 'study_plan_status': {
      const store = getStudyPlanStore();
      const planId = String(args.plan_id ?? '').trim();
      const plan = planId ? store.resolve(planId) : null;
      if (!plan) {
        return { ok: false, reason: `plano "${planId}" não encontrado` };
      }
      const sum = store.summarize(plan);
      const cur = store.findCurrent(plan);
      const lines = [
        `Plano "${plan.topic}" do/a ${plan.owner}: ${sum.doneTopics}/${sum.totalTopics} tópicos feitos.`,
      ];
      if (cur) {
        lines.push(
          `Atual: ${cur.topic.title} (módulo: ${cur.module.title}, status=${cur.topic.status}).`,
        );
        if (cur.topic.notes) lines.push(`Notas: ${cur.topic.notes}`);
      } else if (plan.status === 'done') {
        lines.push('Plano concluído!');
      }
      return { ok: true, text: lines.join('\n'), meta: { planId: plan.planId } };
    }

    case 'study_plan_next': {
      const store = getStudyPlanStore();
      const planId = String(args.plan_id ?? '').trim();
      const plan = planId ? store.resolve(planId) : null;
      if (!plan) {
        return { ok: false, reason: `plano "${planId}" não encontrado` };
      }
      const cur = store.findCurrent(plan);
      if (!cur) {
        return {
          ok: true,
          text: `Plano "${plan.topic}" tá completo! Parabéns.`,
          meta: { planId: plan.planId },
        };
      }
      // Marca como em-progresso (só se ainda não estava)
      if (cur.topic.status === 'not-started') {
        await store.markTopic(plan.planId, cur.topic.id, 'in-progress');
      }
      // Tenta achar/abrir vídeo do tópico no YouTube se ainda não tiver
      let videoLine = '';
      let widget: Widget | undefined;
      // URL que o cliente deve abrir (meta.openUrl — o executor da API repassa).
      let openUrl: string | undefined;
      if (!cur.topic.videoUrl && isYoutubeAvailable()) {
        const query = `${cur.topic.title} ${plan.topic} explicação em português`;
        // Tenta vídeo "médio" (4-20min) primeiro — descarta Shorts e clipes
        // curtos. Fallback pra "long" (>20min) se não achar nada decente.
        let yt = await resolveYoutube(query, 'top', { videoDuration: 'medium' });
        if (!yt) {
          yt = await resolveYoutube(query, 'top', { videoDuration: 'long' });
        }
        if (yt) {
          await store.setTopicVideo(plan.planId, cur.topic.id, yt.url, yt.title);
          openUrl = yt.url;
          videoLine = ` Abri um vídeo no YouTube: "${yt.title}"${yt.channel ? ` de ${yt.channel}` : ''}.`;
          widget = {
            kind: 'youtube',
            videoId: yt.videoId,
            title: yt.title,
            channel: yt.channel,
            thumbnailUrl: `https://i.ytimg.com/vi/${yt.videoId}/mqdefault.jpg`,
            url: yt.url,
          };
        }
      } else if (cur.topic.videoUrl) {
        openUrl = cur.topic.videoUrl;
        videoLine = ` Reabri o vídeo: "${cur.topic.videoTitle ?? 'vídeo salvo'}".`;
      }
      const text =
        `Próximo tópico do plano "${plan.topic}" (${plan.owner}): ` +
        `${cur.topic.title}. Faz parte do módulo "${cur.module.title}". ` +
        `Objetivo do módulo: ${cur.module.objective}.` +
        videoLine +
        ` Diga "terminei" quando concluir, ou peça pra pular.`;
      return {
        ok: true,
        text,
        widget,
        meta: { planId: plan.planId, topicId: cur.topic.id, ...(openUrl ? { openUrl } : {}) },
      };
    }

    case 'study_plan_another_video': {
      const store = getStudyPlanStore();
      const planId = String(args.plan_id ?? '').trim();
      const topicId = String(args.topic_id ?? '').trim();
      const replace = args.replace === true;
      const plan = store.resolve(planId);
      if (!plan) {
        return { ok: false, reason: `plano "${planId}" não encontrado` };
      }
      // Sem topic_id → usa o tópico atual
      const target = topicId
        ? store.findTopic(plan, topicId)
        : store.findCurrent(plan);
      if (!target) {
        return { ok: false, reason: 'nenhum tópico atual' };
      }
      if (!isYoutubeAvailable()) {
        return { ok: false, reason: 'YOUTUBE_API_KEY não configurada' };
      }
      const watched = new Set<string>();
      if (target.topic.videoUrl) watched.add(target.topic.videoUrl);
      for (const v of target.topic.watchedVideos ?? []) watched.add(v.url);

      const query = `${target.topic.title} ${plan.topic} explicação em português`;
      // Busca várias e filtra os que já foram vistos
      let candidates = await searchYoutubeMany(query, { videoDuration: 'medium' }, 8);
      candidates = candidates.filter((c) => !watched.has(c.url));
      if (candidates.length === 0) {
        // Fallback: long
        const longCands = await searchYoutubeMany(
          query,
          { videoDuration: 'long' },
          8,
        );
        candidates = longCands.filter((c) => !watched.has(c.url));
      }
      if (candidates.length === 0) {
        return {
          ok: false,
          reason:
            'não achei outro vídeo em português pra esse tópico — você pode tentar buscar manualmente',
        };
      }
      const next = candidates[0];
      // Sempre registra no histórico. Só substitui o videoUrl principal se
      // replace=true (ex: usuário disse "esse vídeo era ruim, troca").
      if (replace) {
        await store.setTopicVideo(plan.planId, target.topic.id, next.url, next.title);
      } else {
        // Adiciona ao histórico mesmo sem virar principal
        const hist = target.topic.watchedVideos ?? [];
        hist.push({ url: next.url, title: next.title, addedAt: new Date().toISOString() });
        target.topic.watchedVideos = hist;
        plan.updatedAt = new Date().toISOString();
        // Salva via setTopicVideo no mesmo url atual (truque pra forçar persist),
        // ou diretamente — usa setTopicVideo se houver, senão chama setTopicVideo
        // com o url atual pra reaproveitar a persistência.
        // Mais simples: marca como visto via setTopicVideo do url ATUAL (no-op
        // do url, mas re-persiste com hist atualizado).
        if (target.topic.videoUrl) {
          await store.setTopicVideo(
            plan.planId,
            target.topic.id,
            target.topic.videoUrl,
            target.topic.videoTitle ?? undefined,
          );
        }
      }
      const text =
        `Achei outro vídeo pro tópico "${target.topic.title}": ` +
        `"${next.title}"${next.channel ? ` de ${next.channel}` : ''}. ` +
        `Abri no navegador.` +
        (replace ? ' Esse virou o vídeo oficial do tópico.' : '');
      return {
        ok: true,
        text,
        widget: {
          kind: 'youtube',
          videoId: next.videoId,
          title: next.title,
          channel: next.channel,
          thumbnailUrl: `https://i.ytimg.com/vi/${next.videoId}/mqdefault.jpg`,
          url: next.url,
        },
        meta: { planId: plan.planId, topicId: target.topic.id, videoUrl: next.url, openUrl: next.url },
      };
    }

    case 'mark_study_topic': {
      const store = getStudyPlanStore();
      const planId = String(args.plan_id ?? '').trim();
      const topicId = String(args.topic_id ?? '').trim();
      const status = String(args.status ?? '') as TopicStatus;
      const note = args.note !== undefined ? String(args.note) : undefined;
      const plan = planId ? store.resolve(planId) : null;
      if (!plan) return { ok: false, reason: `plano "${planId}" não encontrado` };
      if (!['not-started', 'in-progress', 'done', 'skipped'].includes(status)) {
        return { ok: false, reason: `status "${status}" inválido` };
      }
      const r = await store.markTopic(plan.planId, topicId, status, note);
      if (!r.ok) return { ok: false, reason: r.reason ?? 'falhou' };
      const t = r.topic!;
      const sum = store.summarize(plan);
      const text =
        `Marquei "${t.title}" como ${status}.` +
        (note ? ' Nota anexada.' : '') +
        ` Progresso: ${sum.doneTopics}/${sum.totalTopics}.`;
      return { ok: true, text, meta: { planId: plan.planId, topicId: t.id } };
    }

    case 'web_search': {
      if (!isWebSearchAvailable()) {
        return { ok: false, reason: 'TAVILY_API_KEY não configurada' };
      }
      const query = String(args.query ?? '').trim();
      if (!query) return { ok: false, reason: 'query vazia' };
      const r = await searchWeb(query);
      if (!r.ok) return { ok: false, reason: r.reason };
      const widget: Widget | undefined =
        r.results.length > 0
          ? {
              kind: 'search-results',
              query: r.query,
              results: r.results.slice(0, 5).map((res) => ({
                title: res.title,
                url: res.url,
                snippet:
                  res.content.length > 200
                    ? res.content.slice(0, 200) + '…'
                    : res.content,
              })),
            }
          : undefined;
      return { ok: true, text: formatSearchForVoice(r), widget };
    }

    case 'summarize_youtube': {
      if (!isYoutubeSummaryAvailable()) {
        return { ok: false, reason: 'GEMINI_API_KEY não configurada' };
      }
      const url = String(args.url ?? '').trim();
      if (!url) return { ok: false, reason: 'URL vazia' };
      const r = await summarizeYoutubeVideo(url);
      if (!r.ok) return { ok: false, reason: r.reason };
      const viaLabel = r.via === 'transcript' ? '(via legenda)' : '(via vídeo direto)';
      return {
        ok: true,
        text: r.summary,
        meta: { videoId: r.videoId, via: r.via, viaLabel },
      };
    }

    case 'search_memory':
    case 'search_worklogs': {
      const query = String(args.query ?? '').trim();
      if (!query) return { ok: false, reason: 'query vazia' };
      const rawLimit = Number(args.limit ?? 5);
      const limit = Math.max(1, Math.min(10, isFinite(rawLimit) ? rawLimit : 5));
      try {
        const kind = name === 'search_memory' ? 'memory' : 'worklog';
        const results = await semanticSearch(query, { kind, limit });
        if (results.length === 0) {
          return {
            ok: true,
            text: `Nenhum resultado relevante encontrado pra "${query}".`,
          };
        }
        // Formato leve pra o Live ler. Cada linha: score, title, snippet.
        const lines = results.map((r, i) => {
          const pct = Math.round(r.score * 100);
          const meta =
            r.kind === 'worklog' && r.metadata?.filename
              ? ` (filename: ${r.metadata.filename})`
              : '';
          return `${i + 1}. [${pct}%] ${r.title}${meta}\n   ${r.snippet.replace(/\s+/g, ' ').slice(0, 200)}`;
        });
        const intro =
          name === 'search_memory'
            ? `Memórias relevantes pra "${query}" (top ${results.length}):`
            : `Worklogs relevantes pra "${query}" (top ${results.length}). Pra ler completo, chame read_work_log com o filename.`;
        return { ok: true, text: `${intro}\n${lines.join('\n')}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: `busca falhou: ${msg}` };
      }
    }

    case 'start_work': {
      const description = String(args.description ?? '').trim();
      const clickupTaskId = args.clickup_task_id
        ? String(args.clickup_task_id)
        : undefined;
      const owner = args.owner ? String(args.owner) : undefined;
      if (!description) return { ok: false, reason: 'descrição vazia' };
      const store = getActiveWorkStore();
      const r = await store.startWork({ description, clickupTaskId, owner });
      if (!r.ok) {
        if ('conflict' in r) {
          // Sessão running existente — Gemini precisa perguntar pausar/interromper
          // antes. Devolve metadata pra ele saber o que tá aberto.
          const cur = r.current;
          const age = formatRelativeAge(cur.startedAt);
          return {
            ok: false,
            reason: 'session_open',
            text:
              `[Conflito] Já tem uma sessão aberta: "${cur.description}" ` +
              `(${age}). Pergunte ao usuário em primeira pessoa se quer pausar ` +
              `(salva o estado pra retomar depois) ou interromper (descarta) ` +
              `a atual antes de começar a nova "${description}". Quando ele ` +
              `responder, chame pause_current_work ou interrupt_current_work, ` +
              `e DEPOIS chame start_work de novo.`,
          };
        }
        return { ok: false, reason: r.reason ?? 'falhou' };
      }
      return {
        ok: true,
        text: `Anotei. Você começou a trabalhar em "${description}" agora.`,
      };
    }

    case 'end_work': {
      const note = args.note ? String(args.note) : undefined;
      const store = getActiveWorkStore();
      const r = await store.endWork(note);
      if (!r.ok) return { ok: false, reason: r.reason ?? 'falhou' };
      return {
        ok: true,
        text: `Encerrei a sessão de trabalho em "${r.entry!.description}".`,
      };
    }

    case 'pause_current_work': {
      const note = args.note ? String(args.note) : undefined;
      const store = getActiveWorkStore();
      const r = await store.pauseCurrent(note);
      if (!r.ok) return { ok: false, reason: r.reason ?? 'falhou' };
      return {
        ok: true,
        text: `Pausei "${r.entry!.description}". Pode retomar depois.`,
      };
    }

    case 'interrupt_current_work': {
      const note = args.note ? String(args.note) : undefined;
      const store = getActiveWorkStore();
      const r = await store.interruptCurrent(note);
      if (!r.ok) return { ok: false, reason: r.reason ?? 'falhou' };
      return {
        ok: true,
        text: `Interrompi "${r.entry!.description}".`,
      };
    }

    case 'current_work_status': {
      const store = getActiveWorkStore();
      const cur = store.current();
      const paused = store.pausedEntries();
      const recent = store.recentlyEnded(10);
      if (!cur && paused.length === 0 && recent.length === 0) {
        return { ok: true, text: 'Você não tem nenhuma sessão de trabalho aberta no momento.' };
      }
      const parts: string[] = [];
      if (cur) {
        const age = formatRelativeAge(cur.startedAt);
        const projectInfo = cur.projectName ? ` no projeto ${cur.projectName}` : '';
        const lastStepInfo = cur.lastStep ? ` Última ação: ${cur.lastStep}.` : '';
        parts.push(
          `Em andamento — sessão: "${cur.description}"${projectInfo}, ` +
          `há ${age}${cur.clickupTaskId ? ` (ClickUp: ${cur.clickupTaskId})` : ''}.${lastStepInfo}`,
        );
      }
      if (paused.length > 0) {
        const list = paused
          .slice(0, 3)
          .map((p) => `"${p.description}" (${formatRelativeAge(p.startedAt)})`)
          .join(', ');
        parts.push(`Pausadas: ${list}.`);
      }
      if (recent.length > 0) {
        const list = recent
          .slice(0, 3)
          .map((r) => {
            const status = deriveStatusForDisplay(r);
            const age = formatRelativeAge(r.endedAt!);
            return `"${r.description}" (${status} ${age})`;
          })
          .join(', ');
        parts.push(`Recém-encerradas: ${list}.`);
      }
      return { ok: true, text: parts.join(' ') };
    }

    case 'trello_list_lists': {
      if (!isTrelloAvailable()) {
        return { ok: false, reason: 'TRELLO_API_KEY/TRELLO_TOKEN não configurados' };
      }
      const boardHint = args.board ? String(args.board) : undefined;
      const br = await resolveBoard(boardHint);
      if (!br.board) return { ok: false, reason: br.reason ?? 'board não resolvido' };
      const lists = await listListsForBoard(br.board.id);
      if (!lists) return { ok: false, reason: 'falhou ao listar listas' };
      if (lists.length === 0) {
        return { ok: true, text: `Board "${br.board.name}" não tem listas.` };
      }
      const lines = lists.map((l) => `• ${l.name}`);
      return {
        ok: true,
        text: `Listas do board "${br.board.name}":\n${lines.join('\n')}`,
        meta: { boardId: br.board.id, lists },
      };
    }

    case 'trello_list_labels': {
      if (!isTrelloAvailable()) {
        return { ok: false, reason: 'TRELLO_API_KEY/TRELLO_TOKEN não configurados' };
      }
      const boardHint = args.board ? String(args.board) : undefined;
      const br = await resolveBoard(boardHint);
      if (!br.board) return { ok: false, reason: br.reason ?? 'board não resolvido' };
      const labels = await listLabelsForBoard(br.board.id);
      if (!labels) return { ok: false, reason: 'falhou ao listar labels' };
      const named = labels.filter((l) => l.name);
      if (named.length === 0) {
        return {
          ok: true,
          text: `Board "${br.board.name}" não tem etiquetas nomeadas.`,
        };
      }
      const lines = named.map((l) => `• ${l.name}${l.color ? ` (${l.color})` : ''}`);
      return {
        ok: true,
        text: `Etiquetas do board "${br.board.name}":\n${lines.join('\n')}`,
        meta: { labels: named },
      };
    }

    case 'trello_list_cards': {
      if (!isTrelloAvailable()) {
        return { ok: false, reason: 'TRELLO_API_KEY/TRELLO_TOKEN não configurados' };
      }
      const boardHint = args.board ? String(args.board) : undefined;
      const listHint = args.list ? String(args.list) : undefined;
      const br = await resolveBoard(boardHint);
      if (!br.board) return { ok: false, reason: br.reason ?? 'board não resolvido' };

      let listName: string | undefined;
      let cards;
      if (listHint) {
        const lists = await listListsForBoard(br.board.id);
        if (!lists) return { ok: false, reason: 'falhou ao listar listas' };
        const target =
          lists.find((l) => l.id === listHint) ??
          lists.find((l) =>
            l.name.toLowerCase().includes(listHint.toLowerCase()),
          );
        if (!target) {
          return {
            ok: false,
            reason: `nenhuma lista casa com "${listHint}" no board "${br.board.name}"`,
          };
        }
        listName = target.name;
        cards = await listCardsInList(target.id);
      } else {
        cards = await listCardsInBoard(br.board.id);
      }
      if (!cards) return { ok: false, reason: 'falhou ao listar cards' };
      return {
        ok: true,
        text: formatCardsForVoice(cards, listName),
        widget: cardsToWidget(
          listName ?? `Cards do board ${br.board.name}`,
          cards,
          br.board.name,
        ),
      };
    }

    case 'trello_get_card': {
      if (!isTrelloAvailable()) {
        return { ok: false, reason: 'TRELLO_API_KEY/TRELLO_TOKEN não configurados' };
      }
      const cardHint = String(args.card ?? '').trim();
      if (!cardHint) return { ok: false, reason: 'card vazio' };
      const boardHint = args.board ? String(args.board) : undefined;
      const cr = await resolveCard(cardHint, boardHint);
      if (!cr.card) return { ok: false, reason: cr.reason ?? 'card não encontrado' };

      const br = await resolveBoard(cr.card.idBoard);
      const board = br.board;
      if (!board) return { ok: false, reason: 'board do card não encontrado' };

      const [lists, labels, checklists, comments] = await Promise.all([
        listListsForBoard(board.id),
        listLabelsForBoard(board.id),
        getChecklists(cr.card.id),
        getComments(cr.card.id),
      ]);
      const list = lists?.find((l) => l.id === cr.card!.idList) ?? undefined;
      const cardLabels =
        labels?.filter((l) => cr.card!.idLabels.includes(l.id)) ?? [];

      const detail = {
        card: cr.card,
        board,
        list,
        labels: cardLabels,
        checklists: checklists ?? [],
        comments: comments ?? [],
      };
      return {
        ok: true,
        text: formatCardDetailForVoice(detail),
        widget: cardDetailToWidget(detail),
      };
    }

    case 'trello_create_card': {
      if (!isTrelloAvailable()) {
        return { ok: false, reason: 'TRELLO_API_KEY/TRELLO_TOKEN não configurados' };
      }
      const name = String(args.name ?? '').trim();
      const listHint = String(args.list ?? '').trim();
      if (!name) return { ok: false, reason: 'name vazio' };
      if (!listHint) return { ok: false, reason: 'list vazio' };
      const labelHints = Array.isArray(args.labels)
        ? args.labels.map((l) => String(l))
        : undefined;
      const r = await createCard({
        name,
        desc: args.desc ? String(args.desc) : undefined,
        due: args.due ? String(args.due) : undefined,
        listHint,
        boardHint: args.board ? String(args.board) : undefined,
        labelHints,
      });
      if (!r.ok) return { ok: false, reason: r.reason };
      return {
        ok: true,
        text:
          `Criei o card "${r.card.name}" na lista "${r.list.name}" do board "${r.board.name}".` +
          (r.card.due ? ` Vencimento: ${new Date(r.card.due).toLocaleDateString('pt-BR')}.` : ''),
        meta: { cardId: r.card.id, url: r.card.shortUrl ?? r.card.url },
      };
    }

    case 'trello_update_card': {
      if (!isTrelloAvailable()) {
        return { ok: false, reason: 'TRELLO_API_KEY/TRELLO_TOKEN não configurados' };
      }
      const cardHint = String(args.card ?? '').trim();
      if (!cardHint) return { ok: false, reason: 'card vazio' };
      const boardHint = args.board ? String(args.board) : undefined;
      const cr = await resolveCard(cardHint, boardHint);
      if (!cr.card) return { ok: false, reason: cr.reason ?? 'card não encontrado' };
      const patch: Parameters<typeof updateCard>[1] = {};
      if (typeof args.name === 'string') patch.name = args.name;
      if (typeof args.desc === 'string') patch.desc = args.desc;
      if (args.due === null) patch.due = null;
      else if (typeof args.due === 'string') patch.due = args.due;
      if (typeof args.due_complete === 'boolean') patch.dueComplete = args.due_complete;
      const updated = await updateCard(cr.card.id, patch);
      if (!updated) return { ok: false, reason: 'falhou ao atualizar card' };
      const changed = Object.keys(patch);
      return {
        ok: true,
        text:
          changed.length > 0
            ? `Atualizei "${updated.name}": ${changed.join(', ')}.`
            : `Card "${updated.name}" sem alterações.`,
        meta: { cardId: updated.id },
      };
    }

    case 'trello_move_card': {
      if (!isTrelloAvailable()) {
        return { ok: false, reason: 'TRELLO_API_KEY/TRELLO_TOKEN não configurados' };
      }
      const cardHint = String(args.card ?? '').trim();
      const targetList = String(args.list ?? '').trim();
      if (!cardHint || !targetList) {
        return { ok: false, reason: 'card e list são obrigatórios' };
      }
      const r = await moveCard(
        cardHint,
        targetList,
        args.board ? String(args.board) : undefined,
      );
      if (!r.ok) return { ok: false, reason: r.reason };
      return {
        ok: true,
        text: `Movi "${r.card.name}" para "${r.list.name}".`,
        meta: { cardId: r.card.id, listId: r.list.id },
      };
    }

    case 'trello_archive_card': {
      if (!isTrelloAvailable()) {
        return { ok: false, reason: 'TRELLO_API_KEY/TRELLO_TOKEN não configurados' };
      }
      const cardHint = String(args.card ?? '').trim();
      if (!cardHint) return { ok: false, reason: 'card vazio' };
      const cr = await resolveCard(
        cardHint,
        args.board ? String(args.board) : undefined,
      );
      if (!cr.card) return { ok: false, reason: cr.reason ?? 'card não encontrado' };
      const updated = await archiveCard(cr.card.id);
      if (!updated) return { ok: false, reason: 'falhou ao arquivar card' };
      return {
        ok: true,
        text: `Arquivei "${updated.name}".`,
        meta: { cardId: updated.id },
      };
    }

    case 'trello_unarchive_card': {
      if (!isTrelloAvailable()) {
        return { ok: false, reason: 'TRELLO_API_KEY/TRELLO_TOKEN não configurados' };
      }
      const cardHint = String(args.card ?? '').trim();
      if (!cardHint) return { ok: false, reason: 'card vazio' };
      // Card arquivado normalmente não aparece em listCardsInBoard; aceitar só ID direto.
      const direct = await getCard(cardHint);
      if (!direct) return { ok: false, reason: 'card não encontrado (passe o ID)' };
      const lockedBoard = await getLockedBoard();
      if (!lockedBoard) {
        return { ok: false, reason: 'board permitido não encontrado' };
      }
      if (direct.idBoard !== lockedBoard.id) {
        return {
          ok: false,
          reason: `card não pertence ao board "${lockedBoard.name}" (acesso restrito)`,
        };
      }
      const updated = await unarchiveCard(direct.id);
      if (!updated) return { ok: false, reason: 'falhou ao desarquivar card' };
      return {
        ok: true,
        text: `Desarquivei "${updated.name}".`,
        meta: { cardId: updated.id },
      };
    }

    case 'trello_add_comment': {
      if (!isTrelloAvailable()) {
        return { ok: false, reason: 'TRELLO_API_KEY/TRELLO_TOKEN não configurados' };
      }
      const cardHint = String(args.card ?? '').trim();
      const text = String(args.text ?? '').trim();
      if (!cardHint) return { ok: false, reason: 'card vazio' };
      if (!text) return { ok: false, reason: 'text vazio' };
      const cr = await resolveCard(
        cardHint,
        args.board ? String(args.board) : undefined,
      );
      if (!cr.card) return { ok: false, reason: cr.reason ?? 'card não encontrado' };
      const r = await addCommentToCard(cr.card.id, text);
      if (!r.ok) return { ok: false, reason: r.reason };
      return {
        ok: true,
        text: `Comentei em "${cr.card.name}".`,
        meta: { cardId: cr.card.id },
      };
    }

    case 'trello_add_label':
    case 'trello_remove_label': {
      if (!isTrelloAvailable()) {
        return { ok: false, reason: 'TRELLO_API_KEY/TRELLO_TOKEN não configurados' };
      }
      const cardHint = String(args.card ?? '').trim();
      const labelHint = String(args.label ?? '').trim();
      if (!cardHint || !labelHint) {
        return { ok: false, reason: 'card e label são obrigatórios' };
      }
      const boardHint = args.board ? String(args.board) : undefined;
      const action =
        name === 'trello_add_label' ? addLabelToCard : removeLabelFromCard;
      const r = await action(cardHint, labelHint, boardHint);
      if (!r.ok) return { ok: false, reason: r.reason };
      const verb = name === 'trello_add_label' ? 'adicionei' : 'removi';
      return {
        ok: true,
        text: `${verb[0].toUpperCase()}${verb.slice(1)} a etiqueta "${r.label.name}".`,
        meta: { labelId: r.label.id },
      };
    }

    case 'trello_add_checklist': {
      if (!isTrelloAvailable()) {
        return { ok: false, reason: 'TRELLO_API_KEY/TRELLO_TOKEN não configurados' };
      }
      const cardHint = String(args.card ?? '').trim();
      const checklistName = String(args.name ?? '').trim();
      if (!cardHint) return { ok: false, reason: 'card vazio' };
      if (!checklistName) return { ok: false, reason: 'name vazio' };
      const items = Array.isArray(args.items)
        ? args.items.map((i) => String(i)).filter(Boolean)
        : [];
      const cr = await resolveCard(
        cardHint,
        args.board ? String(args.board) : undefined,
      );
      if (!cr.card) return { ok: false, reason: cr.reason ?? 'card não encontrado' };
      const r = await addChecklist(cr.card.id, checklistName, items);
      if (!r.ok) return { ok: false, reason: r.reason };
      return {
        ok: true,
        text:
          items.length > 0
            ? `Criei checklist "${checklistName}" em "${cr.card.name}" com ${items.length} item(s).`
            : `Criei checklist "${checklistName}" em "${cr.card.name}".`,
        meta: { checklistId: r.checklist.id, cardId: cr.card.id },
      };
    }

    case 'trello_check_item':
    case 'trello_uncheck_item': {
      if (!isTrelloAvailable()) {
        return { ok: false, reason: 'TRELLO_API_KEY/TRELLO_TOKEN não configurados' };
      }
      const cardHint = String(args.card ?? '').trim();
      const itemHint = String(args.item ?? '').trim();
      if (!cardHint || !itemHint) {
        return { ok: false, reason: 'card e item são obrigatórios' };
      }
      const cr = await resolveCard(
        cardHint,
        args.board ? String(args.board) : undefined,
      );
      if (!cr.card) return { ok: false, reason: cr.reason ?? 'card não encontrado' };
      const complete = name === 'trello_check_item';
      const r = await checkChecklistItem(cr.card.id, itemHint, complete);
      if (!r.ok) return { ok: false, reason: r.reason };
      return {
        ok: true,
        text: complete
          ? `Marquei "${r.item.name}" como concluído.`
          : `Desmarquei "${r.item.name}".`,
        meta: { itemId: r.item.id },
      };
    }

    default:
      return null;
  }
}

export const INTEGRATION_NAMES = new Set<string>([
  'weather',
  'play_youtube',
  'clickup_tasks_in_progress',
  'clickup_tasks_high_priority',
  'clickup_explain_task',
  'email_check_now',
  'email_backfill',
  'email_search',
  'email_recent_important',
  'email_mark_important',
  'email_mark_not_important',
  'instagram_profile',
  'instagram_latest_posts',
  'instagram_post_insights',
  'morning_briefing',
  'check_clickup_notifications',
  'list_work_logs',
  'read_work_log',
  'web_search',
  'start_work',
  'end_work',
  'current_work_status',
  'pause_current_work',
  'interrupt_current_work',
  'create_study_plan',
  'list_study_plans',
  'study_plan_status',
  'study_plan_next',
  'study_plan_another_video',
  'mark_study_topic',
  'summarize_youtube',
  'search_memory',
  'search_worklogs',
  'trello_list_lists',
  'trello_list_labels',
  'trello_list_cards',
  'trello_get_card',
  'trello_create_card',
  'trello_update_card',
  'trello_move_card',
  'trello_archive_card',
  'trello_unarchive_card',
  'trello_add_comment',
  'trello_add_label',
  'trello_remove_label',
  'trello_add_checklist',
  'trello_check_item',
  'trello_uncheck_item',
]);
