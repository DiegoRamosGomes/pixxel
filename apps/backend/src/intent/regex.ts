import type { ClientCommand } from '@assistant/shared';

export type RegexHit = {
  command: ClientCommand;
  spokenLabel: string;
};

const URL_RE = /^https?:\/\/\S+$/i;
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i;

// Programas locais (executáveis no $PATH).
const APP_ALIASES: Record<string, string> = {
  spotify: 'spotify',
  vscode: 'code',
  'vs code': 'code',
  'visual studio code': 'code',
  firefox: 'firefox',
  chrome: 'google-chrome',
  chromium: 'chromium',
  terminal: 'gnome-terminal',
  telegram: 'telegram-desktop',
  discord: 'discord',
  obsidian: 'obsidian',
};

// Sites/SaaS conhecidos: nome amigável → URL preferida.
// Têm prioridade sobre APP_ALIASES quando o nome casa em ambos.
const SITE_ALIASES: Record<string, string> = {
  clickup: 'https://app.clickup.com/',
  gmail: 'https://mail.google.com/',
  email: 'https://mail.google.com/',
  agenda: 'https://calendar.google.com/',
  calendario: 'https://calendar.google.com/',
  calendar: 'https://calendar.google.com/',
  'google calendar': 'https://calendar.google.com/',
  'google agenda': 'https://calendar.google.com/',
  maps: 'https://maps.google.com/',
  'google maps': 'https://maps.google.com/',
  drive: 'https://drive.google.com/',
  'google drive': 'https://drive.google.com/',
  youtube: 'https://www.youtube.com/',
  github: 'https://github.com/',
  whatsapp: 'https://web.whatsapp.com/',
  'whatsapp web': 'https://web.whatsapp.com/',
  notion: 'https://www.notion.so/',
  linear: 'https://linear.app/',
  jira: 'https://www.atlassian.com/software/jira',
  slack: 'https://app.slack.com/',
  twitter: 'https://twitter.com/',
  x: 'https://x.com/',
  reddit: 'https://www.reddit.com/',
  linkedin: 'https://www.linkedin.com/',
  netflix: 'https://www.netflix.com/',
  'chat gpt': 'https://chat.openai.com/',
  chatgpt: 'https://chat.openai.com/',
  claude: 'https://claude.ai/',
};

function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Frases de cortesia/redundância que podem aparecer no fim de um comando informal.
const POLITENESS_TRAIL_RE =
  /\s+(pra mim|por favor|por favor\.?|agora|aí|ai|por gentileza|please)\.?$/i;

function trimPunct(s: string): string {
  let t = s.trim().replace(/[?!.]+$/, '').trim();
  // Remove repetidamente trailing politeness ("abra o chrome pra mim agora" → "abra o chrome")
  let prev: string;
  do {
    prev = t;
    t = t.replace(POLITENESS_TRAIL_RE, '').trim();
  } while (t !== prev);
  return t;
}

export function tryRegexMatch(input: string): RegexHit | null {
  const text = trimPunct(input);

  // "abra/abre/abrir [o|a] X" — preserva acentos do alvo
  const openMatch = text.match(/^(?:abra|abre|abrir)\s+(?:o |a |os |as )?(.+)$/i);
  if (openMatch) {
    const target = openMatch[1].trim();
    const targetLc = stripDiacritics(target).toLowerCase();

    if (URL_RE.test(target)) {
      return {
        command: { action: 'open_url', url: target },
        spokenLabel: `Abrindo ${target}.`,
      };
    }
    if (DOMAIN_RE.test(target)) {
      const url = target.startsWith('http') ? target : `https://${target}`;
      return {
        command: { action: 'open_url', url },
        spokenLabel: `Abrindo ${target}.`,
      };
    }
    // Site/SaaS conhecido tem prioridade sobre app local.
    const siteUrl = SITE_ALIASES[targetLc];
    if (siteUrl) {
      return {
        command: { action: 'open_url', url: siteUrl },
        spokenLabel: `Abrindo ${target}.`,
      };
    }
    // App local conhecido: dispara direto.
    const app = APP_ALIASES[targetLc];
    if (app) {
      return {
        command: { action: 'open_app', name: app },
        spokenLabel: `Abrindo ${target}.`,
      };
    }
    // Nome desconhecido — deixa o LLM decidir se é SaaS (open_url) ou app local.
    return null;
  }

  // "pesquise/busque/procure X" — preserva acentos no query
  const searchMatch = text.match(
    /^(?:pesquise|pesquisa|busque|busca|procure|procura)\s+(?:por\s+)?(.+)$/i,
  );
  if (searchMatch) {
    const query = searchMatch[1].trim();
    return {
      command: { action: 'web_search', query },
      spokenLabel: `Pesquisando ${query}.`,
    };
  }

  return null;
}
