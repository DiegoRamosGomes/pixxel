# Piper TTS — setup manual

Coloque aqui o binário do Piper e o modelo de voz. Esses arquivos são grandes
(uns ~100MB) e estão no `.gitignore`, então cada máquina baixa o seu.

## Pré-requisito do sistema

Pra tocar o áudio, o app usa `aplay` (alsa-utils) ou `paplay` (PulseAudio) —
um dos dois geralmente já vem instalado. Se nenhum existir:

```sh
sudo apt install alsa-utils    # ou pulseaudio-utils
```

Teste rápido: `which aplay` deve retornar um caminho.

## 1. Binário do Piper

Baixe a release Linux x86_64 mais recente:

https://github.com/rhasspy/piper/releases

Procure por algo como `piper_linux_x86_64.tar.gz`. Extraia e copie o
executável `piper` (e os arquivos `.so` que vêm junto) pra dentro deste
diretório (`apps/desktop/resources/piper/`).

Estrutura final esperada:

```
apps/desktop/resources/piper/
├── piper                         (executável)
├── espeak-ng-data/               (vem junto da release)
├── libonnxruntime.so.x.x.x       (vem junto)
├── libpiper_phonemize.so.x       (vem junto)
└── ...
```

Teste:

```sh
echo "Olá, eu sou o Jarvis." | ./piper --model pt_BR-faber-medium.onnx --output_file teste.wav
```

(precisa ter o modelo do passo 2 no mesmo diretório)

## 2. Modelo de voz pt-BR

Baixe os DOIS arquivos do modelo (`.onnx` + `.onnx.json`) e coloque neste
diretório.

### Vozes recomendadas (em ordem de naturalidade)

1. **Cadu medium** (recomendada — mais natural, menos pausa)
   https://huggingface.co/rhasspy/piper-voices/tree/main/pt/pt_BR/cadu/medium
   - `pt_BR-cadu-medium.onnx`
   - `pt_BR-cadu-medium.onnx.json`

2. **Edresson low** (voz mais grave, alternativa)
   https://huggingface.co/rhasspy/piper-voices/tree/main/pt/pt_BR/edresson/low

3. **Faber medium** (a primeira que você usou — mais robótica)
   https://huggingface.co/rhasspy/piper-voices/tree/main/pt/pt_BR/faber/medium

### Configurando qual voz usar

No `apps/desktop/.env`, defina:

```
PIPER_VOICE=pt_BR-cadu-medium
```

Outras envs úteis pra fluidez:

```
PIPER_LENGTH_SCALE=0.95     # 0.85-1.0 = mais rápido, default 1.0
PIPER_SENTENCE_SILENCE=0.05 # default 0.2 (engasga); 0.05 fica fluido
```

### Trocar voz

Baixe outro `.onnx + .onnx.json`, coloque aqui, mude `PIPER_VOICE` no `.env`
e reinicia o desktop. Não precisa mexer em código.

## 3. Reiniciar o Electron

Após colocar binário + modelo, feche e abra o `npm run dev:desktop`. O
toggle "🔊 voz" no header deve sair de "sem voz" pra "voz mudo" — clica e
ele liga.

## Trocar pra outra voz

Se quiser outra voz pt-BR (ou outra língua), baixe outro `.onnx` + `.onnx.json`
e troque o nome do arquivo no código (`apps/desktop/src/main/voice/tts.ts`,
constante `pt_BR-faber-medium.onnx`). Em iteração futura podemos transformar
isso em variável de ambiente.
