// Share links: create, list and revoke revocable access to one inspection.
//
// Lives apart from the page that happens to use it today because it is an API
// surface, not UI — the admin list page will want the same three calls, and a
// second copy of them is how two screens start disagreeing about what "revoked"
// means.
//
// Every call needs an admin session; the backend enforces editor access on the
// inspection's asset and these functions surface its refusal as an Error.
(function (global) {
  'use strict';

  async function call(path, init) {
    const r = await fetch(path, Object.assign({
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
    }, init || {}));
    if (!r.ok) {
      let detail = `HTTP ${r.status}`;
      try { detail = (await r.json()).detail || detail; } catch (_) {}
      throw new Error(detail);
    }
    return r.json();
  }

  // expiresInDays: a number, or null for a link with no expiry.
  function create(slug, expiresInDays) {
    return call(`/api/inspections/${encodeURIComponent(slug)}/share`, {
      method: 'POST',
      body: JSON.stringify({ expires_in_days: expiresInDays || null }),
    });
  }

  async function list(slug) {
    const j = await call(`/api/inspections/${encodeURIComponent(slug)}/shares`);
    return j.shares || [];
  }

  function revoke(token) {
    return call(`/api/shares/${encodeURIComponent(token)}`, { method: 'DELETE' });
  }

  global.NoctuaShare = { create, list, revoke };
})(typeof window !== 'undefined' ? window : globalThis);
