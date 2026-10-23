// Script de apresentação automática do Pixxel, conduzido pela API. Sequência
// fixa de "atos"; cada ato faz UMA dessas:
//   - narrate(text): fala via sessão de voz (diretiva pra falar literal)
//   - painéis/widgets: pede ao cliente pra abrir/fechar painel, mostra widget
//   - mouse/type/key: operações locais do cliente (desktop_mouse etc.)
//   - sleep(ms): pausa abortável
//
// Cancelamento: o Esc do cliente vira `presentation_abort` → cancelPresentation().

import type { LocalOp, LocalToolResult, Widget } from '@assistant/shared';
import { searchWeb, formatSearchForVoice } from '../integrations/web-search.js';
import { fetchWeather } from '../integrations/weather.js';

export type PresentationCtx = {
  say(text: string): void;
  local(op: LocalOp, args: Record<string, unknown>): Promise<LocalToolResult>;
  showWidget(widget: Widget, ttlMs: number): string;
  dismissWidget(id: string): void;
};

type Ctx = PresentationCtx;

type Step = {
  label: string;
  run: (ctx: Ctx) => Promise<void>;
};

let aborted = false;

function abortDemo(): void {
  aborted = true;
}

function resetAbort(): void {
  aborted = false;
}

function isAborted(): boolean {
  return aborted;
}

/** Sleep abortável — checa a flag a cada 100ms. */
async function sleep(ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (aborted) return;
    await new Promise((r) => setTimeout(r, Math.min(100, deadline - Date.now())));
  }
}

/** Operação local no cliente — não envia nada depois do cancelamento. */
async function local(ctx: Ctx, op: LocalOp, args: Record<string, unknown>): Promise<void> {
  if (isAborted()) return;
  await ctx.local(op, args);
}

const moveMouse = (ctx: Ctx, x: number, y: number): Promise<void> =>
  local(ctx, 'desktop_mouse', { x, y, unit: 'percent', action: 'move' });
const typeText = (ctx: Ctx, text: string): Promise<void> => local(ctx, 'desktop_type', { text });
const keyPress = (ctx: Ctx, combo: string): Promise<void> => local(ctx, 'desktop_key', { combo });
const panel = (ctx: Ctx, op: 'open_chat' | 'open_camera' | 'show_memory', open: boolean): Promise<void> =>
  local(ctx, op, { open });

async function narrate(ctx: Ctx, text: string): Promise<void> {
  if (isAborted()) return;
  // Diretiva clara pro modelo NÃO chamar tools, só falar exatamente isto.
  ctx.say(
    `[apresentação — fale exatamente este texto em pt-BR e NÃO chame ` +
      `nenhuma tool] ${text}`,
  );
  // Tempo aproximado pra Live falar — 70 chars/seg + overhead.
  const estMs = Math.max(2500, Math.round((text.length / 14) * 1000));
  await sleep(estMs);
}

async function narrateSearchSummary(
  ctx: Ctx,
  query: string,
  fallback: string,
): Promise<{ widgetId: string | null }> {
  if (isAborted()) return { widgetId: null };
  let formatted: string | null = null;
  let results: Array<{ title: string; url: string; content: string }> = [];
  let resolvedQuery = query;
  try {
    const r = await searchWeb(query);
    if (r.ok) {
      formatted = formatSearchForVoice(r);
      results = r.results;
      resolvedQuery = r.query;
    }
  } catch (err) {
    console.warn('[demo] searchWeb falhou:', err);
  }
  if (!formatted) {
    await narrate(ctx, fallback);
    return { widgetId: null };
  }

  // Emite o widget ANTES da fala pra aparecer junto com a narração.
  let widgetId: string | null = null;
  if (results.length > 0) {
    widgetId = ctx.showWidget(
      {
        kind: 'search-results',
        query: resolvedQuery,
        results: results.slice(0, 5).map((res) => ({
          title: res.title,
          url: res.url,
          snippet:
            res.content.length > 200 ? res.content.slice(0, 200) + '…' : res.content,
        })),
      },
      // TTL longo — fechamos manualmente no fim do ato pra controlar o tempo.
      60_000,
    );
  }

  ctx.say(
    `[apresentação — apresente esses resultados de pesquisa em pt-BR, em 2 ou ` +
      `3 frases naturais, citando 1 ou 2 fontes pelo NOME do título. NÃO ` +
      `chame nenhuma tool, só fale.]\n\n${formatted}`,
  );
  // Resposta de 2-3 frases ~ 8-12s; deixa folga.
  await sleep(11000);
  return { widgetId };
}

