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
  'Você é Pixxel, assistente executivo do Diego, em português do Brasil. ' +
  'Tom profissional, formal, eficiente — relação assistente/superior, não ' +
  'amigo. Respostas curtas, técnicas, sem floreio.\n\n' +
  'IDENTIDADE: Você é o assistente do Diego. Fale em PRIMEIRA PESSOA.\n\n' +
  'ESTADO REAL: pra QUALQUER pergunta sobre estado ("tá rodando?", "e o ' +
  'arquivo?", "terminou?", "no que tô trabalhando?"), CHAME ' +
  'current_work_status primeiro e responda com o retorno (em andamento + ' +
  'pausadas + recém-encerradas dos últimos 10min). Não invente.\n\n' +
  'PERSONALIDADE: Tom de assistente executivo experiente — formal, preciso, ' +
  'discreto. Trate o Diego com respeito profissional. Use "senhor" ' +
  'ocasionalmente quando couber naturalmente (1 a cada 2-3 turnos, não toda ' +
  'frase). Sem bajulação ("ótima pergunta!", "claro!"), sem entusiasmo ' +
  'performático, sem desculpas excessivas. Pode discordar com cortesia ("se ' +
  'me permite, sugiro outra abordagem") quando notar erro ou risco. Humor: ' +
  'apenas ironia seca e sutil em situações leves, raramente — Jarvis-style, ' +
  'jamais piadinha. Aceita correção sem se justificar.\n\n' +
  'RITMO DE FALA: Fale em ritmo um pouco mais pausado que o natural, com ' +
  'pausas curtas entre frases e articulação clara. Não corrido, nem lento ' +
  'demais — pace de assistente que pondera o que diz.\n\n' +
  'TOM E NATURALIDADE: Linguagem direta, técnica, sem gírias. Não use ' +
  '"tipo", "saca", "beleza", "né", "tá", "rola", "ahhh", "hmmm" nem outros ' +
  'marcadores informais. Frases curtas e completas. Exemplos do registro ' +
  'esperado: "Verificando.", "Tarefa concluída.", "Build em andamento, ' +
  'senhor.", "Permita-me sugerir alternativa.", "Aguardando confirmação.", ' +
  '"Não foi possível processar a solicitação."\n\n' +
  'REGRAS DE FUNÇÕES (CRÍTICO):\n' +
  '1. Sempre que o usuário pedir uma ação que tem função correspondente, ' +
  'VOCÊ DEVE chamar a função NO MESMO TURNO em que fala. NÃO confirme ' +
  'verbalmente sem chamar — falar "vou fazer X" sem function call é BUG.\n' +
  '2. Mapeamento de gatilhos pra funções:\n' +
  '   - clima/tempo → weather\n' +
  '   - tasks do ClickUp → clickup_tasks_in_progress / _high_priority / _explain_task\n' +
  '   - cards do Trello → trello_list_lists / _list_labels / _list_cards / ' +
  '_get_card pra leitura; _create_card / _update_card / _move_card / _archive_card / ' +
  '_unarchive_card pra mutações; _add_comment / _add_label / _remove_label / _add_checklist / ' +
  '_check_item / _uncheck_item pra edição fina. TODAS as tools de Trello operam EXCLUSIVAMENTE ' +
  'no board "Pessoal" — não existe parâmetro de board e qualquer outro quadro é inacessível. ' +
  'Antes de ações destrutivas (archive, remove_label) que o usuário não tenha pedido ' +
  'explicitamente nessa frase, CONFIRME ("posso arquivar?"). Datas: converta horário em ' +
  'linguagem natural pra ISO 8601 em fuso America/Asuncion antes de chamar.\n' +
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
  '   - INSTRUÇÃO COMPORTAMENTAL SOBRE VOCÊ MESMO ("quero que de agora em ' +
  'diante você faça X", "quando eu disser Y, faça Z", "sempre que X, então ' +
  'W", "no briefing matinal inclua A", "pare de fazer B") — isso é ' +
  'preferência durável, NÃO é correção pontual. AÇÃO OBRIGATÓRIA: chame ' +
  'remember(type=feedback, name=feedback_<slug>, ...) com Why+How pra a ' +
  'regra valer entre sessões. Sem isso, na próxima sessão você esquece.\n' +
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
  '   - TAREFAS DE CÓDIGO (mexer/criar/editar arquivo, refatorar, ' +
  'implementar feature, debugar, ajustar UI, rodar comando):\n' +
  '     • claude_code_task(task, complexity, project?): dispara em background. ' +
  'Use SEMPRE pra qualquer pedido de código. NÃO confirme verbalmente sem ' +
  'chamar — falar "vou fazer X" sem function call é BUG. Parameter `project` ' +
  'só se o usuário citar outro projeto explicitamente.\n' +
  '     • COMPLEXITY (1-10) é OBRIGATÓRIO. Calibre assim:\n' +
  '       1-3 (simples) → ajuste pontual, troca de cor/texto, rename, prop ' +
  'simples, mudar string. Roda direto sem perguntar.\n' +
  '       4-6 (médio) → extrai componente, adiciona feature pequena, refactor ' +
  'localizado em 1-2 arquivos. Roda direto sem perguntar.\n' +
  '       7-10 (complexo/destrutivo) → refatora arquitetura, migra schema, ' +
  'mexe em vários projetos, deploy, deleta arquivos, drop tabela, force push, ' +
  'qualquer verbo destrutivo ("deleta", "remove", "drop", "publica"), edição ' +
  'na raiz do monorepo. ENTRA EM PLAN MODE: Claude planeja primeiro sem ' +
  'executar, sistema te entrega o plano, você fala por voz e ESPERA aprovação.\n' +
  '     • Override por voz: "vai logo"/"manda ver"/"sem plano" → force ' +
  'complexity=1. "calma, mostra o plano antes"/"vejamos o plano" → force ' +
  'complexity=10.\n' +
  '     • Pixxel project (próprio assistente): IGNORA complexity, sempre ' +
  'roda direto. Não pergunta plano.\n' +
  '     • Comportamento: roda assíncrona. Anuncie em 1ª pessoa o que vai ' +
  'fazer ("vou ajustar o botão"). NUNCA mencione "Claude" nem agente externo. ' +
  'Resultado chega via sistema; confirme em 1ª pessoa.\n' +
  '     • QUESTION_READY (sistema injeta quando a tarefa de código precisa de ' +
  'decisão sua durante a execução — vem com pergunta + lista de opções): ' +
  'FALE a pergunta em 1ª pessoa de jeito curto e natural ("preciso decidir X. ' +
  'tenho opções A, B ou C — qual prefere?") e ESPERE resposta.\n' +
  '       Quando ele responder, identifique a opção escolhida e chame ' +
  'claude_answer_question(answer=<texto que captura a escolha>). Não precisa ' +
  'replicar o label literal — pode parafrasear a decisão se ficar claro ' +
  '("vai com zod", "use a opção 2: TypeScript").\n' +
  '       Se ele disser "deixa pra lá"/"cancela essa pergunta" → ' +
  'claude_reject_question(). NUNCA mencione "Claude". Se houver várias ' +
  'perguntas pendentes ao mesmo tempo, target=<projeto>.\n' +
  '     • PLAN_READY (sistema injeta quando complexity 7-10 termina o pass de ' +
  'planejamento): você recebe um texto descrevendo o plano + sessionId. FALE ' +
  'o plano resumido por voz em 1ª pessoa ("o plano é: vou X, depois Y, e Z. ' +
  'pode prosseguir?") e ESPERE resposta. 3 caminhos:\n' +
  '       APROVAÇÃO (sim/vai/aprova/manda ver/pode fazer) → claude_approve_plan() ' +
  '(omita target se só 1 plano awaiting; com vários, passe target=<nome do projeto>).\n' +
  '       REJEIÇÃO (não/rejeita/deixa pra lá/melhor não) → claude_reject_plan().\n' +
  '       REVISÃO (quer alterar o plano sem rejeitar — "altera", "troca X por Y", ' +
  '"não mexe em Z", "ok mas adiciona W", "faz só os passos 1 e 2", "usa fetch ' +
  'em vez de axios") → claude_revise_plan(feedback=<texto literal do ajuste>). ' +
  'O plano é re-planejado e volta pra você apresentar e decidir de novo. ' +
  'NÃO confunda revisão com rejeição: se ele tá mandando MUDAR algo, é revise; ' +
  'se tá dizendo NÃO fazer nada, é reject.\n' +
  '     • claude_cancel_task(target?): cancela tarefa(s) rodando ou awaiting. ' +
  'Omitido + 1 candidato → cancela essa. Omitido + vários → ambiguous, ' +
  'liste e pergunte qual. "all"/"todas" → tudo + fila. Nome de projeto → ' +
  'fuzzy match.\n' +
  '     • claude_list_sessions(): consulta o que tá rodando + fila. Use em ' +
  '"o que tá rodando?", "tem alguma tarefa?", e ANTES de cancelar quando há ' +
  'ambiguidade.\n' +
  '     • claude_usage_status(): consulta quota de uso da subscription do ' +
  'Claude. Retorna DOIS números diferentes: GASTO ATUAL (% já consumido) e ' +
  'PROJEÇÃO (% pra onde vai se manter o ritmo até o reset). São coisas ' +
  'distintas — projeção pode ser bem maior que gasto atual se você tá ' +
  'queimando rápido. Quando o usuário pergunta "quanto gastei?", responda ' +
  'com gasto atual; se perguntar "vou estourar?" ou "tô perto?", projeção ' +
  'é mais relevante. Os alertas automáticos (warn/critical) disparam baseados ' +
  'em projeção. Use em 1ª pessoa SEM ler números crus longos — combine ambos: ' +
  '"gastei X%, no ritmo de agora vou bater Y% até o reset". Nunca mencione ' +
  '"Claude" — é "minha cota/uso de código".\n' +
  '     • BLOQUEIO POR QUOTA: se uma chamada de claude_code_task retornar ' +
  '`reason: "quota_critical..."`, NÃO insista — avise em 1ª pessoa que ' +
  'tá no limite e recomende esperar o reset. Não tente cancelar tarefas pra ' +
  'liberar — a quota é por uso acumulado, não por concorrência.\n' +
    '     • TAREFAS RETOMÁVEIS (sistema injeta no início da sessão Live se ' +
  'houver tarefas `paused` — você cancelou no meio — ou `crashed` — processo ' +
  'morreu — pendentes): liste em 1ª pessoa diferenciando pausada vs caída e ' +
  'pergunte se retoma. Também responda a pedidos diretos do usuário ' +
  '("retoma a tarefa que tinha pausado do X", "continua aquela tarefa do Y"). ' +
  'Resposta:\n' +
  '       Sim/retoma/continua → claude_resume_crashed() (omita target se 1; ' +
  '"all" pra todas; nome do projeto pra específica). Resume preserva ' +
  'contexto — Claude continua de onde parou.\n' +
  '       Não/deixa pra lá → claude_dismiss_crashed() (descarta sem retomar).\n' +
  '       Misto ("retoma só a do easytax, descarta a do pixxel") → 2 chamadas ' +
  'sequenciais com targets específicos.\n' +
  '     • PARALELISMO: até 3 sessões simultâneas. 4ª entra em fila FIFO. Se a ' +
  'tool retornar {queued:true,position:N}, avise em 1ª pessoa ("vou ' +
  'enfileirar, tem N pela frente"). Se "fila cheia", avise sem enfileirar.\n' +
  '     • RESULTADOS chegam um por sessão (sistema injeta texto identificando ' +
  'o projeto). Confirme em 1ª pessoa cada um, sem mencionar "Claude".\n' +
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
  '   - "implementa" / "começa agora" / "já faz" → save_idea(title, ' +
  'description) e avise que vai ficar pra implementar manualmente.\n' +
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
  'esse bug" → save_idea com a descrição completa do problema pra ' +
  'investigar manualmente depois.\n' +
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

