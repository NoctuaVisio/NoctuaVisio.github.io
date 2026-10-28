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
  // Used by assets/ and inspections/ through the global below — those pages are
  // thin and call $() directly rather than reaching through NoctuaHub.
  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]
    ));
  }

  // ── Lang ──────────────────────────────────────────────────────────────────
  // _lang is the source of truth; consumers read it via NoctuaHub.lang().
  let _lang = 'en';
  const _langListeners = [];
  function lang() { return _lang; }
  function onLangChange(cb) { if (typeof cb === 'function') _langListeners.push(cb); }
  let _applying = false;
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

    // Two translation mechanisms live in this site: data-pt/data-en, walked
    // above, and i18n.js keys on data-i18n. Pages mix them — the editor has
    // thirty-one data-i18n elements and its language button comes through here
    // — so one click has to drive both or half the page stays in the old
    // language. The guard stops the two from calling each other forever.
    if (!_applying && global.NoctuaI18n && global.NoctuaI18n.apply) {
      _applying = true;
      try { global.NoctuaI18n.apply(_lang); } catch (_) {}
      _applying = false;
    }

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
  // Two flavors. Hub pages (/assets/, /inspections/, /admin/) toggle
  // `html.dark` because admin-hub.css is light-by-default. Viewer pages
  // (/asset/, /inspection/, /admin/edit/) toggle `body.light` because their
  // styles are dark-by-default. Both flavors share localStorage and the
  // onThemeChange listeners so a switch on any page propagates everywhere.
  const _SUN_HUB    = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
  const _MOON_HUB   = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  // Viewer headers use 11x11 SVGs to match .hbtn icon sizing.
  const _SUN_VIEW   = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
  const _MOON_VIEW  = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  const _themeListeners = [];
  function onThemeChange(cb) { if (typeof cb === 'function') _themeListeners.push(cb); }
  // Stamps `<button id="btnTheme">` with the sun/moon SVG. Viewer pages
  // that have NoctuaI18n loaded also get a translated "Light"/"Dark" label
  // appended (the inspection viewer relies on this). Hub pages keep just
  // the icon — they don't expose a text label on this button.
  function _stampThemeBtn(isDark, viewer) {
    const btn = $('btnTheme');
    if (!btn) return;
    const icon = viewer
      ? (isDark ? _SUN_VIEW : _MOON_VIEW)
      : (isDark ? _SUN_HUB  : _MOON_HUB);
    const i18n = global.NoctuaI18n;
    if (viewer && i18n && typeof i18n.t === 'function') {
      const key = isDark ? 'theme.light' : 'theme.dark';
      const lbl = i18n.t(key);
      if (lbl && lbl !== key) {
        // Keep the data-i18n attribute so NoctuaI18n.apply() re-translates
        // the label on lang toggle (no need to re-stamp from outside).
        btn.innerHTML = `${icon} <span data-i18n="${key}">${esc(lbl)}</span>`;
        return;
      }
    }
    btn.innerHTML = icon;
  }
  function applyTheme(t) {
    const isDark = (t === true) || (t === 'dark');
    document.documentElement.classList.toggle('dark', isDark);
    _stampThemeBtn(isDark, false);
    try { localStorage.setItem('noctua_theme', isDark ? 'dark' : 'light'); } catch {}
    _themeListeners.forEach(cb => { try { cb(isDark ? 'dark' : 'light'); } catch {} });
  }
  function toggleTheme() {
    applyTheme(!document.documentElement.classList.contains('dark'));
  }
  function applyViewerTheme(t) {
    const isLight = (t === 'light') || (t === false);
    document.body.classList.toggle('light', isLight);
    _stampThemeBtn(!isLight, true);
    try { localStorage.setItem('noctua_theme', isLight ? 'light' : 'dark'); } catch {}
    _themeListeners.forEach(cb => { try { cb(isLight ? 'light' : 'dark'); } catch {} });
  }
  function toggleViewerTheme() {
    applyViewerTheme(document.body.classList.contains('light') ? 'dark' : 'light');
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
  // Viewer-flavored variant: same defaults, but flips `body.light` instead
  // of `html.dark`. Used by /asset/, /inspection/, /admin/edit/.
  function bootViewerTheme() {
    let thm = null;
    try { thm = localStorage.getItem('noctua_theme'); } catch {}
    if (thm === 'light') applyViewerTheme('light');
    else if (thm === 'dark') applyViewerTheme('dark');
    else applyViewerTheme(matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  }
  // Full viewer boot — lang (data-pt/data-en) + viewer theme (body.light).
  // Pages that use NoctuaI18n for lang instead should call bootViewerTheme()
  // directly and let NoctuaI18n own the language.
  function bootViewerPrefs() {
    let lng = null;
    try { lng = localStorage.getItem('noctua_lang'); } catch {}
    if (!lng) lng = (navigator.language || 'en').startsWith('pt') ? 'pt' : 'en';
    applyLang(lng === 'pt' ? 'pt' : 'en');
    bootViewerTheme();
  }

  // There used to be a cached "is this an admin" flag here, primed once per
  // page so render paths could branch on it synchronously. Its only consumers
  // were the viewer back links, which pointed at /admin/ for an admin and at
  // the public hub for everyone else. One hub replaced both, so nothing asks
  // any more — and a page that does not branch on the answer cannot get it
  // wrong. Identity still comes from NoctuaAuth, where it belongs.

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
  async function _listSlugs(dir) {
    const j = dir === 'assets'
      ? await global.NoctuaData.listAssets()
      : await global.NoctuaData.listInspections();
    return Array.isArray(j) ? j.slice().sort() : null;
  }
  // The GitHub contents API used to be the canonical fallback here, because a
  // stale index.json would otherwise hide a document from the admin. The
  // database cannot go stale against itself, so the fallback — and the repo
  // token it needed in the browser — are gone.
  async function listAssetSlugs() {
    const m = await _listSlugs('assets').catch(() => null);
    if (m) return m;
    throw new Error('Asset listing unavailable.');
  }
  async function listInspectionSlugs() {
    const m = await _listSlugs('inspections').catch(() => null);
    if (m) return m;
    throw new Error('Inspection listing unavailable.');
  }

  // Access lives on the asset (requireLogin === false → open). Default protected.
  function accessOf(j) {
    return (j && j.requireLogin === false) ? 'open' : 'protected';
  }
  // Kind is either explicit on the asset (`kind: 'splat'`) or inferred from
  // the model URL extension — older assets predate the field. Default 'glb'.
  function kindOf(j) {
    if (j && j.kind === 'splat') return 'splat';
    const url = j && j.model ? String(j.model).toLowerCase().split('?')[0].split('#')[0] : '';
    if (url.endsWith('.splat') || url.endsWith('.ply') || url.endsWith('.ksplat') || url.endsWith('.sog')) return 'splat';
    return 'glb';
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
      const j = await global.NoctuaData.getAsset(slug);
      return {
        slug,
        project:   j.name      || slug,
        thumbnail: j.thumbnail || null,
        modelName: j.modelName || (j.model ? j.model.split('/').pop() : null),
        model:     j.model     || null,
        date:      j.createdAt ? j.createdAt.slice(0, 10) : null,
        access:    accessOf(j),
        isOpen:    accessOf(j) === 'open',
        kind:      kindOf(j),
      };
    } catch (e) {
      return { slug, project: slug, thumbnail: null, modelName: null, model: null,
               date: null, access: 'protected', isOpen: false, kind: 'glb', error: e.message };
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

  // The one read behind the hub page.
  //
  // In api mode this is a single request that already knows who is asking: it
  // carries the role the viewer holds on each asset, which is what decides the
  // affordances. The three hub pages that preceded it each listed everything
  // and then threw rows away by visibility, which is why an asset granted to a
  // person never showed up for them.
  //
  // On the static site there is no identity and no join, so the same shape is
  // composed from the committed files: every asset in them is public and the
  // capability fields are flat off. Built from the fetchers above rather than
  // new ones, so there is one definition of what a card row looks like.
  async function fetchHub() {
    const api = await global.NoctuaData.hub();
    if (api) return api;
    const [assetSlugs, inspSlugs, featured] = await Promise.all([
      listAssetSlugs(), listInspectionSlugs(), fetchLandingSlugs(),
    ]);
    const [assets, insps] = await Promise.all([
      Promise.all(assetSlugs.map(fetchAsset)),
      Promise.all(inspSlugs.map(fetchInspectionForCard)),
    ]);
    const byAsset = {};
    for (const i of insps) {
      if (!i.asset) continue;
      (byAsset[i.asset] = byAsset[i.asset] || []).push(
        Object.assign({}, i, { featured: featured.has(i.slug), pendingTask: null }));
    }
    return {
      user: null,
      canCreate: false,
      assets: assets.filter(a => a.isOpen).map(a => Object.assign({}, a, {
        role: null,
        canEdit: false,
        featured: featured.has(a.slug),
        inspections: sortInspectionsByDate(byAsset[a.slug] || []),
      })),
    };
  }

  // Fail-open: an unreadable carousel list is decoration missing, not an error.
  async function fetchLandingSlugs() {
    return new Set(await global.NoctuaData.landingSlugs());
  }

  // ── Sort / filter ─────────────────────────────────────────────────────────
  // Featured first, then newest. `featured` travels on the row: the old version
  // took a Set of slugs and the caller passed one built from the landing list,
  // which holds INSPECTION slugs, so an asset sorted to the top only when its
  // slug happened to equal one of them.
  function sortAssetsByFeaturedThenDate(items) {
    return items.slice().sort((a, b) => {
      const aL = a.featured ? 0 : 1;
      const bL = b.featured ? 0 : 1;
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

  // Single source of truth for "is this a local dev origin?" — used to gate
  // production-only side effects (Discord beacons, prod-URL preview boxes).
  // Previously duplicated inline in admin/edit and inspection.
  function isLocalhost() {
    const h = location.hostname;
    return !h || h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0';
  }

  // Also global, because several pages call them straight from an onclick
  // attribute. Each page used to solve this its own way — one defined a private
  // copy, two used NoctuaHub.x(), and the two admin pages called a bare name
  // nobody defined, so their language and theme buttons silently did nothing.
  global.toggleLang = toggleLang;
  global.toggleTheme = toggleTheme;

  global.NoctuaHub = {
    // i18n + theme
    lang, applyLang, toggleLang, onLangChange, applyLangInside,
    applyTheme, toggleTheme, onThemeChange, bootPrefs,
    applyViewerTheme, toggleViewerTheme, bootViewerTheme, bootViewerPrefs,
    // UI
    notify, esc,
    // env
    isLocalhost,
    // listing
    listAssetSlugs, listInspectionSlugs,
    fetchHub, fetchAsset, fetchInspectionForCard, fetchLandingSlugs,
    accessOf, kindOf, latestDetected,
    // sort/filter
    sortAssetsByFeaturedThenDate, sortInspectionsByDate, filterBySearch,
  };

  // ── <noctua-logo> ────────────────────────────────────────────────────────
  // Single source of truth for the brand mark used in every navbar/header
  // (viewer pages, hub pages, 404). Two img tags + the CSS swap done by
  // viewer-header.css / admin-hub.css handle dark/light theming. Pages
  // previously hard-coded the <img src> in each navbar, so changing the asset
  // meant touching 6+ files. Now each page just drops <noctua-logo></noctua-logo>.
  //
  // Attributes (all optional):
  //   href       — link target, default '/'
  //   light-src  — override light-theme PNG, default /marca/logo-laranja-circulo.png
  //   dark-src   — override dark-theme PNG,  default /marca/logo-branco.png
  //   img-class  — extra class added to both img tags (e.g. "ag-logo" for the
  //                admin-gate sizing on the login card)
  //   no-link    — when present, renders the bare imgs instead of an <a>
  //                wrapper (admin gate's centered card doesn't link anywhere)
  const LIGHT_SRC = '/marca/logo-laranja-circulo.png';
  const DARK_SRC  = '/marca/logo-branco.png';
  class NoctuaLogo extends HTMLElement {
    connectedCallback() {
      const href     = this.getAttribute('href')      || '/';
      const lightSrc = this.getAttribute('light-src') || LIGHT_SRC;
      const darkSrc  = this.getAttribute('dark-src')  || DARK_SRC;
      const extra    = this.getAttribute('img-class') || '';
      const noLink   = this.hasAttribute('no-link');
      const imgs = `
        <img class="logo-img-light${extra ? ' ' + extra : ''}" src="${lightSrc}" alt="Noctua">
        <img class="logo-img-dark${extra ? ' ' + extra : ''}"  src="${darkSrc}"  alt="Noctua">`;
      this.innerHTML = noLink
        ? imgs
        : `<a class="logo" href="${href}" aria-label="Noctua">${imgs}</a>`;
    }
  }
  if (!customElements.get('noctua-logo')) customElements.define('noctua-logo', NoctuaLogo);
})(window);
