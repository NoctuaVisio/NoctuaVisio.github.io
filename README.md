# noctua-site

Site unificado da Noctua em `noctuavisio.com`. Repo único, deploy estático via GitHub Pages.

## Estrutura

```
.
├── index.html, en/, pt/         Landing page (source of truth visual)
├── inspection/                  Viewer público que clientes abrem via link
├── inspections/<slug>.json      Uma inspeção por arquivo (modelo + rotação + offset + pontos)
├── admin/                       Painel privado (Google OAuth — apenas emails da allowlist)
├── models/                      Modelos 3D legados servidos pelo próprio site
├── marca/, images/              Assets compartilhados
├── landing-models.json          Slugs das inspeções no carrossel da hero da landing
├── scene-core.js                Funções compartilhadas de three.js (viewer + admin)
├── i18n.js                      Dicionário PT/EN + runtime apply
├── 404.html                     Captura /inspection/<slug> e roteia (SPA trick)
└── noctua-viewer.html           Template legado (não usado no fluxo atual)
```

**Modelos `.glb` ficam no bucket público `noctua-models` (GCS) — não entram neste repo.** O admin faz o upload direto via browser, e o `inspections/<slug>.json` aponta pra URL pública do bucket.

## Rodar localmente

```bash
python3 -m http.server 8080
```

URLs:
- `http://localhost:8080/` — landing
- `http://localhost:8080/admin/` — admin
- `http://localhost:8080/inspection/?slug=test` — viewer carregando `inspections/test.json`

⚠ Localmente o `?slug=` é obrigatório — a URL bonita `/inspection/<slug>` só funciona em GH Pages (depende do `404.html` ser servido em rotas inexistentes).

## Fluxo de trabalho (entregar uma inspeção pra um cliente)

Depois do setup inicial (uma vez por máquina — conectar GCS via Google e colar o PAT do GitHub no admin), o fluxo end-to-end roda 100% no browser, sem terminal:

1. **Entrar no admin**
   - Abre `noctuavisio.com/admin/`
   - "Continuar com Google" → login com conta da allowlist (`GCS_CONFIG.allowedEmails`). Próximas visitas com sessão ativa fazem login silencioso sem clique.
2. **Carregar modelo + subir pro GCS** (se for modelo novo)
   - "Carregar Modelo" → escolhe um `.glb` local **ou** cola a URL de um modelo que já está no bucket
   - "Subir pro GCS" → admin calcula SHA-256 do arquivo, checa se já existe (dedupe), faz resumable upload se necessário
3. **Marcar pontos**
   - Renomeia o projeto no header (campo editável)
   - "Adicionar Ponto" → click no modelo → preenche → salva
4. **Gerar link cliente**
   - "Gerar Link Cliente" → preenche slug opcional → "Gerar"
   - Com GitHub conectado: admin faz commit do `inspections/<slug>.json` direto via API, link copiado pro clipboard automático
   - Sem GitHub conectado: cai no modo legado (baixa JSON pra commit manual)
5. **Opcional: adicionar ao carrossel da landing**
   - No painel de resultado, "Adicionar ao carrossel" → admin atualiza `landing-models.json` via API
6. **Enviar pro cliente**
   - Link já está no clipboard, manda direto

GitHub Pages publica em ~30s depois de cada commit.

## Secrets do admin

| O quê | Onde fica | Risco se vazar |
|---|---|---|
| Google OAuth Client ID + bucket name + email allowlist | `GCS_CONFIG` em `admin/index.html` | Nenhum — IDs públicos por design; o gate real é o allowlist (e o IAM no bucket) |
| Access token Google (admin + GCS) | Em memória durante a sessão (não persistido) | Mínimo — escopo `devstorage.read_write` + `email`, expira sozinho em ~1h |
| PAT do GitHub | `localStorage` (por máquina) | Atacante na mesma máquina pode commitar no repo. Use fine-grained PAT escopado só ao repo |