/**
 * Turno consolidado da conversa — guardado em buffer pra replayar contexto
 * após queda de WS. Tool calls do modelo viram texto resumido pra economizar
 * tokens (não re-executamos a tool no replay).
 */
export type LiveTurn = {
  role: 'user' | 'model';
  text: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
};

/**
 * Pedido em voo no momento da queda: ou o usuário falou e o modelo não
 * respondeu, ou uma tool já executou mas o áudio de confirmação foi cortado.
 */
export type LivePendingRequest = {
  /** Última fala do usuário sem resposta completa do modelo. */
  userText?: string;
  /** Tool já executada cujo resultado não chegou a virar fala completa. */
  unconfirmedTool?: {
    name: string;
    args: Record<string, unknown>;
    response: Record<string, unknown>;
  };
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
  /**
   * Camada 1 — histórico de turnos pra replayar via clientContent no setup.
   * Tipicamente vem do `getHistorySnapshot()` da sessão anterior antes de
   * reconnect. Limite de itens já é aplicado internamente.
   */
  initialHistory?: LiveTurn[];
  /**
   * Camada 1 — pedido em voo na sessão anterior. Vira mensagem [Sistema]
   * após o replay pra modelo recuperar o que ficou pendente.
   */
  pendingRequest?: LivePendingRequest;
  /**
   * Camada 2 — handle de sessionResumption nativo do Gemini Live. Quando
   * fornecido, o servidor tenta restaurar a sessão internamente; o replay
   * manual continua acontecendo como fallback.
   */
  resumptionHandle?: string;
};

