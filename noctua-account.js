// The visible half of the login.
//
// Everything else was already built — sessions, OAuth, roles, visibility — and
// none of it appeared anywhere on screen, which made a working login system
// look like it did not exist. This renders who you are and how to leave, on
// every page, from one place.
//
// It mounts itself next to the language button, which every page already has,
// rather than asking seven files to each add markup and keep it in sync.
(function (global) {
  'use strict';

  const STYLE = `
    .nac{display:inline-flex;align-items:center;gap:6px;position:relative;font:inherit}
    .nac-btn{display:inline-flex;align-items:center;gap:6px;background:none;border:1px solid var(--nac-bd,rgba(255,255,255,.14));
      color:inherit;border-radius:6px;padding:4px 8px;cursor:pointer;font:inherit;font-size:11px;line-height:1.2;white-space:nowrap}
    .nac-btn:hover{border-color:var(--acc,#ff6600)}
    .nac-dot{width:6px;height:6px;border-radius:50%;background:#10b981;flex:0 0 auto}
    .nac-menu{position:absolute;top:calc(100% + 6px);right:0;min-width:210px;z-index:300;
      background:var(--nac-bg,#1a1a1a);border:1px solid var(--nac-bd,rgba(255,255,255,.14));
      border-radius:8px;padding:6px;box-shadow:0 10px 30px rgba(0,0,0,.35);display:none}
    .nac-menu.open{display:block}
    .nac-who{padding:6px 8px;font-size:11px;opacity:.75;line-height:1.5;word-break:break-all}
    .nac-who b{display:block;font-size:12px;opacity:1}
    .nac-sep{height:1px;background:var(--nac-bd,rgba(255,255,255,.12));margin:4px 0}
    .nac-item{display:block;width:100%;text-align:left;background:none;border:0;color:inherit;
      font:inherit;font-size:11px;padding:6px 8px;border-radius:5px;cursor:pointer;text-decoration:none}
    .nac-item:hover{background:rgba(255,255,255,.07)}
    body.light .nac{--nac-bg:#fff;--nac-bd:rgba(0,0,0,.14)}
    body.light .nac-item:hover{background:rgba(0,0,0,.05)}
  `;

  // Two language systems exist. hub-core is authoritative where it is present,
  // because its applyLang is what the toggle button calls on those pages; the
  // account bar reading only NoctuaI18n.lang was why this dropdown kept the
  // old language while the rest of the page switched.
  function lang() {
    if (global.NoctuaHub && global.NoctuaHub.lang) return global.NoctuaHub.lang();
    if (global.NoctuaI18n) return global.NoctuaI18n.lang;
    return 'pt';
  }

  function t(pt, en) {
    return lang() === 'pt' ? pt : en;
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  async function render(host) {
    const me = await global.NoctuaAuth.me();
    host.innerHTML = '';

    if (!me.authenticated) {
      // On the static site there is no backend to sign in to, so offering a
      // button that cannot work is worse than offering nothing.
      if ((await global.NoctuaData.mode()) !== 'api') return;
      const btn = el('button', 'nac-btn', t('Entrar', 'Sign in'));
      btn.onclick = () => global.NoctuaAuth.login('google');
      host.appendChild(btn);
      return;
    }

    const u = me.user;
    const label = (u.name || u.email || '').split('@')[0];
    const btn = el('button', 'nac-btn');
    btn.appendChild(el('span', 'nac-dot'));
    btn.appendChild(el('span', null, label));
    btn.title = u.email;

    const menu = el('div', 'nac-menu');
    const who = el('div', 'nac-who');
    who.appendChild(el('b', null, u.name || u.email));
    who.appendChild(el('span', null, u.email));
    if (u.role === 'admin') who.appendChild(el('span', null, ' · admin'));
    menu.appendChild(who);

    if (me.orgs && me.orgs.length) {
      menu.appendChild(el('div', 'nac-sep'));
      for (const o of me.orgs) {
        menu.appendChild(el('div', 'nac-who', `${o.name} · ${o.role}`));
      }
    }

    menu.appendChild(el('div', 'nac-sep'));
    // One hub, so this is not an admin-only shortcut any more: it is where a
    // signed-in person finds whatever was shared with them.
    const hub = el('a', 'nac-item', t('Meus assets', 'My assets'));
    hub.href = '/assets/';
    menu.appendChild(hub);
    // Switching accounts needs the session dropped first: the OAuth start sends
    // prompt=select_account, but coming back to a live session would just
    // re-resolve the one already there.
    const swap = el('button', 'nac-item', t('Entrar com outra conta', 'Switch account'));
    swap.onclick = async () => {
      swap.disabled = true;
      await global.NoctuaAuth.logout();
      global.NoctuaAuth.login('google');
    };
    menu.appendChild(swap);

    const out = el('button', 'nac-item', t('Sair', 'Sign out'));
    out.onclick = async () => {
      out.disabled = true;
      await global.NoctuaAuth.logout();
      location.reload();
    };
    menu.appendChild(out);

    const everywhere = el('button', 'nac-item', t('Sair de todos os dispositivos', 'Sign out everywhere'));
    everywhere.onclick = async () => {
      everywhere.disabled = true;
      await global.NoctuaAuth.logout(true);
      location.reload();
    };
    menu.appendChild(everywhere);

    btn.onclick = (e) => { e.stopPropagation(); menu.classList.toggle('open'); };
    document.addEventListener('click', () => menu.classList.remove('open'));

    host.appendChild(btn);
    host.appendChild(menu);
  }

  function mount() {
    if (document.querySelector('.nac')) return;          // already mounted
    const anchor = document.getElementById('btnLang');
    if (!anchor || !anchor.parentNode) return;
    const style = el('style');
    style.textContent = STYLE;
    document.head.appendChild(style);
    const host = el('div', 'nac');
    anchor.parentNode.insertBefore(host, anchor);
    render(host);
    // Subscribed to both: whichever system the page drives, the bar follows.
    if (global.NoctuaHub && global.NoctuaHub.onLangChange) {
      global.NoctuaHub.onLangChange(() => render(host));
    }
    if (global.NoctuaI18n && global.NoctuaI18n.onChange) {
      global.NoctuaI18n.onChange(() => render(host));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
  global.NoctuaAccount = { mount, render };
})(typeof window !== 'undefined' ? window : globalThis);
