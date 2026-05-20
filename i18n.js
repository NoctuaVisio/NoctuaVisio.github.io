// Noctua i18n — shared by viewer, admin, 404, and (read-side) the landing.
//
// Add a new language: copy any block under DICT, translate the values, keep
// the keys identical. The runtime auto-detects and exposes it via the
// language switcher button. The landing has its own data-pt/data-en system
// and stays as-is; the two systems share localStorage['noctua_lang'] so
// switching from any page propagates to the others.
(function (global) {
  'use strict';

  const DICT = {
    pt: {
      'common.back_to_landing': 'Voltar para noctuavisio.com',

      'common.tabs.overview': 'Visão Geral',
      'common.tabs.list':     'Lista',
      'common.tabs.route':    'Rota',

      'common.filters.all':      'Todos',
      'common.filters.fissura':  'Fissura',
      'common.filters.furo':     'Furo',
      'common.filters.corrosao': 'Corrosão',

      'common.toolbar.heatmap':  'Mapa de Calor',
      'common.toolbar.markers':  'Marcadores',
      'common.toolbar.free':     'Livre',
      'common.toolbar.top':      'Topo',
      'common.toolbar.add':      'Adicionar Ponto',

      'admin.toolbar.rotate':    'Girar',
      'admin.toolbar.rotate_x':  'Girar X',
      'admin.toolbar.rotate_y':  'Girar Y',
      'admin.toolbar.rotate_z':  'Girar Z',
      'admin.toolbar.move':      'Mover',
      'admin.toolbar.reset':     'Zerar',
      'admin.toolbar.place':     'Colocar Ponto',

      'admin.modal.add.photo':         'Foto do problema',
      'admin.modal.add.photo.mock':    'Gerar mock',
      'admin.modal.add.photo.url':     'URL externa',
      'admin.modal.add.photo.upload':  'Upload local',
      'admin.modal.add.photo.url_ph':  'https://...',

      'common.summary.title':    'Resumo',
      'common.summary.total':    'Total',
      'common.summary.critical': 'Críticas',
      'common.summary.high':     'Altas',
      'common.summary.medium':   'Médias',
      'common.summary.low':      'Baixas',

      'common.by_type':         'Por Tipo',
      'common.risk_score':      'Score de Risco',
      'common.risk.structural': 'Estrutural',
      'common.risk.surface':    'Superficial',
      'common.risk.corrosion':  'Corrosão',

      'common.heatmap.title':    'Intensidade de Risco',
      'common.heatmap.low':      'Baixa',
      'common.heatmap.medium':   'Média',
      'common.heatmap.high':     'Alta',
      'common.heatmap.critical': 'Crítica',

      'sev.critical': 'Crítico',
      'sev.high':     'Alto',
      'sev.medium':   'Médio',
      'sev.low':      'Baixo',

      'type.fissura':  'Fissura',
      'type.furo':     'Furo',
      'type.corrosao': 'Corrosão',

      'theme.dark':  'Escuro',
      'theme.light': 'Claro',

      '404.message': 'Página não encontrada.',

      'admin.password.title':       'Noctua Admin',
      'admin.password.placeholder': 'Senha',
      'admin.password.submit':      'Entrar',
      'admin.password.wrong':       'Senha incorreta',

      'admin.header.status':        'Sistema ativo',
      'admin.header.import_model':  'Importar Modelo',
      'admin.header.import_ortho':  'Importar Ortomosaico',
      'admin.header.import_json':   'Importar JSON',
      'admin.header.export_json':   'Exportar JSON',
      'admin.header.generate_link': 'Gerar Link Cliente',
      'admin.header.ortho_loaded':  'Ortomosaico carregado',
      'admin.header.ortho_missing': 'Sem ortomosaico',
      'admin.header.analyze':       'Analisar',
      'admin.header.analyze_busy':  'Analisando…',
      'admin.header.analyze_need':  'Importe modelo + ortomosaico antes',
      'admin.header.analyze_ready': 'Analisar com o serviço (mock)',
      'admin.header.gcs_connect':    'Conectar GCS',
      'admin.header.gcs_upload':     'Subir pro GCS',
      'admin.header.gcs_unset':      'GCS não configurado — preencha GCS_CONFIG no admin (veja README, Fase 4)',
      'admin.header.gcs_need_auth':  'Conecte-se ao Google pra subir pro bucket',
      'admin.header.gcs_need_model': 'Carregue um modelo .glb primeiro',
      'admin.header.gcs_ready':      'Subir o modelo carregado pro bucket público',

      'admin.load_overlay.label': 'Selecione um modelo .glb pra começar',
      'admin.load_overlay.sub':   'Use o botão "Trocar Modelo" no topo',

      'admin.modal.add.title':  'Novo Ponto de Inspeção',
      'admin.modal.add.id':     'ID',
      'admin.modal.add.coords': 'Coordenadas no modelo (metros)',
      'admin.modal.add.type':   'Tipo',
      'admin.modal.add.sev':    'Severidade',
      'admin.modal.add.loc':    'Localização',
      'admin.modal.add.area':   'Área',
      'admin.modal.add.score':  'Score',
      'admin.modal.add.depth':  'Profundidade',
      'admin.modal.add.date':   'Data',
      'admin.modal.add.action': 'Ação Recomendada',
      'admin.modal.add.cancel': 'Cancelar',
      'admin.modal.add.save':   'Salvar Ponto',
      'admin.modal.edit.title': 'Editar Ponto de Inspeção',
      'admin.modal.edit.save':  'Salvar Alterações',
      'admin.detail.edit':      'Editar',
      'admin.detail.move':      'Mover',
      'admin.detail.remove':    'Remover Ponto',
      'admin.hint.placing':     'Clique na superfície do modelo para colocar um ponto',
      'admin.hint.moving':      'Clique na superfície do modelo para mover este ponto',

      'admin.modal.link.title':         'Gerar Link do Cliente',
      'admin.modal.link.project':       'Nome do projeto',
      'admin.modal.link.model_url':     'URL do modelo',
      'admin.modal.link.slug':          'Slug (opcional — geramos se vazio)',
      'admin.modal.link.cancel':        'Cancelar',
      'admin.modal.link.generate':      'Gerar',
      'admin.modal.link.production_url':'Link pro cliente (produção)',
      'admin.modal.link.local_url':     'Pra testar localhost',
      'admin.modal.link.next_step':     'Próximo passo',
      'admin.modal.link.close':         'Fechar',
      'admin.modal.link.copy':          'Copiar Link',
      'admin.modal.link.model_url_hint':'• <b>Modelo no GCS:</b> cole a URL pública completa (<code>https://storage.googleapis.com/…</code>)<br>• <b>Modelo dentro do repo</b> (pasta <code>models/</code>, legado): use caminho absoluto, ex. <code>/models/nome-do-arquivo.glb</code>',
      'admin.modal.link.model_url_prefilled':'✓ Preenchido automaticamente pelo upload pro GCS desta sessão. Edite o campo se quiser usar outra URL.',
      'admin.modal.link.next_step_1':   '1. Mova o JSON baixado pra',
      'admin.modal.link.next_step_2':   'no repo',
      'admin.modal.link.next_step_3':   '2. git add + commit + push',
      'admin.modal.link.next_step_4':   '3. Em ~30s o link de produção acima fica no ar — mande pro cliente',

      'viewer.header.project_label':   'Projeto:',
      'viewer.header.read_only_badge': 'Somente leitura',
      'viewer.header.status_label':    'Inspeção',

      'viewer.loading.label': 'Carregando modelo…',
      'viewer.loading.sub':   'Aguarde',

      'viewer.help.controls': 'Arrastar: orbitar · Scroll: zoom',

      'viewer.footer.vertices':     'Vértices:',
      'viewer.footer.points':       'Pontos:',
      'viewer.footer.global_score': 'Score Global:',

      'viewer.detail.panel_title':    'Detalhe da Inspeção',
      'viewer.detail.empty':          'Clique em um marcador para ver os detalhes',
      'viewer.detail.photo_label':    'Foto de Inspeção',
      'viewer.detail.criticality':    'Criticidade',
      'viewer.detail.identification': 'Identificação',
      'viewer.detail.id':             'ID',
      'viewer.detail.type':           'Tipo',
      'viewer.detail.location':       'Localização',
      'viewer.detail.detected':       'Detectado',
      'viewer.detail.position':       'Posição 3D (metros)',
      'viewer.detail.dimensions':     'Dimensões',
      'viewer.detail.area':           'Área',
      'viewer.detail.depth':          'Profundidade',
      'viewer.detail.action':         'Ação Recomendada',

      'viewer.tooltip.type':     'Tipo',
      'viewer.tooltip.score':    'Score',
      'viewer.tooltip.severity': 'Severidade',
      'viewer.tooltip.location': 'Local',

      'viewer.error.invalid_link.title':       'Link inválido',
      'viewer.error.invalid_link.sub':         'Acesse esta página através do link enviado.',
      'viewer.error.not_found.title':          'Inspeção não encontrada',
      'viewer.error.not_found.sub':            'Confira o link ou entre em contato.',
      'viewer.error.incomplete.title':         'Inspeção incompleta',
      'viewer.error.incomplete.sub':           'Esta inspeção não tem modelo associado.',
      'viewer.error.model_unavailable.title':  'Modelo indisponível',
      'viewer.error.model_unavailable.sub':    'O modelo 3D desta inspeção não pôde ser carregado. Confira o link ou entre em contato.',
    },
    en: {
      'common.back_to_landing': 'Back to noctuavisio.com',

      'common.tabs.overview': 'Overview',
      'common.tabs.list':     'List',
      'common.tabs.route':    'Route',

      'common.filters.all':      'All',
      'common.filters.fissura':  'Crack',
      'common.filters.furo':     'Hole',
      'common.filters.corrosao': 'Corrosion',

      'common.toolbar.heatmap':  'Heatmap',
      'common.toolbar.markers':  'Markers',
      'common.toolbar.free':     'Free',
      'common.toolbar.top':      'Top',
      'common.toolbar.add':      'Add Point',

      'admin.toolbar.rotate':    'Rotate',
      'admin.toolbar.rotate_x':  'Rotate X',
      'admin.toolbar.rotate_y':  'Rotate Y',
      'admin.toolbar.rotate_z':  'Rotate Z',
      'admin.toolbar.move':      'Move',
      'admin.toolbar.reset':     'Reset',
      'admin.toolbar.place':     'Place Point',

      'admin.modal.add.photo':         'Issue photo',
      'admin.modal.add.photo.mock':    'Generate mock',
      'admin.modal.add.photo.url':     'External URL',
      'admin.modal.add.photo.upload':  'Local upload',
      'admin.modal.add.photo.url_ph':  'https://...',

      'common.summary.title':    'Summary',
      'common.summary.total':    'Total',
      'common.summary.critical': 'Critical',
      'common.summary.high':     'High',
      'common.summary.medium':   'Medium',
      'common.summary.low':      'Low',

      'common.by_type':         'By Type',
      'common.risk_score':      'Risk Score',
      'common.risk.structural': 'Structural',
      'common.risk.surface':    'Surface',
      'common.risk.corrosion':  'Corrosion',

      'common.heatmap.title':    'Risk Intensity',
      'common.heatmap.low':      'Low',
      'common.heatmap.medium':   'Medium',
      'common.heatmap.high':     'High',
      'common.heatmap.critical': 'Critical',

      'sev.critical': 'Critical',
      'sev.high':     'High',
      'sev.medium':   'Medium',
      'sev.low':      'Low',

      'type.fissura':  'Crack',
      'type.furo':     'Hole',
      'type.corrosao': 'Corrosion',

      'theme.dark':  'Dark',
      'theme.light': 'Light',

      '404.message': 'Page not found.',

      'admin.password.title':       'Noctua Admin',
      'admin.password.placeholder': 'Password',
      'admin.password.submit':      'Sign in',
      'admin.password.wrong':       'Incorrect password',

      'admin.header.status':        'System active',
      'admin.header.import_model':  'Import Model',
      'admin.header.import_ortho':  'Import Orthomosaic',
      'admin.header.import_json':   'Import JSON',
      'admin.header.export_json':   'Export JSON',
      'admin.header.generate_link': 'Generate Client Link',
      'admin.header.ortho_loaded':  'Orthomosaic loaded',
      'admin.header.ortho_missing': 'No orthomosaic',
      'admin.header.analyze':       'Analyze',
      'admin.header.analyze_busy':  'Analyzing…',
      'admin.header.analyze_need':  'Import a model + orthomosaic first',
      'admin.header.analyze_ready': 'Run analysis (mock)',
      'admin.header.gcs_connect':    'Connect GCS',
      'admin.header.gcs_upload':     'Upload to GCS',
      'admin.header.gcs_unset':      'GCS not configured — fill GCS_CONFIG in the admin (see README, Phase 4)',
      'admin.header.gcs_need_auth':  'Sign in with Google to upload to the bucket',
      'admin.header.gcs_need_model': 'Load a .glb model first',
      'admin.header.gcs_ready':      'Upload the loaded model to the public bucket',

      'admin.load_overlay.label': 'Select a .glb model to start',
      'admin.load_overlay.sub':   'Use the "Change Model" button on top',

      'admin.modal.add.title':  'New Inspection Point',
      'admin.modal.add.id':     'ID',
      'admin.modal.add.coords': 'Coordinates in model (meters)',
      'admin.modal.add.type':   'Type',
      'admin.modal.add.sev':    'Severity',
      'admin.modal.add.loc':    'Location',
      'admin.modal.add.area':   'Area',
      'admin.modal.add.score':  'Score',
      'admin.modal.add.depth':  'Depth',
      'admin.modal.add.date':   'Date',
      'admin.modal.add.action': 'Recommended Action',
      'admin.modal.add.cancel': 'Cancel',
      'admin.modal.add.save':   'Save Point',
      'admin.modal.edit.title': 'Edit Inspection Point',
      'admin.modal.edit.save':  'Save Changes',
      'admin.detail.edit':      'Edit',
      'admin.detail.move':      'Move',
      'admin.detail.remove':    'Remove Point',
      'admin.hint.placing':     'Click on the model surface to place a point',
      'admin.hint.moving':      'Click on the model surface to move this point',

      'admin.modal.link.title':         'Generate Client Link',
      'admin.modal.link.project':       'Project name',
      'admin.modal.link.model_url':     'Model URL',
      'admin.modal.link.slug':          'Slug (optional — generated if empty)',
      'admin.modal.link.cancel':        'Cancel',
      'admin.modal.link.generate':      'Generate',
      'admin.modal.link.production_url':'Client link (production)',
      'admin.modal.link.local_url':     'For localhost testing',
      'admin.modal.link.next_step':     'Next step',
      'admin.modal.link.close':         'Close',
      'admin.modal.link.copy':          'Copy Link',
      'admin.modal.link.model_url_hint':'• <b>Model on GCS:</b> paste the full public URL (<code>https://storage.googleapis.com/…</code>)<br>• <b>Model inside the repo</b> (<code>models/</code> folder, legacy): use the absolute path, e.g. <code>/models/filename.glb</code>',
      'admin.modal.link.model_url_prefilled':'✓ Auto-filled from this session\'s GCS upload. Edit the field to use a different URL.',
      'admin.modal.link.next_step_1':   '1. Move the downloaded JSON to',
      'admin.modal.link.next_step_2':   'in the repo',
      'admin.modal.link.next_step_3':   '2. git add + commit + push',
      'admin.modal.link.next_step_4':   '3. In ~30s the production link above goes live — send it to the client',

      'viewer.header.project_label':   'Project:',
      'viewer.header.read_only_badge': 'Read-only',
      'viewer.header.status_label':    'Inspection',

      'viewer.loading.label': 'Loading model…',
      'viewer.loading.sub':   'Please wait',

      'viewer.help.controls': 'Drag: orbit · Scroll: zoom',

      'viewer.footer.vertices':     'Vertices:',
      'viewer.footer.points':       'Points:',
      'viewer.footer.global_score': 'Global Score:',

      'viewer.detail.panel_title':    'Inspection Detail',
      'viewer.detail.empty':          'Click a marker to see details',
      'viewer.detail.photo_label':    'Inspection Photo',
      'viewer.detail.criticality':    'Criticality',
      'viewer.detail.identification': 'Identification',
      'viewer.detail.id':             'ID',
      'viewer.detail.type':           'Type',
      'viewer.detail.location':       'Location',
      'viewer.detail.detected':       'Detected',
      'viewer.detail.position':       '3D Position (meters)',
      'viewer.detail.dimensions':     'Dimensions',
      'viewer.detail.area':           'Area',
      'viewer.detail.depth':          'Depth',
      'viewer.detail.action':         'Recommended Action',

      'viewer.tooltip.type':     'Type',
      'viewer.tooltip.score':    'Score',
      'viewer.tooltip.severity': 'Severity',
      'viewer.tooltip.location': 'Location',

      'viewer.error.invalid_link.title':       'Invalid link',
      'viewer.error.invalid_link.sub':         'Use the link you received to access this page.',
      'viewer.error.not_found.title':          'Inspection not found',
      'viewer.error.not_found.sub':            'Check the link or contact us.',
      'viewer.error.incomplete.title':         'Incomplete inspection',
      'viewer.error.incomplete.sub':           'This inspection has no model attached.',
      'viewer.error.model_unavailable.title':  'Model unavailable',
      'viewer.error.model_unavailable.sub':    "The 3D model couldn't be loaded. Check the link or contact us.",
    },
  };

  const SUPPORTED   = Object.keys(DICT);
  // Aligned with the landing's hardcoded default so all pages match on
  // first visit before any toggle / localStorage write.
  const DEFAULT     = 'en';
  const STORAGE_KEY = 'noctua_lang';
  const LISTENERS   = [];

  function detect() {
    try {
      const url = new URLSearchParams(location.search).get('lang');
      if (url && DICT[url]) return url;
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored && DICT[stored]) return stored;
    } catch (_) {}
    return DEFAULT;
  }

  function t(key, lang) {
    const l = lang || global.NoctuaI18n.lang;
    return (DICT[l] && DICT[l][key]) || (DICT[DEFAULT] && DICT[DEFAULT][key]) || key;
  }

  function apply(lang) {
    if (!DICT[lang]) lang = DEFAULT;
    global.NoctuaI18n.lang = lang;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (_) {}
    document.documentElement.lang = lang === 'pt' ? 'pt-BR' : lang;

    document.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = t(el.getAttribute('data-i18n'), lang);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      el.placeholder = t(el.getAttribute('data-i18n-placeholder'), lang);
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      el.title = t(el.getAttribute('data-i18n-title'), lang);
    });
    document.querySelectorAll('[data-i18n-html]').forEach(el => {
      el.innerHTML = t(el.getAttribute('data-i18n-html'), lang);
    });

    LISTENERS.forEach(fn => { try { fn(lang); } catch (_) {} });
  }

  function onChange(fn) { LISTENERS.push(fn); }

  global.NoctuaI18n = {
    lang: detect(),
    supported: SUPPORTED,
    t: t,
    apply: apply,
    onChange: onChange,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => apply(global.NoctuaI18n.lang));
  } else {
    apply(global.NoctuaI18n.lang);
  }
})(window);
