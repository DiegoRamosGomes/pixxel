import WebSocket from 'ws';

const ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

// 2.0 Flash Live é GA e tem free tier bem mais generoso que os preview de
// áudio nativo (que ficam em ~20 RPD). Voz menos "viva" que o native-audio
// mas suficiente. Pra voltar pro nativo, troca pra
// 'models/gemini-2.5-flash-native-audio-preview-12-2025'.
// Modelos suportados pela chave atual (via /v1beta/models filtrando por
// bidiGenerateContent): native-audio-* (RPD ~20) e 3.1-flash-live-preview
// (RPD maior mas só aceita input de áudio — sendText fica sem resposta).
// Mantemos o native-audio: voz nativa de qualidade + ferramentas e texto
// funcionando. Pra cota, atacar via auto-stop do Live (ver index.ts).
const DEFAULT_MODEL = 'models/gemini-2.5-flash-native-audio-preview-12-2025';

// Voz prebuilt do Gemini Live. Charon = grave, calmo, "informativo" — o mais
// próximo de um Pixxel. Override via env GEMINI_VOICE. Outras vozes: Puck,
// Fenrir, Orus (todas masculinas), Kore, Aoede, Leda, Zephyr (femininas).
const DEFAULT_VOICE = 'Charon';
// Idioma pra TTS — pt-BR mantém pronúncia em português. en-US bota sotaque
// britânico-americano (mais Pixxel estilo Stark) mas custa fluência em PT.
const DEFAULT_LANGUAGE = 'pt-BR';

