// Shared logic for the asset/inspection hub pages (/assets/, /inspections/,
// /admin/). Each consumer page provides the auth/edit/delete chrome around
// these helpers; this module owns the common parts:
//
//   - language toggle (data-pt / data-en / data-placeholder-* attributes)
//   - theme toggle (html.dark + sun/moon SVG)
//   - notify() toast (uses #notif from admin-hub.css)
//   - asset/inspection listing (manifest first, optional GitHub Contents API
//     fallback for the admin)
//   - landing-models.json reader (for the "featured" badge)
//   - sort/filter helpers
//
// Depends on /inspection-resolver.js (NoctuaInspections.fetchInspectionResolved).
// Exposes window.NoctuaHub.
(function (global) {
  'use strict';

  // ── Utils ─────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]
    ));
  }
  function $(id) { return document.getElementById(id); }

  // ── Lang ──────────────────────────────────────────────────────────────────
  // _lang is the source of truth; consumers read it via NoctuaHub.lang().
  let _lang = 'en';
  const _langListeners = [];
  function lang() { return _lang; }
  function onLangChange(cb) { if (typeof cb === 'function') _langListeners.push(cb); }
  function applyLang(next) {
    _lang = next === 'pt' ? 'pt' : 'en';
    document.documentElement.lang = _lang === 'en' ? 'en' : 'pt-BR';
    const btn = $('btnLang');
    if (btn) btn.textContent = _lang === 'en' ? 'PT' : 'EN';
    document.querySelectorAll('[data-pt]').forEach(el => {
      el.innerHTML = el.dataset[_lang] || el.dataset.pt;
    });
    document.querySelectorAll('[data-placeholder-pt]').forEach(el => {
      el.placeholder = el.dataset[_lang === 'en' ? 'placeholderEn' : 'placeholderPt']
                     || el.dataset.placeholderPt;
    });
    try { localStorage.setItem('noctua_lang', _lang); } catch {}
    _langListeners.forEach(cb => { try { cb(_lang); } catch {} });
  }
  function toggleLang() { applyLang(_lang === 'pt' ? 'en' : 'pt'); }

  // Re-apply current lang to a subtree (used by modals that mount dynamically).
  function applyLangInside(root) {
    if (!root) return;
    root.querySelectorAll('[data-pt]').forEach(el => {
      el.innerHTML = el.dataset[_lang] || el.dataset.pt;
    });
  }

  // ── Theme ─────────────────────────────────────────────────────────────────
  const _SUN  = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
  const _MOON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  const _themeListeners = [];
  function onThemeChange(cb) { if (typeof cb === 'function') _themeListeners.push(cb); }
  function applyTheme(t) {
    const isDark = (t === true) || (t === 'dark');
    document.documentElement.classList.toggle('dark', isDark);
    const btn = $('btnTheme');
    if (btn) btn.innerHTML = isDark ? _SUN : _MOON;
    try { localStorage.setItem('noctua_theme', isDark ? 'dark' : 'light'); } catch {}
    _themeListeners.forEach(cb => { try { cb(isDark ? 'dark' : 'light'); } catch {} });
  }
  function toggleTheme() {
    applyTheme(!document.documentElement.classList.contains('dark'));
  }

  // Boot the user's stored preferences. Defaults: dark theme, language from
  // the browser. Consumers call this once on load.
  function bootPrefs() {
    let lng = null, thm = null;
    try { lng = localStorage.getItem('noctua_lang'); }  catch {}
    try { thm = localStorage.getItem('noctua_theme'); } catch {}
    if (!lng) lng = (navigator.language || 'en').startsWith('pt') ? 'pt' : 'en';
    applyLang(lng === 'pt' ? 'pt' : 'en');
    if (thm === 'light') applyTheme('light');
    else if (thm === 'dark') applyTheme('dark');
    else applyTheme(matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  }

  // ── Notify ────────────────────────────────────────────────────────────────
  // Reuses #notif from admin-hub.css. Caller must have <div id="notif"></div>.
  function notify(msg, isErr) {
    const n = $('notif'); if (!n) return;
    n.textContent = msg;
    n.classList.toggle('err', !!isErr);
    n.classList.add('show');
    setTimeout(() => n.classList.remove('show'), 3400);
  }

  // ── Listings ──────────────────────────────────────────────────────────────
  // The public hubs (assets/, inspections/) get manifest-only because they
  // can't hit the GitHub API without a PAT. The admin passes `gh` options to
  // fall back to the Contents API when the manifest is stale.
  //
  // opts.gh = { owner, repo, branch, headers, authError }
  //   - headers: function returning fetch headers (with Bearer token)
  //   - authError: function(status) returning an Error explaining 401/403
  async function _listFromManifest(dir) {
    const r = await fetch(`/${dir}/index.json`, { cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j) ? j.slice().sort() : null;
  }
  async function _listFromGh(dir, gh) {
    if (!gh || !gh.owner || !gh.repo) return null;
    const url = `https://api.github.com/repos/${gh.owner}/${gh.repo}/contents/${dir}?ref=${gh.branch || 'main'}&_=${Date.now()}`;
    const r = await fetch(url, { headers: gh.headers ? gh.headers() : {}, cache: 'no-store' });
    if (r.status === 404) return [];
    if (r.status === 401 || r.status === 403) {
      throw gh.authError ? gh.authError(r.status) : new Error(`GitHub auth (HTTP ${r.status}).`);
    }
    if (!r.ok) throw new Error(`GitHub list /${dir} (HTTP ${r.status}).`);
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error('Unexpected GitHub response.');
    return j.filter(f => f.type === 'file' && /\.json$/i.test(f.name))
            .map(f => f.name.replace(/\.json$/i, ''))
            .sort();
  }
  async function listAssetSlugs(opts) {
    const m = await _listFromManifest('assets').catch(() => null);
    if (m) return m;
    const g = await _listFromGh('assets', opts && opts.gh);
    if (g) return g;
    throw new Error('Manifest /assets/index.json unavailable.');
  }
  async function listInspectionSlugs(opts) {
    const m = await _listFromManifest('inspections').catch(() => null);
    if (m) return m;
    const g = await _listFromGh('inspections', opts && opts.gh);
    if (g) return g;
    throw new Error('Manifest /inspections/index.json unavailable.');
  }

  // Access lives on the asset (requireLogin === false → open). Default protected.
  function accessOf(j) {
    return (j && j.requireLogin === false) ? 'open' : 'protected';
  }
  function latestDetected(points) {
    if (!Array.isArray(points)) return null;
    let max = null;
    for (const p of points) if (p && p.detected && (!max || p.detected > max)) max = p.detected;
    return max;
  }

  // fetchAsset / fetchInspectionForCard return the shape NoctuaCard expects.
  // Errors collapse to a placeholder card so the grid keeps rendering.
  async function fetchAsset(slug) {
    try {
      const r = await fetch(`/assets/${slug}.json?_=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      return {
        slug,
        project:   j.name      || slug,
        thumbnail: j.thumbnail || null,
        modelName: j.modelName || (j.model ? j.model.split('/').pop() : null),
        model:     j.model     || null,
        date:      j.createdAt ? j.createdAt.slice(0, 10) : null,
        access:    accessOf(j),
        isOpen:    accessOf(j) === 'open',
      };
    } catch (e) {
      return { slug, project: slug, thumbnail: null, modelName: null, model: null,
               date: null, access: 'protected', isOpen: false, error: e.message };
    }
  }
  async function fetchInspectionForCard(slug) {
    try {
      const { inspection, composed: j } = await global.NoctuaInspections.fetchInspectionResolved(slug);
      return {
        slug,
        project:   j.project   || slug,
        thumbnail: j.thumbnail || null,
        points:    Array.isArray(j.points) ? j.points.length : 0,
        asset:     inspection.asset || null,
        date:      j.date || latestDetected(j.points) || null,
        access:    accessOf(j),
      };
    } catch (e) {
      return { slug, project: slug, thumbnail: null, points: 0, asset: null,
               date: null, access: 'protected', error: e.message };
    }
  }

  // Fail-open: if landing-models.json can't be read, return an empty Set.
  async function fetchLandingSlugs() {
    try {
      const r = await fetch(`/landing-models.json?_=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) return new Set();
      const j = await r.json();
      return new Set(Array.isArray(j.inspections) ? j.inspections : []);
    } catch { return new Set(); }
  }

  // ── Sort / filter ─────────────────────────────────────────────────────────
  function sortAssetsByLandingThenDate(items, landingSlugs) {
    return items.slice().sort((a, b) => {
      const aL = landingSlugs && landingSlugs.has(a.slug) ? 0 : 1;
      const bL = landingSlugs && landingSlugs.has(b.slug) ? 0 : 1;
      if (aL !== bL) return aL - bL;
      if (a.date && b.date) return b.date.localeCompare(a.date);
      if (a.date) return -1; if (b.date) return 1;
      return a.slug.localeCompare(b.slug);
    });
  }
  function sortInspectionsByDate(items) {
    return items.slice().sort((a, b) => {
      if (a.date && b.date) return b.date.localeCompare(a.date);
      if (a.date) return -1; if (b.date) return 1;
      return a.slug.localeCompare(b.slug);
    });
  }
  function filterBySearch(items, query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return items;
    return items.filter(i =>
      (i.slug || '').toLowerCase().includes(q) ||
      (i.project || '').toLowerCase().includes(q) ||
      (i.date || '').toLowerCase().includes(q)
    );
  }

  global.NoctuaHub = {
    // i18n + theme
    lang, applyLang, toggleLang, onLangChange, applyLangInside,
    applyTheme, toggleTheme, onThemeChange, bootPrefs,
    // UI
    notify, esc,
    // listing
    listAssetSlugs, listInspectionSlugs,
    fetchAsset, fetchInspectionForCard, fetchLandingSlugs,
    accessOf, latestDetected,
    // sort/filter
    sortAssetsByLandingThenDate, sortInspectionsByDate, filterBySearch,
  };
})(window);
