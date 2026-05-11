// Integração Trello — CRUD completo de cards: criar, editar (descrição,
// datas, labels, checklists, comentários), mover entre listas e arquivar.
// Auth via TRELLO_API_KEY + TRELLO_TOKEN.
//
// Por decisão do usuário, a integração opera EXCLUSIVAMENTE no board cujo
// nome bate com `LOCKED_BOARD_NAME` (default: "Pessoal"). Qualquer hint de
// board vindo das tools é ignorado e todas as resoluções são forçadas pra
// esse board — IDs de cards de outros boards são rejeitados.
//
// Diferente da integração ClickUp (read-only por preferência do usuário),
// aqui escrita é parte do contrato — operações destrutivas (archive, label
// remove) devem ser confirmadas no nível do Gemini Live, não no nível da API.

import type {
  TrelloCardDetailWidget,
  TrelloCardsListWidget,
} from '../../shared/widgets.js';

const BASE = 'https://api.trello.com/1';

const LOCKED_BOARD_NAME = 'Pessoal';

const API_KEY = () => process.env.TRELLO_API_KEY ?? '';
const TOKEN = () => process.env.TRELLO_TOKEN ?? '';

export function isTrelloAvailable(): boolean {
  return Boolean(API_KEY() && TOKEN());
}

type FetchMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

