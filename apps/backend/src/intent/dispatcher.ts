import { AnyIntentSchema, type ClientCommand, isClientCommand } from '@assistant/shared';
import { streamChat, type ChatMessage } from '../llm/client.js';
import { logger } from '../logger.js';
import { tryRegexMatch } from './regex.js';
import { fetchWeatherText } from './weather.js';
import { resolveYoutubeQuery, resolveYoutubeSearch } from './youtube.js';
import {
  buildTaskBriefing,
  formatTasksList,
  getTaskDetails,
  isClickupAvailable,
  listMyHighPriorityTasks,
  listMyInProgressTasks,
} from './clickup.js';

export const SYSTEM_PROMPT = `Você é um assistente pessoal estilo Jarvis em português do Brasil.

Para todo input do usuário, escolha UM dos dois formatos de resposta:

1. **Comando JSON** — quando o pedido for uma AÇÃO clara (abrir programa, abrir site, pesquisar na web, ver clima, tocar música/vídeo). Comece a resposta com '{' e produza apenas JSON válido, sem texto antes ou depois. Esquema:
   - {"action":"open_app","name":"<nome do executável local, ex: spotify, code, firefox>"} — APENAS pra programas instalados localmente.
   - {"action":"open_url","url":"<https://...>"} — pra qualquer SaaS/site web (ClickUp, Notion, Linear, Jira, Slack, Trello, etc.). Se o usuário pedir pra abrir um produto que normalmente é acessado via navegador, use open_url com a URL oficial mesmo que ele tenha dito "abre o X pra mim".
   - {"action":"web_search","query":"<o que pesquisar>"}
   - {"action":"weather","when":"today"}  ou  {"action":"weather","when":"tomorrow"}
   - {"action":"play_youtube","query":"<o que tocar/assistir>","prefer":"top"|"latest"|"first"}
     • prefer="top": pra músicas em geral, clássicos, "tocar X" (escolhe o vídeo mais visto da busca).
     • prefer="latest": quando o usuário disser "último episódio", "mais recente", "novo", "atual", "de hoje". IMPORTANTE: a query deve ser SÓ o nome do canal/programa/assunto. NÃO inclua palavras como "último", "último episódio", "mais recente", "novo" — o filtro \`prefer="latest"\` já faz isso. Ex: usuário diz "último episódio do masterchef brasil" → query="masterchef brasil", prefer="latest".
     • prefer="first": quando o usuário disser "primeiro resultado" ou for ambíguo e você quer deixar o YouTube ranquear.
   - {"action":"clickup_tasks_in_progress"} — quando o usuário perguntar o que está em desenvolvimento, em andamento, em progresso ("o que estou fazendo?", "minhas tasks em andamento", "o que tô desenvolvendo").
   - {"action":"clickup_tasks_high_priority"} — quando perguntar por tasks urgentes/prioritárias ("o que é prioridade alta", "tasks urgentes", "o mais importante").
   - {"action":"clickup_explain_task","taskId":"<id>"} — quando pedir resumo/explicação/ajuda sobre uma task específica. Reconheça variações: "me explica a task X", "resumo da task X", "do que se trata a X", "me ajuda com a task X", "como tá a X", "o que é a X", "o que precisa fazer na X". O taskId pode vir como hash alfanumérico (ex: 868abc12), custom_id completo (ex: DEV-6074) ou só o número (ex: 6074) — o backend lida com todos os formatos. Mande no taskId EXATAMENTE o que o usuário falou.

2. **Texto livre** — para perguntas, conversa, explicações. NÃO comece com '{' nesse caso.

REGRAS GERAIS DE TOM:
- Seja MUITO direto. Mínimo de palavras possível.
- Uma frase costuma ser o ideal. No máximo duas.
- NÃO repita o que o usuário disse. Não recapitule a pergunta.
- NÃO liste opções a menos que o usuário peça explicitamente.
- NÃO use markdown pesado, listas, asteriscos.
- Imagine que a resposta vai ser falada em voz alta — fale como gente fala.

Nunca misture os dois formatos. Nunca explique a escolha — apenas responda.

Regras especiais para MÚSICA e VÍDEO no YouTube:
- Use SEMPRE play_youtube (não open_url) pra tocar música ou assistir vídeo no YouTube.
- Se o usuário pedir pra tocar música SEM especificar qual, responda em texto livre com APENAS a pergunta direta. Ex: "Qual música você quer ouvir?". Nada mais.
- Se o usuário pedir pra você escolher, escolha um clássico de rock antigo (ex: Black Sabbath Iron Man, Led Zeppelin Whole Lotta Love, Pink Floyd Time, Queen Bohemian Rhapsody, AC/DC Back in Black) OU eletrônica (ex: Daft Punk One More Time, Justice D.A.N.C.E., Fred again Marea) e emita play_youtube com prefer="top".
- "Último episódio de X", "X mais recente" → prefer="latest".`;

