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
    name: 'start_work',
    description:
      'Registra o INÍCIO de uma sessão de trabalho — usado pra lembrar no que ' +
      'a pessoa estava trabalhando entre sessões. USE quando o usuário disser ' +
      '"vou começar a trabalhar em X", "começando a fazer Y", "agora vou ' +
      'mexer em Z", "vou pegar a task tal". Se houver task do ClickUp ' +
      'mencionada, passe o ID. ' +
      'COMPORTAMENTO COM SESSÃO ABERTA: se já tem outra sessão running, a tool ' +
      'retorna {ok:false, reason:"session_open"} junto com texto descrevendo a ' +
      'sessão atual. NÃO insista — pergunte ao usuário em primeira pessoa se ' +
      'quer PAUSAR (retomável depois) ou INTERROMPER (descarta) a atual. ' +
      'Quando ele responder, chame pause_current_work ou ' +
      'interrupt_current_work, e DEPOIS chame start_work de novo.',
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description:
            'Descrição curta do que vai fazer (ex: "corrigir bug do login do ' +
            'easytax", "estudar tópico de aquecimento global", "responder ' +
            'emails do cliente X").',
        },
        clickup_task_id: {
          type: 'string',
          description:
            'ID/custom ID da task no ClickUp se ela mencionou. Opcional.',
        },
        owner: {
          type: 'string',
          description:
            'Nome de quem está trabalhando, opcional (ex: "Diego", "Kamila"). ' +
            'Útil pra distinguir histórico entre pessoas usando o mesmo Pixxel.',
        },
      },
      required: ['description'],
    },
  },
  {
    name: 'end_work',
    description:
      'Marca o FIM da sessão de trabalho ativa. USE em "terminei essa task", ' +
      '"vou parar por hoje", "encerra o trabalho", "fechei essa". Pode incluir ' +
      'uma nota com o motivo de parar ou contexto pra retomar depois.',
    parameters: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description:
            'Nota opcional sobre o estado em que deixou (ex: "falta testar ' +
            'edge case Y", "espera resposta do cliente").',
        },
      },
    },
  },
  {
    name: 'current_work_status',
    description:
      'Retorna a sessão de trabalho running agora (se houver) e as pausadas. ' +
      'USE em "no que eu tava trabalhando?", "qual minha tarefa atual?", ' +
      '"que sessão tá aberta?", "tem alguma coisa rodando?".',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'pause_current_work',
    description:
      'Pausa a sessão de trabalho running atual — fica retomável depois. NÃO ' +
      'apaga, só salva o estado. USE quando o usuário responder que quer ' +
      'PAUSAR (e não interromper) durante o conflito de início de nova sessão, ' +
      'OU quando ele disser explicitamente "pausa o que tô fazendo", "salva o ' +
      'estado e suspende".',
    parameters: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description:
            'Nota opcional sobre o ponto em que pausou (ex: "tava no meio da ' +
            'edição do header"). Curto.',
        },
      },
    },
  },
  {
    name: 'interrupt_current_work',
    description:
      'INTERROMPE (descarta) a sessão de trabalho running atual. Sessão fica ' +
      'marcada como interrupted — ainda fica retomável caso o usuário mude de ' +
      'ideia, mas o tom é de "abandono". USE quando o usuário responder que ' +
      'quer INTERROMPER durante conflito de início de nova sessão, ou disser ' +
      '"para tudo", "descarta o que tava fazendo", "não me importa mais".',
    parameters: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: 'Motivo opcional pra registrar.',
        },
      },
    },
  },
  {
    name: 'storage_status',
    description:
      'Status de armazenamento do sistema (espaço total, usado e disponível). ' +
      'USE quando o usuário perguntar "quanto tem de espaço", "qual meu disco", ' +
      '"quanto sobrou de HD", "tá cheio o disco?", "espaço livre", e variações. ' +
      'Default: partição raiz (/). Passe mount="all" se ele quiser TODOS os ' +
      'discos/partições, ou um caminho específico ("/home", "/media/x") se citado.',
    parameters: {
      type: 'object',
      properties: {
        mount: {
          type: 'string',
          description:
            'Ponto de montagem a consultar. Default "/". Use "all" pra listar ' +
            'todos os filesystems reais (ignora tmpfs/etc).',
        },
      },
    },
  },
  {
    name: 'create_study_plan',
    description:
      'Cria um novo plano de estudo persistente em ~/pixxel/study-plans/. ' +
      'USE quando o usuário pedir pra "criar/montar/planejar um curso/roteiro ' +
      'de estudo". VOCÊ elabora a estrutura completa nos parâmetros: ' +
      'módulos numerados do mais básico ao avançado, cada um com objetivo + ' +
      'tópicos discretos e didáticos. Pense num roteiro pra alguém sair do ' +
      'ZERO até virar especialista. Tópicos devem ser pequenos e focados ' +
      '(1 vídeo de 10-30min cobre cada). NÃO cria se o usuário só pediu ' +
      'sugestão verbal — só cria quando ele explicitamente pedir pra ' +
      '"montar um plano persistente" ou "criar um curso".',
    parameters: {
      type: 'object',
      properties: {
        plan_id: {
          type: 'string',
          description:
            'Slug curto e único, opcional. Default: "<owner>-<topic>" slugificado. ' +
            'Ex: "kamila-creditos-de-carbono".',
        },
        owner: {
          type: 'string',
          description:
            'Nome de quem vai estudar (ex: "Kamila", "eu", "Diego"). ' +
            'Usado pra distinguir planos no índice.',
        },
        topic: {
          type: 'string',
          description: 'Tema principal (ex: "Créditos de carbono").',
        },
        goal: {
          type: 'string',
          description:
            'Frase descrevendo o objetivo final (ex: "tornar-se especialista ' +
            'em créditos de carbono e atuar profissionalmente").',
        },
        modules: {
          type: 'array',
          description:
            'Módulos do plano em ordem. Cada um vira uma seção. ' +
            'Mínimo 3, ideal 4-6 módulos. Tópicos por módulo: 4-10.',
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Título do módulo (ex: "Nível 1 — Fundamentos").',
              },
              objective: {
                type: 'string',
                description: 'O que a pessoa vai entender ao final do módulo.',
              },
              topics: {
                type: 'array',
                description: 'Tópicos do módulo, em ordem.',
                items: {
                  type: 'object',
                  properties: {
                    title: {
                      type: 'string',
                      description:
                        'Título curto e específico do tópico (1 vídeo cobre). ' +
                        'Ex: "Aquecimento global: o que é e o que causa".',
                    },
                  },
                  required: ['title'],
                },
              },
            },
            required: ['title', 'objective', 'topics'],
          },
        },
      },
      required: ['owner', 'topic', 'goal', 'modules'],
    },
  },
  {
    name: 'list_study_plans',
    description:
      'Lista todos os planos de estudo cadastrados (com status e progresso). ' +
      'USE quando o usuário perguntar "quais planos a gente tem", "quais ' +
      'cursos a Kamila tá fazendo".',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'study_plan_status',
    description:
      'Devolve o estado atual de um plano de estudo: progresso, módulo e ' +
      'tópico atual, notas. USE quando perguntarem "como tá o plano da Kamila", ' +
      '"em que ponto ela tá no curso de carbono".',
    parameters: {
      type: 'object',
      properties: {
        plan_id: {
          type: 'string',
          description:
            'ID, parte do tópico ou nome do dono — busca flexível. ' +
            'Ex: "kamila", "carbono", "kamila-creditos-de-carbono". ' +
            'Pode passar vazio ou "meu" se a pessoa disser "meu curso" e ' +
            'só houver um plano ativo — o sistema resolve automaticamente.',
        },
      },
    },
  },
  {
    name: 'study_plan_next',
    description:
      'Pega o PRÓXIMO tópico do plano (em-progresso primeiro, depois ' +
      'não-começado), marca como em-progresso, busca um vídeo no YouTube ' +
      'sobre o tópico, abre no navegador e retorna texto pronto pra você ' +
      'falar (módulo + objetivo + tópico + vídeo aberto). ' +
      'USE quando o usuário pedir "qual o próximo passo", "vamos para o ' +
      'próximo", "manda o próximo vídeo do meu curso", "vamos continuar".',
    parameters: {
      type: 'object',
      properties: {
        plan_id: {
          type: 'string',
          description:
            'ID/parte do tópico/owner — busca flexível. Pode passar vazio ' +
            'ou "meu" se houver só um plano ativo.',
        },
      },
    },
  },
  {
    name: 'study_plan_another_video',
    description:
      'Busca um vídeo ALTERNATIVO no YouTube pro tópico atual (ou um ' +
      'tópico específico). Pula vídeos já vistos/registrados no histórico ' +
      'do tópico, então sempre tenta sugerir algo novo. ' +
      'USE quando o usuário pedir "manda outro vídeo desse tópico", "esse ' +
      'não foi bom, manda outro", "quero um diferente", "queria mais um ' +
      'sobre isso". ' +
      'Por padrão (replace=false) só ABRE o vídeo novo e adiciona ao ' +
      'histórico — o vídeo "oficial" do tópico não muda. Se o usuário ' +
      'disser "troca o vídeo principal", "esse era ruim, substitui", ' +
      'passe replace=true.',
    parameters: {
      type: 'object',
      properties: {
        plan_id: {
          type: 'string',
          description: 'ID/parte/owner do plano. Vazio resolve automático.',
        },
        topic_id: {
          type: 'string',
          description:
            'ID OU substring do título do tópico. VAZIO = tópico atual ' +
            '(em-progresso ou próximo da fila).',
        },
        replace: {
          type: 'boolean',
          description:
            'Se true, substitui o vídeo "oficial" do tópico por esse novo. ' +
            'Default false: só abre como alternativa, mantém o oficial.',
        },
      },
    },
  },
  {
    name: 'mark_study_topic',
    description:
      'Atualiza status de um tópico do plano. USE quando o usuário disser ' +
      '"terminei", "concluí esse", "pula esse tópico", ou quiser anexar ' +
      'uma nota ("anota que ela entendeu X bem"). Mantém o histórico.',
    parameters: {
      type: 'object',
      properties: {
        plan_id: {
          type: 'string',
          description:
            'ID/parte do tópico/owner — busca flexível. Pode passar vazio ' +
            'ou "meu" se houver só um plano ativo.',
        },
        topic_id: {
          type: 'string',
          description:
            'ID do tópico OU substring do título — usa busca flexível. ' +
            'Se o usuário disser "esse" sem especificar, use o tópico atual ' +
            '(você sabe qual é via study_plan_status).',
        },
        status: {
          type: 'string',
          enum: ['not-started', 'in-progress', 'done', 'skipped'],
          description:
            'done = concluído. skipped = pulado. in-progress = começou. ' +
            'not-started = volta pra fila.',
        },
        note: {
          type: 'string',
          description:
            'Nota livre opcional (ex: "Kamila gostou bastante, fez resumo"). ' +
            'Vai pro histórico do tópico com data.',
        },
      },
      required: ['plan_id', 'topic_id', 'status'],
    },
  },
  {
    name: 'web_search',
    description:
      'Pesquisa na web e RETORNA o conteúdo das fontes pra você ler e ' +
      'sintetizar uma resposta natural. Use quando o usuário fizer uma ' +
      'pergunta de conhecimento que precisa de informação atual ou que ' +
      'você não sabe (ex: "qual a cotação do dólar hoje?", "o que é X?", ' +
      '"como funciona Y?", "quem é Z?", "últimas notícias de W"). ' +
      'NÃO USE pra abrir site específico (use open_url) nem pra tocar vídeo (play_youtube).\n' +
      'A tool retorna: uma resposta sintética + trechos de 5 fontes. Você ' +
      'deve LER tudo e responder por voz em 2-3 frases citando fontes pelo ' +
      'nome (ex: "segundo a Folha e o G1, X"). NÃO leia URLs em voz alta — ' +
      'os links aparecem no widget visual.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Termo de busca em pt-BR ou no idioma adequado à pergunta.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'weather',
    description:
      'Consulta o clima atual ou previsão. Retorna texto curto pronto pra falar.\n' +
      'CRÍTICO — chama UMA vez só por pedido do usuário:\n' +
      '  • "como tá o clima?" / "vai chover?" → 1 chamada com when=today.\n' +
      '  • "como tá o clima amanhã?" → 1 chamada com when=tomorrow.\n' +
      '  • "clima hoje e amanhã" (os DOIS explícitos) → aí sim 2 chamadas.\n' +
      'NUNCA chame "tomorrow" depois de "today" por conta própria pra ser ' +
      'prestativo — só se o usuário pediu os dois explicitamente.',
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
    name: 'look_at_camera',
    description:
      'OLHA pela webcam e descreve o que vê / responde uma pergunta sobre a ' +
      'imagem. Use quando o usuário disser "o que você tá vendo", "o que tem ' +
      'aqui na minha frente", "o que é isso que eu tô segurando", "lê esse ' +
      'papel pra mim", "descreve meu rosto", "tá escuro aqui?", e variações ' +
      'que peçam análise visual ao vivo. Requer câmera aberta — se estiver ' +
      'fechada, CHAME open_camera primeiro no mesmo turno e DEPOIS chame ' +
      'look_at_camera. NÃO peça pro usuário abrir manualmente. ' +
      'É lentinho (1-3s): fale uma frase curta ' +
      'antes ("deixa eu olhar"). LEIA o texto retornado em `text` exatamente ' +
      'como veio, sem inventar detalhes. NÃO USE pra coisas que não dependem ' +
      'da câmera.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description:
            'Pergunta específica sobre a imagem em pt-BR (ex: "o que estou ' +
            'segurando?", "que cor é minha camisa?", "o que está escrito ' +
            'aqui?"). Se o usuário só disse "olha pra mim", passe ' +
            '"Descreva o que você está vendo".',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'summarize_youtube',
    description:
      'Resume um vídeo do YouTube em pt-BR (3-5 frases). Use quando o usuário ' +
      'pedir "resume esse vídeo X", "do que fala esse vídeo", "me explica esse ' +
      'vídeo do YouTube", "qual o resumo desse vídeo" e variações. ' +
      'É ASSÍNCRONO/lento (5-30s dependendo do vídeo): fale algo curto antes ' +
      '("vou ver o vídeo, um momento") MAS sempre chame a tool no mesmo turno. ' +
      'O retorno traz o resumo pronto em `text` — leia EXATAMENTE como veio, ' +
      'sem inventar. Se a tool retornar erro (ex: 429, vídeo longo demais), ' +
      'avise o usuário com a razão e NÃO improvise um resumo.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'URL completa do vídeo (https://youtube.com/watch?v=... ou youtu.be/...) ' +
            'ou apenas o ID de 11 caracteres.',
        },
      },
      required: ['url'],
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
  {
    name: 'restart_wifi',
    description:
      'Reinicia o rádio WiFi do computador (desliga e liga via nmcli). USE ' +
      'quando o usuário disser "reinicia o wifi", "religa a internet", "minha ' +
      'rede travou", "tá sem net, conserta", "reset do wifi" e variações. ' +
      'Demora ~5-15s pra reconectar — fale algo curto antes ("desligando o ' +
      'wifi") em primeira pessoa. Volta com SSID e força do sinal pra você ' +
      'confirmar a reconexão. Linux/nmcli only.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'email_check_now',
    description:
      'Roda um ciclo do email AGORA: busca não-lidos, classifica e fala se ' +
      'tem importante. USE quando o usuário disser "tem email novo?", "vê meu ' +
      'email", "olha minha caixa", "tem email importante?". É lentinho (~3-8s).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'email_recent_important',
    description:
      'Lista os emails marcados como importantes mais recentes (últimos N do ' +
      'cache, sem fetch novo). USE quando o usuário pedir "quais foram meus ' +
      'emails importantes hoje", "do que era aquele email importante", ' +
      '"resume os importantes". Bem mais rápido que email_check_now.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Quantos trazer. Default 5, máximo 15.',
        },
      },
    },
  },
  {
    name: 'email_backfill',
    description:
      'Indexa os últimos N emails da caixa de entrada (incluindo já lidos) ' +
      'pra busca semântica funcionar com histórico antigo. Não muda labels ' +
      'nem marca como lido. Default 100 emails. É lento (~1-3min). USE ' +
      'quando o usuário disser "indexa meu histórico de email", "carrega ' +
      'meus emails antigos pra busca". Idempotente: re-rodar não duplica.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Quantos emails indexar. Default 100, máximo 500.',
        },
      },
    },
  },
  {
    name: 'email_search',
    description:
      'Busca SEMÂNTICA nos emails já processados — encontra emails pelo ' +
      'SIGNIFICADO da pergunta, não só palavras literais. ' +
      'USE quando o usuário perguntar "qual o último email sobre X", "tem ' +
      'algum email de Y", "me lembra do email sobre Z", "do que era aquele ' +
      'email de proposta/vaga/cobrança". Combina similaridade semântica + ' +
      'recência (mais recente ganha empate). ' +
      'Retorna remetente, assunto, data e snippet — leia o resultado e ' +
      'responda em UMA frase mencionando o remetente e o assunto. NÃO leia ' +
      'URLs nem o snippet inteiro. Se nada relevante voltar, fale isso.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Pergunta/tema em pt-BR (ex: "vagas de emprego", "proposta de ' +
            'projeto", "cobrança da fatura").',
        },
        limit: {
          type: 'number',
          description: 'Quantos emails trazer. Default 3, máximo 10.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'email_mark_important',
    description:
      'Treina o classificador: marca um email recente como IMPORTANTE. USE ' +
      'quando o usuário disser "esse email do X era importante", "lembra do ' +
      'email Y? era importante", "marca aquele como importante". O ' +
      'classificador KNN vai aprender com isso. ' +
      'Passe `query` com algo identificável: nome do remetente OU palavras ' +
      'do assunto OU "último" pra pegar o último processado. ' +
      'Se houver mais de um match, ele pega o mais relevante.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Termo pra achar o email: nome/empresa/assunto/"último". Em pt-BR.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'email_mark_not_important',
    description:
      'Treina o classificador: marca um email recente como NÃO importante. ' +
      'USE em "esse não era importante", "isso era spam", "marca aquele ' +
      'como não-importante". Mesma busca por query do email_mark_important.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Termo pra achar o email. Em pt-BR.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'instagram_profile',
    description:
      'Retorna o resumo do perfil do Instagram do usuário (@ia.pixxel): ' +
      'username, número de seguidores e quantidade de posts. Read-only. ' +
      'USE quando ele perguntar "quantos seguidores eu tenho", "como tá meu insta", ' +
      '"resumo do meu instagram".\n' +
      'CRÍTICO: NUNCA invente números de seguidores ou posts. SEMPRE chame esta ' +
      'tool e leia EXATAMENTE o que vier em `text`. Se ainda não chamou, NÃO ' +
      'mencione nenhum número — chame primeiro e só depois fale.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'instagram_latest_posts',
    description:
      'Lista os últimos posts do Instagram do usuário com data, likes e ' +
      'comentários. Read-only. USE quando ele pedir "meus últimos posts", ' +
      '"o que eu postei recentemente no insta", "como foram meus últimos posts". ' +
      'Default 5 posts.\n' +
      'CRÍTICO: NUNCA invente posts, datas, captions, likes ou comentários. ' +
      'SEMPRE chame esta tool e leia EXATAMENTE o que vier em `text`. Se ainda ' +
      'não chamou, NÃO descreva nenhum post — chame primeiro e só depois fale.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Quantos posts trazer. Default 5, máximo 10.',
        },
      },
    },
  },
  {
    name: 'instagram_post_insights',
    description:
      'Métricas (alcance, likes, comentários, salvamentos, compartilhamentos) ' +
      'de um post específico. Read-only. USE quando ele pedir "métricas do ' +
      'último post", "como foi o desempenho do post X". ' +
      'Pra pegar o mediaId, chame instagram_latest_posts antes — o usuário ' +
      'normalmente vai dizer "do último", então use o id do primeiro item.',
    parameters: {
      type: 'object',
      properties: {
        mediaId: {
          type: 'string',
          description: 'ID da mídia no Instagram (vem de instagram_latest_posts).',
        },
      },
      required: ['mediaId'],
    },
  },
  {
    name: 'open_project',
    description:
      'Abre um projeto no VSCode buscando por nome aproximado. ' +
      'Use quando o usuário disser coisas como "abre o projeto X", ' +
      '"abre o repo da empresa Y", "abre a pasta Z no vscode". ' +
      'Faz busca fuzzy no diretório de projetos do usuário e abre o melhor match. ' +
      'Se não achar, retorna lista de alternativas.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Nome ou descrição do projeto. Pode ter palavras soltas ' +
            '(ex: "web girolabs", "easytext", "assistant").',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'desktop_mouse',
    description:
      'Move o cursor do mouse e/ou clica. USE quando o usuário pedir explicitamente ' +
      '"move o mouse pra X", "clica no centro", "clica duplo aqui". Coordenadas ' +
      'em PIXELS por padrão; passe unit="percent" pra usar 0-100% da tela ' +
      '(mais robusto entre resoluções). Action default = "move".',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Coordenada X (pixel ou %)' },
        y: { type: 'number', description: 'Coordenada Y (pixel ou %)' },
        unit: {
          type: 'string',
          enum: ['pixel', 'percent'],
          description: 'Default "pixel". "percent" = 0-100% da tela.',
        },
        action: {
          type: 'string',
          enum: ['move', 'click', 'double_click', 'right_click'],
          description: 'O que fazer ao chegar na posição. Default "move".',
        },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'desktop_type',
    description:
      'Digita texto literal onde o foco do teclado estiver. USE quando o usuário ' +
      'pedir "digita X", "escreve Y aqui". Cuidado: vai pra qualquer janela ' +
      'que tiver foco no momento — confirme antes se for texto sensível.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Texto a digitar.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'desktop_key',
    description:
      'Pressiona uma combinação de teclas. USE pra atalhos: "aperta enter", ' +
      '"copia" (ctrl+c), "fecha janela" (alt+F4). Aceita formato xdotool: ' +
      'Return, Escape, Tab, BackSpace, ctrl+c, alt+Tab, super+l, ctrl+shift+t.',
    parameters: {
      type: 'object',
      properties: {
        combo: {
          type: 'string',
          description: 'Combinação ex: "Return", "ctrl+c", "alt+F4".',
        },
      },
      required: ['combo'],
    },
  },
  {
    name: 'test_desktop_control',
    description:
      'Roda um TESTE ISOLADO do controle de mouse e teclado (xdotool). ' +
      'Move o cursor em quadrado e círculo pela tela, depois digita um texto ' +
      'onde o foco estiver. ~25 segundos. USE quando o usuário pedir "testa o ' +
      'mouse", "testa o teclado", "vê se o controle do mouse funciona". Esc ' +
      'cancela. Avise antes pra ele abrir um editor de texto se quiser ver o ' +
      'typing.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'start_presentation',
    description:
      'Inicia a apresentação automática do Pixxel — script pré-definido que ' +
      'mostra os principais recursos (câmera, memória, busca semântica, ' +
      'visão de objetos, etc) falando e operando o app sozinho. USE quando o ' +
      'usuário disser "faz uma apresentação", "mostra o que você sabe fazer", ' +
      '"demo", "se apresenta", "mostra teus recursos". É BLOQUEANTE durante a ' +
      'execução (~1-2min). Pode ser cancelada a qualquer momento apertando ' +
      'Esc ou dizendo "para a apresentação".',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'morning_briefing',
    description:
      'Briefing matinal: clima de hoje + tasks em progresso e pendentes do ' +
      'ClickUp + uma frase motivacional. Retorna texto curto pronto pra falar.\n' +
      'GATILHOS: usuário diz "bom dia" / "bom diaaa" / "e aí, bom dia" / ' +
      '"vamos começar os trabalhos" / "vamos começar" / "começando o dia" / ' +
      '"vamos pra cima" e variações análogas.\n' +
      'CONDIÇÃO: chama SOMENTE se for a PRIMEIRA mensagem do usuário nesta ' +
      'sessão. Se o usuário já falou qualquer outra coisa antes (mesmo um "oi" ' +
      'simples sem variação de bom dia), NÃO chama — apenas responde normal. ' +
      'Pode chamar no máximo uma vez por sessão.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'restart_app',
    description:
      'Reinicia o Pixxel (fecha + abre de novo). Use quando o usuário pedir ' +
      'pra reiniciar / restartar / reiniciar o assistente / "reinicia ai".\n' +
      'A reinicialização limpa pollers, conexão Live e estado do main process. ' +
      'Antes de chamar a tool, fale UMA frase curta tipo "reiniciando" — depois ' +
      'a janela vai fechar e abrir de novo automaticamente.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'check_clickup_notifications',
    description:
      'Força uma checagem AGORA das notificações do ClickUp do usuário ' +
      '(tasks atribuídas, comentários em tasks dele, menções, mensagens). ' +
      'O poller automático já roda a cada 5min em background, mas use esta ' +
      'tool quando o usuário pedir explicitamente pra checar.\n' +
      'GATILHOS: "tem alguma notificação?", "tem mensagem nova?", "checa o ' +
      'clickup", "alguém me marcou em alguma coisa?", "tem task nova pra ' +
      'mim?", "alguma novidade do trabalho?".\n' +
      'Retorna texto pronto pra falar com resumo. Se não houver nada novo ' +
      'desde o último poll, retorna mensagem indicando que está tudo em dia.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'search_memory',
    description:
      'Busca SEMÂNTICA na memória persistente (~/pixxel/memory/) — encontra ' +
      'entradas relacionadas pelo SIGNIFICADO da pergunta, não só por palavras ' +
      'literais. Use SEMPRE que o usuário perguntar sobre coisas que você lembra ' +
      'mas o nome exato da entrada não casa com a fala — ex: "lembra do que ' +
      'falei sobre como gosto de receber feedback?", "o que você sabe sobre ' +
      'meus gostos musicais?", "tem alguma anotação sobre ferramentas que uso?". ' +
      'Devolve top-N entradas com score, title e snippet — leia e responda em ' +
      'pt-BR mencionando as relevantes em frase curta. NÃO use pra busca por ' +
      'name exato (use o índice da memória que já tá no system prompt).',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Pergunta ou tópico em linguagem natural (ex: "como gosto de ' +
            'receber feedback", "preferências de música").',
        },
        limit: {
          type: 'number',
          description: 'Quantos resultados devolver. Default 5, máximo 10.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_worklogs',
    description:
      'Busca SEMÂNTICA nos worklogs (~/pixxel/work-log/). Encontra ' +
      'sessões antigas pelo SIGNIFICADO da pergunta, não só palavras exatas. ' +
      'USE quando o usuário perguntar "como fiz aquela coisa de X", "lembra ' +
      'quando mexemos em Y", "qual foi a sessão sobre Z" — sem ele dar nome ' +
      'exato de filename. Devolve top-N worklogs com title, snippet e filename. ' +
      'Pra ler o conteúdo completo de um match, chame read_work_log com o ' +
      'filename retornado.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Tópico/descrição em pt-BR do que procura nas sessões antigas.',
        },
        limit: {
          type: 'number',
          description: 'Quantos resultados devolver. Default 5, máximo 10.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_work_logs',
    description:
      'Lista as últimas sessões de trabalho salvas no work-log ' +
      '(~/pixxel/work-log/). Cada sessão tem projeto, task, status (✅/❌/⏳) ' +
      'e data. USE quando o usuário pedir "quais foram minhas últimas sessões", ' +
      '"mostra o histórico de trabalho", "quais worklogs eu tenho" e variações. ' +
      'Read-only.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Quantas sessões listar. Default 10, máximo 30.',
        },
      },
    },
  },
  {
    name: 'read_work_log',
    description:
      'Lê uma sessão específica do work-log e devolve o conteúdo (frontmatter, ' +
      'progresso, tools usadas, resultado) pra você resumir/explicar pro usuário. ' +
      'USE quando ele pedir "olha como fiz X", "me lembra o que fizemos ' +
      'naquela task de Y", "lê o último worklog", "abre aquela sessão sobre Z". ' +
      'Match é fuzzy: você pode passar nome do projeto, palavras da task, ou ' +
      'até o filename inteiro. Se não souber qual, chama list_work_logs antes. ' +
      'Conteúdo vem truncado em ~8k chars.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Termo de busca: nome do projeto, palavras da task, ou filename. ' +
            'Ex: "easytax download", "girolabs", ou o filename exato.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'remember',
    description:
      'Cria uma nova entrada na memória persistente (vault de markdown em ~/pixxel/memory/, ' +
      'visível no Obsidian). Sobrevive entre sessões.\n' +
      'REGRA DE OURO: se o usuário pedir EXPLICITAMENTE pra lembrar algo ("lembra disso", ' +
      '"anota aí", "guarda essa info", "memoriza X") → CHAMA SEMPRE, sem julgar se é ' +
      'útil ou trivial. Pedido explícito do usuário sobrepõe qualquer outro critério. ' +
      'Use type=user e descreva no content o que ele pediu pra lembrar.\n' +
      'QUANDO USAR PROATIVAMENTE (sem ele pedir) — só se for útil em sessões futuras:\n' +
      '  • type=user: perfil/profissão/empresa/gostos fortes/contexto pessoal recorrente.\n' +
      '  • type=feedback: correção ("não faça X") OU validação não-óbvia ("isso, continua ' +
      'assim"). SEMPRE inclua o motivo no content (Why) e quando aplicar (How to apply).\n' +
      '  • type=project: decisão/prazo/motivação de uma iniciativa em curso. Inclua Why e ' +
      'How to apply. Datas em formato absoluto (ex: 2026-05-07), nunca "quinta".\n' +
      '  • type=reference: ponteiro pra sistema externo (link, ID, dashboard).\n' +
      'NÃO SALVE: estado temporário da sessão atual, info que muda rápido (clima/tasks), ' +
      'dado já presente em código/git, pedidos one-off, ofensas pontuais, qualquer coisa ' +
      'sem valor cross-session.\n' +
      'ANTES DE SALVAR: olhe o índice da MEMÓRIA PERSISTENTE no system prompt. Se já ' +
      'existe entrada parecida, chame update_memory em vez de criar duplicata. Use links ' +
      'pra conectar com entradas relacionadas (vai virar wikilink no Obsidian).',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Slug curto, lowercase, [a-z0-9_-], prefixado pelo tipo. ' +
            'Ex: "user_role", "feedback_no_mocks", "project_clickup_migration", "reference_grafana_oncall".',
        },
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference'],
          description: 'Categoria da memória.',
        },
        description: {
          type: 'string',
          description:
            'Uma linha (max 200 chars) que vai pro índice — seja específica, é o que vai te ' +
            'ajudar a decidir relevância em futuras sessões.',
        },
        content: {
          type: 'string',
          description:
            'Corpo da entrada em markdown (max 4000 chars). Para feedback/project, ' +
            'estruture com **Why:** (motivo dado pelo usuário) e **How to apply:** ' +
            '(quando esta regra/fato deve guiar comportamento). Para user/reference, ' +
            'texto livre conciso.',
        },
        links: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Opcional. Names de outras entradas relacionadas — viram [[wikilink]] no ' +
            'Obsidian e aparecem no grafo. Só linke se a entrada já existe no índice.',
        },
      },
      required: ['name', 'type', 'description', 'content'],
    },
  },
  {
    name: 'update_memory',
    description:
      'Atualiza uma entrada existente da memória (description, content e/ou links). ' +
      'Use quando o usuário corrige/expande algo já salvo, OU quando você ia chamar ' +
      'remember mas viu no índice que já existe entrada equivalente. Não duplique.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name exato da entrada existente (vê no índice).',
        },
        description: { type: 'string', description: 'Nova description (opcional).' },
        content: { type: 'string', description: 'Novo content completo (substitui — opcional).' },
        links: {
          type: 'array',
          items: { type: 'string' },
          description: 'Nova lista de links (substitui — opcional).',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'forget_memory',
    description:
      'Remove uma entrada da memória pelo name. Use SOMENTE quando o usuário pedir ' +
      'explicitamente ("esquece X", "apaga aquela anotação sobre Y"). Nunca apaga em massa.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name exato da entrada a remover (vê no índice).',
        },
      },
      required: ['name'],
    },
  },
];

