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
- **Fase 4 (GCS real)** — substitui mock por upload real pro bucket público.

Detalhes em [project.md](./project.md) e nas memórias do projeto.