async function trelloFetch<T>(
  path: string,
  method: FetchMethod = 'GET',
  params: Record<string, string | string[] | undefined> = {},
  body?: Record<string, unknown>,
): Promise<T | null> {
  const key = API_KEY();
  const token = TOKEN();
  if (!key || !token) return null;

  const url = new URL(`${BASE}${path}`);
  url.searchParams.set('key', key);
  url.searchParams.set('token', token);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, item);
    else url.searchParams.set(k, v);
  }

  try {
    const res = await fetch(url, {
      method,
      headers: body
        ? { 'content-type': 'application/json', accept: 'application/json' }
        : { accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn(
        `[trello] api error ${res.status} on ${method} ${path}:`,
        text.slice(0, 300),
      );
      return null;
    }
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('json')) {
      // Algumas rotas (ex: DELETE label) devolvem 200 vazio.
      return {} as T;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn('[trello] fetch failed:', err);
    return null;
  }
}

// --- Tipos ---

export type TrelloBoard = {
  id: string;
  name: string;
  closed: boolean;
  url: string;
};

export type TrelloList = {
  id: string;
  name: string;
  idBoard: string;
  closed: boolean;
};

export type TrelloLabel = {
  id: string;
  name: string;
  color: string | null;
  idBoard: string;
};

export type TrelloChecklistItem = {
  id: string;
  name: string;
  state: 'complete' | 'incomplete';
  pos: number;
};

export type TrelloChecklist = {
  id: string;
  name: string;
  idCard: string;
  checkItems: TrelloChecklistItem[];
};

export type TrelloCard = {
  id: string;
  name: string;
  desc: string;
  closed: boolean;
  due: string | null;
  dueComplete: boolean;
  idList: string;
  idBoard: string;
  idLabels: string[];
  labels?: TrelloLabel[];
  shortUrl: string;
  url: string;
};

export type TrelloComment = {
  id: string;
  text: string;
  author: string;
  date: string;
};

// --- Discovery / resolução fuzzy ---

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function fuzzyMatch<T extends { name: string }>(
  items: T[],
  query: string,
): T | null {
  const q = norm(query);
  if (!q) return null;
  // Match exato primeiro, depois starts-with, depois contains.
  const exact = items.find((it) => norm(it.name) === q);
  if (exact) return exact;
  const starts = items.find((it) => norm(it.name).startsWith(q));
  if (starts) return starts;
  const contains = items.find((it) => norm(it.name).includes(q));
  if (contains) return contains;
  // Match por palavras (todas precisam aparecer)
  const words = q.split(' ').filter(Boolean);
  return (
    items.find((it) => {
      const n = norm(it.name);
      return words.every((w) => n.includes(w));
    }) ?? null
  );
}

// Não exportado por design: a integração é trancada em `LOCKED_BOARD_NAME`.
// Listar/escolher outro board não faz parte do contrato — só `resolveBoard`
// (interno) toca aqui pra descobrir o ID do board permitido.
async function listBoards(): Promise<TrelloBoard[] | null> {
  return trelloFetch<TrelloBoard[]>('/members/me/boards', 'GET', {
    fields: 'id,name,closed,url',
    filter: 'open',
  });
}

export async function listListsForBoard(
  boardId: string,
): Promise<TrelloList[] | null> {
  return trelloFetch<TrelloList[]>(`/boards/${boardId}/lists`, 'GET', {
    fields: 'id,name,idBoard,closed',
    filter: 'open',
  });
}

export async function listLabelsForBoard(
  boardId: string,
): Promise<TrelloLabel[] | null> {
  return trelloFetch<TrelloLabel[]>(`/boards/${boardId}/labels`, 'GET', {
    fields: 'id,name,color,idBoard',
    limit: '100',
  });
}

let lockedBoardCache: TrelloBoard | null = null;

/**
 * Resolve o ÚNICO board permitido (`LOCKED_BOARD_NAME`). Qualquer `hint`
 * passado é ignorado — a integração inteira é trancada nesse board por
 * decisão do usuário.
 */
export async function resolveBoard(
  _hint?: string,
): Promise<{ board: TrelloBoard | null; reason?: string }> {
  if (lockedBoardCache) return { board: lockedBoardCache };
  const boards = await listBoards();
  if (!boards) return { board: null, reason: 'falhou ao listar boards' };
  const exact = boards.find(
    (b) => norm(b.name) === norm(LOCKED_BOARD_NAME),
  );
  const locked = exact ?? fuzzyMatch(boards, LOCKED_BOARD_NAME);
  if (!locked) {
    return {
      board: null,
      reason: `board "${LOCKED_BOARD_NAME}" não encontrado na conta do Trello`,
    };
  }
  lockedBoardCache = locked;
  return { board: locked };
}

export async function getLockedBoard(): Promise<TrelloBoard | null> {
  const r = await resolveBoard();
  return r.board;
}

async function resolveList(
  board: TrelloBoard,
  hint: string,
): Promise<{ list: TrelloList | null; reason?: string }> {
  const lists = await listListsForBoard(board.id);
  if (!lists) return { list: null, reason: 'falhou ao listar listas' };
  const byId = lists.find((l) => l.id === hint);
  if (byId) return { list: byId };
  const match = fuzzyMatch(lists, hint);
  if (match) return { list: match };
  return {
    list: null,
    reason: `nenhuma lista casa com "${hint}" no board "${board.name}". disponíveis: ${lists.map((l) => l.name).join(', ')}`,
  };
}

async function resolveLabel(
  board: TrelloBoard,
  hint: string,
): Promise<{ label: TrelloLabel | null; reason?: string }> {
  const labels = await listLabelsForBoard(board.id);
  if (!labels) return { label: null, reason: 'falhou ao listar labels' };
  // Labels podem ter nome vazio (só cor). Filtra os nomeados.
  const named = labels.filter((l) => l.name);
  const byId = labels.find((l) => l.id === hint);
  if (byId) return { label: byId };
  const match = fuzzyMatch(named, hint);
  if (match) return { label: match };
  return {
    label: null,
    reason: `nenhuma etiqueta casa com "${hint}". disponíveis: ${named.map((l) => l.name).join(', ') || '(nenhuma nomeada)'}`,
  };
}

// --- Cards ---

const CARD_FIELDS = [
  'id',
  'name',
  'desc',
  'closed',
  'due',
  'dueComplete',
  'idList',
  'idBoard',
  'idLabels',
  'shortUrl',
  'url',
].join(',');

export async function listCardsInList(
  listId: string,
): Promise<TrelloCard[] | null> {
  return trelloFetch<TrelloCard[]>(`/lists/${listId}/cards`, 'GET', {
    fields: CARD_FIELDS,
  });
}

export async function listCardsInBoard(
  boardId: string,
): Promise<TrelloCard[] | null> {
  return trelloFetch<TrelloCard[]>(`/boards/${boardId}/cards`, 'GET', {
    fields: CARD_FIELDS,
    filter: 'open',
  });
}

export async function getCard(cardId: string): Promise<TrelloCard | null> {
  return trelloFetch<TrelloCard>(`/cards/${cardId}`, 'GET', {
    fields: CARD_FIELDS,
  });
}

export async function getChecklists(
  cardId: string,
): Promise<TrelloChecklist[] | null> {
  return trelloFetch<TrelloChecklist[]>(`/cards/${cardId}/checklists`, 'GET');
}

type CommentAction = {
  id: string;
  date: string;
  memberCreator?: { fullName?: string; username?: string };
  data?: { text?: string };
};

export async function getComments(cardId: string): Promise<TrelloComment[] | null> {
  const actions = await trelloFetch<CommentAction[]>(
    `/cards/${cardId}/actions`,
    'GET',
    { filter: 'commentCard', limit: '50' },
  );
  if (!actions) return null;
  return actions.map((a) => ({
    id: a.id,
    text: a.data?.text ?? '',
    author: a.memberCreator?.fullName ?? a.memberCreator?.username ?? 'alguém',
    date: a.date,
  }));
}

/**
 * Busca um card por ID interno, shortLink, ou substring de nome dentro do
 * board trancado. `_boardHint` é ignorado (acesso restrito ao
 * `LOCKED_BOARD_NAME`); cards de outros boards são rejeitados.
 */
export async function resolveCard(
  hint: string,
  _boardHint?: string,
): Promise<{ card: TrelloCard | null; board?: TrelloBoard; reason?: string }> {
  const trimmed = hint.trim();
  if (!trimmed) return { card: null, reason: 'hint vazio' };

  const br = await resolveBoard();
  if (!br.board) return { card: null, reason: br.reason };

  // Tenta direto via API: ID interno (24 hex) ou shortLink (8 alfanum) funcionam.
  // Validamos `idBoard` pra impedir que cards de outros boards sejam alcançados.
  if (/^[a-f0-9]{24}$/.test(trimmed) || /^[a-zA-Z0-9]{8}$/.test(trimmed)) {
    const direct = await getCard(trimmed);
    if (direct) {
      if (direct.idBoard !== br.board.id) {
        return {
          card: null,
          board: br.board,
          reason: `card "${direct.name}" não pertence ao board "${br.board.name}" (acesso restrito)`,
        };
      }
      return { card: direct, board: br.board };
    }
  }

  const cards = await listCardsInBoard(br.board.id);
  if (!cards) return { card: null, board: br.board, reason: 'falhou ao listar cards' };
  const match = fuzzyMatch(cards, trimmed);
  if (!match) {
    return {
      card: null,
      board: br.board,
      reason: `nenhum card casa com "${trimmed}" no board "${br.board.name}"`,
    };
  }
  return { card: match, board: br.board };
}

// --- Mutações ---

export type CreateCardInput = {
  name: string;
  desc?: string;
  due?: string; // ISO 8601
  listHint: string; // nome ou id
  boardHint?: string;
  labelHints?: string[];
};

export async function createCard(
  input: CreateCardInput,
): Promise<
  | { ok: true; card: TrelloCard; board: TrelloBoard; list: TrelloList }
  | { ok: false; reason: string }
> {
  const br = await resolveBoard(input.boardHint);
  if (!br.board) return { ok: false, reason: br.reason ?? 'board não resolvido' };
  const lr = await resolveList(br.board, input.listHint);
  if (!lr.list) return { ok: false, reason: lr.reason ?? 'lista não resolvida' };

  const idLabels: string[] = [];
  for (const lh of input.labelHints ?? []) {
    const lbr = await resolveLabel(br.board, lh);
    if (lbr.label) idLabels.push(lbr.label.id);
  }

  const params: Record<string, string> = {
    idList: lr.list.id,
    name: input.name,
  };
  if (input.desc) params.desc = input.desc;
  if (input.due) params.due = input.due;
  if (idLabels.length) params.idLabels = idLabels.join(',');

  const card = await trelloFetch<TrelloCard>('/cards', 'POST', params);
  if (!card) return { ok: false, reason: 'falhou ao criar card' };
  return { ok: true, card, board: br.board, list: lr.list };
}

export type UpdateCardInput = {
  name?: string;
  desc?: string;
  due?: string | null; // null → limpa
  dueComplete?: boolean;
  closed?: boolean;
};

export async function updateCard(
  cardId: string,
  patch: UpdateCardInput,
): Promise<TrelloCard | null> {
  const params: Record<string, string> = {};
  if (patch.name !== undefined) params.name = patch.name;
  if (patch.desc !== undefined) params.desc = patch.desc;
  if (patch.due !== undefined) params.due = patch.due ?? '';
  if (patch.dueComplete !== undefined) params.dueComplete = String(patch.dueComplete);
  if (patch.closed !== undefined) params.closed = String(patch.closed);
  if (Object.keys(params).length === 0) return getCard(cardId);
  return trelloFetch<TrelloCard>(`/cards/${cardId}`, 'PUT', params);
}

export async function moveCard(
  cardId: string,
  targetListHint: string,
  boardHint?: string,
): Promise<
  | { ok: true; card: TrelloCard; board: TrelloBoard; list: TrelloList }
  | { ok: false; reason: string }
> {
  const cr = await resolveCard(cardId, boardHint);
  if (!cr.card) return { ok: false, reason: cr.reason ?? 'card não encontrado' };
  // Resolve a lista no MESMO board do card — boardHint pode estar desatualizado
  // se o card foi movido entre boards.
  const cardBoardR = await resolveBoard(cr.card.idBoard);
  const cardBoard = cardBoardR.board;
  if (!cardBoard) return { ok: false, reason: 'board do card não encontrado' };
  const lr = await resolveList(cardBoard, targetListHint);
  if (!lr.list) return { ok: false, reason: lr.reason ?? 'lista não resolvida' };
  const updated = await trelloFetch<TrelloCard>(`/cards/${cr.card.id}`, 'PUT', {
    idList: lr.list.id,
  });
  if (!updated) return { ok: false, reason: 'falhou ao mover card' };
  return { ok: true, card: updated, board: cardBoard, list: lr.list };
}

export async function archiveCard(cardId: string): Promise<TrelloCard | null> {
  return updateCard(cardId, { closed: true });
}

export async function unarchiveCard(cardId: string): Promise<TrelloCard | null> {
  return updateCard(cardId, { closed: false });
}

export async function addCommentToCard(
  cardId: string,
  text: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const r = await trelloFetch<unknown>(`/cards/${cardId}/actions/comments`, 'POST', {
    text,
  });
  if (!r) return { ok: false, reason: 'falhou ao comentar' };
  return { ok: true };
}

export async function addLabelToCard(
  cardId: string,
  labelHint: string,
  boardHint?: string,
): Promise<
  | { ok: true; label: TrelloLabel }
  | { ok: false; reason: string }
> {
  const cr = await resolveCard(cardId, boardHint);
  if (!cr.card) return { ok: false, reason: cr.reason ?? 'card não encontrado' };
  const br = await resolveBoard(cr.card.idBoard);
  if (!br.board) return { ok: false, reason: 'board não encontrado' };
  const lr = await resolveLabel(br.board, labelHint);
  if (!lr.label) return { ok: false, reason: lr.reason ?? 'etiqueta não resolvida' };
  const r = await trelloFetch<unknown>(`/cards/${cr.card.id}/idLabels`, 'POST', {
    value: lr.label.id,
  });
  if (!r) return { ok: false, reason: 'falhou ao adicionar etiqueta' };
  return { ok: true, label: lr.label };
}

export async function removeLabelFromCard(
  cardId: string,
  labelHint: string,
  boardHint?: string,
): Promise<
  | { ok: true; label: TrelloLabel }
  | { ok: false; reason: string }
> {
  const cr = await resolveCard(cardId, boardHint);
  if (!cr.card) return { ok: false, reason: cr.reason ?? 'card não encontrado' };
  const br = await resolveBoard(cr.card.idBoard);
  if (!br.board) return { ok: false, reason: 'board não encontrado' };
  const lr = await resolveLabel(br.board, labelHint);
  if (!lr.label) return { ok: false, reason: lr.reason ?? 'etiqueta não resolvida' };
  const r = await trelloFetch<unknown>(
    `/cards/${cr.card.id}/idLabels/${lr.label.id}`,
    'DELETE',
  );
  if (!r) return { ok: false, reason: 'falhou ao remover etiqueta' };
  return { ok: true, label: lr.label };
}

export async function addChecklist(
  cardId: string,
  name: string,
  items: string[] = [],
): Promise<
  | { ok: true; checklist: TrelloChecklist }
  | { ok: false; reason: string }
> {
  const checklist = await trelloFetch<TrelloChecklist>('/checklists', 'POST', {
    idCard: cardId,
    name,
  });
  if (!checklist) return { ok: false, reason: 'falhou ao criar checklist' };
  for (const item of items) {
    await trelloFetch<unknown>(`/checklists/${checklist.id}/checkItems`, 'POST', {
      name: item,
    });
  }
  const refreshed = await trelloFetch<TrelloChecklist>(
    `/checklists/${checklist.id}`,
    'GET',
  );
  return { ok: true, checklist: refreshed ?? checklist };
}

export async function checkChecklistItem(
  cardId: string,
  itemHint: string,
  complete: boolean,
): Promise<
  | { ok: true; item: TrelloChecklistItem; checklistName: string }
  | { ok: false; reason: string }
> {
  const checklists = await getChecklists(cardId);
  if (!checklists) return { ok: false, reason: 'falhou ao listar checklists do card' };
  if (checklists.length === 0) return { ok: false, reason: 'card sem checklists' };

  let foundItem: TrelloChecklistItem | null = null;
  let foundList: TrelloChecklist | null = null;
  for (const cl of checklists) {
    const m = fuzzyMatch(cl.checkItems, itemHint);
    if (m) {
      foundItem = m;
      foundList = cl;
      break;
    }
  }
  if (!foundItem || !foundList) {
    const all = checklists
      .flatMap((cl) => cl.checkItems.map((i) => i.name))
      .join(', ');
    return {
      ok: false,
      reason: `nenhum item casa com "${itemHint}". disponíveis: ${all || '(nenhum)'}`,
    };
  }
  const state = complete ? 'complete' : 'incomplete';
  const updated = await trelloFetch<TrelloChecklistItem>(
    `/cards/${cardId}/checkItem/${foundItem.id}`,
    'PUT',
    { state },
  );
  if (!updated) return { ok: false, reason: 'falhou ao atualizar item' };
  return { ok: true, item: updated, checklistName: foundList.name };
}

// --- Formatação pra voz e widgets ---

export function formatCardsForVoice(
  cards: TrelloCard[],
  listName?: string,
): string {
  if (cards.length === 0) {
    return listName
      ? `Lista "${listName}" está vazia.`
      : 'Nenhum card encontrado.';
  }
  const head =
    cards.length === 1
      ? `1 card${listName ? ` em "${listName}"` : ''}:`
      : `${cards.length} cards${listName ? ` em "${listName}"` : ''}:`;
  const lines = cards.slice(0, 10).map((c) => `• ${c.name}`);
  const more = cards.length > 10 ? `\n…e mais ${cards.length - 10}.` : '';
  return `${head}\n${lines.join('\n')}${more}`;
}

export function cardsToWidget(
  title: string,
  cards: TrelloCard[],
  boardName?: string,
): TrelloCardsListWidget {
  return {
    kind: 'trello-cards',
    title,
    boardName,
    cards: cards.slice(0, 20).map((c) => ({
      id: c.id,
      name: c.name,
      url: c.shortUrl ?? c.url,
      due: c.due ?? undefined,
      dueComplete: c.dueComplete,
    })),
  };
}

export function cardDetailToWidget(input: {
  card: TrelloCard;
  board: TrelloBoard;
  list?: TrelloList;
  labels: TrelloLabel[];
  checklists: TrelloChecklist[];
  comments: TrelloComment[];
}): TrelloCardDetailWidget {
  return {
    kind: 'trello-card-detail',
    card: {
      id: input.card.id,
      name: input.card.name,
      desc: input.card.desc,
      due: input.card.due ?? undefined,
      dueComplete: input.card.dueComplete,
      closed: input.card.closed,
      url: input.card.shortUrl ?? input.card.url,
      boardName: input.board.name,
      listName: input.list?.name,
    },
    labels: input.labels.map((l) => ({ name: l.name, color: l.color ?? undefined })),
    checklists: input.checklists.map((cl) => ({
      name: cl.name,
      items: cl.checkItems.map((i) => ({
        name: i.name,
        complete: i.state === 'complete',
      })),
    })),
    comments: input.comments.slice(0, 10).map((c) => ({
      author: c.author,
      text: c.text,
      date: c.date,
    })),
  };
}

export function formatCardDetailForVoice(input: {
  card: TrelloCard;
  board: TrelloBoard;
  list?: TrelloList;
  labels: TrelloLabel[];
  checklists: TrelloChecklist[];
  comments: TrelloComment[];
}): string {
  const c = input.card;
  const due = c.due ? new Date(c.due).toLocaleDateString('pt-BR') : 'sem data';
  const labelNames = input.labels
    .map((l) => l.name)
    .filter(Boolean)
    .join(', ');
  const checklistSummary = input.checklists
    .map((cl) => {
      const done = cl.checkItems.filter((i) => i.state === 'complete').length;
      return `${cl.name} (${done}/${cl.checkItems.length})`;
    })
    .join('; ');
  const lines = [
    `Card: ${c.name}`,
    `Board: ${input.board.name}${input.list ? ` · lista: ${input.list.name}` : ''}`,
    `Vencimento: ${due}${c.dueComplete ? ' (concluído)' : ''}`,
    labelNames ? `Etiquetas: ${labelNames}` : 'Sem etiquetas',
    checklistSummary ? `Checklists: ${checklistSummary}` : 'Sem checklists',
    c.desc ? `\nDescrição:\n${c.desc.slice(0, 600)}${c.desc.length > 600 ? '…' : ''}` : '',
    input.comments.length > 0
      ? `\nÚltimos comentários:\n${input.comments
          .slice(0, 3)
          .map((cm) => `- ${cm.author}: ${cm.text.slice(0, 150)}`)
          .join('\n')}`
      : '',
  ];
  return lines.filter(Boolean).join('\n');
}
