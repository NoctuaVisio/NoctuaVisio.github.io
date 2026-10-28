# Noctua — Plano de migração: estático → dinâmico

Sucessor do [project.md](./project.md) (que descreve o MVP estático, hoje em produção).
Objetivo: sair do GitHub Pages + JSONs commitados para um app com banco relacional,
login próprio e Label Studio integrado.

## Decisões fechadas

| Tema | Decisão |
|---|---|
| Backend | Python 3.12 + FastAPI (SQLAlchemy 2 + Alembic) |
| Banco | Cloud SQL for PostgreSQL (uma instância, dois databases: `noctua`, `labelstudio`) |
| Hospedagem | Google Cloud — Docker no **Cloud Run**, imagens no Artifact Registry, build no Cloud Build |
| Blobs | GCS (bucket atual `noctua-models` fica público/legado; novos objetos vão pro bucket privado via signed URL) |
| Login | Sessão própria (cookie assinado + tabela de sessões) com OAuth social: Google, GitHub, Microsoft + magic-link |
| Label Studio | Serviço separado, **as imagens são nossas** (GCS source storage), dados sincronizados nos dois bancos via webhook + API. Login unificado é fase 2 (CE não tem OIDC). |
| Frontend | Continua vanilla JS sem build step. Troca a camada de dados, não a renderização. |

---

## 1. Onde estamos (inventário do que precisa migrar)

- **~23k LOC** de JS/HTML/CSS sem build step. `admin/edit/index.html` sozinho tem ~10k linhas — é a maior superfície de refactor.
- **Dados**: `assets/<slug>.json`, `inspections/<slug>.json`, `tasks/eval-*.json`, `landing-models.json`,
  mais os manifestos `assets/index.json` e `inspections/index.json` que existem só porque
  GitHub Pages não lista diretório.
- **Escrita**: o browser commita no repo via GitHub API com um **PAT guardado em localStorage**.
  Some inteiro nessa migração (é o maior buraco de segurança atual).
- **Páginas OG**: `asset/<slug>/index.html` e `inspection/<slug>/index.html` são HTML **gerado e commitado**,
  só pra ter preview no WhatsApp. Viram render server-side.
- **Roteamento**: `404.html` como truque de SPA. Some.
- **Auth**: Google OAuth implícito no browser; admin = allowlist de e-mail hardcoded no HTML;
  viewer = flag `requireLogin` que só coleta e-mail (não protege nada — o GLB está em bucket público).
- **Observabilidade**: pings pro Worker do Discord (`noctua-log.…workers.dev`) — vira audit log no banco,
  com o Discord como notificação opcional.

Invariantes que **não** podem quebrar:
- Links já entregues a cliente (`noctuavisio.com/inspection/<slug>`) continuam funcionando, com o mesmo preview.
- URLs públicas de modelos já no bucket continuam válidas (cliente pode ter cacheado).
- Inspeção funciona **igual em GLB e em Splat** — nada de caminho especial no backend.

---

## 2. Arquitetura alvo

```
                    noctuavisio.com                  label.noctuavisio.com
                           │                                  │
                  ┌────────▼────────┐                ┌────────▼────────┐
                  │  Cloud Run      │                │  Cloud Run      │
                  │  noctua-api     │◄──webhook──────│  label-studio   │
                  │  FastAPI        │───API─────────►│  (imagem CE)    │
                  │  + static + SSR │                └────────┬────────┘
                  └───┬─────────┬───┘                         │
                      │         │                             │
            ┌─────────▼──┐   ┌──▼──────────────┐              │
            │ Cloud SQL  │   │ GCS             │◄─────────────┘
            │ postgres   │   │ (source storage │  lê as MESMAS imagens,
            │ noctua     │   │  + signed URLs) │  via signed URL, sem copiar
            │ labelstudio│   └─────────────────┘
            └────────────┘
```

Um único serviço `noctua-api` serve API JSON **e** os arquivos estáticos **e** o HTML com
as meta tags OG. Sem CORS, um deploy só, e o frontend continua sendo os mesmos arquivos de hoje.

### Layout do repositório

O site **continua na raiz**. Mover pra `web/` quebraria a produção na hora — este repo
*é* o GitHub Pages (`NoctuaVisio.github.io`), servido da raiz. A reorganização, se valer
a pena, só depois do cutover.

```
noctua-site/
├── index.html admin/ asset/ inspection/ *.js *.css   ← o site, intocado
├── api/                      ← novo, excluído do Pages via _config.yml
│   ├── main.py               FastAPI app (routers + StaticFiles + Jinja)
│   ├── db.py models.py       SQLAlchemy
│   ├── migrations/           Alembic
│   ├── auth/                 providers OAuth, sessão, RBAC
│   ├── routes/               assets, inspections, tasks, uploads, share, hooks
│   ├── labelstudio/          client.py, converter.py, sync.py
│   ├── scripts/import_json.py
│   ├── Dockerfile            build context = raiz do repo
│   └── requirements.txt
├── infra/                    env.sh, 00-bootstrap.sh, 01-deploy.sh, README.md
├── _config.yml               mantém api/ e infra/ fora do GitHub Pages
└── migration-plan.md
```

