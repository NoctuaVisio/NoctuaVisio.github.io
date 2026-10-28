// Single entry point for "who is signed in".
//
// Same contract as noctua-data.js: resolve once per page load, then every
// caller reads the cached answer. Nothing else in the site should fetch
// /auth/me or build a login URL by hand.
//
// On the static site (no backend) there is nobody signed in and no provider to
// offer, so every call answers "anonymous" instead of failing. That keeps the
// gates working on GitHub Pages while the migration runs.
(function (global) {
  'use strict';

  const ANON = { authenticated: false, user: null, orgs: [] };
  let _mePromise = null;
  let _providersPromise = null;

  function apiMode() {
    return global.NoctuaData ? global.NoctuaData.mode() : Promise.resolve('files');
  }

  // The resolved identity, cached. Pass true after a login or logout to re-ask.
  function me(force) {
    if (force) _mePromise = null;
    if (!_mePromise) {
      _mePromise = apiMode().then(m => {
        if (m !== 'api') return ANON;
        return fetch('/auth/me', { cache: 'no-store', credentials: 'same-origin' })
          .then(r => (r.ok ? r.json() : ANON))
          .catch(() => ANON);
      });
    }
    return _mePromise;
  }

  function providers() {
    if (!_providersPromise) {
      _providersPromise = apiMode().then(m => {
        if (m !== 'api') return [];
        return fetch('/auth/providers', { cache: 'no-store' })
          .then(r => (r.ok ? r.json() : { providers: [] }))
          .then(j => j.providers || [])
          .catch(() => []);
      });
    }
    return _providersPromise;
  }

  async function user() { return (await me()).user; }
  async function isAuthenticated() { return (await me()).authenticated === true; }
  async function isAdmin() {
    const u = await user();
    return !!u && u.role === 'admin';
  }

  // Sends the browser to the provider. `next` is where to land afterwards;
  // the backend only accepts same-site paths, so an open redirect is not
  // reachable from here either way.
  // `next` is where to land afterwards; the backend only accepts same-site
  // paths. The provider is always asked to show the account chooser, so a
  // person with several Google accounts is never silently put into the wrong
  // one — which is the failure that has no visible symptom.
  function login(provider, next) {
    const dest = next || (location.pathname + location.search + location.hash);
    location.href = `/auth/${encodeURIComponent(provider)}/start?next=${encodeURIComponent(dest)}`;
  }

  async function logout(everywhere) {
    try {
      await fetch(everywhere ? '/auth/logout-everywhere' : '/auth/logout', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
      });
    } catch (_) {}
    _mePromise = null;
  }

  // May this account edit what the editor was opened on?
  //
  // Pure: hub payload plus the slug in the URL, in; a verdict, out. It lives
  // here rather than inside /admin/edit/ because that page's gate is a
  // `type="module"` block — it imports three.js, so it cannot be evaluated
  // outside a browser and the rule inside it could not be tested. The rule is
  // the part that was wrong (it demanded platform admin, and told an editor
  // with a granted asset that they were "not an admin"), so the rule is what
  // had to come out.
  //
  // `target` is the slug from ?load= or ?asset=, or null for a brand-new asset.
  // An inspection slug resolves through the asset that holds it, because the
  // role is held on the asset.
  //
  // Returns { allow, reason, project }. The caller owns the wording: it knows
  // the language and this does not.
  function editGate(hub, target) {
    if (!hub) return { allow: false, reason: 'unknown' };
    if (!target) {
      // Nothing to hold a role on yet, which is why creating takes an admin.
      return hub.canCreate ? { allow: true, reason: 'create' }
                           : { allow: false, reason: 'cannot_create' };
    }
    const row = (hub.assets || []).find(a =>
      a.slug === target || (a.inspections || []).some(i => i.slug === target));
    if (!row) return { allow: false, reason: 'no_access' };
    if (!row.canEdit) return { allow: false, reason: 'read_only', project: row.project };
    return { allow: true, reason: 'edit', project: row.project };
  }

  // The slug the editor is pointed at, by the same precedence the editor uses:
  // ?load= wins over ?asset= when both are present.
  function editTarget(search) {
    const p = new URLSearchParams(search == null ? location.search : search);
    const t = p.get('load') || p.get('asset');
    return t && /^[a-z0-9-]+$/i.test(t) ? t : null;
  }

  global.NoctuaAuth = {
    me, providers, user, isAuthenticated, isAdmin, login, logout,
    editGate, editTarget,
  };
})(typeof window !== 'undefined' ? window : globalThis);
