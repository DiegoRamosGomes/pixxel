// Tipos de widgets visuais que o desktop renderiza em paralelo à voz do
// Gemini. Cada tool call de integração retorna OPCIONALMENTE um widget,
// que é emitido pro renderer via IPC e empilhado no card stack.

export type WeatherWidget = {
  kind: 'weather';
  when: 'today' | 'tomorrow';
  city: string;
  country?: string;
  tempC?: number;
  weatherCode?: number;
  condition: string;
  minC?: number;
  maxC?: number;
  rainPercent?: number;
};

export type TasksListWidget = {
  kind: 'tasks-list';
  title: string;
  tasks: Array<{
    id: string;
    customId?: string;
    name: string;
    status?: string;
    priority?: string;
    url?: string;
  }>;
};

export type TaskDetailWidget = {
  kind: 'task-detail';
  task: {
    id: string;
    customId?: string;
    name: string;
    description: string;
    status?: string;
    priority?: string;
    list?: string;
    space?: string;
    dueDate?: string;
    url?: string;
  };
  comments: Array<{
    author: string;
    text: string;
    date?: string;
  }>;
};

export type YoutubeWidget = {
  kind: 'youtube';
  videoId: string;
  title: string;
  channel: string;
  thumbnailUrl: string;
  url: string;
};

export type SearchResultsWidget = {
  kind: 'search-results';
  query: string;
  results: Array<{
    title: string;
    url: string;
    snippet: string;
  }>;
};

export type BuildStatusWidget = {
  kind: 'build-status';
  provider: 'expo';
  buildId?: string;
  appName?: string;
  platform?: 'ios' | 'android';
  status: 'started' | 'finished' | 'errored' | 'canceled' | string;
  buildUrl?: string; // EAS dashboard
  artifactUrl?: string; // .apk/.ipa direto (só em finished)
  receivedAt?: number;
};

export type NotificationsWidget = {
  kind: 'notifications';
  source: 'clickup';
  // Compactos pra UI: cada item vira uma linha clicável.
  items: Array<{
    id: string;
    kind: 'task_assigned' | 'task_comment' | 'mention' | 'chat_message' | 'other';
    title: string;
    detail?: string;
    actor?: string;
    taskId?: string;
    taskUrl?: string;
    date?: string;
  }>;
};

export type StorageWidget = {
  kind: 'storage';
  scope: 'single' | 'all';
  disks: Array<{
    mount: string;
    fstype: string;
    totalBytes: number;
    usedBytes: number;
    availBytes: number;
    usedPercent: number;
  }>;
};

export type TrelloCardsListWidget = {
  kind: 'trello-cards';
  title: string;
  boardName?: string;
  cards: Array<{
    id: string;
    name: string;
    url?: string;
    due?: string;
    dueComplete?: boolean;
  }>;
};

export type TrelloCardDetailWidget = {
  kind: 'trello-card-detail';
  card: {
    id: string;
    name: string;
    desc: string;
    due?: string;
    dueComplete?: boolean;
    closed: boolean;
    url?: string;
    boardName: string;
    listName?: string;
  };
  labels: Array<{ name: string; color?: string }>;
  checklists: Array<{
    name: string;
    items: Array<{ name: string; complete: boolean }>;
  }>;
  comments: Array<{ author: string; text: string; date?: string }>;
};

export type Widget =
  | WeatherWidget
  | TasksListWidget
  | TaskDetailWidget
  | YoutubeWidget
  | SearchResultsWidget
  | StorageWidget
  | NotificationsWidget
  | BuildStatusWidget
  | TrelloCardsListWidget
  | TrelloCardDetailWidget
  | BriefingWidget;

export type NewsArea = 'mundo' | 'tecnologia' | 'economia';

export type BriefingSegment =
  | {
      kind: 'date';
      say: string;
      cue: string;
      weekday: string;
      day: number;
      monthYear: string;
      observance?: { name: string; type: 'holiday' | 'observance' };
    }
  | {
      kind: 'weather';
      say: string;
      cue: string;
      place: string;
      tempC: number;
      condition: string;
      weatherCode?: number;
      minC?: number;
      maxC?: number;
      rainPercent?: number;
    }
  | {
      kind: 'news';
      say: string;
      cue: string;
      area: NewsArea;
      title: string;
      summary: string;
      url: string;
      imageUrl?: string;
      source: string;
      publishedAt: string;
    };

export type BriefingWidget = { kind: 'briefing'; segments: BriefingSegment[] };
