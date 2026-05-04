import { shell } from 'electron';
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
import { lookAtCamera } from './vision.js';
import { search as semanticSearch } from './embeddings.js';
import {
  clickMouse,
  doubleClickMouse,
  keyPress,
  moveMouse,
  typeText,
} from './desktop-control.js';
import { buildMorningBriefing } from './briefing.js';
import { openProject } from './projects.js';
import { listWorkLogs, readWorkLog } from './work-log-view.js';
import { isWebSearchAvailable, searchWeb, formatSearchForVoice } from './web-search.js';
import {
  getStudyPlanStore,
  type TopicStatus,
} from './study-plans.js';
import { getActiveWorkStore, formatRelativeAge, type WorkEntry } from './active-work.js';

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
import { getStorageStatus } from './storage.js';
import { restartWifi } from '../wifi.js';
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
import type { Widget } from '../../shared/widgets.js';

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
      try {
        await shell.openExternal(result.url);
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : 'falhou ao abrir',
        };
      }
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
        meta: { videoId: result.videoId, url: result.url },
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

    case 'restart_wifi': {
      const r = await restartWifi();
      if (!r.ok) return { ok: false, reason: r.reason };
      const text = r.ssid
        ? `WiFi reiniciado, conectado em ${r.ssid}${r.signal != null ? ` (sinal ${r.signal}%)` : ''}.`
        : 'WiFi reiniciado, mas ainda não reconectou — pode levar mais alguns segundos.';
      return { ok: true, text };
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

    case 'open_project': {
      const query = String(args.query ?? '').trim();
      if (!query) return { ok: false, reason: 'query vazia' };
      const r = await openProject(query);
      if (r.ok) {
        // Inclui o path no meta pra o main marcar este como projeto ativo
        // do claude_code_task (Gemini delega edições no projeto recém-aberto).
        return {
          ok: true,
          text: r.text,
          meta: { projectPath: r.project.path, projectName: r.project.name },
        };
      }
      // Sem match — devolve alternativas no `text` pra Gemini ler/escolher
      const alts = r.alternatives ?? [];
      const altText = alts.length
        ? ` Projetos disponíveis: ${alts.map((a) => a.name).join(', ')}.`
        : '';
      return { ok: false, reason: r.reason + altText };
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
          try {
            await shell.openExternal(yt.url);
          } catch (err) {
            console.warn('[study-plan] falha ao abrir vídeo:', err);
          }
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
        try {
          await shell.openExternal(cur.topic.videoUrl);
        } catch (err) {
          console.warn('[study-plan] falha ao abrir vídeo salvo:', err);
        }
        videoLine = ` Reabri o vídeo: "${cur.topic.videoTitle ?? 'vídeo salvo'}".`;
      }
      const text =
        `Próximo tópico do plano "${plan.topic}" (${plan.owner}): ` +
        `${cur.topic.title}. Faz parte do módulo "${cur.module.title}". ` +
        `Objetivo do módulo: ${cur.module.objective}.` +
        videoLine +
        ` Diga "terminei" quando concluir, ou peça pra pular.`;
      return { ok: true, text, widget, meta: { planId: plan.planId, topicId: cur.topic.id } };
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
      try {
        await shell.openExternal(next.url);
      } catch (err) {
        console.warn('[study-plan] falha ao abrir vídeo alternativo:', err);
      }
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
        meta: { planId: plan.planId, topicId: target.topic.id, videoUrl: next.url },
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

    case 'desktop_mouse': {
      const x = Number(args.x ?? 0);
      const y = Number(args.y ?? 0);
      const unit = (args.unit as 'pixel' | 'percent' | undefined) ?? 'pixel';
      const action = (args.action as string | undefined) ?? 'move';
      try {
        await moveMouse(x, y, unit);
        if (action === 'click') await clickMouse(1);
        else if (action === 'right_click') await clickMouse(3);
        else if (action === 'double_click') await doubleClickMouse();
        return { ok: true, text: `Mouse: ${action} em ${x},${y} (${unit}).` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: `xdotool falhou: ${msg}` };
      }
    }

    case 'desktop_type': {
      const text = String(args.text ?? '');
      if (!text) return { ok: false, reason: 'text vazio' };
      try {
        await typeText(text);
        return { ok: true, text: `Digitei.` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: `xdotool falhou: ${msg}` };
      }
    }

    case 'desktop_key': {
      const combo = String(args.combo ?? '').trim();
      if (!combo) return { ok: false, reason: 'combo vazio' };
      try {
        await keyPress(combo);
        return { ok: true, text: `Tecla: ${combo}.` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: `xdotool falhou: ${msg}` };
      }
    }

    case 'look_at_camera': {
      const question = String(args.question ?? '').trim();
      const r = await lookAtCamera(question);
      if (!r.ok) return { ok: false, reason: r.reason };
      return { ok: true, text: r.text };
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
          const kindLabel = cur.kind === 'code' ? 'tarefa de código' : 'sessão';
          return {
            ok: false,
            reason: 'session_open',
            text:
              `[Conflito] Já tem uma ${kindLabel} aberta: "${cur.description}" ` +
              `(${age}). Pergunte ao usuário em primeira pessoa se quer pausar ` +
              `(salva o estado pra retomar depois) ou interromper (descarta) ` +
              `a atual antes de começar a nova "${description}". Quando ele ` +
              `responder, chame pause_current_work ou interrupt_current_work, ` +
              `e DEPOIS chame start_work de novo. NUNCA mencione "Claude" — ` +
              `é tudo VOCÊ trabalhando.`,
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

    case 'storage_status': {
      const mount = args.mount ? String(args.mount) : '/';
      try {
        const r = await getStorageStatus(mount);
        const widget: Widget | undefined =
          r.disks.length > 0
            ? {
                kind: 'storage',
                scope: mount === 'all' ? 'all' : 'single',
                disks: r.disks.map((d) => ({
                  mount: d.mount,
                  fstype: d.fstype,
                  totalBytes: d.totalBytes,
                  usedBytes: d.usedBytes,
                  availBytes: d.availBytes,
                  usedPercent: d.usedPercent,
                })),
              }
            : undefined;
        return { ok: true, text: r.text, widget, meta: { disks: r.disks } };
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : 'falhou ao ler df',
        };
      }
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
        const kindLabel = cur.kind === 'code' ? 'tarefa de código' : 'sessão';
        const lastStepInfo = cur.lastStep ? ` Última ação: ${cur.lastStep}.` : '';
        parts.push(
          `Em andamento — ${kindLabel}: "${cur.description}"${projectInfo}, ` +
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
  'restart_wifi',
  'email_check_now',
  'email_backfill',
  'email_search',
  'email_recent_important',
  'email_mark_important',
  'email_mark_not_important',
  'instagram_profile',
  'instagram_latest_posts',
  'instagram_post_insights',
  'open_project',
  'morning_briefing',
  'list_work_logs',
  'read_work_log',
  'web_search',
  'start_work',
  'end_work',
  'current_work_status',
  'pause_current_work',
  'interrupt_current_work',
  'storage_status',
  'create_study_plan',
  'list_study_plans',
  'study_plan_status',
  'study_plan_next',
  'study_plan_another_video',
  'mark_study_topic',
  'summarize_youtube',
  'look_at_camera',
  'search_memory',
  'search_worklogs',
  'desktop_mouse',
  'desktop_type',
  'desktop_key',
]);
