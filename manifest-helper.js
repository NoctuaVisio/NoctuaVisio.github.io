// Updates /assets/index.json and /inspections/index.json in the repo.
// Best-effort: the hub's fallback is the GitHub Contents API (canonical), so
// even if the manifest goes stale the admin still lists everything. But
// keeping it in sync lets the public hub (no PAT) and local env work directly.
//
// Requires in global scope: GITHUB_REPO, ghHeaders(), ghToken().
(function (global) {
  'use strict';

  // dir: 'assets' | 'inspections'. action: 'add' | 'remove'. Idempotent.
  async function updateManifest(dir, slug, action) {
    if (!slug) return;
    const repo = global.GITHUB_REPO;
    if (!repo) throw new Error('GITHUB_REPO not configured.');
    const token = global.ghToken && global.ghToken();
    if (!token) throw new Error('No PAT to update manifest.');
    const headers = global.ghHeaders ? global.ghHeaders() : { 'Accept': 'application/vnd.github+json', 'Authorization': `Bearer ${token}` };

    const path = `${dir}/index.json`;
    const url  = `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${path}`;

    // 1) Read the current manifest (if any) to capture sha + slugs.
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

    // 2) Apply the mutation and sort (stable).
    const before = slugs.length;
    if (action === 'add' && !slugs.includes(slug)) slugs.push(slug);
    if (action === 'remove') slugs = slugs.filter(s => s !== slug);
    slugs.sort();
    // Short-circuit: nothing changed → don't commit (avoids git noise).
    const after = slugs.length;
    if (action === 'add'    && before === after) return { slugs, skipped: true };
    if (action === 'remove' && before === after) return { slugs, skipped: true };

    // 3) PUT to the repo. No sha = create; with sha = update.
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
      throw new Error(`Manifest ${path} update failed (${resp.status}): ${t.slice(0, 160)}`);
    }
    return { slugs };
  }

  global.NoctuaManifest = { updateManifest };
})(typeof window !== 'undefined' ? window : globalThis);