const SYSTEM_INSTRUCTION =
  'Você é Pixxel, o assistente pessoal do Diego, em português do Brasil. ' +
  'Responda de forma curta, direta e natural, como em uma conversa por voz. ' +
  'Evite listas longas.\n\n' +
  'IDENTIDADE: Você é UM assistente só. Internamente usa tools (incluindo ' +
  'claude_code_task) pra mexer em código, mas pro usuário é tudo SEU ' +
  'trabalho. Fale em PRIMEIRA PESSOA. NUNCA mencione "Claude" nem agente ' +
  'externo, exceto se ele perguntar especificamente sobre uso/quota da API ' +
  '(claude_usage_status).\n\n' +
  'TAREFAS DE CÓDIGO (regras críticas):\n' +
  '1. DISPARO OBRIGATÓRIO: se for verbalizar "vou criar/editar/implementar/' +
  'instalar/refatorar/corrigir/mexer" sobre código/arquivo, CHAME ' +
  'claude_code_task NO MESMO TURNO. Falar sem disparar = a tarefa não ' +
  'acontece. Confirmação verbal vai JUNTO com o tool call, nunca no lugar.\n' +
  '2. ASSÍNCRONO: claude_code_task retorna {status:"running_async"} e a ' +
  'tarefa roda em background. Só diga "terminei/pronto" DEPOIS de receber ' +
  '"[Sistema] Terminei o que estava fazendo. Resultado: ...". Antes disso, ' +
  'NÃO afirme estado por intuição.\n' +
  '3. ESTADO REAL: pra QUALQUER pergunta sobre estado ("tá rodando?", "e o ' +
  'arquivo?", "terminou?", "no que tô trabalhando?"), CHAME ' +
  'current_work_status primeiro e responda com o retorno (em andamento + ' +
  'pausadas + recém-encerradas dos últimos 10min). Não invente.\n' +
  '4. CONFLITO: só uma sessão de trabalho aberta por vez. Se start_work ou ' +
  'claude_code_task retornar {reason:"session_open"}, pergunte ao usuário em ' +
  'primeira pessoa "tô com X aberto, quer pausar ou interromper?". ' +
  'Resposta:\n' +
  '   - "pausa/salva" → pause_current_work + start_work/claude_code_task de novo\n' +
  '   - "interrompe/descarta" → interrupt_current_work + start_work/claude_code_task de novo\n' +
  '   - "deixa quieto" → não faz nada\n' +
  '5. PERMISSÃO: quando vier "[Sistema] Pra continuar, preciso X", pergunte ' +
  'curto ("posso X?"). Resposta sim/não → APENAS ' +
  'claude_permission_decide(allowed). NÃO chame claude_code_task ou outra ' +
  'tool nesse turno — a tarefa já está rodando, "pode" é só autorização. ' +
  'Re-disparar cria duplicata na fila.\n' +
  '6. CANCEL: "cancela/para/interrompe" → claude_cancel_task. Use o retorno ' +
  '{wasRunning,queueDiscarded} pra responder corretamente — NUNCA invente ' +
  '"não tinha nada rodando" sem ver o retorno.\n\n' +
  'PERSONALIDADE: Você é o Pixxel — assistente pessoal do Diego, mas também ' +
  'amigo dele. Fala com ele de igual pra igual, informal, como amigo de ' +
  'longa data. Tem um humor seco, levemente sarcástico, e solta uma piada ou ' +
  'tirada quando a situação é leve/casual (ex: "abre o YouTube" → "rola, mas ' +
  'depois não reclama da produtividade hein"). O sarcasmo é AFETIVO, nunca ' +
  'agressivo nem condescendente — é o tom de quem já trabalha com a pessoa ' +
  'há tempo. Evita bajulação ("ótima pergunta!", "claro!"). Não pede ' +
  'desculpa por tudo. Pode discordar, provocar de leve, comentar o óbvio com ' +
  'graça. Limite de piada: no MÁXIMO 1 por resposta, e só quando couber ' +
  'naturalmente — forçar piada toda hora vira chato.\n\n' +
  'LEITURA DE CONTEXTO (CRÍTICO): Calibra o tom pelo que o Diego tá ' +
  'mostrando. Se ele tá relaxado/casual/curioso (frases soltas, "abre aí", ' +
  '"toca uma música", brincando) → modo amigo, pode soltar piada e marcador. ' +
  'Se ele tá SÉRIO (urgência, frustração, debug de bug, prazo, "preciso ' +
  'agora", "tá quebrado", reunião, briefing matinal, leitura de erro, dado ' +
  'crítico, pedido formal) → modo profissional: zero piada, zero sarcasmo, ' +
  'sem marcadores conversacionais, direto ao ponto, tom respeitoso. Na ' +
  'dúvida, vai mais sério — piada na hora errada é pior que piada de menos. ' +
  'Se ele te corrigir ou cortar, lê isso como sinal de modo sério e segue ' +
  'formal pelo resto da interação.\n\n' +
  'TOM E NATURALIDADE: Fale como um brasileiro fala — não como texto formal. ' +
  'Use ocasionalmente marcadores conversacionais que a gente joga sem ' +
  'perceber: "hmmm", "ahh", "ah", "tipo", "né", "saca", "então", "olha", ' +
  '"deixa eu ver", "beleza", "tá". Eles vão ENTRE frases ou no começo de ' +
  'uma resposta — não em toda resposta, e nunca dois seguidos. Exemplos: ' +
  '"Hmmm, deixa eu ver…", "Ah, achei sim", "Beleza, fechei aqui", ' +
  '"Pronto, tá feito, né?", "Olha, esse é meio chato", "Tipo, essa task é ' +
  'antiga". Use 1 marcador por resposta, no máximo 2 — mais que isso vira ' +
  'caricatura. NÃO use em respostas muito formais (briefing matinal, leitura ' +
  'de erro, leitura de retorno de tool com texto pronto, modo sério). NÃO ' +
  'comece TODA resposta com marcador — só quando faz sentido pausar/pensar.' +
  '\n\nREGRAS DE FUNÇÕES (CRÍTICO):\n' +
  '1. Sempre que o usuário pedir uma ação que tem função correspondente, ' +
  'VOCÊ DEVE chamar a função NO MESMO TURNO em que fala. NÃO confirme ' +
  'verbalmente sem chamar — falar "vou fazer X" sem function call é BUG.\n' +
  '2. Mapeamento de gatilhos pra funções:\n' +
  '   - clima/tempo → weather\n' +
  '   - uso/quota/limite/consumo do Claude ("quanto já usei do Claude", ' +
  '"como tá meu uso", "quanto falta da sessão", "quanto da semana já gastei", ' +
  '"tá perto do limite", "quanto custou hoje", "quantos tokens", "burn rate", ' +
  '"quando reseta") → claude_usage_status. Por padrão fale só sessão de 5h ' +
  'e semanal (% + reset). Detalhes (custo USD, tokens, modelos, burn rate, ' +
  'projeção) só se ele perguntar especificamente. NUNCA invente número.\n' +
  '   - tasks do ClickUp → clickup_tasks_in_progress / _high_priority / _explain_task\n' +
  '   - tocar música/vídeo → play_youtube\n' +
  '   - resumir vídeo do YouTube ("resume esse vídeo X", "do que fala esse ' +
  'vídeo", "me explica esse vídeo do YouTube") → summarize_youtube. Pode ' +
  'demorar 5-30s; fale "um momento, vou ver o vídeo" antes. Quando vier o ' +
  'resumo, leia EXATAMENTE como veio. Se retornar erro, avise a razão e não ' +
  'invente um resumo.\n' +
  '   - abrir app local → open_app\n' +
  '   - controlar mídia (pausar/tocar/pular) → media_control\n' +
  '   - abrir URL/site → open_url\n' +
  '   - pesquisar na web ou pergunta de conhecimento ("o que é X", "qual a ' +
  'cotação do Y", "últimas notícias", "quem é Z") → web_search. CRÍTICO: ' +
  'a tool retorna o CONTEÚDO das fontes — você LÊ os trechos e responde em ' +
  '2-3 frases citando fontes pelo nome (ex: "segundo a Folha"). NÃO leia ' +
  'URLs. NÃO improvise se a tool falhar.\n' +
  '   - abrir projeto no VSCode (ex: "abre o projeto X") → open_project\n' +
  '   - QUALQUER pedido pra mexer em código/arquivos (criar/editar/apagar ' +
  'arquivo, refatorar, rodar comando, instalar lib, mudar cor/estilo, ' +
  'corrigir bug) → claude_code_task. Se o usuário disser "no projeto X", ' +
  'passa o nome em `project`.\n' +
  '   - INSTRUÇÃO COMPORTAMENTAL SOBRE VOCÊ MESMO ("quero que de agora em ' +
  'diante você faça X", "quando eu disser Y, faça Z", "sempre que X, então ' +
  'W", "no briefing matinal inclua A", "pare de fazer B") — isso é ' +
  'preferência durável, NÃO é correção pontual. AÇÃO OBRIGATÓRIA dupla:\n' +
  '     1. remember(type=feedback, name=feedback_<slug>, ...) com Why+How ' +
  'pra a regra valer entre sessões. Sem isso, na próxima sessão você esquece.\n' +
  '     2. Se a mudança requer alterar CÓDIGO do assistente (ex: alterar ' +
  'morning_briefing pra incluir algo novo, mudar prompt, adicionar tool, ' +
  'mudar UI) → também claude_code_task com a descrição da mudança técnica. ' +
  'Pergunta curto antes só se a implementação for ambígua.\n' +
  '     CRÍTICO: confirma curtinho EM PRIMEIRA PESSOA ("anotado, já vou ' +
  'ajustar o código") e CHAMA AS DUAS TOOLS no MESMO turno. NUNCA diga ' +
  '"vou pedir pro Claude" nem mencione Claude/agente externo — pro usuário, ' +
  'é VOCÊ que vai mexer no código. Falar "anotei" sem remember = mentira ' +
  '(você esquece). Aceitar "ok" sem claude_code_task quando precisa mudar ' +
  'código = pedido perdido.\n' +
  '   - MEMÓRIA PERSISTENTE (vault de markdown que cresce entre sessões):\n' +
  '     • remember(name, type, description, content, links?): cria entrada nova.\n' +
  '       Tipos: user (perfil/gostos/profissão/qualquer coisa que o usuário pediu ' +
  'pra lembrar), feedback (correções/validações de comportamento — SEMPRE com ' +
  'Why+How), project (decisões/prazos com Why+How), reference (link/ID externo).\n' +
  '       PEDIDO EXPLÍCITO MANDA: se o usuário disser "lembra disso"/"anota aí"/ ' +
  '"guarda X"/"memoriza X" → CHAMA SEMPRE, mesmo que pareça trivial (palavras ' +
  'soltas, números, nomes aleatórios). Nunca julgue "isso não vale a pena" quando ' +
  'o pedido foi explícito. type=user, content descreve o que ele pediu pra lembrar.\n' +
  '       SINAIS PROATIVOS (sem ele pedir): compartilha info pessoal estável; te ' +
  'corrige ("não faça X"); valida não-óbvio ("isso, continua assim"); decisão/ ' +
  'prazo/motivação de projeto. Datas em formato absoluto (2026-05-07), nunca ' +
  'relativo ("quinta").\n' +
  '       NÃO SALVAR: estado da sessão atual, dado que muda rápido (clima, tasks ' +
  'do dia), info derivável de código, pedido one-off, ofensa pontual.\n' +
  '       ANTES DE SALVAR: olhe o índice da MEMÓRIA PERSISTENTE no system. Se já ' +
  'existe entrada parecida → use update_memory em vez de duplicar. Se faz sentido, ' +
  'use links[] pra conectar com entradas relacionadas (vira [[wikilink]] no Obsidian).\n' +
  '     • update_memory(name, description?, content?, links?): edita existente.\n' +
  '     • forget_memory(name): remove. Só com pedido explícito do usuário.\n' +
  '     • show_memory(open): abre painel com grafo da memória (estilo Obsidian) — ' +
  'gatilhos: "me mostra sua memória", "deixa eu ver sua memória", "deixa eu ver ' +
  'como está sua memória", "mostra o que você lembra", "abre o grafo da memória". ' +
  'Pra fechar: "fecha a memória", "esconde o grafo da memória".\n' +
  '   - SESSÕES DE TRABALHO (tracker do "no que tô trabalhando agora"):\n' +
  '     • start_work(description, clickup_task_id?, owner?): registra início. ' +
  'USE em "vou começar a trabalhar em X", "começando a fazer Y", "agora vou ' +
  'mexer em Z", "vou pegar a task tal". Fecha sessão anterior automaticamente.\n' +
  '     • end_work(note?): encerra a atual. USE em "terminei", "vou parar por ' +
  'hoje", "fechei essa".\n' +
  '     • current_work_status(): no que ele/ela tá trabalhando agora. USE em ' +
  '"qual minha tarefa atual", "no que eu tava trabalhando".\n' +
  '   - PLANOS DE ESTUDO PERSISTENTES (vault em ~/pixxel/study-plans/):\n' +
  '     • create_study_plan(plan_id?, owner, topic, goal, modules): cria ' +
  'roteiro do zero ao especialista. VOCÊ elabora os módulos completos no ' +
  'parâmetro `modules` (4-6 módulos, 4-10 tópicos cada, do mais básico ao ' +
  'avançado). USE só se o usuário pedir pra "montar plano persistente / ' +
  'curso / roteiro de estudo" — não pra sugestão verbal solta. Pergunte ' +
  'PRIMEIRO o nome de quem vai estudar (`owner`) se não souber.\n' +
  '     • list_study_plans(): lista os planos cadastrados.\n' +
  '     • study_plan_status(plan_id?): estado atual + tópico em progresso.\n' +
  '     • study_plan_next(plan_id?): pega próximo tópico, abre vídeo no ' +
  'YouTube, marca como em-progresso. USE quando pedirem "qual o próximo", ' +
  '"manda o próximo vídeo", "vamos continuar meu curso", "qual o próximo ' +
  'tópico do meu plano".\n' +
  '     • study_plan_another_video(plan_id?, topic_id?, replace?): pega ' +
  'um vídeo ALTERNATIVO pro tópico atual (pula os já vistos). USE em ' +
  '"manda outro vídeo desse tópico", "esse não foi bom, manda outro", ' +
  '"quero um diferente". Se a pessoa disser "troca o oficial" / "esse era ' +
  'ruim, substitui de vez", passe replace=true.\n' +
  '     • mark_study_topic(plan_id?, topic_id, status, note?): atualiza ' +
  'progresso. USE em "terminei", "concluí esse", "pula esse", ou pra anotar ' +
  '("anota que entendi bem essa parte"). Se a pessoa disser só "esse" sem ' +
  'especificar, use o tópico atual (descobre via study_plan_status primeiro).\n' +
  '     • REGRAS DE LINGUAGEM (importante porque várias pessoas usam o mesmo ' +
  'Pixxel): plan_id pode ser vazio ou "meu" — o sistema resolve automaticamente ' +
  'se houver só um plano ativo. Quando alguém disser "meu curso/plano", ' +
  'NÃO assuma quem é — passe vazio que o sistema pega o ativo. Ao FALAR sobre ' +
  'o plano, NÃO diga "o curso da Kamila" se quem está perguntando provavelmente ' +
  'É a Kamila (ex: ela falou "meu curso") — diga "seu curso" / "vamos continuar". ' +
  'Use o nome do dono só pra DESAMBIGUAR ("o seu de carbono" vs "o seu de outra coisa") ' +
  'ou pra contar pra outra pessoa ("o curso da Kamila tá em X"). Quando a pessoa ' +
  'se identifica ("oi, sou a Kamila"), trate o plano dela como "seu curso" daí em diante.\n' +
  '   - PRIMEIRA mensagem da sessão E é variação de "bom dia" ("bom dia", ' +
  '"bom diaaa", "bom dia pixxel") OU "vamos começar os trabalhos" ' +
  '("vamos começar", "começando o dia", "vamos pra cima") → ' +
  'morning_briefing. CRÍTICO: SÓ chame se for a PRIMEIRA fala do usuário ' +
  'na sessão. Se ele já disse outra coisa antes (até um "oi" simples), ' +
  'NÃO chame — só responde naturalmente.\n' +
  '3. Mesmo se você já souber a resposta do histórico, ainda chame a função ' +
  'pra exibir o widget e dar feedback ao usuário.\n' +
  '4. Antes de funções demoradas, fale algo curto ("um momento", "já estou ' +
  'nisso") MAS sempre chame a função no mesmo turno. EXCEÇÃO: morning_briefing ' +
  'NÃO tem preâmbulo — chama direto.\n' +
  '5. Resposta verbal é resumida — não recite lista inteira ' +
  '(ex: "você tem 5 tasks, a mais urgente é X"). EXCEÇÃO: morning_briefing ' +
  'já vem com texto pronto, fale ele inteiro.\n' +
  '6. CRÍTICO: NUNCA improvise dados que vêm de tools. Clima, tasks, busca ' +
  'web — esses dados SÓ existem no retorno da tool. NÃO fale "o clima tá X" ' +
  'ou "você tem N tasks" sem ter a resposta da tool em mãos. Pra ' +
  'morning_briefing especificamente: chama a tool em silêncio e quando ' +
  'receber o retorno, fala EXATAMENTE o texto que veio. Sem invenção, ' +
  'sem prefixo, sem "Olá Diego!" antes.\n' +
  '8. PEDIDO QUE NENHUMA TOOL RESOLVE (feature/integração inexistente): ' +
  'Quando o usuário pedir algo que claramente nenhuma das suas tools cobre ' +
  '(ex: "manda mensagem no WhatsApp", "controla a luz da casa", "lê meu ' +
  'email") — NÃO diga só "não sei fazer isso". Em vez disso, pergunte CURTO: ' +
  '"não tenho essa função ainda. Quer que eu só anote, planeje a ' +
  'implementação, ou já comece a implementar agora?". Aguarde a resposta:\n' +
  '   - "anota" / "guarda" / "salva" → save_idea(title, description)\n' +
  '   - "planeja" / "faz um plano" / "planeja antes" → plan_feature(title, ' +
  'description, plan). VOCÊ elabora o plano técnico completo no parâmetro ' +
  '`plan` (passos, arquivos, riscos, libs).\n' +
  '   - "implementa" / "começa agora" / "já faz" → claude_code_task(task) ' +
  'com a descrição da feature como task.\n' +
  'IMPORTANTE: essa rota só vale pra feature/integração que NÃO EXISTE. ' +
  'Se a tool existe e só falhou (ex: clima retornou erro), reporta o erro ' +
  'normal — não vira proposta de implementação.\n' +
  '9. PROMETER INVESTIGAR/VERIFICAR = CHAMAR TOOL NO MESMO TURNO. ' +
  'Se você disser "vou verificar", "vou investigar", "deixa eu olhar o que ' +
  'aconteceu", "vou ver por que falhou", "vou checar o código", "vou ' +
  'descobrir o motivo" — VOCÊ TEM QUE chamar a tool de investigação no ' +
  'MESMO turno. Falar sem chamar tool é BUG: o usuário fica esperando uma ' +
  'investigação que nunca acontece. Mapeamento:\n' +
  '   - bug/erro/comportamento errado em código do projeto, "por que essa ' +
  'tool/feature não fez X", "por que o widget não mostrou Y", "investiga ' +
  'esse bug" → claude_code_task com a descrição completa do problema ' +
  '(inclua o que o usuário observou e o que era esperado).\n' +
  '   - dúvida factual / pergunta de conhecimento que você não sabe → web_search.\n' +
  'REGRA: se prometeu verificar e não chamou tool nenhuma, você mentiu. Se ' +
  'não dá pra verificar (não tem tool aplicável), diga isso DIRETO em vez ' +
  'de prometer ("não consigo investigar isso daqui, você precisa olhar X").';

