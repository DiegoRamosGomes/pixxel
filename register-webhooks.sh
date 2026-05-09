#!/usr/bin/env bash
set -euo pipefail

# Ajusta se o root dos seus projetos for outro
PROJECTS_ROOT="${PROJECTS_ROOT:-$HOME/Projects}"

WEBHOOK_URL="https://pixxel.solutionsdk.duckdns.org/webhook/expo"

PROJECTS=(
  "girolabs/easytax-app"
)

# Gera secret único compartilhado entre todos os webhooks
SECRET=$(openssl rand -hex 32)

echo "═══════════════════════════════════════════════════════"
echo "  EXPO_WEBHOOK_SECRET (salve!):"
echo "  $SECRET"
echo "═══════════════════════════════════════════════════════"
echo

# Confirma login no EAS
if ! eas whoami >/dev/null 2>&1; then
  echo "✕ eas não tá logado. Rode: eas login"
  exit 1
fi
echo "✓ logado como: $(eas whoami)"
echo

for project in "${PROJECTS[@]}"; do
  path="$PROJECTS_ROOT/$project"
  echo "── $project"
  if [ ! -d "$path" ]; then
    echo "  ✕ diretório não existe: $path — pulando"
    continue
  fi
  if [ ! -f "$path/eas.json" ] && [ ! -f "$path/app.json" ]; then
    echo "  ✕ não parece ser projeto Expo (sem eas.json/app.json) — pulando"
    continue
  fi
  if (cd "$path" && eas webhook:create \
        --event BUILD \
        --url "$WEBHOOK_URL" \
        --secret "$SECRET" 2>&1 | sed 's/^/  /'); then
    echo "  ✓ webhook criado"
  else
    echo "  ✕ falhou"
  fi
  echo
done

echo "═══════════════════════════════════════════════════════"
echo "  PRONTO. Cola este valor no .env da VPS:"
echo "  EXPO_WEBHOOK_SECRET=$SECRET"
echo "═══════════════════════════════════════════════════════"
