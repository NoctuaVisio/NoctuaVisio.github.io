# Noctua — Plano do Projeto

## Visão

Unificar três peças num único site em `noctuavisio.com`:

1. **Landing page** (atual em `~/Downloads/Newsletter HTML`, source of truth do branding/domínio)
2. **Viewer** — página standalone que abre um modelo 3D + pontos de inspeção a partir de uma URL aleatória entregue ao cliente
3. **Admin** — página privada (URL secreta + senha) onde criamos modelos, marcamos pontos e geramos os links pros clientes

MVP sem autenticação real, sem backend complexo, sem banco de dados. Tudo estático, hospedado no GitHub Pages (mesmo deploy da landing).

## Decisões arquiteturais (MVP)

| Tema | Decisão | Motivo |
|------|---------|--------|
| Armazenamento dos modelos (até 1GB) | GCS com **bucket público** e nomes ofuscados (UUID) | 100% estático, sem signed URLs, sem backend. Aceitamos que quem tem o link tem o arquivo pra sempre. |
| Roteamento das URLs do cliente | `noctuavisio.com/v/<slug-aleatorio>` | Slug curto, opaco, sem listagem possível. |
| Admin | `noctuavisio.com/admin/` + senha no carregamento | URL secreta cobre descoberta casual; senha cobre vazamento de link. Suficiente pra MVP. |
| Estrutura de repositório | **Monorepo com pastas separadas** dentro do repo atual da landing | Um deploy, um domínio, um source of truth. |
| Hospedagem | **GitHub Pages** (mantém) | Tudo é estático. Não precisa migrar enquanto não precisarmos de signed URLs ou auth real. |
| Backend | Nenhum no MVP | Se um dia quisermos signed URLs, basic auth real ou stats → migrar pra Cloudflare Pages + Workers. |

## Estrutura final do repositório

Repo único (renomear o `Newsletter HTML` ou criar um novo `noctua-site`):

```
noctua-site/
├── CNAME                  # noctuavisio.com
├── index.html             # landing (raiz)
├── en/index.html
├── pt/index.html
├── images/                # assets da landing
├── marca/                 # branding compartilhado
│
├── v/                     # viewer público
│   ├── index.html         # SPA que lê o slug da URL e carrega o link correspondente
│   └── viewer.js          # lógica do three.js (extraída do noctua-viewer.html)
│
├── admin/       # painel privado (nome do dir é o "segredo")
│   ├── index.html         # prompt de senha + admin
│   └── admin.js           # lógica de marcação de pontos + gerador de link
│
├── links/                 # um JSON por cliente
│   ├── abc123.json        # { "model": "<uuid>.glb", "points": [...], "client": "..." }
│   └── xyz789.json
│
└── README.md
```

### Como funciona o viewer

1. Cliente abre `noctuavisio.com/v/abc123`
2. GitHub Pages serve `v/index.html` (precisa de um pequeno truque com `404.html` pra rotear `/v/<slug>` pro mesmo HTML, ou simplesmente usar `v/index.html?id=abc123`)
3. O JS lê o slug, faz `fetch('/links/abc123.json')`
4. JSON aponta pro modelo público no GCS (`https://storage.googleapis.com/<bucket>/<uuid>.glb`)
5. Viewer carrega modelo + pontos

### Como funciona o admin

1. Eu abro `noctuavisio.com/admin/`
2. Página pede senha (hash da senha hardcoded no JS, validação client-side — fraca, mas combinada com URL secreta basta pro MVP)
3. Carrega modelo local (`.glb`) ou aponta pra UUID existente no GCS
4. Marca pontos como hoje no `noctua-admin.html`
5. Clico em "Gerar link do cliente":
   - JS gera um slug aleatório
   - Monta o JSON `{model, points, client}`
   - Faz download do arquivo `<slug>.json`
6. Eu commito o arquivo em `links/<slug>.json` e dou push
7. GitHub Pages publica em segundos, mando o link `noctuavisio.com/v/<slug>` pro cliente

> **Próxima iteração** (se virar gargalo): admin grava direto no repo via GitHub API com um Personal Access Token, eliminando o passo manual de commit.