// Tools de captura de ideias: usadas quando o usuário pede algo que
// nenhuma outra tool resolve. Fluxo: Gemini detecta o gap, oferece os
// 3 caminhos por voz (anota / planeja / implementa) e chama a tool
// adequada conforme a resposta.
export const IDEAS_TOOLS: ToolDeclaration[] = [
  {
    name: 'save_idea',
    description:
      'Anota uma ideia/feature pedida pelo usuário no IDEIAS.md pra fazer ' +
      'depois. USE quando o usuário pediu algo que NENHUMA outra tool resolve ' +
      '(ex: nova integração, feature inexistente) E ele respondeu apenas ' +
      '"anota", "salva", "guarda" — sem querer planejar nem implementar agora.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description:
            'Título curto da feature (3-8 palavras). Ex: "Integração com Notion".',
        },
        description: {
          type: 'string',
          description:
            'Uma frase descrevendo o que o usuário pediu, em pt-BR.',
        },
      },
      required: ['title', 'description'],
    },
  },
  {
    name: 'plan_feature',
    description:
      'Planeja a implementação de uma feature nova e grava em IDEIAS.md. ' +
      'USE quando o usuário disse pra "planejar" ou "fazer um plano". ' +
      'VOCÊ elabora o plano completo no parâmetro `plan` (passos técnicos, ' +
      'arquivos envolvidos, riscos, tools/libs sugeridas).',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Título curto da feature (3-8 palavras).',
        },
        description: {
          type: 'string',
          description: 'Uma frase resumindo o que o usuário pediu.',
        },
        plan: {
          type: 'string',
          description:
            'Plano técnico COMPLETO em markdown (pode ter listas e ' +
            'subtítulos). Inclua: passos de implementação, arquivos/módulos ' +
            'a tocar, dependências externas, riscos, alternativas mais simples.',
        },
      },
      required: ['title', 'description', 'plan'],
    },
  },
];