export type DispatchOutcome =
  | { kind: 'command'; command: ClientCommand; spokenLabel: string; source: 'regex' | 'llm' }
  | { kind: 'chat'; fullText: string; model: string };

export type DispatchCallbacks = {
  onChatStart: (model: string) => void;
  onChatDelta: (delta: string) => void;
};

function spokenLabelFor(cmd: ClientCommand): string {
  switch (cmd.action) {
    case 'open_app':
      return `Abrindo ${cmd.name}.`;
    case 'open_url':
      return `Abrindo ${cmd.url}.`;
    case 'web_search':
      return `Pesquisando ${cmd.query}.`;
  }
}

export async function dispatch(
  messages: ChatMessage[],
  userText: string,
  cb: DispatchCallbacks,
): Promise<DispatchOutcome> {
  const hit = tryRegexMatch(userText);
  if (hit) {
    logger.info({ command: hit.command }, 'dispatch via regex');
    return {
      kind: 'command',
      command: hit.command,
      spokenLabel: hit.spokenLabel,
      source: 'regex',
    };
  }

  type Mode = 'unknown' | 'json' | 'text';
  let model = '';
  let buffer = '';
  const state = { mode: 'unknown' as Mode, chatStarted: false };

  const startChatOnce = (m: string): void => {
    if (state.chatStarted) return;
    state.chatStarted = true;
    cb.onChatStart(m);
  };

  const result = await streamChat(messages, {
    onStart: (m) => {
      model = m;
    },
    onDelta: (delta) => {
      if (state.mode === 'unknown') {
        buffer += delta;
        const trimmed = buffer.replace(/^\s+/, '');
        if (trimmed.length === 0) return;
        if (trimmed.startsWith('{')) {
          state.mode = 'json';
        } else {
          state.mode = 'text';
          startChatOnce(model);
          cb.onChatDelta(buffer);
          buffer = '';
        }
        return;
      }
      if (state.mode === 'text') {
        cb.onChatDelta(delta);
      } else {
        buffer += delta;
      }
    },
  });

  if (state.mode === 'text') {
    return { kind: 'chat', fullText: result.fullText, model: result.model };
  }

  // state.mode === 'json' (ou 'unknown' com buffer vazio)
  const raw = (state.mode === 'unknown' ? result.fullText : buffer).trim();
  if (!raw) {
    startChatOnce(result.model);
    return { kind: 'chat', fullText: '', model: result.model };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn({ raw, err }, 'failed to parse llm json output, treating as chat');
    startChatOnce(result.model);
    cb.onChatDelta(raw);
    return { kind: 'chat', fullText: raw, model: result.model };
  }

  const intent = AnyIntentSchema.safeParse(parsed);
  if (!intent.success) {
    logger.warn({ parsed, error: intent.error }, 'llm json failed schema validation');
    startChatOnce(result.model);
    cb.onChatDelta(raw);
    return { kind: 'chat', fullText: raw, model: result.model };
  }

  if (intent.data.action === 'weather') {
    const text = await fetchWeatherText(intent.data.when);
    startChatOnce(result.model);
    cb.onChatDelta(text);
    return { kind: 'chat', fullText: text, model: result.model };
  }

  if (
    intent.data.action === 'clickup_tasks_in_progress' ||
    intent.data.action === 'clickup_tasks_high_priority'
  ) {
    if (!isClickupAvailable()) {
      const msg = 'A integração com o ClickUp não está configurada.';
      startChatOnce(result.model);
      cb.onChatDelta(msg);
      return { kind: 'chat', fullText: msg, model: result.model };
    }

    const tasks =
      intent.data.action === 'clickup_tasks_in_progress'
        ? await listMyInProgressTasks()
        : await listMyHighPriorityTasks();

    if (tasks === null) {
      const msg = 'Não consegui falar com o ClickUp agora.';
      startChatOnce(result.model);
      cb.onChatDelta(msg);
      return { kind: 'chat', fullText: msg, model: result.model };
    }

    const emptyMsg =
      intent.data.action === 'clickup_tasks_in_progress'
        ? 'Você não tem nada em desenvolvimento agora.'
        : 'Você não tem tasks de prioridade alta ou urgente.';
    const text = formatTasksList(tasks, emptyMsg);
    startChatOnce(result.model);
    cb.onChatDelta(text);
    return { kind: 'chat', fullText: text, model: result.model };
  }

  if (intent.data.action === 'clickup_explain_task') {
    if (!isClickupAvailable()) {
      const msg = 'A integração com o ClickUp não está configurada.';
      startChatOnce(result.model);
      cb.onChatDelta(msg);
      return { kind: 'chat', fullText: msg, model: result.model };
    }

    const details = await getTaskDetails(intent.data.taskId);
    if (!details) {
      const msg = `Não achei a task ${intent.data.taskId}.`;
      startChatOnce(result.model);
      cb.onChatDelta(msg);
      return { kind: 'chat', fullText: msg, model: result.model };
    }

    const briefing = buildTaskBriefing(details.task, details.comments);
    const summarizePrompt = [
      'Resuma a task abaixo em três blocos curtos, em pt-BR, sem markdown:',
      '',
      'Sobre: <o que é a task em 1-2 frases>',
      'Fazer: <o que precisa ser feito em 1-3 bullets bem curtos>',
      'Testar: <como testar em 1-3 bullets bem curtos>',
      '',
      'Se algum bloco não tiver informação, escreva "Não tem informação suficiente."',
      '',
      'TASK:',
      briefing,
    ].join('\n');

    startChatOnce(result.model);

    let summary = '';
    const summarized = await streamChat(
      [{ role: 'user', content: summarizePrompt }],
      {
        onStart: () => {},
        onDelta: (d) => {
          summary += d;
          cb.onChatDelta(d);
        },
      },
    );
    return { kind: 'chat', fullText: summary, model: summarized.model };
  }

  if (intent.data.action === 'play_youtube') {
    const url = await resolveYoutubeQuery(intent.data.query, intent.data.prefer);
    const cmd: ClientCommand = { action: 'open_url', url };
    return {
      kind: 'command',
      command: cmd,
      spokenLabel: `Tocando ${intent.data.query}.`,
      source: 'llm',
    };
  }

  if (isClientCommand(intent.data)) {
    let cmd = intent.data;
    // Resolve URL de busca do YouTube para vídeo direto antes de mandar pro cliente.
    if (cmd.action === 'open_url') {
      const resolved = await resolveYoutubeSearch(cmd.url);
      if (resolved !== cmd.url) {
        cmd = { ...cmd, url: resolved };
      }
    }
    return {
      kind: 'command',
      command: cmd,
      spokenLabel: spokenLabelFor(cmd),
      source: 'llm',
    };
  }

  startChatOnce(result.model);
  cb.onChatDelta(raw);
  return { kind: 'chat', fullText: raw, model: result.model };
}
