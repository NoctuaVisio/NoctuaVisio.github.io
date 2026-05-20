# noctua-site

Site unificado da Noctua em `noctuavisio.com`. Repo único, deploy estático via GitHub Pages.

## Estrutura

```
.
├── index.html, en/, pt/         Landing page (source of truth visual)
├── inspection/                  Viewer público que clientes abrem via link
├── inspections/<slug>.json      Uma inspeção por arquivo (modelo + rotação + offset + pontos)
├── admin-<segredo>/             Painel privado (URL secreta + senha)
├── models/                      Modelos 3D pequenos servidos pelo próprio site
├── marca/, images/              Assets compartilhados
├── landing-models.json          Slugs das inspeções no carrossel da hero da landing
├── scene-core.js                Funções compartilhadas de three.js (viewer + admin)
├── i18n.js                      Dicionário PT/EN + runtime apply
├── 404.html                     Captura /inspection/<slug> e roteia (SPA trick)
└── noctua-viewer.html           Template legado (não usado no fluxo atual)
```

**Modelos grandes (até 1GB) ficam num bucket público do GCS — não entram neste repo.** O `inspections/<slug>.json` aponta pra URL pública deles.

## Rodar localmente

```bash
python3 -m http.server 8080
```

URLs:
- `http://localhost:8080/` — landing
- `http://localhost:8080/admin-<segredo>/` — admin (senha SHA-256 client-side)
- `http://localhost:8080/inspection/?slug=test` — viewer carregando `inspections/test.json`

⚠ Localmente o `?slug=` é obrigatório — a URL bonita `/inspection/<slug>` só funciona em GH Pages (depende do `404.html` ser servido em rotas inexistentes).

## Fluxo de trabalho (entregar uma inspeção pra um cliente)

1. **Marcar pontos no admin**
   - Abre `noctuavisio.com/admin-<segredo>/` e digita a senha
   - "Trocar Modelo" → seleciona o `.glb` local
   - "Adicionar Ponto" → clica no modelo, preenche o modal, salva
2. **Gerar link**
   - "Gerar Link Cliente" → preenche nome do projeto, URL do modelo (GCS ou `/models/<file>.glb`) e slug opcional
   - Baixa um `<slug>.json`
3. **Publicar**
   - Move o JSON pra `inspections/<slug>.json`
   - `git add inspections/<slug>.json && git commit && git push`
   - GH Pages publica em ~30s
4. **Enviar**
   - O link `noctuavisio.com/inspection/<slug>` já está no ar — manda pro cliente

## Trocar a senha do admin

```bash
printf '%s' 'nova_senha_aqui' | shasum -a 256
```

Cola o hash no `admin-<segredo>/index.html` substituindo o valor de `PW_HASH`.

## Carrossel da landing

O hero da landing é um carrossel de inspeções, dirigido por `landing-models.json`:

```json
{ "inspections": ["landing-warehouse", "outro-slug"] }
```

Cada entry referencia `inspections/<slug>.json` (mesmo formato que o admin exporta). A landing aplica `modelRotation` + `modelOffset`, renderiza os `points` como markers, e usa o `action` como descrição expandida no detalhe.

Pra adicionar ou trocar um modelo do carrossel: editar `landing-models.json` à mão (copiar o slug do URL do viewer). Não há UI no admin pra isso — decisão consciente, fluxo manual é suficiente.

## Para onde isso vai (futuro do admin)

O fluxo atual ("clicar em pontos manualmente no admin → exportar JSON → mover pra `inspections/`") é a forma simplificada. O fluxo alvo:

1. **Importar modelo 3D + ortomosaico** no admin.
2. **Clicar "Analisar"** → admin chama um serviço cloud (Noctua Visão) que devolve os pontos automaticamente, junto com imagens individuais de cada defeito.
3. **Admin sobe os artefatos** que ainda não estão no storage (modelo, ortomosaico, fotos) — funcionando como bridge de upload pra GCS.
4. **Ajuste fino** — operador move/edita pontos detectados automaticamente se houver pequenas discrepâncias.
5. **Gerar link cliente** — fluxo atual.

