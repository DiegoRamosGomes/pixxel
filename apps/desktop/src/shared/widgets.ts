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

export type Widget =
  | WeatherWidget
  | TasksListWidget
  | TaskDetailWidget
  | YoutubeWidget
  | SearchResultsWidget
  | StorageWidget;
