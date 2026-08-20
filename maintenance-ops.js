// Rota de manutenção / checagem de ERP (mockada) / ordens de serviço / ROI —
// tudo derivado dos `points` de uma inspeção, 100% client-side (sem backend,
// ver decisão em project.md). A recomendação técnica de cada OS vem de
// `pt.recommendation`, se o admin já tiver gerado via LLM na publicação
// (Opção 1 documentada em project.md); sem esse campo, cai num texto local.
import { pointTags, tagLabel, tagKey } from './inspection-detail.js';

const ESTIMATED_MINUTES_BY_SEVERITY = { critical: 55, high: 35, medium: 20, low: 12 };

// Uma entrada por tag "curada" (ver TAG_CURATED em inspection-detail.js) +
// fallback genérico pra tags desconhecidas. Estoque é mockado — troca por
// integração real com o ERP do cliente quando existir.
const MATERIAL_BY_TAG = {
  fissura:            { material: 'Selante poliuretano PU-40',               unit: 'un',  quantityNeeded: 2 },
  furo:                { material: 'Chapa de remendo + rebite estrutural',    unit: 'un',  quantityNeeded: 3 },
  corrosao:            { material: 'Conversor de ferrugem + fixador inox M8', unit: 'kit', quantityNeeded: 1 },
  infiltracao:         { material: 'Manta asfáltica + primer',                unit: 'm²',  quantityNeeded: 2 },
  desplacamento:       { material: 'Argamassa polimérica de reparo',          unit: 'kg',  quantityNeeded: 5 },
  armadura_exposta:    { material: 'Inibidor de corrosão + graute',           unit: 'kit', quantityNeeded: 1 },
  eflorescencia:       { material: 'Removedor de eflorescência + hidrofugante', unit: 'l', quantityNeeded: 1 },
  manchas_de_umidade:  { material: 'Impermeabilizante acrílico',              unit: 'l',   quantityNeeded: 3 },
  deformacao:          { material: 'Escoramento temporário + laudo estrutural', unit: 'kit', quantityNeeded: 1 },
  vazamento:           { material: 'Kit de vedação hidráulica',               unit: 'kit', quantityNeeded: 1 },
  oxidacao:            { material: 'Conversor de ferrugem + fixador inox M8', unit: 'kit', quantityNeeded: 1 },
  _default:            { material: 'Kit de inspeção complementar',            unit: 'kit', quantityNeeded: 1 },
};

// Estoque mockado do ERP do cliente — troca por integração real quando disponível.
const STOCK_BY_MATERIAL = {
  'Selante poliuretano PU-40': 1,
  'Chapa de remendo + rebite estrutural': 10,
  'Conversor de ferrugem + fixador inox M8': 0,
  'Manta asfáltica + primer': 6,
  'Argamassa polimérica de reparo': 40,
  'Inibidor de corrosão + graute': 2,
  'Removedor de eflorescência + hidrofugante': 4,
  'Impermeabilizante acrílico': 8,
  'Escoramento temporário + laudo estrutural': 0,
  'Kit de vedação hidráulica': 3,
  'Kit de inspeção complementar': 2,
};

// Prestadores mockados. O plano é isso virar uma busca automática pelo
// fornecedor de melhor custo-benefício (ver conversa em project.md); até lá,
// já modelamos como "empresa contratada", não "pessoa", pra não ter que
// migrar o conceito depois.
const PROVIDERS = ['Ferraz Manutenção Industrial', 'RM Serviços de Manutenção', 'Prisma Engenharia e Manutenção'];

function primaryTagKey(pt) {
  const tags = pointTags(pt);
  return tags.length ? tagKey(tags[0]) : '_default';
}

function materialRequirement(pt) {
  return MATERIAL_BY_TAG[primaryTagKey(pt)] || MATERIAL_BY_TAG._default;
}

export function checkStock(pt) {
  const req = materialRequirement(pt);
  const quantityInStock = STOCK_BY_MATERIAL[req.material] ?? 0;
  const status =
    quantityInStock >= req.quantityNeeded ? 'available' :
    quantityInStock > 0 ? 'low' : 'out_of_stock';
  return { material: req.material, unit: req.unit, quantityNeeded: req.quantityNeeded, quantityInStock, status };
}