const SCRIPT: Step[] = [
  {
    label: 'reset',
    run: async (ctx) => {
      // Ponto zero — fecha qualquer painel aberto pra começar limpo.
      await panel(ctx, 'open_chat', false);
      await panel(ctx, 'open_camera', false);
      await panel(ctx, 'show_memory', false);
      await sleep(500);
    },
  },
  {
    label: 'intro',
    run: async (ctx) => {
      await narrate(
        ctx,
        'Oi! Eu sou o Pixxel, um assistente pessoal por voz feito em JavaScript. Posso conversar, pesquisar, te ver pela câmera, controlar mouse e teclado, e me lembrar do que você me conta. Vou te mostrar.',
      );
    },
  },
  {
    label: 'web_search',
    run: async (ctx) => {
      await narrate(
        ctx,
        'Primeiro, busca na internet. Vou pesquisar o que tá rolando em inteligência artificial agora e te trazer um resumo com as fontes.',
      );
      const { widgetId } = await narrateSearchSummary(
        ctx,
        'principais novidades em inteligência artificial em 2026',
        'Hoje a busca falhou, mas normalmente eu trago um resumo do que encontrei.',
      );
      // Fecha o widget no fim do ato — próximo passo começa limpo.
      if (widgetId) {
        ctx.dismissWidget(widgetId);
      }
    },
  },
  {
    label: 'camera',
    run: async (ctx) => {
      await narrate(
        ctx,
        'Também enxergo. Vou abrir a câmera — eu detecto rosto e objetos em tempo real e posso descrever o que vejo quando você pedir.',
      );
      await panel(ctx, 'open_camera', true);
      await sleep(5000);
      await panel(ctx, 'open_camera', false);
      await sleep(500);
    },
  },
  {
    label: 'chat_typing',
    run: async (ctx) => {
      await narrate(
        ctx,
        'Se você preferir, dá pra conversar comigo por texto também. Vou abrir o chat e digitar uma mensagem usando o controle de teclado.',
      );
      await panel(ctx, 'open_chat', true);
      // Espera o painel montar e o autoFocus pegar a textarea.
      await sleep(900);
      if (isAborted()) return;
      await typeText(ctx, 'Oi, sou o Pixxel — digitando isso pelo teclado.');
      await sleep(2500);
      await panel(ctx, 'open_chat', false);
      await sleep(500);
    },
  },
  {
    label: 'weather',
    run: async (ctx) => {
      await narrate(
        ctx,
        'Também trago informações úteis em widgets. Olha o clima de hoje, por exemplo.',
      );
      try {
        const w = await fetchWeather('today');
        if (w.widget) {
          ctx.showWidget(w.widget, 8000);
        }
        await narrate(ctx, w.text);
      } catch (err) {
        console.warn('[demo] weather falhou:', err);
        await narrate(ctx, 'Hoje o clima não respondeu, mas normalmente ele aparece aqui.');
      }
      await sleep(3500);
    },
  },
  {
    label: 'outro',
    run: async (ctx) => {
      await narrate(
        ctx,
        'É isso! Se quiser acompanhar a evolução do Pixxel, segue arroba a-i ponto pixxel em todas as redes — Instagram, TikTok, YouTube — e curte esse vídeo. Valeu!',
      );
    },
  },
];

let running = false;

export function isPresentationRunning(): boolean {
  return running;
}

