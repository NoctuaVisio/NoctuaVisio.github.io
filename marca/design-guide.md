# Guia de Design — Noctua Visio

> Você pode editar esse arquivo a qualquer momento.
> As skills de carrossel, proposta e slide leem este arquivo antes de criar qualquer visual.

---

## Cores

A paleta é neutra (preto/cinza/branco) com o laranja como único ponto de calor. O site suporta tema claro e escuro — o escuro é o default.

### Acento (comum aos dois temas)

- **Cor de destaque / CTA:** `#ff6600` (laranja principal)
- **Laranja escuro (hover/variação):** `#cc5500`

### Tema escuro (default)

- **Fundo principal:** `#111111`
- **Fundo alternativo (seções):** `#1a1a1a`
- **Fundo terciário (hover/chrome):** `#222222`
- **Fundo do canvas 3D:** `#0a0a0a`
- **Texto principal:** `#f0f0f0`
- **Texto secundário:** `#888888`
- **Texto terciário (apagado):** `#444444`
- **Bordas:** `rgba(255,255,255,.08)` e `rgba(255,255,255,.14)`

### Tema claro

- **Fundo principal:** `#ffffff`
- **Fundo alternativo (seções):** `#f5f5f5`
- **Fundo terciário (hover/chrome):** `#ebebeb`
- **Fundo do canvas 3D:** `#cccccc`
- **Texto principal:** `#141414`
- **Texto secundário:** `#6b6b6b`
- **Texto terciário (apagado):** `#a3a3a3`
- **Bordas:** `rgba(0,0,0,.08)` e `rgba(0,0,0,.14)`

### Cores de severidade (anomalias / status)

Usadas apenas em marcadores, indicadores e badges de status — não em fundos ou textos genéricos.

- **Crítico:** `#ef4444` (vermelho)
- **Alto:** `#f97316` (laranja escuro)
- **Médio:** `#f59e0b` (amarelo)
- **Baixo:** `#10b981` (verde)

### O que evitar

- Gradientes coloridos chamativos (roxo→rosa, etc.)
- Azul, ciano e pastéis fora do palette acima — fogem do posicionamento tech/industrial
- Usar verde/vermelho/amarelo fora do contexto de severidade

---

## Tipografia

- **Títulos e destaques:** Inter, Sora ou Geist — sem serifa, peso Bold (700) ou ExtraBold (800)
- **Corpo, subtítulos e botões:** Inter ou Geist — Regular (400) ou Medium (500)
- **Peso do título:** Bold a ExtraBold — nunca Light em títulos

---

## Estilo geral

Dark, técnico, preciso. Inspirado em interfaces de controle industrial e dashboards de engenharia. Clean sem ser minimalista vazio — cada elemento tem função. Geometria forte, laranja como único ponto de calor numa paleta fria e profunda.

---

## Elementos-chave

- **Bordas:** finas, `1px`, cor `#484c75` ou `#2b2d46`
- **Border-radius dos cards:** `8px` a `12px` — arredondado mas não "fofo"
- **Botões:** fundo `#ff6600`, texto branco, radius `6px` — sem sombra excessiva
- **Sombras:** sutis, escuras (`rgba(0,0,0,0.4)`) — sem glow colorido
- **Ícones:** estilo linha (outline) ou sólido geométrico — sem ícones "ilustrativos"

---

## O que NUNCA fazer

- Fundo branco com laranja — perde o posicionamento tech/industrial
- Gradientes coloridos chamativos (tipo roxo → rosa)
- Fontes com serifa ou decorativas
- Imagens de banco com pessoas sorridentes em escritório
- Tom "startup de app" — a Noctua opera em campo, não em SaaS B2C

---

## Logo

- **Ícone laranja (fundo claro):** `marca/logo-laranja.png`
- **Ícone laranja + círculo preto (versão completa):** `marca/logo-laranja-circulo.png`
- **Versão pra fundo escuro (branco):** `marca/logo-branco.png`
- **Versão monocromática (preto):** `marca/logo-preto.png`
- **Uso padrão em fundos escuros:** `logo-branco.png` ou `logo-laranja-circulo.png`
- **Uso em fundos claros:** `logo-laranja.png` ou `logo-preto.png`
- **Onde usar:** slide final do carrossel (CTA), header de propostas, slides de apresentação
- **Tamanho sugerido:** largura entre 80–160px nos HTMLs

---

## Observações adicionais

Posicionamento visual deve reforçar: "Autonomous Industrial Inspection. Faster. Safer. Smarter."
Tudo que parece amador, "startup de app" ou corporativo genérico está errado. A Noctua opera em ambientes extremos — o visual deve comunicar isso.