---

## 3. Modelo relacional

Nomes do domínio (Asset, Inspection, Anomaly, Photo) em vez de nomes técnicos.
O que é genuinamente livre (`source`, `align`, `region`) fica em `jsonb`; o resto vira coluna.

**Dois eixos que não se misturam.** Tudo que a IA pode pré-preencher carrega
`author_id` (**quem** produziu) **separado** de `status` (em que ponto da revisão
está). Enfiar os dois num enum só — `ai_suggested`, `human_approved`… — é o erro
clássico: na hora que um humano edita uma sugestão da IA, não dá pra representar.
Separados, "pré-preenchido pela IA esperando revisão" é simplesmente
`author_id=<o user da IA>, status=pending_review`.

**E a IA é um user.** Não existe enum `ai|human`: o detector tem linha em `users`
com `kind='ai'`. `author_id` é sempre FK, nunca nulo, e vale a mesma pergunta pra
pessoa e pra máquina. O ML backend passa a autenticar e ser autorizado pelo RBAC
de todo mundo — um user de IA com grant `labeler` num asset pode anotar foto e
não pode publicar inspeção, pelas mesmas regras que valem pra um estagiário.

A palavra `source` fica reservada pra Photo, que é onde ela significa alguma coisa:
como a imagem foi obtida (drone, câmera de mão, recorte de ortomosaico).

```sql
-- ── identidade, org e acesso ──────────────────────────────────────────
users          (id, email citext unique, name, avatar_url,
                kind: human|ai|service,                -- a IA é um user como outro qualquer
                role: admin|normal,                    -- plataforma: equipe Noctua vs cliente
                created_at, last_seen_at)
--   kind='ai' não tem linha em `identities` → login é impossível por construção,
--   não por checagem espalhada pelo código. Email sintético interno
--   (detector@ai.noctua.internal) mantém o unique simples.
identities     (id, user_id→users, provider, provider_sub, email,
                UNIQUE(provider, provider_sub))        -- google|github|microsoft|email
sessions       (id uuid, user_id, created_at, expires_at, user_agent, ip)

orgs           (id, slug unique, name, created_at)
memberships    (org_id, user_id, role: owner|member, invited_by, joined_at,
                PK(org_id, user_id))

-- Acesso a asset: concedido a uma ORG ou a um USER. Duas tabelas em vez de um
-- subject_type polimórfico — FK de verdade nas duas pontas.
asset_org_access  (asset_id, org_id,  role: editor|labeler|viewer, granted_by, granted_at,
                   PK(asset_id, org_id))
asset_user_access (asset_id, user_id, role: editor|labeler|viewer, granted_by, granted_at,
                   PK(asset_id, user_id))
--   editor  = marca ponto, publica inspeção
--   labeler = anota foto no Label Studio, não publica
--   viewer  = só vê

-- ── blobs no GCS ──────────────────────────────────────────────────────
-- Uma linha por objeto, deduplicado por sha256 (convenção que o site já usa:
-- img/<sha>.<ext>). O sha256 é a chave de cruzamento com o Label Studio:
-- mesmo objeto, referenciado dos dois lados, sem cópia.
images         (id, sha256 unique, bucket, object_path, mime, width, height,
                bytes, created_at)
models3d       (id, sha256 unique, bucket, object_path, kind: glb|splat, bytes,
                rotation jsonb, offset jsonb, scale, created_at, created_by)

-- ── domínio ───────────────────────────────────────────────────────────
assets         (id, owner_org_id→orgs, slug unique, name, description,
                lat, lon, address,                     -- "position"
                thumbnail_id→images, og_title, og_description,
                visibility: public|link|private, created_by, created_at)

inspections    (id, asset_id→assets, slug unique, captured_at,
                inspector_id→users,
                model_id→models3d NOT NULL,            -- o scan daquele voo
                status: draft|evaluating|published, evaluated_at,
                thumbnail_id→images, og_title, og_description,
                visibility, created_by, created_at)

photos         (id, inspection_id, image_id→images,
                kind: photo|ortho_tile, name, taken_at,
                source: drone|handheld|ortho|other,    -- COMO a imagem foi obtida
                device,                                -- "DJI Mavic 3", "iPhone 15"…
                lat, lon, altitude, heading,           -- EXIF/GPS, hoje sempre nulo
                tile jsonb,                            -- {name,x0,y0,x1,y1,xzCell} do recorte
                verdict: pending|clean|has_defects,
                ls_task_id, created_at)

-- A anomalia é só a IDENTIDADE do problema: onde ele está no modelo 3D.
-- O que se sabe sobre ele vive em evaluations; onde ele aparece, em annotations.
anomalies      (id, inspection_id, ext_id 'INC-001',
                px, py, pz, location,
                current_evaluation_id→evaluations,     -- atalho de leitura
                created_by, created_at, updated_at)
anomaly_tags   (anomaly_id, tag)

-- O diagnóstico, versionado. A IA propõe uma linha; o humano que corrige cria
-- outra que supersede a primeira. A original NÃO é sobrescrita — é exatamente
-- o par (o que o modelo disse, o que o humano corrigiu) que treina a próxima
-- versão do modelo. Jogar fora agora é irrecuperável depois.
evaluations    (id, anomaly_id→anomalies,
                problem, suggested_fix,
                criticality: low|medium|high|critical, score numeric,
                area_m2 numeric, depth_m numeric, detected_on date,
                author_id→users NOT NULL,              -- pessoa OU IA
                model_version, confidence,             -- preenchidos quando é IA
                status: draft|pending_review|approved|rejected|superseded,
                reviewed_by→users, reviewed_at,
                supersedes_id→evaluations, created_at, updated_at)

-- Onde a anomalia aparece em cada foto. N:N — uma anomalia em várias fotos,
-- uma foto com várias anomalias. É AQUI que o Label Studio escreve: cada linha
-- é uma annotation dele (ou uma prediction, quando source=ai).
annotations    (id, photo_id→photos, anomaly_id→anomalies NULL,
                region jsonb,                          -- polígono em coords normalizadas
                label,
                author_id→users NOT NULL,              -- pessoa OU IA
                model_version, confidence,             -- preenchidos quando é IA
                status: pending_review|approved|rejected|superseded,
                ls_annotation_id unique, ls_prediction_id, ls_updated_at,
                reviewed_by→users, reviewed_at,
                supersedes_id→annotations, created_at, updated_at)
--   anomaly_id NULL = sugestão da IA ainda não promovida a anomalia.
--   Virar anomalia é o ato de aceitar.

-- ── apoio ─────────────────────────────────────────────────────────────
eval_tasks     (id, inspection_id, kind, status: pending|running|done,
                align jsonb, source jsonb, ls_project_id, created_by, created_at)
featured       (asset_id, position)        -- substitui landing-models.json
share_links    (token pk, inspection_id, expires_at, created_by, revoked_at)
audit_log      (id, at, user_id, action, subject_type, subject_id, meta jsonb)
```

