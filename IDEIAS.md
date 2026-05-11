# Ideias para versões futuras

Caderno aberto de ideias que **não** estão no escopo do MVP, mas que não quero perder. Não é roadmap nem compromisso — só captura. Quando uma ideia amadurecer, ela sai daqui e vira issue/plano de implementação.

Formato de cada ideia:
- **O quê:** descrição curta
- **Por quê:** o valor que traz
- **Notas:** dependências técnicas, riscos, links, qualquer coisa relevante

---

## Visão computacional

### Reconhecimento de gestos pela câmera do notebook
- **O quê:** abrir a webcam e reconhecer gestos da mão (ex.: pausar/continuar, próximo/anterior, ok, mute) para controlar o assistente sem precisar falar.
- **Por quê:** úteis em situações onde voz não é prática (ambiente barulhento, reunião, alguém dormindo do lado).
- **Notas:**
  - Possíveis libs: MediaPipe Hands (roda no browser/Electron via WASM), TensorFlow.js handpose.
  - Processamento local — não enviar vídeo para VPS.
  - Pensar em UX de ativação: a câmera fica ligada o tempo todo? Por hotkey? Indicador visual obrigatório.

### Reconhecimento de objetos
- **O quê:** identificar objetos no campo de visão da câmera ("o que é isso que estou segurando?", "tem alguém na sala?").
- **Por quê:** abre caminho para interações multimodais ("descreva o que você está vendo").
- **Notas:**
  - Modelos: YOLO local, ou enviar frame para um VLM (NIM tem modelos de visão).
  - Custo de banda se for remoto — preferir local quando possível.

### Reconhecimento de pessoas / presença
- **O quê:** detectar quando estou na frente do computador, quando saí, quem está na sala.
- **Por quê:**
  - Auto-pausar quando saio.
  - Saudação personalizada se tiver mais de uma pessoa cadastrada.
  - Não falar coisas sensíveis em voz alta se tiver alguém estranho.
- **Notas:**
  - Reconhecimento facial tem implicações de privacidade — só dados locais, nunca subir embeddings para nuvem.
  - Pode começar simples: só "tem rosto / não tem rosto" antes de identificar quem.

---

## Integrações com sistemas do dia a dia

### Google Agenda
- **O quê:** ler e criar eventos por voz ("o que tenho hoje?", "marca reunião com fulano amanhã às 15h", "estou livre quinta de tarde?").
- **Por quê:** consulta e criação de evento por voz é muito mais rápido que abrir o app e clicar.
- **Notas:**
  - OAuth do Google — token guardado no desktop, nunca na VPS.
  - Cuidado com confirmação antes de criar/alterar/deletar evento (ação destrutiva, falar de volta antes de executar).
  - Considerar leitura proativa: lembrete falado X minutos antes de cada evento.

### Google Maps — busca de lugares + handoff pro celular
- **O quê:** fluxo completo de "buscar perto e ir até lá" por voz. Funciona pra qualquer categoria de pesquisa (mercado, padaria, farmácia, posto, restaurante, etc.), não só um tipo fixo.
- **Fluxo alvo:**
  1. Usuário fala: "onde tem um mercado aqui perto?"
  2. Assistente busca lugares próximos no Maps (Places API).
  3. Lê de volta as opções com **distância e tempo estimado** até cada um (resumido — top 3 no máximo).
  4. Usuário escolhe um por voz ("o segundo", "o Pão de Açúcar").
  5. Assistente envia a rota pro **celular do usuário** já com destino definido, pronto pra abrir no Maps mobile e iniciar navegação.
- **Por quê:** elimina o atrito de pegar o celular, abrir o app, digitar, escolher e só então sair. Usuário decide de boca enquanto ainda está em casa/no escritório e sai com o caminho pronto.
- **Notas:**
  - APIs: Places (Nearby Search / Text Search) pra encontrar, Distance Matrix pra distância+tempo de cada um, Directions pra rota final.
  - Localização atual: pegar do desktop (IP geo é impreciso) ou cadastrar locais frequentes ("casa", "escritório") e usar o ativo.
  - Handoff pro celular — opções a avaliar:
    - Link `https://www.google.com/maps/dir/?api=1&destination=...` enviado via push notification / Telegram / WhatsApp / e-mail.
    - App companion Android (fase 2 do projeto já prevê mobile) recebendo o destino direto via canal próprio.
    - Google Maps "send to phone" oficial (requer login Google ativo nos dois lados).
  - Resposta por voz precisa ser resumida — nunca recitar rota passo a passo nem ler endereço completo.
  - Confirmar antes de mandar pro celular ("mando o Extra pro seu celular?") pra evitar disparo errado.

