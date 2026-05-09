# Deploy do pixxel-backend

Backend que recebe webhooks de terceiros (Expo, etc.) e relaya pro desktop via WebSocket.
Persiste fila em SQLite pra reentrega quando o desktop estiver offline.

## Setup inicial na VPS

Premissas (baseado no padrão dos outros projetos da VPS):
- Linux + Docker já configurado
- nginx rodando em container, conf por projeto em `/var/docker/sites/nginx/sites/`
- Network docker `sites` existe (se não, `docker network create sites`)
- Webroot do certbot em `/var/www/webroot`

### 1. Cria o diretório do projeto

```bash
mkdir -p /var/docker/sites/pixxel-backend
cd /var/docker/sites/pixxel-backend
```

### 2. Sobe o código

Duas opções:

**Opção A — via git no servidor:**
```bash
git clone <repo> ../assistant
ln -s ../assistant/apps/backend/Dockerfile .
ln -s ../assistant/apps/backend/docker-compose.yml .
mkdir data
```

**Opção B — copia só o necessário:**
Copia o monorepo inteiro pra um path qualquer (ex: `/opt/assistant`),
depois daqui só:
```bash
cp /opt/assistant/apps/backend/docker-compose.yml .
# Edita o context: build.context aponta pra /opt/assistant
mkdir data
```

### 3. Configura `.env`

```bash
cp /opt/assistant/apps/backend/.env.example .env
# Edita:
#   CLIENT_TOKEN=$(openssl rand -hex 32)
#   EXPO_WEBHOOK_SECRET=<será definido na criação do webhook>
```

Salva o `CLIENT_TOKEN` — vai precisar no `.env` do desktop também.

### 4. Sobe o container

```bash
docker compose up -d --build
docker compose logs -f pixxel_backend  # confirma "pixxel-backend listening"
```

### 5. nginx

```bash
cp /opt/assistant/apps/backend/nginx/pixxel.solutionsdk.duckdns.org.conf \
   /var/docker/sites/nginx/sites/

# Reload do nginx (ajusta o nome do container se for diferente)
docker exec nginx nginx -t && docker exec nginx nginx -s reload
```

### 6. Cert TLS via Let's Encrypt

Antes do reload do nginx funcionar com HTTPS, precisa do cert. Como
o nginx só tem HTTP-01 challenge habilitado pelo bloco da porta 80:

```bash
# Confirma que o subdomínio aponta pro IP da VPS (DuckDNS).
# Depois emite via webroot:
docker run --rm \
  -v /etc/letsencrypt:/etc/letsencrypt \
  -v /var/www/webroot:/var/www/webroot \
  certbot/certbot certonly --webroot \
  -w /var/www/webroot \
  -d pixxel.solutionsdk.duckdns.org \
  --email <seu-email> --agree-tos --non-interactive

# Renova nginx pra carregar o cert
docker exec nginx nginx -s reload
```

### 7. Cria webhook no Expo

```bash
# Local, no projeto Expo do app que você quer monitorar:
eas webhook:create \
  --event BUILD \
  --url https://pixxel.solutionsdk.duckdns.org/webhook/expo \
  --secret <SECRET_LONGO>

# Copia o SECRET pro EXPO_WEBHOOK_SECRET no .env da VPS:
ssh user@vps
cd /var/docker/sites/pixxel-backend
nano .env  # atualiza EXPO_WEBHOOK_SECRET
docker compose restart
```

### 8. Configura o desktop

No `apps/desktop/.env`:
```
WS_URL=wss://pixxel.solutionsdk.duckdns.org/ws
CLIENT_TOKEN=<mesmo token configurado na VPS>
```

Reinicia o Pixxel — ele conecta automaticamente. No primeiro `hello_ok`
o backend drena a fila de pendentes, então qualquer build que ocorreu
enquanto o desktop estava fechado é entregue.

## Como testar localmente sem VPS

```bash
cd apps/backend
cp .env.example .env  # CLIENT_TOKEN qualquer; EXPO_WEBHOOK_SECRET escolha um
npm run dev

# Em outro terminal, simula um webhook:
SIG=$(echo -n '{"status":"finished","appName":"meu-app","platform":"ios"}' \
  | openssl dgst -sha1 -hmac "$EXPO_WEBHOOK_SECRET" -hex | awk '{print $2}')
curl -X POST http://localhost:8080/webhook/expo \
  -H "Content-Type: application/json" \
  -H "expo-signature: sha1=$SIG" \
  -d '{"status":"finished","appName":"meu-app","platform":"ios"}'
```

## Operação

```bash
# Logs
docker compose logs -f pixxel_backend

# Restart
docker compose restart

# Update (após git pull)
docker compose up -d --build

# Backup do SQLite
cp data/pixxel.db data/pixxel-$(date +%Y%m%d).db.bak
```