### O ciclo de revisão, concretamente

```
IA roda sobre as fotos (autenticada como o user 'Noctua Visão', kind=ai)
  └─ annotations(author_id=<IA>, status=pending_review, anomaly_id=NULL, confidence=0.83)
     └─ humano abre no Label Studio
        ├─ rejeita  → status=rejected.                      Fim. (vira negativo de treino)
        ├─ aceita   → status=approved + cria anomalies + evaluations(author_id=<IA>,
        │             status=pending_review) com o que o modelo achou
        └─ corrige  → nova annotations(author_id=<humano>, status=approved,
                      supersedes_id=<a da IA>); a da IA vira status=superseded
```

A evaluation segue o mesmo caminho: a IA pré-preenche `problem` / `suggested_fix` /
`criticality` com `status=pending_review`, e o operador aprova ou cria uma versão
nova que supersede. Em nenhum momento o que a IA disse é apagado.

### Modelo 3D: só na inspeção

`inspections.model_id` é **NOT NULL** — cada voo é um scan, e a página do asset
renderiza o scan da **última inspeção**. O asset não guarda modelo nenhum.

Isso tem uma consequência que o importador precisa tratar: hoje três assets têm
modelo e **nenhuma** inspeção — `bo-model3d`, `garten-3gds` e `pollux`. Pra eles o
importador cria uma inspeção *baseline* com `status='draft'` carregando aquele
modelo, datada pelo `createdAt` do asset. Fica coerente com a regra (todo modelo
pertence a algum scan) sem sujar a timeline do cliente, que só mostra inspeção
publicada.

Asset sem nenhuma inspeção passa a ser um estado legítimo — a página mostra o
cadastro e um empty state, não um viewer quebrado.

### A escada de visibilidade

`visibility` tem três degraus, e o do meio é o que preserva o que já existe:

| degrau | quem entra | corresponde a |
|---|---|---|
| `public` | qualquer um, sem login | `requireLogin: false` de hoje |
| `link` | quem tem a URL (o slug é a capability) | `requireLogin: true` de hoje |
| `private` | sessão + acesso ao asset | **novo** — nada usa ainda |

O gate antigo pedia login do Google e aceitava **qualquer** conta: ele registrava
quem olhou, não decidia quem pode. Quem protegia a inspeção era o slug
inadivinhável. Por isso `requireLogin: true` virou `link`, não `private` —
mapear pra `private` revogaria todo link já entregue a cliente.

O que `share_links` acrescenta sobre `link` é **revogabilidade e prazo**: hoje
um link vazado não tem como ser cancelado.

### Normalização que o importador precisa fazer

- `position` hoje são **strings** (`"-8.5189"`) → numeric.
- `area: "0.004 m²"` e `depth: "—"` → `area_m2` numeric, `depth_m` numeric, `—` vira NULL.
- `severity` (low/medium/high) → `criticality`; `type` + `tags` → `anomaly_tags`.
- `action` → `evaluations.suggested_fix`; `type` → `evaluations.problem`.
- Os 41 pontos existentes entram como `evaluations(status=approved)` com `author_id`
  do operador — foram feitos à mão, já estão revisados por definição.