### YouTube
- **O quê:** controlar reprodução, buscar vídeo, adicionar à fila ("toca tal música", "pula", "põe na fila o próximo episódio do canal X").
- **Por quê:** mãos livres enquanto trabalho/cozinho/etc.
- **Notas:**
  - YouTube Data API para busca; controle de reprodução depende de onde está tocando (browser, app, TV via cast).
  - Versão simples: abrir vídeo no browser por voz. Versão avançada: integrar com player ativo (mais complexo, talvez via extensão).
  - Pensar se vale separar "YouTube Music" de "YouTube vídeo" — usos diferentes.

---

## Interface e visual

### Círculo central com ondas reativas à voz
- **O quê:** tela principal do desktop tem um círculo no centro com ondas/anéis ao redor que se animam acompanhando a voz — quando o usuário fala, as ondas pulsam/oscilam com a amplitude do áudio do microfone; quando o assistente fala, oscilam com o áudio de saída do TTS.
- **Por quê:** identidade visual estilo Pixxel, dá feedback imediato de que o sistema está ouvindo/respondendo (sem precisar ler texto). Inspiração nas imagens de referência (anéis concêntricos azul/ciano em fundo escuro).
- **Notas:**
  - Estados visuais distintos a considerar: idle, ouvindo, processando (pensando), falando, erro/offline. Cada estado tem cor/comportamento diferente.
  - Implementação: Web Audio API (`AnalyserNode.getByteFrequencyData` ou `getByteTimeDomainData`) alimentando um canvas/WebGL. Bibliotecas possíveis: `wavesurfer.js`, `three.js` para algo mais 3D, ou Canvas 2D puro se for simples.
  - Performance: animação roda a 60fps com áudio em tempo real — testar consumo de CPU, principalmente se rodar em background.
  - Considerar acessibilidade: alguma indicação textual/legível além do visual (label "ouvindo", "falando").
  - Versão "minimal" (só um anel pulsante) pode vir antes da versão "full Pixxel" com vários anéis e detalhes geométricos.

---

## Memória persistente / "aprendizado" do assistente

### Vault de notas em markdown que cresce com o uso
- **O quê:** estrutura de arquivos `.md` locais que o assistente pode ler/escrever pra acumular preferências, decisões e contexto através de sessões. Carregado no setup do Gemini Live como contexto adicional do system prompt.
- **Por quê:** hoje o Gemini esquece tudo entre sessões. Com vault, o assistente vira "alguém que te conhece" — lembra preferências, retoma conversas, evita repetir erros. Fator tempo: quanto mais o usuário usa, mais o assistente aprende.
- **Estrutura proposta (já valer começar agora pra não migrar depois):**
  ```
  ~/pixxel/memory/
    MEMORY.md              # índice — uma linha por entrada com título + hook
    user_*.md              # quem é o usuário (role, gostos, contexto pessoal)
    feedback_*.md          # correções e validações de comportamento
    project_*.md           # decisões/estado de projetos em andamento
    reference_*.md         # ponteiros pra sistemas externos (links, IDs)
  ```
  - JSON existente (nome, identidade fixa) **continua** — markdown é pro que cresce com o tempo, não pra dado fixo.
- **Tools necessárias (function calling do Live):**
  - `remember_preference({ rule, reason, type })` — Gemini chama quando detecta padrão worth saving
  - `forget_preference({ id })` — quando o usuário muda de ideia
  - `search_memory({ query })` — busca semântica/grep no vault pra trazer contexto sob demanda (alternativa a carregar tudo no system prompt)
- **Detecção: explícita vs automática:**
  - Explícita (mais confiável): "lembra disso" / "anota aí" → tool call direto
  - Automática (mais útil mas escorrega): Gemini decide sozinho que algo é preferência. Pode salvar lixo. Solução: instrução clara no system prompt sobre **o que NÃO salvar** (estado temporário, ofensas pontuais, dados que mudam rápido).
