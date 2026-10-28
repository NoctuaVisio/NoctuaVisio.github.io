// Single entry point for every read of asset / inspection / task data.
//
// The same files are served two ways while the migration runs: by the FastAPI
// app (which has a database behind it) and by GitHub Pages (which has only the
// committed JSON). This module resolves which one it is talking to ONCE, then
// routes every call accordingly, so no caller has to know or care.
//
// Nothing else in the site should fetch /assets/*.json, /inspections/*.json,
// /tasks/*.json or /landing-models.json directly. If you are about to write
// such a fetch, add a function here instead.
(function (global) {
  'use strict';

  let _modePromise = null;

  // 'api' when this origin serves the backend, 'files' on the static site.
  // One probe per page load; every later call reuses the resolved value.
  function mode() {
    if (!_modePromise) {
      // The probe insists on the actual health payload, not merely a 2xx. A
      // plain file server with an api/ directory happily answers 200 with an
      // HTML listing, and taking that for a backend breaks every read on the
      // page. Only {ok:true} counts.
      _modePromise = fetch('/api/health', { cache: 'no-store' })
        .then(r => (r.ok ? r.json() : null))
        .then(j => (j && j.ok === true ? 'api' : 'files'))
        .catch(() => 'files');
    }
    return _modePromise;
  }

  async function json(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  }

  // Cache-busting only matters for the static site, where GitHub's CDN serves
  // the file; the API already answers no-store.
  function bust(url) { return `${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`; }

  // A share token in the URL (?t=…) is the capability for a client who has no
  // account. It lives here rather than at each call site so every read carries
  // it automatically — forgetting it in one place is how a shared link breaks
  // on exactly one page.
  function shareToken() {
    try { return new URLSearchParams(location.search).get('t') || null; }
    catch (_) { return null; }
  }

  function withToken(url) {
    const t = shareToken();
    if (!t) return url;
    return `${url}${url.includes('?') ? '&' : '?'}t=${encodeURIComponent(t)}`;
  }

  // Session-storage handoff: right after the admin commits a resource via the
  // GitHub API, the matching file is not served yet (~30s of CDN propagation).
  // Stashing the object lets the next page hydrate immediately. Consumed on
  // read. Disappears with the GitHub write path itself.
  function takeStash(kind, slug) {
    try {
      const key = `${kind}-bootstrap-${slug}`;
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;
      sessionStorage.removeItem(key);
      return JSON.parse(raw);
    } catch (_) { return null; }
  }

  async function listAssets() {
    return (await mode()) === 'api'
      ? json('/api/assets')
      : json(bust('/assets/index.json'));
  }

  async function listInspections() {
    return (await mode()) === 'api'
      ? json('/api/inspections')
      : json(bust('/inspections/index.json'));
  }

  async function getAsset(slug) {
    const stash = takeStash('asset', slug);
    if (stash) return stash;
    return (await mode()) === 'api'
      ? json(`/api/assets/${encodeURIComponent(slug)}`)
      : json(bust(`/assets/${slug}.json`));
  }

  async function getInspection(slug) {
    const stash = takeStash('inspection', slug);
    if (stash) return stash;
    return (await mode()) === 'api'
      ? json(withToken(`/api/inspections/${encodeURIComponent(slug)}`))
      : json(bust(`/inspections/${slug}.json`));
  }

  // { inspection, asset, composed } — composed is the legacy shape the viewer,
  // admin and landing all read: asset fields, overridden by inspection fields,
  // plus `project` from the asset name.
  //
  // In api mode this is one round trip. In files mode it is still two, which is
  // the whole reason the endpoint exists.
  async function getInspectionResolved(slug) {
    if ((await mode()) === 'api' && !peekStash('inspection', slug)) {
      return json(withToken(`/api/inspections/${encodeURIComponent(slug)}?resolved=1`));
    }
    const inspection = await getInspection(slug);
    // A legacy inspection carries its own model and has no asset to merge.
    if (!inspection.asset) return { inspection, asset: null, composed: inspection };
    const asset = await getAsset(inspection.asset);
    return {
      inspection,
      asset,
      composed: Object.assign({}, asset, inspection, { project: asset.name }),
    };
  }

  function peekStash(kind, slug) {
    try { return sessionStorage.getItem(`${kind}-bootstrap-${slug}`) !== null; }
    catch (_) { return false; }
  }

  // Which evaluation tasks exist for an inspection. Only the API can answer:
  // on the static site the editor listed the tasks/ directory through GitHub.
  async function listInspectionTasks(slug) {
    if ((await mode()) !== 'api') return [];
    try {
      const j = await json(`/api/inspections/${encodeURIComponent(slug)}/tasks`);
      return j.tasks || [];
    } catch (_) { return []; }
  }

  async function getTask(id) {
    return (await mode()) === 'api'
      ? json(`/api/tasks/${encodeURIComponent(id)}`)
      : json(bust(`/tasks/${id}.json`));
  }

  // Everything the hub grid needs, in one answer: who you are, every asset you
  // may open with the role you hold on it, the inspections inside them, and the
  // badges. Null on the static site, which has no identity to report and no
  // join to do it with — hub-core composes the same shape from the files there.
  async function hub() {
    return (await mode()) === 'api' ? json('/api/hub') : null;
  }

  async function landingSlugs() {
    try {
      const j = (await mode()) === 'api'
        ? await json('/api/landing-models')
        : await json(bust('/landing-models.json'));
      return Array.isArray(j.inspections) ? j.inspections : [];
    } catch (_) {
      return [];   // fail-open: the carousel is decoration, not function
    }
  }

  async function assetExists(slug) {
    // GET against the API (the payload is a few hundred bytes and the routes
    // are GET-only), HEAD against the static site (where it saves the body).
    try {
      if ((await mode()) === 'api') {
        const r = await fetch(`/api/assets/${encodeURIComponent(slug)}`, { cache: 'no-store' });
        return r.ok;
      }
      const r = await fetch(bust(`/assets/${slug}.json`), { method: 'HEAD', cache: 'no-store' });
      return r.ok;
    } catch (_) { return false; }
  }

  global.NoctuaData = {
    mode,
    shareToken,
    hub,
    listAssets,
    listInspections,
    getAsset,
    getInspection,
    getInspectionResolved,
    getTask,
    listInspectionTasks,
    landingSlugs,
    assetExists,
  };
})(typeof window !== 'undefined' ? window : globalThis);
