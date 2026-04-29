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
- **Por quê:** identidade visual estilo Jarvis, dá feedback imediato de que o sistema está ouvindo/respondendo (sem precisar ler texto). Inspiração nas imagens de referência (anéis concêntricos azul/ciano em fundo escuro).
- **Notas:**
  - Estados visuais distintos a considerar: idle, ouvindo, processando (pensando), falando, erro/offline. Cada estado tem cor/comportamento diferente.
  - Implementação: Web Audio API (`AnalyserNode.getByteFrequencyData` ou `getByteTimeDomainData`) alimentando um canvas/WebGL. Bibliotecas possíveis: `wavesurfer.js`, `three.js` para algo mais 3D, ou Canvas 2D puro se for simples.
  - Performance: animação roda a 60fps com áudio em tempo real — testar consumo de CPU, principalmente se rodar em background.
  - Considerar acessibilidade: alguma indicação textual/legível além do visual (label "ouvindo", "falando").
  - Versão "minimal" (só um anel pulsante) pode vir antes da versão "full Jarvis" com vários anéis e detalhes geométricos.

---

## (Adicionar novas categorias aqui conforme surgirem)
