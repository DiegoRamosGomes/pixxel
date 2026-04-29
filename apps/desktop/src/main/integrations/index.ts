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
import { isYoutubeAvailable, resolveYoutube, type YoutubePrefer } from './youtube.js';
import type { Widget } from '../../shared/widgets.js';

export type IntegrationResult =
  | {
      ok: true;
      text: string;
      widget?: Widget;
      meta?: Record<string, unknown>;
    }
  | { ok: false; reason: string };

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
]);