// Tools de UI: controlam o estado visual do app (abrir/fechar painéis).
// Não são ClientCommand nem integração — main dispatcher trata direto.
export const UI_TOOLS: ToolDeclaration[] = [
  {
    name: 'open_chat',
    description:
      'Abre ou fecha o painel de chat (a janela com a conversa em texto). ' +
      'Use quando o usuário pedir "abre o chat", "mostra o chat", "fecha o chat", ' +
      '"esconde o chat" ou variações.',
    parameters: {
      type: 'object',
      properties: {
        open: {
          type: 'boolean',
          description: 'true pra abrir, false pra fechar. Default true.',
        },
      },
    },
  },
  {
    name: 'show_memory',
    description:
      'Abre ou fecha o painel de visualização da memória persistente — um grafo ' +
      'que mostra todas as entradas do vault (~/pixxel/memory/) agrupadas por tipo ' +
      'e conectadas pelos wikilinks. Use quando o usuário disser "me mostra sua ' +
      'memória", "deixa eu ver sua memória", "deixa eu ver como está sua memória", ' +
      '"abre o grafo da memória", "mostra o que você lembra de mim" e variações. ' +
      'Pra fechar: "fecha a memória", "esconde o grafo".',
    parameters: {
      type: 'object',
      properties: {
        open: {
          type: 'boolean',
          description: 'true pra abrir, false pra fechar. Default true.',
        },
      },
    },
  },
  {
    name: 'open_camera',
    description:
      'CHAMA SEMPRE quando o usuário disser "abre a câmera", "liga a câmera", ' +
      '"me mostra a câmera", "fecha a câmera", "desliga a câmera" e variações ' +
      'óbvias. Esta tool ABRE/FECHA o painel da webcam — você não precisa ' +
      'pedir nada ao usuário, apenas chama com open=true ou open=false. ' +
      'OBRIGATÓRIO passar `open` explicitamente — true pra abrir, false pra ' +
      'fechar. NUNCA omita o parâmetro. NÃO confundir com look_at_camera ' +
      '(que é pra OLHAR/analisar a imagem). Se o usuário disser "abre a ' +
      'câmera e olha pra mim", chama open_camera com open=true PRIMEIRO e ' +
      'depois look_at_camera no mesmo turno.',
    parameters: {
      type: 'object',
      properties: {
        open: {
          type: 'boolean',
          description:
            'true pra abrir, false pra fechar. SEMPRE passe explicitamente.',
        },
      },
      required: ['open'],
    },
  },
];

