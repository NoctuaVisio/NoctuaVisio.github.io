# noctua-site

Site unificado da Noctua (`noctuavisio.com`).

Repo único contendo:

- **Landing page** (raiz, `index.html`, `pt/`, `en/`) — versão pública institucional
- **Viewer 3D** (será movido pra `v/` na Fase 1) — abre modelos do GCS via slug aleatório
- **Admin** (será movido pra `admin-<segredo>/` na Fase 2) — marca pontos de inspeção e gera links pros clientes

Hospedagem: GitHub Pages (repo `NoctuaVisio/NoctuaVisio.github.io`, deploy automático em push pra `main`).

Modelos 3D (até 1GB cada) ficam num bucket público do GCS — **não entram neste repo**.

Veja [project.md](./project.md) pro plano completo e fases de execução.

## Como rodar localmente

```bash
python3 -m http.server 8080
```

Depois acesse:

- `http://localhost:8080/` — landing
- `http://localhost:8080/noctua-admin.html` — admin (legado, pré-reorganização)
- `http://localhost:8080/noctua-viewer.html` — viewer (legado, pré-reorganização)
