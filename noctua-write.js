// Every write the editor makes, in one place.
//
// This replaces two things at once: committing JSON to the repository through
// the GitHub API with a personal access token kept in localStorage, and
// uploading to the bucket with a Google token minted inside the page. Both
// handed the browser a credential far wider than the job — the PAT could push
// anything to the repo, the Google token could write anything in the bucket.
//
// Now the browser holds no credential at all. The session cookie proves who it
// is; the backend decides and signs.
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

  const put = (path, body) => call(path, { method: 'PUT', body: JSON.stringify(body || {}) });

  // ── documents ────────────────────────────────────────────────────────────
  // The payload is the object the editor already holds. Same shape it used to
  // commit, so nothing upstream had to change to move off git.
  const putAsset      = (slug, data) => put(`/api/assets/${encodeURIComponent(slug)}`, data);
  const putInspection = (slug, data) => put(`/api/inspections/${encodeURIComponent(slug)}`, data);
  const putTask       = (id, data)   => put(`/api/tasks/${encodeURIComponent(id)}`, data);
  const deleteAsset      = (slug) =>
    call(`/api/assets/${encodeURIComponent(slug)}`, { method: 'DELETE' });
  const deleteInspection = (slug) =>
    call(`/api/inspections/${encodeURIComponent(slug)}`, { method: 'DELETE' });
  const addFeatured   = (slug) => put(`/api/featured/${encodeURIComponent(slug)}`);
  const removeFeatured = (slug) =>
    call(`/api/featured/${encodeURIComponent(slug)}`, { method: 'DELETE' });

  // ── blobs ────────────────────────────────────────────────────────────────
  async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // sign → PUT straight to storage → commit.
  //
  // Three calls rather than one because the hash is known before the transfer:
  // `sign` can answer "already stored" and a 55MB model that exists is not sent
  // again. `opts.onProgress` is only meaningful for the large ones.
  async function uploadBlob(bytes, mime, opts) {
    opts = opts || {};
    const buffer = bytes instanceof ArrayBuffer ? bytes : bytes.buffer;
    const sha256 = await sha256Hex(buffer);
    const meta = {
      sha256,
      kind: opts.kind || 'image',
      content_type: mime,
      bytes: buffer.byteLength,
      filename: opts.filename || null,
      public: !!opts.public,
      for_inspection: opts.forInspection || null,
    };

    const signed = await call('/api/uploads/sign', {
      method: 'POST', body: JSON.stringify(meta),
    });

    if (!signed.exists) {
      const res = await fetch(signed.upload_url, {
        method: 'PUT',
        headers: signed.headers,
        body: bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`upload failed (${res.status}) ${text.slice(0, 160)}`);
      }
    }

    const row = await call('/api/uploads/commit', {
      method: 'POST',
      body: JSON.stringify(Object.assign({}, meta, {
        width: opts.width || null,
        height: opts.height || null,
        model_kind: opts.modelKind || null,
      })),
    });
    return Object.assign({ sha256, skipped: !!signed.exists }, row);
  }

  // A data: URL — how the editor carries a freshly cropped defect photo.
  async function uploadDataUrl(dataUrl, opts) {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || '');
    if (!m) return { url: dataUrl, skipped: true };     // already a URL
    const mime = m[1].toLowerCase();
    const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
    const row = await uploadBlob(bytes, mime, Object.assign({ kind: 'image' }, opts));
    return Object.assign({ url: publicUrlOf(row) }, row);
  }

  // The URL to store in a payload. For a public object this is the permanent
  // one; a private object is signed on read by the API, so what matters here is
  // that the object path round-trips.
  function publicUrlOf(row) {
    if (!row || !row.bucket) return null;
    return `https://storage.googleapis.com/${row.bucket}/${row.object_path}`;
  }

  global.NoctuaWrite = {
    putAsset, putInspection, putTask, addFeatured, removeFeatured,
    deleteAsset, deleteInspection,
    uploadBlob, uploadDataUrl, publicUrlOf, sha256Hex,
  };
})(typeof window !== 'undefined' ? window : globalThis);