## Adicionar/remover um operador

Edita a lista `GCS_CONFIG.allowedEmails` em [admin/index.html](./admin/index.html), commita e dá push. Em ~30s o acesso atualiza em prod. Pra ser cirúrgico (revogar sessões ativas também), remove o email do IAM no bucket GCS — token continua válido mas perde permissão de upload.

## Carrossel da landing

O hero da landing é um carrossel de inspeções, dirigido por `landing-models.json`:

```json
{ "inspections": ["landing-warehouse", "outro-slug"] }
```

Cada entry referencia `inspections/<slug>.json` (mesmo formato que o admin gera). A landing aplica `modelRotation` + `modelOffset`, renderiza os `points` como markers, e usa o `action` como descrição expandida no detalhe.

Há um botão "Adicionar ao carrossel" no admin (no painel de resultado depois de gerar o link) que faz o read-modify-write do `landing-models.json` via GitHub API. Editar à mão também continua funcionando.

## Roadmap

### Próximas fases

- **Versão light do modelo + mapa de topo** — pra cada `.glb`, gerar um modelo de baixa resolução (~5% da geometria) usado como preview/thumbnail num futuro "sistema de arquivos" por usuario e como progressive-load no viewer (carrega leve, troca pelo pesado em background). Em paralelo, um ortomosaico de topo em alta resolução pra zoom 2D quando não precisa do 3D. Resolve o problema "modelo de 500MB demora 30s pra abrir".
- **Views com dono** — cada `inspections/<slug>.json` ganha um campo `owner` (email). Admin lista as inspeções do operador logado e permite editar. Hoje o `inspections/` é só uma pasta plana.
- **Convergência viewer + admin + landing** — viewer e admin já compartilham `scene-core.js`; a landing ainda tem uma cópia divergente. Unificar pra que renderização de modelo + pontos venha de um lugar só. Reduz drift.
- **View mobile-friendly** — viewer precisa funcionar bem em celular. UI atual assume mouse + tela larga. Targets: gesture controls (pinch zoom, two-finger pan), painel lateral colapsável, tipografia responsiva.

### Visão de longo prazo (admin como pipeline de inspeção)

O fluxo atual ainda é "operador clica pontos manualmente". O fluxo alvo:

1. **Importar modelo 3D + ortomosaico** no admin (modelo: feito; ortomosaico: feature escondida)
2. **Clicar "Analisar"** → admin chama um serviço cloud (Noctua Visão) que devolve os pontos automaticamente, junto com imagens individuais de cada defeito
3. **Admin sobe os artefatos** que ainda não estão no storage (modelo: feito; ortomosaico e fotos: pendente)
4. **Ajuste fino** — operador move/edita pontos detectados automaticamente
5. **Gerar link cliente** — feito, já automatizado end-to-end

Hoje (1) e (4) parcial estão implementados, e o caminho "do upload ao link" está zero-toque. Falta plugar o serviço de análise (2) e a parte ortomosaico/fotos de (3).

Detalhes em [project.md](./project.md) e nas memórias do projeto.

---

## Gerar pontos por imagens

No editor de inspeção do admin, um botão **"Gerar pontos por imagens"** abre uma **nova janela**:

- **Ortomosaico** → mostra a **área de relevância** pra delimitar e **depois** roda a análise.
- **Fotos** (imagens separadas) → vai **direto pra análise**.

Os pontos gerados entram no próprio `inspections/<slug>.json`, junto dos pontos manuais. **Cada ponto guarda a imagem de origem** — qual foto (ou qual tile do orto) ele pertence — pro operador ver o recorte do defeito no ajuste fino. Depois segue pro "Gerar link cliente" (já existe).

Tudo **client-side**, no estilo do resto do site (canvas, OAuth em memória, sem build step; dev em `:8080`). O modelo de IA e o treino são assunto de **outra vida** — hoje nem entram no escopo.