- Os 21 `defects` com `poly` viram `annotations(status=approved)`, mesma autoria.
- `model_version` e `confidence` ficam nulos em tudo que é importado: nada disso
  saiu de modelo.
- O `source` dos JSONs de hoje (`{kind:'ortho', name, nx, ny}`) é geometria de recorte,
  não procedência: vai pro `photos.tile`, e `photos.source` recebe `ortho`.
- PostGIS fica de fora: `lat`/`lon` como numeric bastam até o georreferenciamento
  virar requisito de verdade.

---

## 4. Login

`/auth/{provider}/start` → `/auth/{provider}/callback` com **Authlib**; providers Google,
GitHub e Microsoft, mais magic-link por e-mail. Callback resolve `identities` → `users`
(merge por e-mail verificado), cria linha em `sessions`, seta cookie `HttpOnly; Secure; SameSite=Lax`.

Substituições diretas:
- `GCS_CONFIG.allowedEmails` → `memberships.role in (owner, operator)`.
- Gate do viewer → `visibility` + `share_links`.
- Token GCS no browser → **nunca mais**. Upload passa por `POST /api/uploads/sign`
  (o backend assina a URL resumable com a service account do Cloud Run) e
  `POST /api/uploads/commit` com o sha256.
- PAT do GitHub → deletado, junto com todo o `maintenance-ops.js` de commit.

---

## 5. Label Studio: o pedaço delicado

**O que você pediu**: as imagens são nossas, e alteração feita de um lado aparece do outro.

### Imagens — fonte única, sem cópia
LS lê o nosso bucket por **Source Cloud Storage (GCS)**, com `use_blob_urls` e presigned URLs.
LS guarda só a referência; os bytes nunca saem do nosso GCS. Nada de upload duplicado.
Alternativa se a presign do LS der trabalho: criar as tasks via API com `image` apontando
pra `https://noctuavisio.com/api/img/<sha>?t=<token>`, servido pela nossa API.

### Dados — dois bancos, sincronizados em duas vias
- **LS → nós**: webhooks `ANNOTATION_CREATED / ANNOTATION_UPDATED / ANNOTATION_DELETED`
  batendo em `POST /api/hooks/label-studio` (header com segredo compartilhado + HMAC do corpo).
  Upsert em `annotations` por `ls_annotation_id`.
- **Nós → LS**: quando o operador edita um defeito no nosso editor,
  `PATCH /api/annotations/<ls_annotation_id>` no LS com o `result` convertido.
- **Conversor** (`api/labelstudio/converter.py`): nosso polígono em coordenadas normalizadas ↔
  `PolygonLabels/RectangleLabels` do LS (que usa **porcentagem** + `original_width/height`).
  Um módulo só, as duas direções, com teste de round-trip — é aqui que a sincronização
  vive ou morre.
- **Reconciliação**: job no Cloud Scheduler (`/api/jobs/ls-sync`) varre divergência por
  `updated_at` e conserta drift. Last-write-wins por timestamp, com o conflito indo pro audit log.

### Projetos e tasks
Um projeto LS por `eval_task` (ou por asset, se a quantidade incomodar), criado pela nossa API
com o labeling config XML gerado a partir da nossa taxonomia de defeitos — assim a lista de
labels não diverge entre os dois sistemas.

### Login
Fase 1: LS com contas próprias, criadas com o mesmo e-mail (você disse que não precisa ser unificado).
Fase 2 (opcional): `noctuavisio.com/label/*` como reverse proxy na nossa API — exige nossa sessão,
cria o usuário LS sob demanda e injeta o token. Funciona, mas é gambiarra contida:
**LS CE não tem OIDC/SAML — isso é Enterprise.** Fica isolado num módulo `api/labelstudio/proxy.py`
pra poder morrer no dia que valer a pena pagar.

### A verificar antes da fase 5
- Se o LS precisa de **rqworker + Redis (Memorystore)** separado pro sync de cloud storage —
  se precisar, é mais um Cloud Run (ou job) e mais custo.
- `min-instances=1` no serviço do LS (Django com cold start é sofrível).
- Licença da CE (Apache-2.0 na última vez que olhei) — confirmar antes de embutir.

---

## 6. Fatias de execução

Cada fatia é entregável sozinha e deixa o site funcionando.

### Fatia 0 — Fundação (infra, sem feature) — **concluída**
Projeto GCP: `amazing-pipe-496422-n5` (o mesmo do bucket e do OAuth client), região
`southamerica-east1`. Staging no ar em
`https://noctua-api-staging-363943270136.southamerica-east1.run.app`.
Detalhes e passo a passo em [infra/README.md](./infra/README.md).
- [x] `api/` com FastAPI servindo o site atual da raiz + `/healthz`; `api/Dockerfile`.
- [x] `_config.yml`, `.gcloudignore`, `.dockerignore` — backend fora do Pages, `models/` fora do build.
- [x] `infra/00-bootstrap.sh` (APIs, Artifact Registry, service account) e `infra/01-deploy.sh` (Cloud Build → Cloud Run).
- [x] Paridade verificada localmente: landing, `/admin/`, páginas OG e fallback do `404.html`.
- [x] `gcloud auth login`, projeto escolhido, billing já vinculado ("Conta 1").
- [x] Service account dedicada de build (`noctua-build`) — projetos pós-2024 não dão
      permissão pra SA default do Compute.