export async function runPresentation(ctx: Ctx): Promise<{
  ok: boolean;
  reason?: string;
  completed: number;
}> {
  if (running) {
    return { ok: false, reason: 'apresentação já está rodando', completed: 0 };
  }
  running = true;
  resetAbort();
  let completed = 0;
  try {
    for (const step of SCRIPT) {
      if (isAborted()) break;
      console.log(`[presentation] step: ${step.label}`);
      await step.run(ctx);
      completed++;
    }
  } catch (err) {
    console.warn('[presentation] erro:', err);
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'erro desconhecido',
      completed,
    };
  } finally {
    running = false;
  }
  return { ok: true, completed };
}

export function cancelPresentation(): void {
  abortDemo();
}

// ===== Teste isolado de mouse e teclado =====
//
// Sequência curta (~25s) só pra validar que o cliente tá movendo o cursor e
// digitando. Movimento visível em cantos da tela + um typing demo. Esc
// cancela igual à apresentação principal.

const MOUSE_TEST: Step[] = [
  {
    label: 'mt_intro',
    run: async (ctx) => {
      await narrate(
        ctx,
        'Beleza, vou testar mouse e teclado. Observa o cursor — vou mover ele em volta da tela.',
      );
    },
  },
  {
    label: 'mt_center',
    run: async (ctx) => {
      await moveMouse(ctx, 50, 50);
      await sleep(800);
    },
  },
  {
    label: 'mt_corners',
    run: async (ctx) => {
      // Quadrado em volta da tela com margem de 10%.
      const corners: Array<[number, number]> = [
        [10, 10],
        [90, 10],
        [90, 90],
        [10, 90],
        [10, 10],
      ];
      for (const [x, y] of corners) {
        if (isAborted()) return;
        await moveMouse(ctx, x, y);
        await sleep(500);
      }
    },
  },
  {
    label: 'mt_circle',
    run: async (ctx) => {
      // 16 pontos num círculo no centro.
      const cx = 50,
        cy = 50,
        r = 25;
      for (let i = 0; i < 16; i++) {
        if (isAborted()) return;
        const t = (i / 16) * Math.PI * 2;
        const x = cx + r * Math.cos(t);
        const y = cy + r * Math.sin(t);
        await moveMouse(ctx, x, y);
        await sleep(80);
      }
      await moveMouse(ctx, 50, 50);
    },
  },
  {
    label: 'mt_keyboard_warning',
    run: async (ctx) => {
      await narrate(
        ctx,
        'Agora teclado. Daqui a 4 segundos vou digitar um texto onde o foco estiver. Se não quiser, abre um editor de texto agora ou aperta Esc.',
      );
      await sleep(4000);
    },
  },
  {
    label: 'mt_type',
    run: async (ctx) => {
      if (isAborted()) return;
      await typeText(ctx, 'Pixxel testando teclado: ');
      await sleep(300);
      await typeText(ctx, 'o mouse e o teclado funcionam.');
      await sleep(500);
      // Pressiona Home pra você ver visualmente que key também rolou.
      await keyPress(ctx, 'Home');
    },
  },
  {
    label: 'mt_done',
    run: async (ctx) => {
      await narrate(
        ctx,
        'Fim do teste. Se você viu o cursor andando e o texto aparecer no editor, tudo certo.',
      );
    },
  },
];

let mkRunning = false;

export function isMouseKeyboardTestRunning(): boolean {
  return mkRunning;
}

export async function runMouseKeyboardTest(ctx: Ctx): Promise<{
  ok: boolean;
  reason?: string;
  completed: number;
}> {
  if (mkRunning || running) {
    return { ok: false, reason: 'outro demo já está rodando', completed: 0 };
  }
  mkRunning = true;
  resetAbort();
  let completed = 0;
  try {
    for (const step of MOUSE_TEST) {
      if (isAborted()) break;
      console.log(`[demo-mk] step: ${step.label}`);
      await step.run(ctx);
      completed++;
    }
  } catch (err) {
    console.warn('[demo-mk] erro:', err);
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'erro desconhecido',
      completed,
    };
  } finally {
    mkRunning = false;
  }
  return { ok: true, completed };
}