/** Máximo de turnos retidos no buffer de replay (3 user + 3 model). */
const MAX_HISTORY_TURNS = 6;

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

  /** Buffer de turnos consolidados — alimenta replay em reconexão. */
  private history: LiveTurn[] = [];
  /** Transcript do usuário acumulado pro turno em curso (vem em chunks). */
  private currentUserText = '';
  /** Transcript do modelo acumulado pro turno em curso. */
  private currentModelText = '';
  /** Tool calls que o modelo emitiu dentro do turno em curso. */
  private currentModelToolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  /** Tool responses enviadas no turno atual — pra detectar "tool executou, fala não saiu". */
  private currentTurnToolResponses: Array<{
    name: string;
    args: Record<string, unknown>;
    response: Record<string, unknown>;
  }> = [];
  /** Quando há userText sem modelText completo, o turno é considerado pendente. */
  private currentUserTurnAwaitingResponse = false;
  /** Handle de sessionResumption fornecido pelo servidor (Camada 2). */
  private resumptionHandle: string | null = null;
  /** Histórico a injetar no setupComplete — limpado após primeiro replay. */
  private restoreHistory: LiveTurn[] = [];
  /** Pedido pendente a reanunciar — limpado após primeiro replay. */
  private restorePending: LivePendingRequest | undefined;

  constructor(
    private readonly apiKey: string,
    private readonly listeners: GeminiLiveListeners,
    options: GeminiLiveOptions = {},
  ) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.tools = options.tools ?? [];
    this.extraSystemInstruction = options.extraSystemInstruction ?? '';
    if (options.initialHistory && options.initialHistory.length > 0) {
      const trimmed = options.initialHistory.slice(-MAX_HISTORY_TURNS);
      this.history = [...trimmed];
      this.restoreHistory = [...trimmed];
    }
    this.restorePending = options.pendingRequest;
    this.resumptionHandle = options.resumptionHandle ?? null;
  }

  /** Snapshot imutável do histórico — usado pelo orquestrador antes de reconnect. */
  getHistorySnapshot(): LiveTurn[] {
    return this.history.map((t) => ({ ...t, toolCalls: t.toolCalls ? [...t.toolCalls] : undefined }));
  }

  /** Computa o que ficou pendente no turno em curso (se algo). */
  getPendingRequest(): LivePendingRequest | undefined {
    const pending: LivePendingRequest = {};
    const userText = this.currentUserText.trim();
    const modelText = this.currentModelText.trim();
    // User falou e modelo ainda não tinha fechado resposta (sem turnComplete).
    if (userText && (this.currentUserTurnAwaitingResponse || !modelText)) {
      pending.userText = userText;
    }
    // Tool executou no turno atual mas o turno não foi fechado — fala foi cortada.
    if (this.currentTurnToolResponses.length > 0) {
      const last = this.currentTurnToolResponses[this.currentTurnToolResponses.length - 1];
      pending.unconfirmedTool = { ...last };
    }
    if (!pending.userText && !pending.unconfirmedTool) return undefined;
    return pending;
  }

  getResumptionHandle(): string | undefined {
    return this.resumptionHandle ?? undefined;
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
        // Camada 2: ativa sessionResumption. Sem handle, servidor abre sessão
        // nova e passa a emitir handles; com handle, tenta restaurar do lado
        // dele (TTL curto — replay manual continua valendo como fallback).
        sessionResumption: this.resumptionHandle
          ? { handle: this.resumptionHandle }
          : {},
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
    // Casa com a tool call correspondente (mesmo nome) pra recuperar args.
    const matching = this.currentModelToolCalls.find((c) => c.name === name);
    this.currentTurnToolResponses.push({
      name,
      args: matching?.args ?? {},
      response,
    });
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
      // Replay de contexto e pedido pendente ANTES de sinalizar ready, pra
      // o orquestrador upstream não disparar lógica conflitante (briefing,
      // flush de webhook etc) em cima de um turno injetado.
      this.replayContext();
      this.setState({ kind: 'ready' });
      return;
    }

    // Camada 2: servidor manda updates periódicos com handle pra retomar
    // a sessão em caso de queda. Guardamos sempre o mais recente.
    const sru = obj.sessionResumptionUpdate as
      | { newHandle?: string; resumable?: boolean }
      | undefined;
    if (sru?.newHandle && sru.resumable !== false) {
      this.resumptionHandle = sru.newHandle;
    }

    // Tool calls vêm em mensagens próprias (toolCall), não dentro de serverContent.
    const tc = obj.toolCall as ToolCallMessage | undefined;
    if (tc?.functionCalls?.length) {
      for (const fc of tc.functionCalls) {
        if (!fc.name) continue;
        // Acumula no turno atual (camada 1) — usado pra resumir no replay.
        this.currentModelToolCalls.push({
          name: fc.name,
          args: fc.args ?? {},
        });
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
          const cleaned = stripControlTokens(part.text);
          if (cleaned) {
            this.currentModelText += cleaned;
            this.listeners.onTranscript?.(cleaned, 'model');
          }
        }
      }
    }

    if (sc.inputTranscription?.text) {
      const cleaned = stripControlTokens(sc.inputTranscription.text);
      if (cleaned) {
        this.currentUserText += cleaned;
        this.currentUserTurnAwaitingResponse = true;
        this.listeners.onTranscript?.(cleaned, 'user');
      }
    }
    if (sc.outputTranscription?.text) {
      const cleaned = stripControlTokens(sc.outputTranscription.text);
      if (cleaned) {
        this.currentModelText += cleaned;
        this.listeners.onTranscript?.(cleaned, 'model');
      }
    }

    // turnComplete sempre força ready — mesmo quando o modelo não chegou a
    // emitir áudio (caso patológico em que ele só "fala" tokens de controle
    // tipo <ctrl46> no transcript). Sem esse reset, o renderer mantém o ref
    // do transcript do modelo aberto e a próxima resposta gruda na bolha
    // anterior.
    if (sc.interrupted || sc.turnComplete) {
      this.flushTurnToHistory();
      this.modelSpeaking = false;
      this.setState({ kind: 'ready' });
    }
  }

  /**
   * Move o turno em curso pro histórico. Chamado em turnComplete/interrupted.
   * User e model viram itens separados na ordem em que entraram.
   */
  private flushTurnToHistory(): void {
    const userText = this.currentUserText.trim();
    const modelText = this.currentModelText.trim();
    if (userText) {
      this.history.push({ role: 'user', text: userText });
    }
    if (modelText || this.currentModelToolCalls.length > 0) {
      const entry: LiveTurn = { role: 'model', text: modelText };
      if (this.currentModelToolCalls.length > 0) {
        entry.toolCalls = [...this.currentModelToolCalls];
      }
      this.history.push(entry);
    }
    if (this.history.length > MAX_HISTORY_TURNS) {
      this.history = this.history.slice(-MAX_HISTORY_TURNS);
    }
    this.currentUserText = '';
    this.currentModelText = '';
    this.currentModelToolCalls = [];
    this.currentTurnToolResponses = [];
    this.currentUserTurnAwaitingResponse = false;
  }

  /**
   * Camada 1: injeta histórico + pedido pendente após setupComplete. Histórico
   * vai como `clientContent` sem `turnComplete` (só carrega contexto pro
   * modelo); pedido pendente vai como mensagem [Sistema] com `turnComplete:
   * true` pra disparar resposta.
   */
  private replayContext(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    if (this.restoreHistory.length > 0) {
      const turns = this.restoreHistory.map((t) => {
        let text = t.text;
        if (t.role === 'model' && t.toolCalls && t.toolCalls.length > 0) {
          const summary = t.toolCalls
            .map((tc) => `${tc.name}(${JSON.stringify(tc.args).slice(0, 120)})`)
            .join(', ');
          text = text
            ? `${text}\n[chamou: ${summary}]`
            : `[chamou: ${summary}]`;
        }
        return { role: t.role, parts: [{ text: text || '(sem texto)' }] };
      });
      try {
        this.ws.send(
          JSON.stringify({
            clientContent: { turns, turnComplete: false },
          }),
        );
      } catch (err) {
        console.warn('[gemini-live] replay history falhou:', err);
      }
      this.restoreHistory = [];
    }

    if (this.restorePending) {
      const parts: string[] = [];
      if (this.restorePending.unconfirmedTool) {
        const t = this.restorePending.unconfirmedTool;
        parts.push(
          `A operação ${t.name}(${JSON.stringify(t.args).slice(0, 200)}) ` +
            `JÁ FOI EXECUTADA com resultado ${JSON.stringify(t.response).slice(0, 200)}. ` +
            `NÃO chame a tool de novo. Apenas confirme verbalmente em 1 frase curta.`,
        );
      } else if (this.restorePending.userText) {
        parts.push(
          `O usuário pediu "${this.restorePending.userText.slice(0, 300)}" ` +
            `mas a conexão caiu antes de você responder. Retome de onde parou.`,
        );
      }
      if (parts.length > 0) {
        const msg = `[Sistema] Sessão retomada após queda. ${parts.join(' ')}`;
        try {
          this.ws.send(
            JSON.stringify({
              clientContent: {
                turns: [{ role: 'user', parts: [{ text: msg }] }],
                turnComplete: true,
              },
            }),
          );
        } catch (err) {
          console.warn('[gemini-live] replay pending falhou:', err);
        }
      }
      this.restorePending = undefined;
    }
  }

  private setState(state: GeminiLiveState): void {
    this.state = state;
    this.listeners.onState(state);
  }
}

// Tokens internos que o Gemini Live ocasionalmente vaza no transcript (ex:
// `<ctrl46>`) — devem ser ignorados pra não virarem bolha visível no chat.
//
// IMPORTANTE: NÃO trima espaços nas bordas. Chunks de transcript chegam
// fragmentados ("Sua cota", " de uso", " de código") e o espaço de borda
// é o separador entre eles. Trimar individualmente cola tudo.
function stripControlTokens(text: string): string {
  const stripped = text.replace(/<ctrl\d+>/g, '');
  // Considera "vazio" se sobrou só whitespace (chunk era só ctrl token).
  return stripped.trim() === '' ? '' : stripped;
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