- [x] Primeiro deploy no Cloud Run de staging, paridade de bytes verificada contra o site.
- Cloud SQL **não** entra aqui: criar antes do schema é pagar por banco vazio (vai na Fatia 1).
- **Pronto quando**: o site de hoje abre idêntico servido pelo Cloud Run de staging.

### Fatia 1 — Schema + importação — *em andamento*
- [x] `api/models.py` — 20 tabelas, enums como TEXT + CHECK (enum nativo do PG é
      doloroso de alterar, e esse schema ainda vai mudar muito).
- [x] Alembic configurado (`api/alembic.ini`, `api/migrations/`), migration inicial
      `bfe9f2f562a7` aplicada.
- [x] `api/scripts/import_json.py` — rodou contra os dados reais: 8 assets,
      13 inspeções (10 + 3 baseline), 54 fotos, 41 anomalias, 41 evaluations,
      21 annotations, 102 imagens, 8 modelos. Idempotente (2ª rodada, contagens idênticas).
- [x] API **somente leitura** (`api/routes/legacy.py`) devolvendo o shape dos JSONs:
      `/api/assets`, `/api/assets/<slug>`, `/api/inspections`, `/api/inspections/<slug>`,
      `/api/landing-models`, `/api/tasks/<id>`.
- [x] `api/scripts/check_parity.py` — **19 recursos, 0 divergências**. Alguns assets
      saem byte a byte idênticos ao arquivo.
- [ ] Cloud SQL provisionado — `infra/02-cloudsql.sh` pronto, barrado em
      `gcloud auth login` (token expirado, reautenticação precisa de browser).
- **Pronto quando**: um diff programático mostra que API e arquivo são equivalentes pra todos os slugs. ✅

**Os valores saem das colunas normalizadas, não de uma cópia do JSON.** Essa regra é o
que fez o teste valer: ele achou que o importador estava perdendo `points[].source`
(o `nx,ny` da anomalia na imagem de origem — eu tinha confundido com o bbox do tile),
e mais três bugs de formatação. Guardar o JSON cru pra re-emitir teria passado no
teste sem provar nada.

**Duas diferenças são de escrita, não de dado**, e o checker normaliza explicitamente:
`2026-05-25T21:18:24Z` vs `...24.000Z` é o mesmo instante, e `requireLogin` ausente
no arquivo significa `true` — que é como o próprio frontend lê (`!== false`).

**Pareamento anomalia↔foto**: os dados legados não têm ligação explícita. O importador
resolve por geometria — converte o `(nx, ny)` da anomalia no ortho pra coordenada
relativa ao tile e testa point-in-polygon contra o `poly` do defeito. Casou **21 de 21**,
incluindo os tiles com 2 pontos e 2 defeitos, onde parear por ordem erraria calado.

### Fatia 2 — Camada de dados do frontend — **concluída**
- [x] `noctua-data.js` — **módulo único** por onde passa toda leitura de asset,
      inspeção, task e carrossel. Os 16 fetches espalhados por 6 arquivos viraram
      zero: `grep` por `fetch('/assets…')` no site não retorna mais nada.
- [x] Detecta uma vez por page load se a origem serve a API ou os arquivos, e
      roteia tudo. O mesmo código roda no GitHub Pages e no Cloud Run.
- [x] `GET /api/inspections/<slug>?resolved=1` devolve `{inspection, asset, composed}`
      num request. O browser fazia dois fetches e o merge na mão — isso só existia
      porque o GitHub Pages não sabe fazer join.
- [x] `inspection-resolver.js` virou camada fina sobre o módulo (65 → 29 linhas);
      `hub-core.js` perdeu `_listFromManifest` e os fetches próprios.
- [x] Verificado fora do browser (`node`) contra os dois servidores: **saída idêntica**
      nos modos `files` e `api`.
- **Pronto quando**: staging roda inteiro contra a API, sem ler JSON do repo. ✅

**O probe exige o payload, não um 2xx.** Um servidor de arquivos com um diretório
`api/` responde 200 com listagem HTML, e tomar isso por backend quebra toda leitura
da página. Só `{ok:true}` conta — foi o teste nos dois modos que expôs isso.

Os manifestos `index.json` continuam no repo enquanto o GitHub Pages for produção;
só somem no cutover (Fatia 4).

### Fatia 3 — Login — **concluída**
- [x] Sessão própria (`api/auth/sessions.py`): cookie leva token aleatório, banco
      guarda só o SHA-256. Logout é revogação real, não validade que o servidor
      não cancela.
- [x] RBAC num lugar só (`api/auth/deps.py`). Concessão direta ao usuário **e** via
      org são checadas juntas; admin de plataforma vale `editor` em tudo.