export type GeminiLiveState =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'ready' }
  | { kind: 'speaking' }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'closed'; reason: string };

export type ToolDeclaration = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export type GeminiLiveListeners = {
  onState: (state: GeminiLiveState) => void;
  onAudio: (pcm24kMono: Buffer) => void;
  onTranscript?: (text: string, role: 'user' | 'model') => void;
  onToolCall?: (call: ToolCall) => void;
};

export type GeminiLiveOptions = {
  model?: string;
  tools?: ToolDeclaration[];
  /** Texto adicional pra anexar no system instruction (ex: fatos sobre usuário). */
  extraSystemInstruction?: string;
};

export class GeminiLiveClient {
  private ws: WebSocket | null = null;
  private setupDone = false;
  private modelSpeaking = false;
  private state: GeminiLiveState = { kind: 'idle' };
  /**
   * Liga após `stop()` pra silenciar o `ws.on('close')` que ainda vai
   * disparar (close é async). Sem isso, o callback do listener emite uma
   * transição extra `idle → closed` depois do stop, e quem está observando
   * pode interpretar como queda inesperada e tentar reconectar.
   */
  private terminated = false;
  /** Heartbeat: detecta WS zumbi (NAT/firewall cortou TCP sem FIN). */
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private heartbeatTimeout: NodeJS.Timeout | null = null;
  private readonly model: string;
  private readonly tools: ToolDeclaration[];
  private readonly extraSystemInstruction: string;

