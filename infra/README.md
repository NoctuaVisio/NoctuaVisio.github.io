# Infra — Fatia 0

Objetivo desta fatia: **o site de hoje, idêntico, servido por um container no Cloud Run**.
Nenhum dado muda de lugar, o GitHub Pages continua no ar em paralelo.

Tudo que custa dinheiro está marcado com 💸.

---

## Passo 1 — ferramentas locais (uma vez por máquina)

```bash
brew install --cask google-cloud-sdk
gcloud version
```

Docker **não** é necessário: o build roda no Cloud Build. (Se quiser testar a imagem
localmente, aí sim precisa do Docker Desktop aberto.)

## Passo 2 — entrar na conta (interativo, abre o browser)

```bash
gcloud auth login
gcloud auth application-default login   # credencial que as libs usam
gcloud projects list
```

Provavelmente já existe um projeto — o OAuth client do admin
(`363943270136-…apps.googleusercontent.com`) pertence ao projeto de número **363943270136**,
que é onde o bucket `noctua-models` vive. Dá pra reaproveitar ou criar um novo.

**Reaproveitar:**
```bash
gcloud config set project <PROJECT_ID>
```

**Criar um novo** (mais limpo, separa prod de experimento):
```bash
gcloud projects create noctua-app --name="Noctua App"
gcloud config set project noctua-app
```

## Passo 3 — billing 💸 (o único bloqueio real)

Cloud Run e Cloud SQL exigem conta de faturamento no projeto.

```bash
gcloud billing accounts list
gcloud billing projects link $(gcloud config get-value project) --billing-account=<ACCOUNT_ID>
```

Se `billing accounts list` vier vazio, é preciso criar a conta de faturamento no console
(https://console.cloud.google.com/billing) — cartão de crédito, uma vez.
Nesta fatia o gasto fica em **centavos**: Cloud Run só cobra quando recebe request,
e Artifact Registry/Cloud Build cabem no free tier.

## Passo 4 — provisionar (idempotente, não cria nada caro)

```bash
./infra/00-bootstrap.sh
```

Habilita as APIs, cria o repositório de imagens e a service account `noctua-api`
com os papéis mínimos: `cloudsql.client`, `secretmanager.secretAccessor`, e
`storage.objectAdmin` **escopado ao bucket** (não ao projeto).

## Passo 5 — subir 💸

```bash
./infra/01-deploy.sh
```

Faz upload do repositório (sem `models/` — veja `.gcloudignore`), builda no Cloud Build,
publica no Cloud Run e imprime a URL.

Verificar:
```bash
curl -s https://<url>/api/health     # {"ok":true,...}
curl -s https://<url>/api/version
open https://<url>/                  # a landing, idêntica
open https://<url>/inspection/?slug=landing-warehouse
```

## Passo 6 — rodar local (sem nuvem nenhuma)

```bash
cd /caminho/noctua-site
python3 -m venv .venv && source .venv/bin/activate
pip install -r api/requirements.txt
uvicorn api.main:app --reload --port 8080
```

Substitui o `python3 -m http.server 8080` do README. Mesmas URLs, mais o `/api/health`.

---

## Decisões embutidas nos scripts

| O quê | Valor | Porquê |
|---|---|---|
| Região | `southamerica-east1` (São Paulo) | Latência pros clientes; muda via `REGION=…` |
| Serviço | `noctua-api-staging` | Staging primeiro; prod só no cutover da Fatia 4 |
| `min-instances` | `0` | Cold start é aceitável em staging; vira 1 em prod |
| Build | Cloud Build, não Docker local | Uma dependência a menos na máquina |
| Site no container | copiado, menos `api/`, `infra/`, `.git`, `models/` | Código do backend não pode ser servido como arquivo estático |

## O que ainda NÃO está aqui (de propósito)

- **Cloud SQL** 💸 — entra na Fatia 1, junto com o schema. Criar antes seria pagar por um
  banco vazio.
- **Domínio** — `noctuavisio.com` continua apontando pro GitHub Pages. O domain mapping
  só na Fatia 4, com o GH Pages de rede de segurança.
- **CI** — por enquanto o deploy é manual via script. Trigger no push vem quando o
  deploy já for rotina.

## Pegadinhas conhecidas

- **`models/` tem 1,2 GB** e é local (está no `.gitignore`). O `.gcloudignore` precisa
  excluí-lo, senão cada build sobe 1,2 GB.
- **GitHub Pages publica a raiz do repo.** Sem o `_config.yml` que acabou de entrar,
  `api/main.py` seria servido em `noctuavisio.com/api/main.py`. Se um dia o `_config.yml`
  sumir ou um `.nojekyll` aparecer, esse furo volta.
- **`/healthz` não funciona no Cloud Run.** O Google Frontend intercepta esse path
  antes do container (responde um 404 próprio, com `server` vazio, e a request nem
  aparece no log do Cloud Run). Por isso o health check vive em `/api/health`.
- **Os arquivos continuam na raiz**, não em `web/`. Mover agora quebraria a produção.