- [x] Providers por configuração (`api/auth/providers.py`): Google, Microsoft e
      GitHub acendem pela presença das credenciais, sem mudar código. Google ligado.
- [x] Matching de conta: e-mail **verificado** liga um segundo provider à mesma
      conta; não verificado nunca liga; conta `kind='ai'`/`service` recusa login.
- [x] **Allowlist morta** — zero ocorrências de `allowedEmails` no site. Quem entra
      no admin é `users.role='admin'`, e revogar é `update`, não editar HTML.
- [x] Visibilidade aplicada **na API**, não no browser: `public` aberto, `link`
      exige sessão, `private` exige acesso ao asset. Listagens filtram.
- [x] `share_links` com rotas de criar, listar e revogar; token no `?t=` vale sem conta.
- [x] **Os três clientes OAuth viraram um.** O do viewer (projeto separado) e o
      gate do localStorage foram deletados; sobra o do token de GCS, que morre na Fatia 4.
- [ ] GitHub como segundo provider (OAuth App tem um só callback — precisa de dois apps).
      Descartado por ora: o usuário decidiu que não é necessário.
- [x] UI de share link no admin.
- [x] `/privacy/` e `/terms/`, bilíngues, com a declaração de **Uso Limitado** que o
      Google exige pra publicar o consent screen. Escritos a partir do que o sistema
      realmente coleta, incluindo o beacon do Discord, que manda nome e e-mail pra um
      Worker da Cloudflare — omitir isso tornaria a política falsa.
- [ ] **Publicar o consent screen** (Internal/Testing → External). Só no console; os
      escopos são `openid email profile`, não-sensíveis, então não há verificação do
      Google. Enquanto estiver em Testing, conta de fora do domínio não entra.
- **Pronto quando**: entrar com GitHub dá os mesmos poderes que a conta Google de hoje.

**O gate antigo não era uma tranca.** `signInAs` aceitava qualquer conta Google:
registrava quem olhou, não decidia quem pode. Quem protegia era o slug. Por isso
`requireLogin: true` virou `link` (exige sessão, qualquer conta — igual a antes) e
não `private`, que revogaria todo link já entregue.

**E a inspeção herda a visibilidade do asset.** O JSON de inspeção não tem
`requireLogin` — esse campo vive no asset, e o viewer o lê do objeto composto.
Sem a herança o carrossel da landing ficava vazio, porque a inspeção em destaque
seria `link` com o asset `public`.

### Fatia 4 — Escrita (o fim do GitHub-as-database) — *em andamento*
- [x] `api/ingest.py` — **a normalização num lugar só**. O importador tinha toda a
      lógica (strings→numeric, `"0,004 m²"`, pareamento por polígono); a escrita ia
      reimplementar. Extraído: o importador caiu de 571 pra 246 linhas e as duas
      rotas usam o mesmo código. Paridade 29/29 confirmou que o refactor não mudou nada.
- [x] `PUT /api/assets/<slug>` e `PUT /api/inspections/<slug>`, aceitando **o shape
      que o editor já tem em mãos** — troca de transporte, não de modelo de dados.
      Round-trip verificado: a resposta é idêntica ao arquivo de origem.
- [x] `DELETE /api/inspections/<slug>` e audit log em toda escrita.
- [x] `POST /api/uploads/sign` + `/commit` — URL assinada por objeto, método e prazo
      (15 min), assinada via IAM signBlob porque o Cloud Run não tem chave privada.
      Dedupe por sha256 mantido: objeto que já existe não sobe de novo.
- [x] **O GitHub saiu do site inteiro.** Auditado: zero `api.github.com`, zero
      `devstorage`, zero `noctua_gh_token`, zero `accounts.google.com`.
      `manifest-helper.js` deletado — `index.json` existia porque o GitHub Pages
      não lista diretório, e o banco lista.
- [x] **Dois buckets**, `noctua-models` (público) e `noctua-private-staging`.
      `uniform-bucket-level-access` + `public-access-prevention` + versionamento,
      reafirmados a cada execução do script. Nada migra entre eles: cada linha
      guarda seu bucket, então URL já entregue continua valendo.
- [x] Upload por URL assinada **validado no Cloud Run**: sign → PUT direto no GCS
      → commit, com a assinatura vinda do IAM signBlob. O objeto resultante dá
      **403 público** — o bucket privado funciona.
- [x] Reclamação de órfãos movida pro backend. O admin calculava isso no browser
      buscando *todo* asset e inspeção pra montar o keep-set: O(n) requisições e
      corrida com qualquer save concorrente. Em SQL é uma query por tabela.
- [x] Páginas OG renderizadas por `api/routes/pages.py`, substituindo o HTML
      commitado. Era o único motivo do gerador existir, então tinha que vir antes.
- [x] `infra/09-domain.sh check` — verificação de prontidão pro cutover.
- [ ] **Cutover de DNS**: `./infra/09-domain.sh map` + trocar os registros no
      registrador. É o único passo que não dá pra fazer daqui, e o único
      irreversível em termos de links de cliente.
- **Pronto quando**: criar uma inspeção do zero não toca em git nenhuma vez. ✅

