// Atualiza /assets/index.json e /inspections/index.json no repo.
// Best-effort: o fallback do hub é o GitHub Contents API (canônico), então se
// o manifest ficar stale o admin ainda lista tudo. Mas mantê-lo sincronizado
// faz o hub público (sem PAT) e o ambiente local funcionarem direto.
//
// Requer no escopo global: GITHUB_REPO, ghHeaders(), ghToken().
(function (global) {
  'use strict';

  // dir: 'assets' | 'inspections'. action: 'add' | 'remove'. Idempotente.
  async function updateManifest(dir, slug, action) {
    if (!slug) return;
    const repo = global.GITHUB_REPO;
    if (!repo) throw new Error('GITHUB_REPO não configurado.');
    const token = global.ghToken && global.ghToken();
    if (!token) throw new Error('Sem PAT pra atualizar manifest.');
    const headers = global.ghHeaders ? global.ghHeaders() : { 'Accept': 'application/vnd.github+json', 'Authorization': `Bearer ${token}` };

    const path = `${dir}/index.json`;
    const url  = `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${path}`;

    // 1) Lê o manifesto atual (se existir) pra capturar sha + slugs.
    let slugs = [];
    let sha = null;
    try {
      const r = await fetch(`${url}?ref=${repo.branch}&_=${Date.now()}`, { headers, cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        sha = j.sha;
        try { slugs = JSON.parse(atob(j.content.replace(/\n/g, ''))); }
        catch { slugs = []; }
      }
    } catch {}
    if (!Array.isArray(slugs)) slugs = [];

    // 2) Aplica a mutação e ordena (estável).
    const before = slugs.length;
    if (action === 'add' && !slugs.includes(slug)) slugs.push(slug);
    if (action === 'remove') slugs = slugs.filter(s => s !== slug);
    slugs.sort();
    // Curto-circuito: nada mudou → não commita (evita ruído no git).
    const after = slugs.length;
    if (action === 'add'    && before === after) return { slugs, skipped: true };
    if (action === 'remove' && before === after) return { slugs, skipped: true };

    // 3) PUT no repo. Sem sha = create; com sha = update.
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(slugs, null, 2) + '\n')));
    const msg = `chore(manifest): ${action} ${slug} in ${path}`;
    const body = sha
      ? { message: msg, content, branch: repo.branch, sha }
      : { message: msg, content, branch: repo.branch };
    const resp = await fetch(url, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`Manifest ${path} update falhou (${resp.status}): ${t.slice(0, 160)}`);
    }
    return { slugs };
  }

  global.NoctuaManifest = { updateManifest };
})(typeof window !== 'undefined' ? window : globalThis);