Hoje só (1)/(4) parcial está implementado. O resto vai chegando em fases.

### Fases pendentes (resumo)

- **Fase 2.5** — auto-commit do JSON via GitHub API (eliminar o `mv → commit → push` manual).
- **Mover ponto** — feature pra reposicionar marker existente.
- **Upload bridge mock** — admin reconhece o que está no repo, simula upload pro resto.
- **Botão Analisar (mock)** — chama o "serviço" e popula pontos.
- **Import ortomosaico** — UI pra carregar a imagem 2D.
- **Fase 4 (GCS real)** — upload do modelo `.glb` direto do admin pro bucket público. Implementado no código, requer setup de infra (abaixo).

Detalhes em [project.md](./project.md) e nas memórias do projeto.

## Fase 4 — Upload pro GCS (setup)

O admin tem um botão "Subir pro GCS" que faz upload do `.glb` carregado pro bucket público, usando Google OAuth (sem backend). Nome do arquivo no bucket = SHA-256 do conteúdo + `.glb` — isso dá dedupe automático (se o mesmo arquivo já foi subido, pula o upload).

O botão fica desabilitado até três constantes serem preenchidas em [admin-067darhzhd/index.html](./admin-067darhzhd/index.html) (busca por `GCS_CONFIG`):

```js
const GCS_CONFIG = {
  bucket:        '',  // ex: 'noctua-models'
  oauthClientId: '',  // ex: '1234567890-abc...apps.googleusercontent.com'
  allowedEmails: [],  // ex: ['rafael@noctuavisao.com']
};
```

Até preencher, o fluxo legado (digitar `/models/<file>.glb` à mão no modal de gerar link) continua funcionando.

### Setup uma vez

1. **Criar o bucket** (Google Cloud Console > Cloud Storage):
   - Nome: `noctua-models` (ou outro — coloca em `GCS_CONFIG.bucket`)
   - Region: `us-central1` (egress barato; ajuste se preferir)
   - Public access prevention: **OFF**
   - Uniform bucket-level access: **ON**
2. **Tornar leitura pública (sem listar)**: na aba *Permissions* do bucket, adiciona principal `allUsers` com role **`Storage Legacy Object Reader`**. Importante: NÃO usar `Storage Object Viewer` — ela inclui `storage.objects.list`, que expõe a lista de tudo no bucket pra qualquer um. A "Legacy Object Reader" só dá `storage.objects.get` (leitura por nome conhecido), que é o que o viewer precisa.
3. **Dar permissão de escrita pra sua conta**: na mesma aba, adiciona o email da sua conta Noctua com role `Storage Object Admin` (ou `Storage Object Creator` se quiser estritamente write-only).
4. **CORS no bucket**:
   ```bash
   cat > /tmp/cors.json <<'EOF'
   [{
     "origin": ["https://noctuavisio.com", "http://localhost:8080"],
     "method": ["GET", "HEAD", "PUT", "POST", "OPTIONS"],
     "responseHeader": ["Content-Type", "Authorization", "X-Goog-Resumable", "Content-Range", "X-Upload-Content-Type", "X-Upload-Content-Length", "Location"],
     "maxAgeSeconds": 3600
   }]
   EOF
   gcloud storage buckets update gs://noctua-models --cors-file=/tmp/cors.json
   ```
5. **Ativar API**: APIs & Services > Library > **Cloud Storage JSON API** → Enable.
6. **Criar OAuth Client ID**: APIs & Services > Credentials > Create credentials > **OAuth client ID**:
   - Application type: **Web application**
   - Authorized JavaScript origins: `https://noctuavisio.com`, `http://localhost:8080`
   - Authorized redirect URIs: deixar vazio (usamos o token client implícito)
   - Copia o Client ID pra `GCS_CONFIG.oauthClientId`.
7. **Allowlist de emails**: coloca em `GCS_CONFIG.allowedEmails` a lista de emails Google autorizados a subir. Email que não está na lista é recusado mesmo se o usuário logar com sucesso.

Depois disso: commit + push do `index.html` do admin. Próxima vez que abrir o admin, aparece "Conectar GCS" no header → login → "Subir pro GCS".