- **Notas:**
  - Carregamento: ler todo `MEMORY.md` no início da sessão e injetar no system prompt. Como cada entrada é uma linha no índice, fica leve. Conteúdo detalhado só carrega via `search_memory` quando relevante.
  - Risco principal: vault inflar com lixo ou contradições. Precisa de revisão periódica (talvez uma tool `audit_memory` que mostra duplicatas/contradições).
  - Compatível com Obsidian se o usuário quiser ferramenta gráfica depois — mesmo formato.
  - Em paralelo, o JSON de identidade fixa continua sendo a fonte pra dados como nome/email — não duplicar.

---

## (Adicionar novas categorias aqui conforme surgirem)

---

## Capturadas via voz

Ideias capturadas em conversa por voz com o Pixxel.

### Integração WhatsApp
<!-- anchor: 2026-04-30-integracao-whatsapp -->
- **Status:** planejado (2026-04-30)
- **O quê:** Planejar a implementação de uma funcionalidade para enviar mensagens via WhatsApp.

#### Plano (Gemini)

## Passos de Implementação:
1. Pesquisar e selecionar uma API ou gateway de WhatsApp Business (ex: Twilio, Zenvia)
2. Analisar custos e viabilidade técnica da integração.
3. Definir o escopo: envio de mensagens de texto, notificações, etc.
4. Configurar autenticação e gerenciar credenciais de forma segura.
5. Desenvolver o módulo de integração no backend e a interface no frontend.

## Arquivos/Módulos:
- Criação de novo módulo `src/whatsapp/`
- Atualização de `package.json` para dependências
- Configurações em `config/`

## Riscos e Alternativas:
- **Riscos:** Mudanças nas políticas do WhatsApp, custos operacionais elevados, complexidade de manutenção.
- **Alternativas:** Implementar deep links para abrir o WhatsApp Web/Desktop com números pré-preenchidos, que é mais simples e não requer API complexa.

### Explicar alterações técnicas antes de autorizar
<!-- anchor: 2026-04-30-explicar-alteracoes-tecnicas-antes-de-autorizar -->
- **Status:** ideia (2026-04-30)
- **O quê:** Permitir que o assistente detalhe tecnicamente as alterações de código solicitadas pelo Claude Code antes de pedir autorização ao usuário, para que o usuário possa analisar e decidir.

### Explicar alterações técnicas antes de autorizar
<!-- anchor: 2026-04-30-explicar-alteracoes-tecnicas-antes-de-autorizar -->
- **Status:** ideia (2026-04-30)
- **O quê:** Adicionar skill para o assistente conseguir explicar tecnicamente as alterações que serão feitas antes de pedir autorização, ajudando na análise do usuário.

### Integração com WhatsApp
<!-- anchor: 2026-05-01-integracao-com-whatsapp -->
- **Status:** ideia (2026-05-01)
- **O quê:** Controlar e enviar mensagens pelo WhatsApp do usuário.

### Implementação de controle do WhatsApp
<!-- anchor: 2026-05-01-implementacao-de-controle-do-whatsapp -->
- **Status:** planejado (2026-05-01)
- **O quê:** Implementar a capacidade de controlar o WhatsApp para enviar mensagens, buscar contatos, etc.

#### Plano (Gemini)

**Passos de Implementação:**
1.  **Análise de Viabilidade:** Verificar APIs disponíveis (WhatsApp Business API ou similares) e requisitos de autenticação e segurança.
2.  **Desenvolvimento de Tools:** Criar tools específicas como `send_whatsapp_message(contact, message)`, `search_whatsapp_contacts(query)`, `list_chats()`.
3.  **Integração:** Integrar as novas tools ao fluxo de conversação, permitindo que o usuário solicite ações no WhatsApp.
4.  **Segurança e Privacidade:** Implementar fortes medidas de segurança para garantir a privacidade das mensagens e contatos do usuário.

**Arquivos/Módulos a tocar:**
- Ferramentas/integração_whatsapp.py
- Configuração de permissões e autenticação

**Dependências Externas:**
- Possível necessidade de bibliotecas específicas para integração com a API do WhatsApp.

**Riscos:**
- Complexidade da API do WhatsApp Business ou restrições de uso.
- Questões de privacidade e segurança dos dados do usuário.
- Necessidade de autenticação recorrente ou configuração complexa.

**Alternativas mais simples:**
- Manter o comportamento atual de apenas abrir o link direto para uma conversa, sem controle total.

#### Revisão técnica (Claude)