// Agrega a necessidade de material por vários pontos de uma vez (ex: rota
// atual + rotas futuras previstas) — soma a quantidade necessária quando
// mais de um ponto pede o mesmo material, e lista quais pontos estão
// vinculados a cada um.
export function checkStockForPoints(points) {
  const byMaterial = new Map();
  points.forEach(pt => {
    const req = materialRequirement(pt);
    const entry = byMaterial.get(req.material);
    if (entry) {
      entry.quantityNeeded += req.quantityNeeded;
      entry.linkedPoints.push(pt);
    } else {
      byMaterial.set(req.material, { material: req.material, unit: req.unit, quantityNeeded: req.quantityNeeded, linkedPoints: [pt] });
    }
  });
  return [...byMaterial.values()].map(entry => {
    const quantityInStock = STOCK_BY_MATERIAL[entry.material] ?? 0;
    const status =
      quantityInStock >= entry.quantityNeeded ? 'available' :
      quantityInStock > 0 ? 'low' : 'out_of_stock';
    return { ...entry, quantityInStock, status };
  });
}

function distance3D(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Caminho físico entre os pontos críticos/altos: começa pelo mais grave
// (maior score) e, a cada passo, vai pro ponto não visitado mais próximo no
// espaço 3D (nearest-neighbor). Não é o caminho ótimo global (isso é NP-difícil
// pra qualquer quantidade de pontos), mas é uma heurística padrão pra rotas
// pequenas como as de uma inspeção, e evita zigue-zague sem sentido pela planta.
export function orderPointsSpatially(points) {
  return nearestNeighborPath(points);
}

function nearestNeighborPath(points) {
  if (points.length <= 1) return [...points];
  const remaining = [...points].sort((a, b) => b.score - a.score);
  const path = [remaining.shift()];
  while (remaining.length) {
    const last = path[path.length - 1];
    let bestIdx = 0, bestDist = Infinity;
    remaining.forEach((p, i) => {
      const d = distance3D(last.position, p.position);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    });
    path.push(remaining.splice(bestIdx, 1)[0]);
  }
  return path;
}

// Se a inspeção já tem um `route` explícito (lista de IDs, ver
// inspection-resolver.js), respeita essa ordem — permite o admin curar a
// sequência manualmente. Senão: filtra pelos pontos críticos/altos (critério
// de prioridade) e ordena como um caminho físico entre eles (nearestNeighborPath).
export function buildRoute(points, explicitRouteIds) {
  let ordered;
  if (Array.isArray(explicitRouteIds) && explicitRouteIds.length) {
    const byId = new Map(points.map(p => [p.id, p]));
    ordered = explicitRouteIds.map(id => byId.get(id)).filter(Boolean);
  } else {
    const critical = points.filter(p => p.severity === 'critical' || p.severity === 'high');
    ordered = nearestNeighborPath(critical);
  }
  return ordered.map((point, i) => ({
    sequence: i + 1,
    point,
    estimatedMinutes: ESTIMATED_MINUTES_BY_SEVERITY[point.severity] ?? 20,
  }));
}

export function totalMinutes(route) {
  return route.reduce((sum, item) => sum + item.estimatedMinutes, 0);
}

// Mesma tabela de tempo por severidade, mas aplicada direto numa lista de
// pontos crus (usado pelas rotas previstas, que não passam por buildRoute).
export function estimateMinutesForPoints(points) {
  return points.reduce((sum, p) => sum + (ESTIMATED_MINUTES_BY_SEVERITY[p.severity] ?? 20), 0);
}

// Datas de parada programada da planta cliente — mockado por enquanto.
const BLACKOUT_DATES = new Set();

function nextAvailableDate(after) {
  const d = new Date(after);
  d.setDate(d.getDate() + 1);
  while (BLACKOUT_DATES.has(d.toISOString().split('T')[0])) d.setDate(d.getDate() + 1);
  return d;
}

function pointRecommendation(pt, material, t) {
  if (typeof pt.recommendation === 'string' && pt.recommendation.trim()) {
    return { text: pt.recommendation.trim(), source: 'llm' };
  }
  const tag = pointTags(pt)[0];
  const materialNote =
    material.status === 'available' ? t('wo.material.reserved', 'Reservado')
    : material.status === 'low'     ? t('wo.material.pending_partial', 'Pendente compra (parcial)')
    : t('wo.material.pending', 'Pendente compra');
  const text = `${pt.location}: ${tagLabel(tag)}, score ${pt.score}/100. ${pt.action || ''} (${materialNote}: ${material.material})`.trim();
  return { text, source: 'template' };
}

const SEVERITY_RANK = { critical: 3, high: 2, medium: 1, low: 0 };

// Uma rota inteira = uma demanda de manutenção = UMA Ordem de Serviço.
// Os pontos críticos identificados juntos formam o escopo dessa OS; não faz
// sentido emitir uma OS por ponto quando o técnico resolve tudo numa mesma
// intervenção. Ver conversa registrada em project.md (2026-08-07).
export function buildWorkOrder(route, { t } = { t: (k, f) => f }) {
  if (!route.length) return null;
  const scheduledDate = nextAvailableDate(new Date());
  const highestPriority = route.reduce(
    (worst, item) => (SEVERITY_RANK[item.point.severity] > SEVERITY_RANK[worst] ? item.point.severity : worst),
    route[0].point.severity
  );
  const stops = route.map((item) => {
    const material = checkStock(item.point);
    const { text, source } = pointRecommendation(item.point, material, t);
    return { point: item.point, material, recommendation: text, recommendationSource: source };
  });
  return {
    number: `OS-${scheduledDate.getFullYear()}-${String(route[0].point.id).replace(/\D/g, '') || '001'}`,
    // Nasce como proposta do sistema — ninguém confirmou nada ainda. Só vira
    // "scheduled" quando um humano (ou, no futuro, a busca automática de
    // fornecedor) confirma; "completed" quando o serviço é executado.
    status: 'proposed',
    provider: PROVIDERS[0],
    priority: highestPriority,
    scheduledDate: scheduledDate.toISOString().split('T')[0],
    estimatedMinutes: totalMinutes(route),
    stops,
    recommendationSource: stops.some(s => s.recommendationSource === 'llm') ? 'llm' : 'template',
  };
}

// ── Manutenção preditiva (simulada) ─────────────────────────────────────────
// Ainda não existe um modelo real de degradação (isso é trabalho pra visão
// computacional analisando inspeções ao longo do tempo — ver roadmap em
// project.md). Pra demonstrar a ideia, simulamos uma velocidade de
// degradação por ponto (determinística, baseada no próprio ID, pra não
// mudar a cada re-render) e projetamos quando cada ponto ainda não crítico
// cruzaria o limiar de criticidade. Isso vira propostas de rota futura.
// FNV-1a — hash simples com boa dispersão mesmo pra strings quase iguais
// (IDs tipo INC-001/INC-002 diferem só no último char; um hash polinomial
// ingênuo produz frações quase idênticas pra eles, o que colapsava todas as
// previsões pro mesmo horizonte).
function seededFraction(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 1000) / 1000;
}