## Fases de execução

### Fase 0 — Setup (1 sessão)
- [ ] Decidir nome final do repo unificado e movê-lo pra `~/projects/noctua-site` (ou similar — sair de `Downloads`)
- [ ] Mover conteúdo do Dashboard atual (`noctua-admin.html`, `noctua-viewer.html`) pro repo unificado
- [ ] Configurar bucket GCS público + CORS pra `noctuavisio.com`
- [ ] Subir um modelo de teste com UUID

### Fase 1 — Viewer estático (1 sessão)
- [ ] Extrair lógica three.js do `noctua-viewer.html` pra `v/viewer.js`
- [ ] `v/index.html` lê slug da URL e busca `links/<slug>.json`
- [ ] Configurar roteamento `/v/<slug>` (truque do 404.html do GitHub Pages)
- [ ] Testar com 1 link de exemplo

### Fase 2 — Admin estático (1 sessão)
- [ ] Renomear pasta admin com segredo
- [ ] Adicionar prompt de senha (hash SHA-256 client-side)
- [ ] Adaptar `noctua-admin.html` pra apontar pra modelo do GCS em vez de upload local
- [ ] Botão "gerar link do cliente" que baixa o JSON pronto pra commit

### Fase 3 — Polimento
- [ ] Página de erro decente quando slug não existe
- [ ] Loader/progress bar (modelo 1GB demora)
- [ ] Documentar fluxo de "gerar link" no README

### Fase 4 (futuro, se necessário)
- Admin grava direto via GitHub API
- Migrar pra Cloudflare Pages + Workers se precisarmos de signed URLs, basic auth real ou stats
- Migrar storage pra R2 se egress do GCS virar problema

### Fase 5 — Backlog (próximas)
- [x] **Fotos dos defeitos → GCS.** A foto enviada sobe pro bucket (`img/<hash>.<ext>`,
      dedupe por hash) no "Gerar Link"/"Exportar JSON"; o ponto guarda só a URL.
      Vale pra fotos novas; as já embutidas em JSON commitado ficam até re-publicar.
- [x] **Preview/thumbnail no compartilhamento (WhatsApp/OG).** "Gerar Link" captura
      um print isométrico do modelo → GCS (`thumbnail`) e commita `inspection/<slug>/index.html`
      com as meta tags Open Graph (og:image = thumbnail) que redireciona pro viewer.
      Assim `/inspection/<slug>` vira um 200 real com preview (resolve o 404.html sem OG).
- [x] **Tokens GCS/GitHub expiram → botões param de funcionar.** GCS: rastreia validade
      e renova silencioso (ensureGcsToken), tenta de novo em 401. GitHub: valida o PAT
      (GET /user) antes de commitar e dá erro "reconecte" claro em 401/403.

### Migração futura GCS → Cloudflare R2 (egress zero)
- **Por quê:** R2 não cobra egress (GCS ~$0,12/GB). Pra GLB grande visto muito, é o caminho.
- **Leitura: fácil.** Bucket R2 com domínio próprio; trocar a base das URLs (2 helpers
  `gcsPublicUrl`/`gcsImgPublicUrl` + find/replace nos JSONs já gravados) + copiar o bucket
  (`rclone`/`aws s3 sync`, mecânico).
- **Escrita: médio.** R2 não tem OAuth no browser → precisa de um Cloudflare Worker emitindo
  presigned URLs (admin pede URL → PUT direto). Esse Worker também habilita auth real (Fase 4).

## Riscos conhecidos

- **Bucket público**: link vazado = modelo vazado. Aceitável pro MVP, mas significa que rotacionar acesso = re-upload com novo UUID.
- **Senha client-side**: qualquer um com a URL secreta consegue ver o hash em View Source. Cobre só "amigo que viu por cima do ombro".
- **Modelo de 1GB no GCS**: egress custa ~$0,12/GB. 100 clientes = $12. Atento, mas não bloqueante.
- **Roteamento no GitHub Pages**: `/v/<slug>` precisa do truque do `404.html` ou alternativa com query string (`?id=`). Decidir na Fase 1.