- **Stack errada no plano:** o Gemini citou `Ferramentas/integração_whatsapp.py`, mas o projeto é Electron + TS. O módulo deve ficar em `apps/desktop/src/main/integrations/whatsapp.ts` seguindo o padrão de `clickup.ts`/`youtube.ts`, e as tools precisam ser declaradas em `voice/tool-declarations.ts`.
- **WhatsApp Business API não serve para uso pessoal:** ela exige número dedicado, aprovação Meta, templates pré-aprovados e janela de 24h. Para "controlar o MEU WhatsApp" o caminho real é `whatsapp-web.js` ou `Baileys` (engenharia reversa do WhatsApp Web via WebSocket) — funciona, mas é cinza no ToS e pode banir o número. Vale registrar isso explicitamente como risco bloqueante.
- **Baileys > whatsapp-web.js para Electron:** Baileys não precisa de Chromium headless (já temos um Electron rodando, segundo navegador é overhead grande); conecta direto via WS, autentica por QR code uma vez e persiste sessão em disco — encaixa bem no padrão de `storage.ts`.
- **Falta no plano:** persistência da sessão (auth state), UI de QR code no primeiro pareamento, estratégia de reconexão, e como expor "contato" para o LLM (nome fuzzy → JID). Sem resolver o matching de contatos, `send_whatsapp_message(contact, ...)` vai errar destinatário — risco alto de mandar mensagem pra pessoa errada.
- **Confirmação obrigatória antes de enviar:** dado o histórico de "ClickUp é read-only", envio de mensagem deveria exigir confirmação explícita por voz/clique antes de disparar, nunca auto-send a partir do Live. Tratar `send_*` como ação destrutiva.
- **Alternativa intermediária real:** usar só `https://wa.me/<numero>?text=<msg>` via `shell.openExternal` (já temos no main). Resolve 80% dos casos ("manda mensagem pro fulano dizendo X"), zero risco de ban, zero auth — abre o WhatsApp Desktop com texto pré-preenchido e o usuário só aperta enter. Recomendo começar por aqui e só migrar para Baileys se a fricção do "apertar enter" incomodar.
- **Leitura de mensagens é escopo separado e mais arriscado:** `list_chats`/`search_contacts` exigem sessão ativa Baileys e levantam questão de privacidade (mensagens de terceiros passando pelo Gemini). Adiar para fase 2 e decidir explicitamente o que vai/não vai pro contexto do LLM.

### Integração Google Maps com Widget Visual e Handoff
<!-- anchor: 2026-05-01-integracao-google-maps-com-widget-visual-e-handoff -->
- **Status:** planejado (2026-05-01)
- **O quê:** Implementar widget de mapa visual na interface, permitir traçar rotas por comando de voz (ex: "mercado La Familia"), confirmar e enviar automaticamente para o celular (handoff).

#### Plano (Gemini)

**Passos de Implementação:**
1.  **Desenvolvimento do Widget:** Criar um novo widget (`MapWidget.tsx`) na interface (`apps/desktop/src/renderer/`). Utilizar uma biblioteca de mapas (ex: `react-leaflet` ou similar, se compatível com a stack atual) ou integração direta via `iframe`/API do Google Maps para exibir um mapa interativo no painel.
2.  **Integração com Voz e Comandos:**
    *   Adicionar intents para reconhecimento de comandos de rota (ex: "traçar rota para [local]", "ir para [local]").
    *   Vincular a intent ao `MapWidget`, que usará a descrição do local ("[local]", ex: "mercado La Familia") para buscar e traçar a rota no mapa.
3.  **Handoff para Celular:**
    *   Implementar a lógica de confirmação do usuário (via voz ou UI).
    *   No backend, desenvolver a funcionalidade de "handoff". Isso provavelmente envolverá:
        *   Uso de `shell.openExternal` para abrir a URL da rota no navegador padrão, que sincronizará com o celular via conta Google, OU
        *   Integração com ferramentas como `kdeconnect` ou similar para envio direto (se disponível no ambiente do Diego). A primeira opção (`shell.openExternal`) é mais universal e deve ser priorizada.
4.  **Persistência e Memória:** Registrar as rotas traçadas e preferências de handoff na memória (`remember(type=user/project)`).

**Arquivos/Módulos a tocar:**
*   `apps/desktop/src/renderer/` (criação de `MapWidget.tsx`, `styles.css` associado, integração no layout principal)
*   Módulos de reconhecimento de voz e processamento de intents.
*   Backend (integração `shell.openExternal` ou similar para handoff).