**O que o browser perdeu, e era o ponto:** um PAT no `localStorage` que podia
dar push em qualquer coisa do repo, e um token Google com `devstorage.read_write`
que podia escrever qualquer coisa no bucket — herdado por qualquer script
rodando na página. Agora o browser não carrega credencial nenhuma: o cookie de
sessão diz quem é, e o backend decide e assina.

**Default privado no upload**: esquecer a flag super-protege em vez de publicar o
modelo de um cliente. E se `GCS_PRIVATE_BUCKET` não estiver configurado, o upload
falha com 503 em vez de cair no bucket público.

**O modelo da landing tinha 55 MB.** 1,8 milhão de triângulos, 1,1 milhão de
vértices e um `TEXCOORD_0` em cada primitiva embora nenhum dos quatro materiais
tenha textura — UV puro desperdício. Em visita nova (sem cache) a hero ficava
baixando por minutos, e se a transferência caísse o `GLTFLoader` chamava o
callback de erro, que só escondia o loader e deixava na tela um galpão de
`BoxGeometry` construído à mão, como se fosse o produto. O galpão falso morreu;
a falha agora diz o que aconteceu e oferece tentar de novo, e o progresso mostra
megabytes em vez de só uma barra. `infra/cloudbuild-optimize-model.yaml` +
`infra/optimize-model.mjs` encolhem o GLB dentro da rede do Google, sem Draco
nem meshopt de propósito: os dois exigiriam registrar um decoder nos cinco
pontos que constroem `GLTFLoader`, e um modelo que não decodifica é uma hero em
branco. Só glTF puro e `KHR_mesh_quantization`, que o three.js lê nativamente.

**Os bytes não passam pelo serviço.** Um modelo de 55 MB atravessando um container
de 512 MiB custaria CPU e egress sem ganho nenhum — o browser faz `PUT` direto no
GCS com a URL assinada.

**Decisão pendente: leitura em bucket privado.** URL assinada de leitura muda a cada
request, o que derruba o cache do browser — um `.glb` de 55 MB seria baixado de novo
a cada visita. A saída implementada em `api/storage.py` é arredondar o prazo pra uma
janela fixa (12h), então a URL é idêntica pra todos dentro da janela e o cache volta
a funcionar. Falta decidir se vale a troca, porque isso também quebra a paridade:
a URL no payload deixa de ser estável pra sempre.

### Fatia 4.5 — Um hub só — **concluída**

Três páginas renderizavam a mesma grade a partir dos mesmos dados e diferiam só
no que descartavam depois. `/assets/` e `/inspections/` guardavam
`requireLogin === false` e jogavam o resto fora; `/admin/` mostrava tudo atrás de
um muro de login. O resultado: **um asset concedido a uma pessoa nunca aparecia
pra ela** — a API honrava a concessão e a página a descartava. O mesmo defeito
estava em `/asset/`, que recusava qualquer asset não-público a quem não fosse
admin da plataforma, inclusive ao cliente que acabara de recebê-lo.

- [x] `GET /api/hub` — uma resposta com quem está olhando, cada asset que essa
      pessoa pode abrir **com o papel que ela tem nele**, as inspeções dentro,
      a contagem de pontos, o que está na landing e o que tem avaliação aberta.
      Substitui o que a página pedia em `2 + 3N` requests.
- [x] `/assets/` é o hub, de todo mundo. `?asset=<slug>` é a vista de inspeções.
      `/admin/`, `/inspections/`, `/admin/list/` e `/admin/inspections/`
      redirecionam pra lá em um salto.
- [x] **Sem muro de login.** Quem você é decide o que a grade contém e quais
      botões cada linha carrega, não se você pode olhar a página. O cabeçalho diz
      qual das três pessoas você é ("Todos os assets" / "Seus assets" /
      "Assets da Noctua").
- [x] O modo do card é **por linha**, vindo de `canEdit` que o servidor resolveu.
      Um editor com acesso a um asset vê as ações desse asset e de nenhum outro.
- [x] `may_read` existe **uma vez** (`api/auth/deps.py`); `legacy.py` tinha uma
      segunda cópia da escada de visibilidade e agora delega.
- [x] Morreram: o gate de asset privado no viewer, `primeAdmin`/`isAdminUnlocked`
      (nada mais ramificava nisso), o N+1 da timeline do asset, e o `landingSlugs`
      que era um conjunto de slugs de **inspeção** testado contra slugs de asset.
- [x] Testes que reproduzem o bug: `tests/page-boot.mjs` ganhou **personas**
      (`client@assets/index.html`) e verifica que toda linha que a pessoa pode
      abrir está na grade e que nenhuma linha que ela não pode editar traz botão
      de operador. `tests/api_access.py` prova o mesmo contra Postgres de verdade,
      em transação revertida — 30 checks, incluindo que concessão pessoal **não**
      vaza pra organização.
- **Pronto quando**: entrar com uma conta que recebeu um asset privado mostra
  esse asset na grade e abre o viewer dele. ✅

