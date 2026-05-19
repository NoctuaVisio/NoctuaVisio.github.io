# noctua-site

Site unificado da Noctua em `noctuavisio.com`. Repo único, deploy estático via GitHub Pages.

## Estrutura

```
.
├── index.html, en/, pt/      Landing page (source of truth visual)
├── inspection/               Viewer público que clientes abrem via link
├── inspections/<slug>.json   Uma inspeção por arquivo (metadata + pontos)
├── admin-<segredo>/          Painel privado (URL secreta + senha)
├── models/                   Modelos 3D pequenos servidos pelo próprio site
├── marca/, images/           Assets compartilhados
├── 404.html                  Captura /inspection/<slug> e roteia (SPA trick)
└── noctua-viewer.html        Template usado pelo "Exportar Viewer" do admin
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

## Onde está o plano

Veja [project.md](./project.md) — fases de execução, decisões arquiteturais, riscos, próximos passos (incluindo Fase 4 do bucket GCS e Fase 2.5 de automatizar o commit do JSON).