**Riscos e Alternativas:**
*   **Risco:** Compatibilidade da biblioteca de mapas com a stack atual e licenças de API do Google Maps.
*   **Alternativa:** Começar com uma implementação mais simples usando apenas URLs estáticas ou `iframe`s básicos, evoluindo para interatividade total depois. O handoff via `shell.openExternal` é a alternativa mais segura e rápida para a integração inicial, conforme feedback anterior sobre WhatsApp.

#### Revisão técnica (Claude)

- **Linguagem do plano está fora do projeto:** "intents" e "backend" não existem aqui. O fluxo é Gemini Live → function call → handler em `main/integrations/maps.ts` → widget em `renderer/components/widgets/MapCard.tsx` (seguindo `WeatherCard`/`youtube.ts`). Reescrever o plano nesse vocabulário antes de codar.
- **react-leaflet ≠ Google Maps:** Leaflet usa tiles OSM e não traça rotas sozinho (precisa de OSRM/Mapbox/GraphHopper). Misturar "react-leaflet" com "API do Google Maps" no mesmo passo é incoerente. Escolher um eixo: (a) **Maps Embed API** num `<iframe>` (zero custo, sem chave com billing obrigatório, traça rota nativa) ou (b) JS API completo (exige billing habilitado, mais complexo). Para MVP, (a) é o caminho.
- **Handoff "shell.openExternal sincroniza via conta Google" é falso hoje:** o "Send to phone" do Maps foi descontinuado. O caminho real que funciona é abrir `https://www.google.com/maps/dir/?api=1&destination=<query>` no desktop — se o celular estiver logado na mesma conta Google, a busca aparece em "Recentes" no app do Maps. Não é push automático; documentar isso como expectativa do usuário antes de prometer "envia pro celular".
- **Geocoding pode ser evitado:** não chamar Places API (paga). Passar a query crua (`destination=mercado+La+Familia`) na URL do Maps já resolve no servidor do Google — grátis e idêntico ao que o usuário digitaria.
- **Confirmação obrigatória antes do handoff:** mesma regra do WhatsApp — abrir navegador externo é ação visível, exigir confirmação por voz/clique antes de `openExternal`. Nada de auto-disparo a partir do Live.
- **Cortar do escopo MVP:** KDE Connect (depende do DE do usuário, não declarado) e "persistir rotas e preferências na memória" (não há caso de uso recorrente — rota é efêmera). Adicionar só se virar pedido real.
- **Caminho mais simples (recomendado):** pular o widget visual na v1. Tool `open_route(destination)` que chama `shell.openExternal` com a URL do Maps resolve 90% do valor com ~30 linhas. Widget `MapCard` com iframe Embed entra na v2 se a fricção do "abrir no navegador" incomodar — exatamente o mesmo arco que a discussão do WhatsApp acima.

### Reconhecimento Multi-Usuário via Câmera
<!-- anchor: 2026-05-02-reconhecimento-multi-usuario-via-camera -->
- **Status:** planejado (2026-05-02)
- **O quê:** Planejar implementação de reconhecimento de múltiplos usuários via câmera para ajuste automático de contexto.

#### Plano (Gemini)

**Passos de Implementação:**
1.  **Integração de Biblioteca:** Adicionar biblioteca de reconhecimento facial (ex: `face-api.js` ou similar) ao projeto.
2.  **Módulos de Câmera:** Modificar `open_camera` e `look_at_camera` para integrar a análise facial, ativando o reconhecimento quando a câmera é aberta ou periodicamente durante o uso.
3.  **Gestão de Contexto:** Criar módulo `user_context.ts` para gerenciar perfis de usuário, vinculando identidades visuais às entradas de memória existentes (como `user_diego_visual_identity` e `user_kamila_spouse`).
4.  **Ajuste Automático:** Atualizar a lógica principal para que o contexto (como `owner` em `start_work`, `study_plan_next`, etc.) seja ajustado automaticamente com base no usuário reconhecido, seguindo o plano em `feedback_multi_user_recognition_plan`.

**Arquivos/Módulos a Tocar:** `camera_module.ts`, `user_context.ts`, `main.ts`, `package.json` (para dependências).

