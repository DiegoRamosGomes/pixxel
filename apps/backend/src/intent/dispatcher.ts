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

export const SYSTEM_PROMPT = `Você é um assistente pessoal estilo Pixxel em português do Brasil.

Para todo input do usuário, escolha UM dos dois formatos de resposta:

1. **Comando JSON** — quando o pedido for uma AÇÃO clara (abrir programa, abrir site, pesquisar na web, ver clima, tocar música/vídeo, controlar mídia). A resposta DEVE ser APENAS o JSON, NADA mais. NÃO escreva nada antes do '{' — nem "Sim, vou pausar.", nem "Claro!", nem confirmação de qualquer tipo. Sua mensagem inteira deve começar com '{' e terminar com '}'. Esquema:
   - {"action":"open_app","name":"<nome do executável local, ex: spotify, code, firefox>"} — APENAS pra programas instalados localmente.
   - {"action":"open_url","url":"<https://...>"} — pra qualquer SaaS/site web (ClickUp, Notion, Linear, Jira, Slack, Trello, etc.). Se o usuário pedir pra abrir um produto que normalmente é acessado via navegador, use open_url com a URL oficial mesmo que ele tenha dito "abre o X pra mim".
   - {"action":"web_search","query":"<o que pesquisar>"}
   - {"action":"media_control","op":"pause"|"play"|"play_pause"|"next"|"previous"|"stop"} — controla a música/vídeo que está tocando (no Spotify, YouTube no navegador, etc). Use "pause" pra "pausa/para", "play" pra "continua/retoma", "next" pra "próxima/pula", "previous" pra "anterior/volta".
   - {"action":"weather","when":"today"}  ou  {"action":"weather","when":"tomorrow"}
   - {"action":"play_youtube","query":"<o que tocar/assistir>","prefer":"top"|"latest"|"first"}
     • prefer="top": pra músicas em geral, clássicos, "tocar X" (escolhe o vídeo mais visto da busca).
     • prefer="latest": quando o usuário disser "último episódio", "mais recente", "novo", "atual", "de hoje". IMPORTANTE: a query deve ser SÓ o nome do canal/programa/assunto. NÃO inclua palavras como "último", "último episódio", "mais recente", "novo" — o filtro \`prefer="latest"\` já faz isso. Ex: usuário diz "último episódio do masterchef brasil" → query="masterchef brasil", prefer="latest".
     • prefer="first": quando o usuário disser "primeiro resultado" ou for ambíguo e você quer deixar o YouTube ranquear.
   - {"action":"clickup_tasks_in_progress"} — quando o usuário perguntar o que está em desenvolvimento, em andamento, em progresso ("o que estou fazendo?", "minhas tasks em andamento", "o que tô desenvolvendo").
   - {"action":"clickup_tasks_high_priority"} — quando perguntar por tasks urgentes/prioritárias ("o que é prioridade alta", "tasks urgentes", "o mais importante").
   - {"action":"clickup_explain_task","taskId":"<id>"} — quando pedir resumo/explicação/ajuda sobre uma task específica. Reconheça variações: "me explica a task X", "resumo da task X", "do que se trata a X", "me ajuda com a task X", "como tá a X", "o que é a X", "o que precisa fazer na X". O taskId pode vir como hash alfanumérico (ex: 868abc12), custom_id completo (ex: DEV-6074) ou só o número (ex: 6074) — o backend lida com todos os formatos. Mande no taskId EXATAMENTE o que o usuário falou.

2. **Texto livre** — para perguntas, conversa, explicações. NÃO comece com '{' nesse caso.

REGRAS GERAIS DE TOM (a resposta SEMPRE vai ser falada em voz alta por TTS):
- Texto corrido SEMPRE. ZERO bullets, ZERO listas, ZERO asteriscos, ZERO markdown.
- ZERO labels com dois pontos no começo de bloco (não escreva "Sobre:", "Status:", "Tarefa:", etc).
- Encadeie com palavras de transição naturais ("a task trata de...", "pra fazer isso, precisa...", "pra testar, é só...").
- Seja MUITO direto. Mínimo de palavras possível. Uma frase costuma ser o ideal, no máximo duas ou três.
- NÃO repita o que o usuário disse. Não recapitule a pergunta.
- NÃO liste opções a menos que o usuário peça explicitamente — e mesmo assim, escreva "primeiro X, depois Y, e por último Z" em texto corrido, sem bullets.
- Fale como gente fala numa conversa. Se você sentir vontade de quebrar em tópicos, NÃO QUEBRE — junte tudo em parágrafo.

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
  /** Emite uma mensagem de chat completa e isolada (novo messageId).
   *  Usar pra "frases de apoio" antes de outcome do tipo command. */
  emitSupportMessage: (text: string, model: string) => void;
};

function spokenLabelFor(cmd: ClientCommand): string {
  switch (cmd.action) {
    case 'open_app':
      return `Abrindo ${cmd.name}.`;
    case 'open_url':
      return `Abrindo ${cmd.url}.`;
    case 'web_search':
      return `Pesquisando ${cmd.query}.`;
    case 'media_control':
      switch (cmd.op) {
        case 'pause':
          return 'Pausando.';
        case 'play':
          return 'Tocando.';
        case 'play_pause':
          return 'Pausa-toca.';
        case 'stop':
          return 'Parando.';
        case 'next':
          return 'Próxima.';
        case 'previous':
          return 'Anterior.';
      }
  }
}

const SUPPORT_PHRASES: Record<string, string[]> = {
  clickup_explain_task: [
    'Tá, deixa eu ver ela aqui. ',
    'Beleza, abrindo aqui. ',
    'Hmm, vou olhar. ',
  ],
  weather: [
    'Deixa eu checar. ',
    'Olhando aqui. ',
  ],
  clickup_tasks_in_progress: [
    'Olhando suas tasks. ',
    'Vendo aqui. ',
  ],
  clickup_tasks_high_priority: [
    'Vendo o que é urgente. ',
    'Olhando as prioridades. ',
  ],
  play_youtube: [
    'Procurando. ',
    'Achando aqui. ',
  ],
};

function pickSupport(action: string): string | null {
  const opts = SUPPORT_PHRASES[action];
  if (!opts) return null;
  return opts[Math.floor(Math.random() * opts.length)];
}

/** Procura um JSON com `action` num texto e tenta parsear. */
function tryRecoverJsonFromText(text: string): unknown {
  const start = text.search(/\{\s*["']?action["']?/);
  if (start < 0) return null;
  // Tenta achar o `}` correspondente — assume JSON simples sem aninhamento.
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
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
  // Texto pendente em modo 'text' que ainda não foi emitido pro cliente,
  // pra dar tempo de detectar um JSON com action vindo no meio do stream
  // (caso o LLM prefixe o JSON com texto livre).
  let pendingText = '';
  const TAIL_LEN = 25;
  const JSON_ACTION_RE = /\{\s*["']?action["']?\s*:/;
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
          pendingText = buffer;
          buffer = '';
        }
        return;
      }
      if (state.mode === 'text') {
        pendingText += delta;
        // Detecta JSON com action aparecendo no meio do texto livre.
        const m = pendingText.match(JSON_ACTION_RE);
        if (m && m.index !== undefined) {
          const before = pendingText.slice(0, m.index);
          if (before) cb.onChatDelta(before);
          buffer = pendingText.slice(m.index);
          pendingText = '';
          state.mode = 'json';
          return;
        }
        // Sem JSON detectado — emite tudo menos os últimos TAIL_LEN chars
        // (segura pra detectar JSON dividido entre chunks).
        if (pendingText.length > TAIL_LEN) {
          const toEmit = pendingText.slice(0, -TAIL_LEN);
          cb.onChatDelta(toEmit);
          pendingText = pendingText.slice(-TAIL_LEN);
        }
      } else {
        buffer += delta;
      }
    },
  });

  // Drena o tail pendente (caso modo continuou 'text' até o fim).
  if (state.mode === 'text' && pendingText) {
    // Última chance: se há JSON no que sobrou, ainda dá pra interceptar.
    const m = pendingText.match(JSON_ACTION_RE);
    if (m && m.index !== undefined) {
      const before = pendingText.slice(0, m.index);
      if (before) cb.onChatDelta(before);
      buffer = pendingText.slice(m.index);
      pendingText = '';
      state.mode = 'json';
    } else {
      cb.onChatDelta(pendingText);
      pendingText = '';
    }
  }

  if (state.mode === 'text') {
    // Defesa final: o LLM pode ter colado um JSON parseável dentro do texto.
    // Tenta extrair e processar como command. Se conseguir, a resposta vira
    // command (mesmo que parte do texto livre antes já tenha sido falada).
    const recovered = tryRecoverJsonFromText(result.fullText);
    if (recovered) {
      const recIntent = AnyIntentSchema.safeParse(recovered);
      if (recIntent.success && isClientCommand(recIntent.data)) {
        logger.info(
          { recovered: recIntent.data },
          'recovered command from text-mode response',
        );
        return {
          kind: 'command',
          command: recIntent.data,
          spokenLabel: spokenLabelFor(recIntent.data),
          source: 'llm',
        };
      }
    }
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
    // O LLM começou a resposta com '{' mas o JSON quebrou no meio. Não
    // devolver isso cru pro TTS — emite mensagem amigável.
    logger.warn({ raw, err }, 'failed to parse llm json output');
    const msg = 'Tive um problema entendendo o pedido. Pode tentar de novo?';
    startChatOnce(result.model);
    cb.onChatDelta(msg);
    return { kind: 'chat', fullText: msg, model: result.model };
  }

  const intent = AnyIntentSchema.safeParse(parsed);
  if (!intent.success) {
    // LLM emitiu um JSON com `action` que não existe no schema — comando
    // ainda não implementado. Não devolver o JSON cru pro TTS; emitir uma
    // mensagem amigável e logar a action tentada pra a gente adicionar
    // depois.
    const attempted =
      typeof parsed === 'object' && parsed !== null && 'action' in parsed
        ? String((parsed as { action?: unknown }).action ?? '')
        : '';
    logger.warn(
      { attemptedAction: attempted, parsed, error: intent.error },
      'llm tried action not in schema',
    );

    const replies = attempted
      ? [
          `Ainda não sei fazer essa, é "${attempted}". Quer que eu implemente?`,
          `Esse comando "${attempted}" ainda não existe. Posso adicionar se quiser.`,
          `Não tenho "${attempted}" ainda. Dá pra implementar.`,
        ]
      : ['Não entendi direito. Pode reformular?'];
    const msg = replies[Math.floor(Math.random() * replies.length)];
    startChatOnce(result.model);
    cb.onChatDelta(msg);
    return { kind: 'chat', fullText: msg, model: result.model };
  }

  if (intent.data.action === 'weather') {
    const supportWeather = pickSupport('weather');
    if (supportWeather) {
      startChatOnce(result.model);
      cb.onChatDelta(supportWeather);
    }
    const text = await fetchWeatherText(intent.data.when);
    startChatOnce(result.model);
    cb.onChatDelta(text);
    return {
      kind: 'chat',
      fullText: (supportWeather ?? '') + text,
      model: result.model,
    };
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

    // Frase de apoio enquanto faz a chamada à API
    const support = pickSupport(intent.data.action);
    if (support) {
      startChatOnce(result.model);
      cb.onChatDelta(support);
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

    // Frase de apoio antes de buscar a task (3 chamadas + LLM = ~3-5s)
    const supportExplain = pickSupport('clickup_explain_task');
    if (supportExplain) {
      startChatOnce(result.model);
      cb.onChatDelta(supportExplain);
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
      'Resuma a task abaixo em pt-BR, em texto corrido, num único parágrafo curto pensado pra ser FALADO em voz alta numa conversa.',
      '',
      'Cubra naturalmente, encadeado em frases:',
      '1. O que a task trata (contexto, em 1 frase).',
      '2. O que precisa ser feito (em 1-2 frases).',
      '3. Como testar (em 1 frase) — APENAS se houver informação clara sobre isso na descrição ou comentários.',
      '',
      'Termine SEMPRE com uma pergunta curta convidando a continuar a conversa, como: "Algo mais que você quer saber?", "Quer que eu explique alguma parte?", "Posso te ajudar em mais alguma coisa nessa?".',
      '',
      'REGRAS RÍGIDAS:',
      '- ZERO bullets, ZERO listas, ZERO asteriscos, ZERO labels com dois pontos.',
      '- Encadeie com transições naturais: "essa task trata de...", "pra resolver, precisa...", "pra testar, é só...".',
      '- Se faltar informação sobre algum ponto, OMITA silenciosamente — nunca diga "não tem informação".',
      '- Total: 3 a 5 frases curtas + a pergunta final.',
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
    const supportYt = pickSupport('play_youtube');
    if (supportYt) cb.emitSupportMessage(supportYt, result.model);
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
