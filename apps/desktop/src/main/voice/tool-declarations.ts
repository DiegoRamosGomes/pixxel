import type { ToolDeclaration } from './gemini-live.js';

// Function declarations expostas ao Gemini Live. Cada nome corresponde a um
// `action` do schema em packages/shared/src/commands.ts. Os args do toolCall
// são validados com Zod (CLIENT_COMMAND) ou roteados pra integrations/.

export const CLIENT_COMMAND_TOOLS: ToolDeclaration[] = [
  {
    name: 'open_app',
    description:
      'Abre um aplicativo local pelo nome do executável (ex: "spotify", "code", "firefox", "chrome"). ' +
      'Use quando o usuário pedir pra abrir um programa específico.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Nome do executável a abrir, ex: "spotify", "code"',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'open_url',
    description:
      'Abre uma URL no navegador padrão. Use quando o usuário pedir pra abrir um site específico.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL completa começando com http:// ou https://',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'web_search',
    description:
      'Faz uma pesquisa na web abrindo o Google com o termo. ' +
      'Use quando o usuário pedir pra pesquisar algo sem especificar um site.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'O termo de busca',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'media_control',
    description:
      'Controla a mídia que está tocando no sistema (Spotify, navegador, etc). ' +
      'Use pra pausar, continuar, próxima/anterior música.',
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['play', 'pause', 'play_pause', 'stop', 'next', 'previous'],
          description:
            'play_pause é o toggle padrão pra "pausa/continua". ' +
            'next/previous trocam de faixa.',
        },
      },
      required: ['op'],
    },
  },
];

// Tools de integrações: clima, ClickUp (read-only), YouTube. Resposta volta
// pro Gemini que vai vocalizar usando os dados retornados.
export const INTEGRATION_TOOLS: ToolDeclaration[] = [
  {
    name: 'weather',
    description:
      'Consulta o clima atual ou previsão. Retorna texto curto pronto pra falar.',
    parameters: {
      type: 'object',
      properties: {
        when: {
          type: 'string',
          enum: ['today', 'tomorrow'],
          description: 'today = agora; tomorrow = amanhã. Default today.',
        },
      },
    },
  },
  {
    name: 'play_youtube',
    description:
      'Busca no YouTube e abre o vídeo no navegador. ' +
      'Use quando o usuário pedir pra tocar uma música ou ver um vídeo. ' +
      'Default de prefer = "top" (vídeo com mais views). ' +
      'Use "latest" pra "último vídeo do canal X" e "first" pro primeiro resultado.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'O que buscar (música, canal, vídeo)',
        },
        prefer: {
          type: 'string',
          enum: ['top', 'latest', 'first'],
          description: 'Estratégia de seleção. Default top.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'clickup_tasks_in_progress',
    description:
      'Lista as tasks do usuário no ClickUp que estão em status "em progresso/desenvolvimento". ' +
      'Read-only. Retorna texto formatado.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'clickup_tasks_high_priority',
    description:
      'Lista as tasks do usuário no ClickUp com prioridade urgente ou alta. ' +
      'Read-only. Retorna texto formatado.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'clickup_explain_task',
    description:
      'Pega detalhes completos (descrição + comentários) de uma task do ClickUp ' +
      'pra resumir/explicar. Aceita ID interno (868abc) ou custom (DEV-1234) ou só número.',
    parameters: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'ID da task no ClickUp',
        },
      },
      required: ['taskId'],
    },
  },
];

export const ALL_TOOLS: ToolDeclaration[] = [
  ...CLIENT_COMMAND_TOOLS,
  ...INTEGRATION_TOOLS,
];