**Riscos e Alternativas:**
*   **Privacidade:** Risco de coleta e armazenamento de dados sensíveis. Necessário implementar políticas claras de permissão e armazenamento seguro.
*   **Performance:** Análise de vídeo constante pode consumir muitos recursos. Avaliar a frequência de reconhecimento.
*   **Acurácia:** A eficácia pode variar.

**Tools/Libs Sugeridas:** `face-api.js` (ou similar), `claude_code_task` para implementação, `remember` e `update_memory` para refinar perfis de usuário.

#### Revisão técnica (Claude)

- **Arquivos do plano não batem com o repo.** Não existe `camera_module.ts` nem `main.ts` — o que há é `apps/desktop/src/main/integrations/vision.ts` (envia frame pro Gemini) e `apps/desktop/src/renderer/components/CameraPanel.tsx` (dono do `getUserMedia` e do `<video>`). Reconhecimento tem que rodar no **renderer**, onde o stream vive; mandar o frame pro main só pra rodar TF.js é round-trip à toa.
- **`face-api.js` está praticamente abandonado** (último release ~2020, TF.js antigo, models ~6MB). Se for por esse caminho, usar o fork `@vladmandic/face-api` ou, melhor, **MediaPipe Face Landmarker / Face Detection** do Google (mantido, WASM, leve). Decidir antes de codar — trocar depois é caro.
- **Falta a etapa de enrollment.** O plano vai direto pra "ajustar `owner` automaticamente" sem dizer como um embedding vira "Diego" ou "Kamila". Precisa de UI pra cadastrar rosto + nome (1-3 fotos por pessoa) e armazenar `{nome, embedding[]}` em disco local — nunca enviar embeddings biométricos pro Gemini.
- **Conflito com o opt-in de mic/câmera.** Memória `feedback_mic_opt_in` diz que ligar Pixxel não ativa mic; câmera segue o mesmo contrato (`open_camera` é explícito). "Reconhecimento periódico durante o uso" quebra isso — limitar a "rodar uma vez por frame que o usuário já pediu pra capturar", não loop contínuo.
- **Caso multi-pessoa não está definido.** Se Diego e Kamila aparecem juntos, qual vira `owner`? Decidir regra (maior bounding box / quem falou por último / pergunta) antes de ligar à lógica de `start_work` e `study_plan_next`, senão o contexto vai oscilar de forma confusa.
- **Alternativa muito mais simples (recomendada pra v1):** o Gemini multimodal já recebe o frame. Em vez de embed local, mandar junto 1-2 fotos de referência por pessoa (prompt cache) e pedir "quem está nessa imagem? responde só o nome ou 'desconhecido'". Zero dependência nova, zero modelo pra baixar, ~30 linhas em `vision.ts`. Só migrar pra face-api/MediaPipe se latência/custo Gemini incomodar — mesmo arco do Maps/WhatsApp acima.
- **Privacidade ≠ "armazenamento seguro".** Embedding facial é dado biométrico; o mínimo é (1) arquivo só local em `app.getPath('userData')`, (2) opção de apagar por pessoa na UI, (3) nunca subir embedding nem foto-de-cadastro pro Gemini. O plano atual fica em genérico — vale escrever isso explícito antes de implementar.