const CRITICAL_SCORE_THRESHOLD = 80;
const FORECAST_HORIZON_MONTHS = 12;
const FORECAST_WINDOW_MONTHS = 3;

export function predictFutureRoutes(points) {
  const candidates = points.filter(p => p.severity === 'medium' || p.severity === 'low');
  const predictions = candidates
    .map(p => {
      const monthlyGrowth = 1.5 + seededFraction(p.id) * 5; // 1.5 a 6.5 pontos de score/mês
      const monthsToCritical = Math.max(1, Math.ceil((CRITICAL_SCORE_THRESHOLD - p.score) / monthlyGrowth));
      return { point: p, monthsToCritical };
    })
    .filter(pr => pr.monthsToCritical <= FORECAST_HORIZON_MONTHS)
    .sort((a, b) => a.monthsToCritical - b.monthsToCritical);

  const buckets = [];
  predictions.forEach(pr => {
    const idx = Math.floor((pr.monthsToCritical - 1) / FORECAST_WINDOW_MONTHS);
    (buckets[idx] = buckets[idx] || []).push(pr);
  });

  const now = new Date();
  return buckets
    .map((items, idx) => {
      if (!items || !items.length) return null;
      const monthsAhead = (idx + 1) * FORECAST_WINDOW_MONTHS;
      const targetDate = new Date(now.getFullYear(), now.getMonth() + monthsAhead, now.getDate());
      return {
        monthsAhead,
        targetDate: targetDate.toISOString().split('T')[0],
        points: orderPointsSpatially(items.map(i => i.point)),
      };
    })
    .filter(Boolean);
}

export function computeRoi(points) {
  const critical = points.filter(p => p.severity === 'critical').length;
  const high = points.filter(p => p.severity === 'high').length;
  const avgScore = points.length ? Math.round(points.reduce((s, p) => s + p.score, 0) / points.length) : 0;
  return {
    totalPoints: points.length,
    preventedShutdowns: critical,
    estimatedSavingsThousandsBRL: critical * 18 + high * 7,
    assetHealthScore: Math.max(0, 100 - avgScore),
  };
}