export const UI_TOOL_NAMES: Set<string> = new Set(UI_TOOLS.map((t) => t.name));

export const IDEAS_TOOL_NAMES: Set<string> = new Set(IDEAS_TOOLS.map((t) => t.name));

export const CLAUDE_TOOLS: ToolDeclaration[] = [
  {
    name: 'claude_code_task',
    description:
      'Dispara uma tarefa de código pra rodar em background no projeto ativo (ou no projeto especificado em `project`). ' +
      'Use SEMPRE que o usuário pedir pra mexer no código: criar/editar/refatorar arquivo, rodar comando, debugar, ' +
      'implementar feature, ajustar UI. NÃO confirme verbalmente sem chamar — falar "vou fazer X" sem disparar é BUG. ' +
      'A tarefa roda assíncrona; o resultado chega depois e você anuncia em primeira pessoa SEM mencionar "Claude" nem agente externo.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            'Descrição clara do que fazer, em português. Inclua arquivos/símbolos quando o usuário citou. ' +
            'Ex: "ajusta o botão de submit em LoginForm.tsx pra ficar azul" ou "extrai um hook useDebounce de App.tsx".',
        },
        project: {
          type: 'string',
          description:
            'Nome do projeto pra rodar (ex: "easytax-web", "pixxel"). OPCIONAL — se omitir, usa o projeto ativo. ' +
            'Só passe se o usuário citou explicitamente outro projeto.',
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'claude_cancel_task',
    description:
      'Cancela tarefa(s) de código rodando. Use quando o usuário disser "cancela", "para", "interrompe". ' +
      'Comportamento por `target`:\n' +
      '- omitido + 1 sessão rodando → cancela essa\n' +
      '- omitido + >1 rodando → retorna { ok: false, reason: "ambiguous", running: [...] }; LISTE pro usuário e pergunte qual\n' +
      '- "all"/"todas" → cancela todas + esvazia fila\n' +
      '- nome de projeto (fuzzy match: "easytax", "pixxel") → cancela a desse projeto. Se >1 sessão no mesmo projeto, ambíguo\n' +
      '- sessionId UUID → cancela específica\n' +
      'NUNCA invente "não tinha nada rodando" sem ver o retorno.',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description:
            'Opcional. "all"/"todas" pra cancelar todas, nome do projeto pra fuzzy match, ou sessionId UUID. Omita pra cancelar a única rodando.',
        },
      },
    },
  },
  {
    name: 'claude_list_sessions',
    description:
      'Lista tarefas de código em andamento + tamanho da fila. ' +
      'Use quando o usuário perguntar "o que tá rodando?", "tem alguma tarefa em andamento?", ' +
      '"quantas tarefas?", "quais tarefas estão rodando?". ' +
      'Também útil ANTES de cancelar quando você não sabe qual escolher.',
    parameters: { type: 'object', properties: {} },
  },
];

export const CLAUDE_TOOL_NAMES: Set<string> = new Set(CLAUDE_TOOLS.map((t) => t.name));

export const ALL_TOOLS: ToolDeclaration[] = [
  ...CLIENT_COMMAND_TOOLS,
  ...INTEGRATION_TOOLS,
  ...UI_TOOLS,
  ...IDEAS_TOOLS,
  ...CLAUDE_TOOLS,
];
