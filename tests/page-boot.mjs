// Loads a page's inline scripts in a stubbed browser and reports what breaks.
//
// This exists because of a specific failure that static checks miss entirely:
// a ReferenceError thrown while a <script> evaluates aborts the REST of that
// script, so every function defined after the throw never exists. The symptom
// in the browser is a button that does nothing — no error visible unless the
// console is open — and the page otherwise looks fine.
import { readFileSync, readdirSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import * as acorn from 'acorn';

const PAGES = process.argv.slice(2);
let failed = 0;

// Who is looking. The harness used to answer as a signed-in admin for every
// page, which is the one identity under which the hub's filtering bug was
// invisible: an admin sees everything either way. The bug was that a client
// granted a private asset saw an empty grid, because the page asked the API
// for what it could read and then dropped everything that was not public.
//
// A page is named `<persona>@<file>` to be checked as somebody else.
const PERSONAS = {
  admin: {
    me: { authenticated: true, user: { email: 'a@b.test', name: 'Test', role: 'admin', kind: 'human' }, orgs: [] },
    // Both assets, both editable. Delete and Access must be on the cards.
    assets: ['public', 'private'], role: 'editor', canCreate: true,
    expectActions: true,
  },
  client: {
    me: { authenticated: true, user: { email: 'client@b.test', name: 'Client', role: 'normal', kind: 'human' }, orgs: [] },
    // The reported bug, exactly: a private asset granted to this person has to
    // reach the grid, and must carry no operator buttons.
    assets: ['public', 'private'], role: 'viewer', canCreate: false,
    expectActions: false,
  },
  // The case the other three cannot express: write access without platform
  // admin. Every operator affordance that is really an admin power hides here,
  // because for `admin` and `client` alike "can edit" and "is admin" happen to
  // agree. The Access button appearing for an editor matched an API that let an
  // editor grant editor to anybody.
  editor: {
    me: { authenticated: true, user: { email: 'ed@b.test', name: 'Editor', role: 'normal', kind: 'human' }, orgs: [] },
    assets: ['public', 'private'], role: 'editor', canCreate: false,
    expectActions: true,
  },
  anon: {
    me: { authenticated: false, user: null, orgs: [] },
    assets: ['public'], role: null, canCreate: false,
    expectActions: false,
  },
};

const ASSET_FIXTURES = {
  public: {
    slug: 'landing-warehouse', project: 'Test Asset', thumbnail: null,
    date: '2026-01-01T00:00:00.000Z', visibility: 'public',
    access: 'open', isOpen: true, kind: 'glb', featured: true,
  },
  private: {
    slug: 'forklift', project: 'Forklift Bay', thumbnail: null,
    date: '2026-02-02T00:00:00.000Z', visibility: 'private',
    access: 'protected', isOpen: false, kind: 'glb', featured: false,
  },
};

function hubPayload(persona) {
  const p = PERSONAS[persona];
  const canEdit = p.role === 'editor';
  return {
    user: p.me.user && {
      email: p.me.user.email, name: p.me.user.name,
      role: p.me.user.role, isAdmin: p.me.user.role === 'admin',
    },
    canCreate: p.canCreate,
    assets: p.assets.map(key => Object.assign({}, ASSET_FIXTURES[key], {
      // A public asset is readable with no grant, so a client holds no role on
      // it while still holding one on the private asset. Mirrors the server.
      role: key === 'private' ? p.role : (canEdit ? 'editor' : null),
      canEdit,
      // Separate from canEdit: handing out access is a platform-admin power,
      // and the button for it must not appear for an editor. The API used to
      // accept `editor` there, so the UI offering it was consistent with a
      // real escalation.
      canManageAccess: p.me.user ? p.me.user.role === 'admin' : false,
      inspections: [{
        slug: key === 'private' ? 'forklift-01' : 'landing-warehouse',
        project: ASSET_FIXTURES[key].project,
        asset: ASSET_FIXTURES[key].slug,
        thumbnail: null, date: '2026-01-01T00:00:00.000Z', points: 3,
        visibility: ASSET_FIXTURES[key].visibility,
        access: ASSET_FIXTURES[key].access,
        featured: key === 'public', pendingTask: canEdit ? 'task-1' : null,
      }],
    })),
  };
}

// A throw inside the page's own `(async () => …)()` surfaces as an unhandled
// rejection in this process, not as an exception at the eval site. Without
// these handlers it kills the run instead of being reported against the page
// that caused it — and that is the exact failure mode being tested for.
let current = null;
const record = (err) => {
  const msg = err && err.stack ? err.stack.split('\n').slice(0, 2).join(' | ')
                               : String(err);
  if (current) current.push(`async: ${msg}`);
  else console.log(`    (outside a page) ${msg}`);
};
process.on('unhandledRejection', record);
process.on('uncaughtException', record);

for (const arg of PAGES) {
  // 'inspections/index.html?asset=x' — some pages need a parameter to have
  // anything to render, and without it they correctly show an empty state that
  // would otherwise read as a failure.
  const persona = arg.includes('@') ? arg.split('@')[0] : 'admin';
  const spec = arg.includes('@') ? arg.slice(arg.indexOf('@') + 1) : arg;
  if (!PERSONAS[persona]) throw new Error(`unknown persona: ${persona}`);
  const [file, query = ''] = spec.split('?');
  const html = readFileSync(file, 'utf8');
  const errors = [];
  current = errors;

  const vc = new VirtualConsole();
  vc.on('jsdomError', (err) => {
    if (/Not implemented: navigation/.test(err.message)) return;
    errors.push(`jsdom: ${err.message.split('\n')[0]}`);
  });

  const dom = new JSDOM(html, {
    virtualConsole: vc,
    runScripts: 'outside-only',
    url: `https://noctua.test/${query ? '?' + query : ''}`,
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // Everything the page reaches for that a stub can stand in for. Keeping this
  // list small is deliberate: a missing stub shows up as a clear error rather
  // than a silent pass.
  // Answers as a signed-in admin from the very first request. This has to be in
  // place BEFORE the page's scripts run: NoctuaData.mode() probes /api/health
  // once and caches the answer, and a generic stub resolves it to 'files' —
  // which makes every gate take its early return and the success path, where
  // the bugs live, never execute.
  window.fetch = (url) => {
    const u = String(url);
    const body = u.includes('/auth/me')
      ? PERSONAS[persona].me
      : u.includes('/api/hub')      ? hubPayload(persona)
      : u.includes('/api/health')   ? { ok: true, db: true, schema_ok: true }
      : u.includes('/auth/providers') ? { providers: [{ name: 'google', label: 'Google' }] }
      // A plausible public asset and one inspection, so the pages that render a
      // grid actually render it. Empty responses make every page show its empty
      // state, which looks like a pass while exercising almost nothing.
      // The slug decides which fixture answers, so a page can be checked
      // against a PRIVATE asset. The viewer used to refuse one of those to
      // anybody who was not a platform admin, including the client it had just
      // been granted to; asking for the public one every time hid that.
      : /\/api\/assets\/[^/]+$/.test(u) ? (() => {
          const want = u.split('/api/assets/')[1].split('?')[0];
          const fx = Object.values(ASSET_FIXTURES).find(a => a.slug === want)
                  || ASSET_FIXTURES.public;
          return {
            slug: fx.slug, name: fx.project,
            model: 'https://storage.googleapis.com/b/x.glb', modelName: 'x.glb',
            requireLogin: !fx.isOpen, thumbnail: null, createdAt: fx.date,
          };
        })()
      : /\/api\/inspections\/[^/]+\/tasks$/.test(u) ? { tasks: [] }
      : /\/api\/inspections\/[^/]+/.test(u) ? {
          inspection: { asset: 'landing-warehouse', date: '2026-01-01T00:00:00.000Z', points: [] },
          asset: { slug: 'landing-warehouse', name: 'Test Asset', requireLogin: false },
          composed: {
            slug: 'landing-warehouse', asset: 'landing-warehouse', project: 'Test Asset',
            model: 'https://storage.googleapis.com/b/x.glb', points: [],
            date: '2026-01-01T00:00:00.000Z', requireLogin: false,
          },
        }
      : u.includes('/api/assets')      ? ['landing-warehouse']
      : u.includes('/api/inspections') ? ['landing-warehouse']
      : u.includes('/api/landing-models') ? { inspections: ['landing-warehouse'] }
      : {};
    return Promise.resolve({ ok: true, status: 200, json: async () => body, text: async () => '' });
  };
  // crypto is getter-only on jsdom's window, so it is defined rather than assigned.
  Object.defineProperty(window, 'crypto', {
    value: { subtle: { digest: async () => new ArrayBuffer(32) }, getRandomValues: a => a },
    configurable: true,
  });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  window.requestAnimationFrame = () => 0;
  window.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  window.onerror = (msg) => { errors.push(String(msg)); };

  // The shared modules are real: they are what the page is wired to, and
  // stubbing them would hide exactly the kind of mismatch being hunted.
  const shared = [...html.matchAll(/<script src="\/([\w-]+\.js)"/g)].map(m => m[1]);
  for (const name of shared) {
    try {
      window.eval(readFileSync(name, 'utf8'));
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }

  // Module blocks cannot be evaluated here — they import three.js and friends,
  // which needs a real resolver — but they MUST still be parsed. A duplicate
  // `let` in one of them is a SyntaxError that stops the whole block from
  // running, and skipping the block outright made the editor's main script
  // silently unexecutable while every other check passed.
  const all = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(([, attrs]) => !/importmap|application\/json/.test(attrs));
  for (const [, attrs, code] of all) {
    if (!/type="module"/.test(attrs) || !code.trim()) continue;
    try {
      acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true });
    } catch (err) {
      errors.push(`module block does not parse: ${err.message}`);
    }
  }

  const inline = all.filter(([, attrs]) => !/type="module"/.test(attrs));

  for (const [, , code] of inline) {
    if (!code.trim()) continue;
    try {
      window.eval(code);
    } catch (err) {
      errors.push(`${err.name}: ${err.message}`);
    }
  }

  // Every handler the HTML names must exist after boot. A missing one does not
  // throw while loading — it throws on click, which is how "the button does
  // nothing" reaches a person instead of a test.
  const handlers = new Set();
  for (const m of html.matchAll(/\son(?:click|change|input|submit)="([^"]*)"/g)) {
    // Only bare calls. `document.getElementById(...)` and `NoctuaHub.toggleLang()`
    // are method calls on something else — matching them reported a missing
    // global for every page that does the correct thing.
    for (const call of m[1].matchAll(/(?<![.\w$])(?:window\.)?([A-Za-z_$][\w$]*)\s*\(/g)) {
      // A call inside `${...}` runs while the HTML string is being built, in
      // whatever scope that template literal lives in — it is not a handler.
      const before = m[1].slice(0, call.index);
      if (/\$\{[^}]*$/.test(before)) continue;
      handlers.add(call[1]);
    }
  }

  // Handlers assigned inside a `type="module"` block are detected statically:
  // those scripts import three.js and friends, so evaluating them here would
  // need a real module resolver. A `window.foo =` is enough to know it exists.
  // Also scan the shipped scripts a module imports: viewer-ui.js and friends
  // assign window handlers on import, and the page's HTML names them.
  // Only explicit global assignments count. A bare `function foo()` inside a
  // shared module's IIFE is NOT a global — treating it as one is what hid
  // `listAssetSlugs` going missing: hub-core.js defines it, but only exposes it
  // as NoctuaHub.listAssetSlugs.
  const importedAssigned = new Set(
    readdirSync('.').filter(f => f.endsWith('.js'))
      .flatMap(f => [...readFileSync(f, 'utf8')
        .matchAll(/(?:window|global)\.([A-Za-z_$][\w$]*)\s*=/g)])
      .map(m => m[1])
  );

  const moduleAssigned = new Set(
    [...html.matchAll(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/g)]
      .flatMap(([, code]) => [...code.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)])
      .map(m => m[1])
  );
  // Template literals inside rendered strings are not handlers of this page.
  const JS_KEYWORDS = new Set(['if', 'return', 'typeof', 'void', 'new', 'delete', 'await']);
  for (const name of handlers) {
    if (JS_KEYWORDS.has(name) || moduleAssigned.has(name) || importedAssigned.has(name)) continue;
    if (typeof window[name] !== 'function') {
      errors.push(`handler referenced by HTML is not defined: ${name}()`);
    }
  }

  // i18n keys that have no entry render as the raw key — visible nonsense in
  // the UI rather than a crash, so nothing catches it without looking.
  const dict = window.NoctuaI18n;
  if (dict && typeof dict.t === 'function') {
    const missing = [];
    for (const m of html.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)) {
      // `data-i18n="${k}"` is a key computed at runtime; there is nothing to
      // look up here.
      if (m[1].includes('${')) continue;
      if (dict.t(m[1], 'pt') === m[1] && dict.t(m[1], 'en') === m[1]) missing.push(m[1]);
    }
    if (missing.length) {
      errors.push(`i18n keys with no translation: ${[...new Set(missing)].slice(0, 5).join(', ')}`);
    }
  }

  // Drive the flows that only run after an await. The login gate broke twice
  // in exactly this blind spot: `adminBootGate` resolves a fetch and then calls
  // `unlockAdmin`, so a missing `unlockAdmin` throws long after the page has
  // finished loading — nothing static sees it, and the page looks fine until
  // someone clicks.
  const flows = [
    ['adminBootGate', () => window.adminBootGate && window.adminBootGate()],
    ['adminSignIn', () => window.adminSignIn && window.adminSignIn(false)],
    ['refreshShareList', () => window.refreshShareList && window.refreshShareList()],
  ];
  // Assigning location.href is left alone: jsdom does not navigate, it reports
  // "Not implemented: navigation" on the virtual console and carries on, which
  // is exactly the behaviour this test wants — the handler runs to the end.

  // Let the boot's own promises settle first: a throw inside one of them is
  // the failure being hunted, and it happens after eval returns.
  await new Promise(r => setTimeout(r, 50));

  for (const [name, run] of flows) {
    try {
      await run();
    } catch (err) {
      errors.push(`${name}() threw after boot: ${err.name}: ${err.message}`);
    }
  }
  // Language switching. Two different failures hide here, and both were live:
  //   · markup that carries no translation attribute, so it never changes
  //   · a page that keeps its own `_lang` copy and never subscribes, so every
  //     string it builds in JS is frozen at the initial value
  // The second is invisible by inspection — the toggle works, the static labels
  // change, and the dynamic half silently does not.
  const langApi = window.NoctuaHub && window.NoctuaHub.applyLang ? window.NoctuaHub
                : window.NoctuaI18n && window.NoctuaI18n.apply ? window.NoctuaI18n : null;
  if (langApi) {
    for (const lang of ['pt', 'en']) {
      try {
        (langApi.applyLang || langApi.apply).call(langApi, lang);
      } catch (err) {
        errors.push(`applying language ${lang} threw: ${err.message}`);
        break;
      }
      // innerHTML re-encodes entities, so compare rendered text, not markup.
      const text = (html) => {
        const d = window.document.createElement('div');
        d.innerHTML = html == null ? '' : html;
        return (d.textContent || '').replace(/\s+/g, ' ').trim();
      };
      // data-i18n elements must move too: a page can carry both mechanisms and
      // a single toggle has to translate all of it.
      if (window.NoctuaI18n && window.NoctuaI18n.lang !== lang) {
        errors.push(`i18n.js stayed on "${window.NoctuaI18n.lang}" after switching to "${lang}"`);
      }
      const attr = lang === 'pt' ? 'data-pt' : 'data-en';
      for (const el of window.document.querySelectorAll('[data-pt]')) {
        const want = text(el.getAttribute(attr) || el.getAttribute('data-pt'));
        const other = text(el.getAttribute(lang === 'pt' ? 'data-en' : 'data-pt'));
        const now = text(el.innerHTML);
        // Only elements still under translation control are checked. One whose
        // content matches neither language was deliberately overwritten by the
        // page with something richer, and demanding the attribute back would
        // be demanding a regression.
        if (now !== want && now === other) {
          errors.push(`[${attr}] not applied: shows "${now.slice(0, 40)}" instead of "${want.slice(0, 40)}"`);
          break;
        }
      }
    }
  }

  // A page that holds its own copy of the language must subscribe to changes.
  // Nothing at runtime reveals this: the copy simply never moves.
  const pageCode = inline.map(([, , c]) => c).join('\n');
  if (/\b_lang\b/.test(pageCode) && /let\s+_lang/.test(pageCode)
      && !/onLangChange|NoctuaI18n\.onChange/.test(pageCode)) {
    errors.push('declares its own _lang but never subscribes to language changes');
  }

  // Let this page's pending work finish while it is still the current page.
  // `unhandledRejection` is process-wide, so a promise from a closed window
  // settling later gets blamed on whichever page is being checked at that
  // moment — which looked like a real bug in five files at once.
  await new Promise(r => setTimeout(r, 40));

  // The rule behind the editor's login gate.
  //
  // It demanded `role === 'admin'`, so an editor granted one asset clicked
  // "Editar" on their own card and was told "Account … is not an admin" — by a
  // page whose write API would have accepted everything they were about to do.
  // Nothing threw and nothing rendered an error block; the overlay simply
  // stayed up, which is why none of the other checks saw it.
  //
  // The gate itself lives in a `type="module"` block that imports three.js, so
  // it cannot be evaluated here. The DECISION was extracted to
  // NoctuaAuth.editGate for exactly that reason, and this drives it with the
  // payload this persona would actually receive.
  if (window.NoctuaAuth && window.NoctuaAuth.editGate) {
    const hub = hubPayload(persona);
    const canEdit = PERSONAS[persona].role === 'editor';
    const cases = [
      // [target, may it be edited by this persona?]
      ['forklift', canEdit],                 // a granted private asset
      ['landing-warehouse', canEdit],        // a public asset
      ['forklift-01', canEdit],              // an inspection, via its asset
      ['no-such-asset', false],              // nothing to hold a role on
      [null, PERSONAS[persona].canCreate],   // a brand-new asset
    ];
    for (const [target, want] of cases) {
      const got = window.NoctuaAuth.editGate(hub, target).allow;
      if (got !== want) {
        errors.push(`editGate(${JSON.stringify(target)}) = ${got}, expected ${want}`);
      }
    }
    // A signed-out visitor holds nothing, whatever the slug.
    if (!PERSONAS[persona].me.authenticated
        && window.NoctuaAuth.editGate(hub, 'landing-warehouse').allow) {
      errors.push('editGate let a signed-out visitor edit');
    }
  }

  // What the grid actually contains, for the page that renders one.
  //
  // Two failures live here and only one of them has ever shown up as an error:
  //   · a row the viewer may open is missing — the API returned it and the page
  //     dropped it. This is what made a granted asset invisible to its client.
  //   · an operator button on a row the viewer may not edit, or a missing one
  //     on a row they may. Both come from a page-wide notion of "am I admin"
  //     rather than a per-row capability.
  const grid = window.document.querySelector('.grid');
  if (grid && window.NoctuaCard) {
    const shown = window.document.body.textContent || '';
    const payload = hubPayload(persona);
    const inAssetView = !query.includes('asset=');
    const expected = inAssetView
      ? payload.assets.map(a => a.slug)
      : (payload.assets.find(a => query.includes(`asset=${a.slug}`)) || { inspections: [] })
          .inspections.map(i => i.slug);
    for (const slug of expected) {
      if (!shown.includes(slug)) {
        errors.push(`row the viewer may open is not in the grid: ${slug}`);
      }
    }
    const hasAccess = /Acesso|Access/.test(
      [...window.document.querySelectorAll('.cbtn')].map(b => b.textContent).join('|'));
    const admin = !!(PERSONAS[persona].me.user && PERSONAS[persona].me.user.role === 'admin');
    if (inAssetView && admin && !hasAccess) {
      errors.push('an admin got no Access button on any card');
    }
    if (!admin && hasAccess) {
      errors.push('a non-admin was given the Access button');
    }
    const hasDelete = !!window.document.querySelector('.cbtn.danger');
    if (PERSONAS[persona].expectActions && !hasDelete) {
      errors.push('an editor got no Delete button on any card');
    }
    if (!PERSONAS[persona].expectActions && hasDelete) {
      errors.push('a viewer was given a Delete button');
    }
  }

  // Errors the page catches itself. `refresh()` renders "Failed to load assets"
  // into a .err block instead of throwing, so driving the flow is not enough —
  // the DOM has to be read. This is what a person sees, which makes it the one
  // check that cannot be fooled by a well-placed try/catch.
  // `#err` as well as `.err`: the viewer pages carry an error panel addressed
  // by id and revealed with a `vis` class, and matching only the class let a
  // viewer render "Asset privado" while the test reported a clean boot.
  for (const el of window.document.querySelectorAll('.err, #err, [data-error]')) {
    if (el.id === 'err' && !el.classList.contains('vis')) continue;
    const text = (el.textContent || '').trim();
    if (text) errors.push(`page rendered an error: ${text.slice(0, 120)}`);
  }

  const label = arg.padEnd(34);
  if (errors.length) {
    failed++;
    console.log(`✗ ${label} ${errors.length} error(s)`);
    for (const e of [...new Set(errors)].slice(0, 6)) console.log(`    ${e}`);
  } else {
    console.log(`✓ ${label} boots clean`);
  }
  current = null;
  dom.window.close();
  // A beat after closing: anything that fires now belongs to nobody, and the
  // handler says so instead of blaming the next file.
  await new Promise(r => setTimeout(r, 10));
}

process.exit(failed ? 1 : 0);