**`editor` edita; não distribui acesso.** As três rotas de `/api/assets/<slug>/access`
exigiam `editor`, então um editor num asset podia conceder **`editor` naquele asset
a qualquer pessoa** — a si mesmo e a qualquer um de fora. Escalonamento alcançável
por quem recebeu o papel de escrita mais fraco que a gente dá. Gerenciar acesso
agora pede **admin de plataforma**, numa definição só
(`deps.may_manage_access`), e o hub devolve `canManageAccess` por asset pra UI
obedecer em vez de inferir de `canEdit`. O `asset` está na assinatura do
predicado sem ser usado de propósito: a regra é per-asset em princípio, e o passo
óbvio é deixar o owner de uma org de cliente convidar os próprios colegas pro
próprio asset. Travado por `tests/api_access.py` (editor/viewer/estranho → 403,
anônimo → 401, admin → 200) e pela persona `editor@` em `tests/page-boot.mjs`,
que é a única que expressa "escreve mas não é admin".

**Ainda com `editor`, a decidir:** `DELETE /api/assets/<slug>` e
`DELETE /api/inspections/<slug>`. Apagar um asset cascateia pra todas as
inspeções dele, o que é mais que editar.

**Dois bugs que o hub único revelou:**

*Cache sem hash.* O `StaticFiles` não manda `Cache-Control` nenhum, e resposta
sem ele e sem `Expires` é cacheada **heuristicamente** — o navegador inventa a
validade a partir do `Last-Modified`. Sem build step nenhum nome de arquivo tem
hash, então o navegador combinou HTML novo com `hub-core.js` velho e a página
morreu com `NoctuaHub.fetchHub is not a function`, com o servidor entregando os
bytes certos. `RevalidatingStatic` em `api/main.py` põe `no-cache` ("guarde, mas
pergunte antes de usar") em tudo que sai do mount; continua barato porque 304 é
o caso normal. Blobs no GCS ficam de fora de propósito: content-addressed, com
`max-age=31536000, immutable`. Travado por `tests/api_http.py`.

*A inspeção renderizava o scan de outra.* `asset_payload` reporta o modelo da
inspeção **mais recente**, que é o certo pra página do asset. Mesclado debaixo de
uma inspeção, significava pedir a inspeção X e receber o scan da Y — o carrossel
pede uma inspeção featured e recebia o voo mais novo. Invisível enquanto todas as
inspeções de um asset apontam pro mesmo blob, errado no instante em que uma é
revoada. `resolved_payload` agora sobrepõe o scan da própria inspeção, e só em
`composed`: os arquivos legados não trazem modelo na inspeção, então emitir um no
endpoint cru quebraria paridade sem ganho. `model_fields()` é a definição única de
como um scan se escreve num payload.

### Fatia 5 — SSR e limpeza
- `/asset/<slug>` e `/inspection/<slug>` renderizados por Jinja com as meta tags OG do banco.
- Apagar os diretórios de HTML gerado e o `404.html`.
- Carrossel da landing lendo `featured`.
- **Pronto quando**: compartilhar um link novo no WhatsApp mostra preview sem nada ter sido commitado.

### Fatia 6 — Label Studio
- Cloud Run do LS + database `labelstudio` + GCS source storage.
- Criação de projeto/task a partir do fluxo imggen.
- Webhook, conversor e reconciliação.
- **Pronto quando**: anotar um polígono no LS aparece no nosso editor sem reload manual, e vice-versa.

### Fatia 7 — Depois
- Proxy de login unificado pro LS.
- Audit log substituindo os pings do Discord (Discord fica como notificação).
- CDN na frente dos GLBs (ou R2, se egress do GCS incomodar).
- Serviço de análise plugado como **ML backend** do LS — pré-anotação automática,
  que é exatamente o fluxo 2 do roadmap do README.

---

## 7. Custo mensal estimado (GCP, ordem de grandeza)

| Item | ~USD/mês |
|---|---|
| Cloud SQL Postgres menor tier (sem HA) | 10–25 |
| Cloud Run `noctua-api` (min-instances 0–1) | 0–15 |
| Cloud Run `label-studio` (min-instances 1) | 10–20 |
| GCS storage 1,5 GB + egress dos GLBs | depende do tráfego (hoje já é o maior item) |
| Artifact Registry / Cloud Build / Secret Manager | ~0 (free tier) |

---

## 8. Riscos

- **`admin/edit/index.html` com 10k linhas** é o grande risco de cronograma. Não refatorar
  o arquivo nessa migração — só trocar a camada de dados por baixo. Refactor é outra conversa.
- **Cold start no Cloud Run** em páginas que já demoram por causa de modelo pesado.
  `min-instances=1` na API, estáticos no CDN.
- **Cutover de DNS**: links de cliente são o ativo mais sensível. Manter GH Pages servindo
  em paralelo até o tráfego confirmar que nada quebrou.
- **Sincronização com LS** é a parte com mais chance de drift silencioso. O conversor
  precisa de teste de round-trip desde o primeiro commit, e o job de reconciliação
  entra junto — não depois.
- **Dois bancos** significa dois backups e duas migrações. Mesma instância reduz ops,
  mas não torna a consistência automática.