### Watchlist do dktv via WhatsApp da Kamila
<!-- anchor: 2026-05-10-watchlist-dktv-whatsapp-kamila -->
- **Status:** ideia (2026-05-10)
- **O quê:** quando a integração WhatsApp do Pixxel sair, detectar mensagens da Kamila pedindo "baixa o filme X" e registrar X numa watchlist do dktv (streaming pessoal do Diego em https://dktv.vercel.app, código em `~/Projects/dk/dktv`, filmes hospedados na VPS). Pixxel anota, Diego baixa depois.
- **Por quê:** hoje pedidos da Kamila se perdem em conversa do WhatsApp; centralizar numa fila evita esquecimento e dá ao Pixxel um hook útil sem exigir comando explícito.
- **Notas:**
  - Tratar como function call dedicada (`dktv_add_to_watchlist(title, requester)`), não como side-effect genérico de leitura de mensagem — evita o Pixxel criar entrada em qualquer "será que tem o filme tal?".
  - Persistência no próprio dktv (DB/JSON na VPS), não na memória do Pixxel — watchlist é dado do dktv, Pixxel só escreve nela.
  - Confirmar formato com Diego antes de implementar — pode querer metadata extra (ano, prioridade, quem pediu, status "baixado").
  - Depende da integração WhatsApp resolver primeiro a parte mais arriscada (Baileys vs `wa.me`, ver entradas anteriores). Pra leitura de mensagens vale mesmo o cuidado de privacidade — só rotear pro `dktv_add_to_watchlist` se bater padrão claro de pedido.

### App mobile do Pixxel pra Kamila (Android)
<!-- anchor: 2026-05-10-app-mobile-pixxel-kamila-android -->
- **Status:** ideia (2026-05-10)
- **O quê:** app Android do Pixxel pra Kamila usar no celular dela — escopo reduzido vs desktop, focado em voz + integrações que fazem sentido pra ela (WhatsApp, agenda compartilhada, pedido de filme pro dktv, etc.), sem ferramentas de dev.
- **Por quê:** Pixxel hoje é só desktop e atende o Diego. Várias ideias em discussão (watchlist dktv, WhatsApp) já têm a Kamila como atora natural — faz sentido ela ter o assistente no bolso pra coisas do dia-a-dia do casal.
- **Notas:**
  - Stack JS/TS end-to-end (preferência forte do Diego). React Native/Expo é o caminho default.
  - Backend do Pixxel hoje está congelado até Fase 3 — app mobile provavelmente força destravar essa fase pra ter ponto de sincronização entre desktop dele e mobile dela (Gemini Live por si só não compartilha estado entre clientes).
  - Definir personas explicitamente: o que Kamila pode fazer ≠ o que Diego pode fazer (ex.: ela pede filme, ele aprova/baixa; ela vê agenda compartilhada, não a dele privada).
  - Reaproveita a função de reconhecimento de voz da Kamila já existente no desktop — no mobile dela, é sempre ela, simplifica.
  - Push notifications (já há infra Expo no projeto) viram canal natural pra avisar Kamila de coisas que o Pixxel coletou.

### API do Pixxel não responde / Indicador 'conectando'
<!-- anchor: 2026-05-11-api-do-pixxel-nao-responde-indicador-conectando -->
- **Status:** ideia (2026-05-11)
- **O quê:** Usuário notou que o indicador de conexão está sempre 'conectando', sugerindo que a API do pixxel pode não estar respondendo. Isso está relacionado ao feedback anterior para remover tentativas de reconexão automática.

### trello_integration
<!-- anchor: 2026-05-11-trello-integration -->
- **Status:** planejado (2026-05-11)
- **O quê:** Integração completa com o Trello para criação, edição (etiquetas, datas, checklists, comentários), movimentação e arquivamento automático e manual de tarefas, centralizando a organização.

#### Plano (Gemini)

**Plano de Implementação: Integração Trello**

**1. Configuração Inicial e Autenticação**
- Criar um novo projeto ou módulo para a integração (`trello-integration`).
- Configurar variáveis de ambiente para `TRELLO_API_KEY` e `TRELLO_TOKEN`.
- Implementar fluxo de autenticação OAuth para obter e persistir o token do usuário.

**2. Mapeamento e Estrutura**
- Definir a estrutura de dados para mapear conceitos do Pixxel (tarefas, projetos) com Boards, Lists e Cards do Trello.
- Criar serviços para buscar Boards e Lists disponíveis, permitindo ao usuário configurar onde as tarefas serão gerenciadas.

**3. Implementação de Funcionalidades CRUD**
- **Criação:** Implementar `createCard` (criar tarefas) com campos para título, descrição, data de vencimento (`due`), e membros.
- **Edição:** Desenvolver `updateCard` para suportar:
    - Adição/remoção de etiquetas (`labels`).
    - Definição de datas (`due`).
    - Gestão de checklists (`checklists`).
    - Adição de comentários (`comments`).
- **Movimentação:** Criar `moveCard` para permitir mover cards entre listas (`lists`) específicas.
- **Arquivamento:** Implementar `archiveCard` para arquivar tarefas concluídas ou descartadas.

**4. Automação e Sincronização (Webhooks)**
- Configurar e gerenciar webhooks do Trello para sincronização automática.
- Receber notificações de criação, atualização e movimentação de cards para refletir o estado no Pixxel e vice-versa.

**Riscos e Alternativas:**
- Risco: Limitações da API do Trello ou quotas podem impactar a sincronização em tempo real.
- Alternativa: Implementar sincronização periódica (polling) como fallback.
- Dependências: `axios` para requisições HTTP, bibliotecas de criptografia para armazenamento seguro do token.