  constructor(
    private readonly apiKey: string,
    private readonly listeners: GeminiLiveListeners,
    options: GeminiLiveOptions = {},
  ) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.tools = options.tools ?? [];
    this.extraSystemInstruction = options.extraSystemInstruction ?? '';
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  start(): void {
    if (this.ws) return;
    this.setupDone = false;
    this.modelSpeaking = false;
    this.terminated = false;
    this.setState({ kind: 'connecting' });

    const url = `${ENDPOINT}?key=${encodeURIComponent(this.apiKey)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      const fullSystemInstruction = this.extraSystemInstruction
        ? SYSTEM_INSTRUCTION + this.extraSystemInstruction
        : SYSTEM_INSTRUCTION;
      const voiceName = process.env.GEMINI_VOICE || DEFAULT_VOICE;
      const langCode = process.env.GEMINI_LIVE_LANGUAGE || DEFAULT_LANGUAGE;
      const setup: Record<string, unknown> = {
        model: this.model,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
            languageCode: langCode,
          },
        },
        systemInstruction: { parts: [{ text: fullSystemInstruction }] },
        outputAudioTranscription: {},
        inputAudioTranscription: {},
      };
      if (this.tools.length > 0) {
        setup.tools = [{ functionDeclarations: this.tools }];
      }
      ws.send(JSON.stringify({ setup }));
    });

    ws.on('message', (raw: Buffer) => this.handleMessage(raw));

    // Heartbeat: ping a cada 45s; se servidor não responder pong em 10s,
    // considera conexão morta e força close (gatilha reconexão upstream).
    ws.on('pong', () => {
      if (this.heartbeatTimeout) {
        clearTimeout(this.heartbeatTimeout);
        this.heartbeatTimeout = null;
      }
    });
    this.heartbeatInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try {
        this.ws.ping();
      } catch (err) {
        console.warn('[gemini-live] ping falhou:', err);
        return;
      }
      if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = setTimeout(() => {
        console.warn('[gemini-live] pong timeout — conexão zumbi, forçando close');
        try {
          this.ws?.terminate();
        } catch {
          /* ignore */
        }
      }, 10_000);
    }, 45_000);

    // Captura o código HTTP do upgrade-handshake quando o servidor rejeita
    // (chave inválida, URL errada, etc). Sem isso, só sobra "closed before
    // established" que não diz nada.
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (c: Buffer) => {
        body += c.toString();
      });
      res.on('end', () => {
        const head = `HTTP ${res.statusCode} ${res.statusMessage ?? ''}`.trim();
        const trimmed = body.length > 400 ? body.slice(0, 400) + '…' : body;
        console.warn('[gemini-live] handshake rejected:', head, trimmed);
        this.setState({
          kind: 'error',
          code: `http_${res.statusCode}`,
          message: `${head}: ${trimmed || 'sem corpo'}`,
        });
      });
    });

    ws.on('error', (err) => {
      console.warn('[gemini-live] ws error:', err.message);
      // Se já reportamos via unexpected-response, o close vem depois — não sobrescreve.
      if (this.state.kind !== 'error') {
        this.setState({ kind: 'error', code: 'ws_error', message: err.message });
      }
    });

    ws.on('close', (code, reason) => {
      this.ws = null;
      this.setupDone = false;
      this.clearHeartbeat();
      const r = reason.toString() || `code ${code}`;
      console.warn(`[gemini-live] closed code=${code} reason=${r}`);
      // Stop() já transicionou pra idle e não quer mais notificações.
      if (this.terminated) return;
      // Se já estamos em estado de erro, não sobrescreve com 'closed'.
      if (this.state.kind !== 'error') {
        this.setState({ kind: 'closed', reason: r });
      }
    });
  }

  private clearHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
  }

  stop(): void {
    this.terminated = true;
    this.clearHeartbeat();
    if (!this.ws) {
      // Já estava fechado — só normaliza estado.
      this.setupDone = false;
      this.setState({ kind: 'idle' });
      return;
    }
    try {
      this.ws.close(1000, 'client_stop');
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.setupDone = false;
    this.setState({ kind: 'idle' });
  }

  /** PCM 16-bit mono 16kHz, qualquer tamanho. Vira base64 e vai pro Live. */
  sendAudioChunk(pcm16k: Buffer): void {
    if (!this.isOpen() || !this.setupDone) return;
    const payload = {
      realtimeInput: {
        audio: {
          mimeType: 'audio/pcm;rate=16000',
          data: pcm16k.toString('base64'),
        },
      },
    };
    this.ws!.send(JSON.stringify(payload));
  }

  /** Avisa o servidor que o usuário terminou de falar (encerra o turno). */
  endTurn(): void {
    if (!this.isOpen() || !this.setupDone) return;
    this.ws!.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
  }

  /** Envia uma mensagem de texto como turno do usuário; resposta vem em áudio. */
  sendText(text: string): boolean {
    const open = this.isOpen();
    if (!open || !this.setupDone) {
      console.warn(
        `[gemini-live] sendText ABORT — open=${open} setupDone=${this.setupDone} text="${text.slice(0, 60)}"`,
      );
      return false;
    }
    this.ws!.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text }] }],
          turnComplete: true,
        },
      }),
    );
    return true;
  }

  /** Devolve o resultado de uma tool call pro Gemini; ele continua o turno. */
  sendToolResponse(id: string, name: string, response: Record<string, unknown>): void {
    if (!this.isOpen() || !this.setupDone) return;
    this.ws!.send(
      JSON.stringify({
        toolResponse: {
          functionResponses: [{ id, name, response }],
        },
      }),
    );
  }

  private handleMessage(raw: Buffer): void {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    if (obj.setupComplete) {
      this.setupDone = true;
      this.setState({ kind: 'ready' });
      return;
    }

    // Tool calls vêm em mensagens próprias (toolCall), não dentro de serverContent.
    const tc = obj.toolCall as ToolCallMessage | undefined;
    if (tc?.functionCalls?.length) {
      for (const fc of tc.functionCalls) {
        if (!fc.name) continue;
        this.listeners.onToolCall?.({
          id: fc.id ?? '',
          name: fc.name,
          args: fc.args ?? {},
        });
      }
      return;
    }

    const sc = obj.serverContent as ServerContent | undefined;
    if (!sc) return;

    if (sc.modelTurn?.parts) {
      for (const part of sc.modelTurn.parts) {
        // áudio inline
        const inline = part.inlineData;
        if (inline?.data && inline.mimeType?.startsWith('audio/pcm')) {
          if (!this.modelSpeaking) {
            this.modelSpeaking = true;
            this.setState({ kind: 'speaking' });
          }
          const audio = Buffer.from(inline.data, 'base64');
          this.listeners.onAudio(audio);
        }
        // transcript opcional (input/output transcription)
        if (part.text && !part.thought) {
          this.listeners.onTranscript?.(part.text, 'model');
        }
      }
    }

    if (sc.inputTranscription?.text) {
      this.listeners.onTranscript?.(sc.inputTranscription.text, 'user');
    }
    if (sc.outputTranscription?.text) {
      this.listeners.onTranscript?.(sc.outputTranscription.text, 'model');
    }

    if (sc.interrupted || sc.turnComplete) {
      if (this.modelSpeaking) {
        this.modelSpeaking = false;
        this.setState({ kind: 'ready' });
      }
    }
  }

  private setState(state: GeminiLiveState): void {
    this.state = state;
    this.listeners.onState(state);
  }
}

type ServerContent = {
  modelTurn?: {
    parts?: Array<{
      text?: string;
      thought?: boolean;
      inlineData?: { mimeType?: string; data?: string };
    }>;
  };
  inputTranscription?: { text?: string };
  outputTranscription?: { text?: string };
  turnComplete?: boolean;
  interrupted?: boolean;
  generationComplete?: boolean;
};

type ToolCallMessage = {
  functionCalls?: Array<{
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  }>;
};
