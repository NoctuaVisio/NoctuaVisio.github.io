// ════════════════════════════════════════════
// CARD UNIFICADO — asset/inspection, admin/público.
// Regras:
//  - Card inteiro é clicável (área thumb+body em <a>) → abre o viewer.
//  - Sem botão "Abrir" / "View" (já é o card todo).
//  - Sem nome do modelo no card (alguns nomes são hash e estouram o layout).
//  - "Editar" curto, sem sufixo (asset/inspeção).
//  - Botão "Avaliar" SÓ no card de inspeção (admin) quando há task pendente.
//  - Botão "Excluir" só no admin.
//  - Botão "Inspeções" só no card de asset (drill-down).
// ════════════════════════════════════════════
(function () {
  const I18N = {
    pt: {
      avaliar: 'Avaliar', editar: 'Editar', excluir: 'Excluir', insps: 'Inspeções',
      pts: 'pontos', pt1: 'ponto', created: 'criado em',
      nothumb: 'sem thumb', unfinished: 'Sem avaliação',
      unfTip: 'Esta inspeção ainda não tem pontos avaliados.',
      evalTip: 'Tem uma avaliação pendente nesta inspeção — marque os defeitos e aplique os pontos.',
      landing: 'Na landing',
      landingT: 'Este asset aparece no carousel da landing page',
      accProtected: 'Protegido', accOpen: 'Livre',
      accProtectedT: 'Protegido: o cliente precisa entrar com a conta Google pra ver o modelo 3D. Cada acesso fica registrado.',
      accOpenT: 'Livre: qualquer pessoa com o link abre o modelo 3D direto, sem login e sem registro.',
      inspectionPrefix: 'Inspeção',
      needTok: 'Configure o token GitHub pra excluir',
      splat: 'Splat',
      splatT: 'Asset Gaussian Splat — nuvem de pontos com sombreamento gaussiano. Não suporta inspeções nem visão Topo.',
      noInspsSplat: 'Splats não suportam inspeções (sem raycast)',
    },
    en: {
      avaliar: 'Evaluate', editar: 'Edit', excluir: 'Delete', insps: 'Inspections',
      pts: 'points', pt1: 'point', created: 'created on',
      nothumb: 'no thumb', unfinished: 'Unfinished',
      unfTip: 'This inspection has no evaluated points yet.',
      evalTip: 'Has a pending evaluation in this inspection — mark the defects and apply the points.',
      landing: 'On landing',
      landingT: 'This asset is featured in the landing hero carousel',
      accProtected: 'Protected', accOpen: 'Open',
      accProtectedT: 'Protected: the client must sign in with Google to view the 3D model. Every access is logged.',
      accOpenT: 'Open: anyone with the link opens the 3D model directly — no login, no logging.',
      inspectionPrefix: 'Inspection',
      needTok: 'Configure GitHub token to enable delete',
      splat: 'Splat',
      splatT: 'Gaussian Splat asset — radiance-field point cloud. Inspections and Top view are not supported.',
      noInspsSplat: 'Splats do not support inspections (no raycastable mesh)',
    },
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  // Inspection.date is stored as full ISO ("2026-06-08T16:46:36.113Z") so two
  // same-day inspections sort + label distinctly. Rendering it raw on a card
  // shows the user a wall of ISO noise — collapse to "YYYY-MM-DD HH:MM" in
  // their local time. Date-only legacy strings ("2026-05-19") pass through.
  function fmtDate(input) {
    if (input == null || input === '') return '';
    const s = String(input);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // opts: { type:'asset'|'inspection', mode:'admin'|'public', data, ctx }
  // ctx: { lang, hasGhToken, landingSlugs, taskMap, asset (fallback do thumb pra inspection) }
  function render(opts) {
    const { type, mode = 'public', data, ctx = {} } = opts;
    const lang = ctx.lang === 'en' ? 'en' : 'pt';
    const T = I18N[lang];
    const isAdmin = mode === 'admin';
    const isAsset = type === 'asset';

    // Open href: clicar no card abre isto. Inspection herda ?asset= (se houver)
    // pra habilitar o time slider do viewer.
    const assetSlug = isAsset ? null : (data.asset || (ctx.asset && ctx.asset.slug) || null);
    const openHref = isAsset
      ? `/asset/?slug=${encodeURIComponent(data.slug)}`
      : `/inspection/?slug=${encodeURIComponent(data.slug)}${assetSlug ? `&asset=${encodeURIComponent(assetSlug)}` : ''}`;

    // Thumb: asset usa data.thumbnail; inspection herda do asset (ctx.asset.thumbnail).
    const thumbUrl = isAsset
      ? (data.thumbnail || null)
      : ((ctx.asset && ctx.asset.thumbnail) || data.thumbnail || null);
    const thumbInner = thumbUrl
      ? `<img src="${esc(thumbUrl)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph',textContent:'${T.nothumb}'}))">`
      : `<div class="ph">${T.nothumb}</div>`;

    // Nome no topo.
    const dateLbl = fmtDate(data.date);
    const name = isAsset
      ? esc(data.project || data.name || data.slug)
      : (dateLbl ? `${T.inspectionPrefix} · ${esc(dateLbl)}` : T.inspectionPrefix);

    // Meta — SEM nome do modelo. Asset: createdAt. Inspection: pontos + date.
    const metaParts = [];
    if (isAsset && dateLbl) {
      metaParts.push(`<span><b>${esc(dateLbl)}</b> ${T.created}</span>`);
    }
    if (!isAsset) {
      const pts = data.points || 0;
      metaParts.push(`<span><b>${pts}</b> ${pts === 1 ? T.pt1 : T.pts}</span>`);
      if (dateLbl) metaParts.push(`<span><b>${esc(dateLbl)}</b></span>`);
    }
    const meta = metaParts.length ? `<div class="cmeta">${metaParts.join('')}</div>` : '';

    // Badges.
    const isSplat = isAsset && data.kind === 'splat';
    const badges = [];
    // "Unfinished" is now strictly tied to the presence of an open eval task
    // — same signal that drives the "Evaluate" button below. If there's no
    // pending task entry for this slug, the inspection has been worked on
    // (or never had one), so the badge would be misleading. ctx.taskMap is
    // admin-only; public views never show this badge by design.
    const hasPendingEval = !isAsset && ctx.taskMap && ctx.taskMap[data.slug];
    if (hasPendingEval) {
      badges.push(`<span class="badge-access protected" data-tip="${esc(T.unfTip)}" style="background:rgba(248,158,0,.14);color:#f89e00;border-color:rgba(248,158,0,.4)">${T.unfinished}</span>`);
    }
    if (isAdmin) {
      const acc = (data.access === 'open')
        ? { cls: 'open',      label: T.accOpen,      title: T.accOpenT }
        : { cls: 'protected', label: T.accProtected, title: T.accProtectedT };
      badges.push(`<span class="badge-access ${acc.cls}" data-tip="${esc(acc.title)}">${acc.label}</span>`);
    }
    if (isAdmin && ctx.landingSlugs && ctx.landingSlugs.has && ctx.landingSlugs.has(data.slug)) {
      badges.push(`<span class="badge-landing" data-tip="${esc(T.landingT)}">${T.landing}</span>`);
    }
    // Splat badge: surfaced in both admin and public so clients also see the
    // format flag. Sits next to access/landing so all asset metadata reads in
    // one row.
    if (isSplat) {
      badges.push(`<span class="badge-splat" data-tip="${esc(T.splatT)}">${T.splat}</span>`);
    }
    const badgeRow = badges.length ? `<div class="cbadges">${badges.join('')}</div>` : '';

    const errBadge = data.error ? `<div class="cerr">⚠ ${esc(data.error)}</div>` : '';

    // Ações por (type, mode).
    const actions = [];
    if (isAsset && isAdmin) {
      const inspsHref = `/admin/?asset=${encodeURIComponent(data.slug)}`;
      const editHref  = `/admin/edit/?asset=${encodeURIComponent(data.slug)}`;
      const dlgName = JSON.stringify(data.project || data.name || data.slug);
      // Splat inspections now supported (PC Picker → world point → entity-local).
      actions.push(`<a class="cbtn" href="${inspsHref}">${T.insps}</a>`);
      actions.push(`<a class="cbtn" href="${editHref}" target="_blank" rel="noopener">${T.editar}</a>`);
      actions.push(`<button class="cbtn danger" onclick="openDel('asset','${esc(data.slug)}', ${esc(dlgName)})" ${ctx.hasGhToken ? '' : `disabled title="${esc(T.needTok)}"`}>${T.excluir}</button>`);
    } else if (isAsset && !isAdmin) {
      const inspsHref = `/inspections/?asset=${encodeURIComponent(data.slug)}`;
      actions.push(`<a class="cbtn" href="${inspsHref}">${T.insps}</a>`);
    } else if (!isAsset && isAdmin) {
      const editHref = `/admin/edit/?load=${encodeURIComponent(data.slug)}`;
      const taskId = ctx.taskMap && ctx.taskMap[data.slug];
      if (taskId) {
        actions.push(`<a class="cbtn" href="/admin/edit/?task=${encodeURIComponent(taskId)}" target="_blank" rel="noopener" title="${esc(T.evalTip)}" style="background:var(--acc);border-color:var(--acc);color:#fff;font-weight:700">${T.avaliar}</a>`);
      }
      actions.push(`<a class="cbtn" href="${editHref}" target="_blank" rel="noopener">${T.editar}</a>`);
      const dlgName = JSON.stringify(name);
      actions.push(`<button class="cbtn danger" onclick="openDel('inspection','${esc(data.slug)}', ${esc(dlgName)})" ${ctx.hasGhToken ? '' : `disabled title="${esc(T.needTok)}"`}>${T.excluir}</button>`);
    }
    // Inspection pública: sem ações (o card todo já abre).

    const actionsHtml = actions.length
      ? `<div class="cactions" style="grid-template-columns:repeat(${actions.length},1fr)">${actions.join('')}</div>`
      : '';

    // Wrapper <a> envolve thumb+body (não inclui a linha de ações pra não ter <a> aninhado).
    return `
      <div class="card">
        <a class="card-link" href="${openHref}">
          <div class="thumb">${thumbInner}</div>
          <div class="cbody">
            <div class="cname">${name}</div>
            <div class="cslug">${esc(data.slug)}</div>
            ${badgeRow}
            ${meta}
            ${errBadge}
          </div>
        </a>
        ${actionsHtml}
      </div>`;
  }

  window.NoctuaCard = { render };
})();
