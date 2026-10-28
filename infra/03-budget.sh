#!/usr/bin/env bash
# Budget alerts on the billing account. Free — a budget never blocks spending,
# it only emails the billing admins when a threshold is crossed.
#
# One budget of R$100 with rules at 50% and 100% gives alerts at exactly R$50
# and R$100, which is cheaper to reason about than two overlapping budgets.
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/env.sh

BILLING_ACCOUNT="${BILLING_ACCOUNT:-$(gcloud billing projects describe "$PROJECT_ID" \
  --format='value(billingAccountName)' | sed 's|billingAccounts/||')}"
BUDGET_NAME="${BUDGET_NAME:-noctua-mensal}"
BUDGET_AMOUNT="${BUDGET_AMOUNT:-100}"

echo "==> enabling the budget API"
gcloud services enable billingbudgets.googleapis.com --project "$PROJECT_ID"

echo "==> budget '$BUDGET_NAME' (${BUDGET_AMOUNT} BRL, alerts at 50% and 100%)"
EXISTING="$(gcloud billing budgets list --billing-account="$BILLING_ACCOUNT" \
  --filter="displayName=${BUDGET_NAME}" --format='value(name)' 2>/dev/null | head -1)"

if [ -n "$EXISTING" ]; then
  gcloud billing budgets update "$EXISTING" \
    --billing-account="$BILLING_ACCOUNT" \
    --budget-amount="${BUDGET_AMOUNT}BRL" \
    --threshold-rule=percent=0.5 \
    --threshold-rule=percent=1.0
  echo "    atualizado"
else
  gcloud billing budgets create \
    --billing-account="$BILLING_ACCOUNT" \
    --display-name="$BUDGET_NAME" \
    --budget-amount="${BUDGET_AMOUNT}BRL" \
    --threshold-rule=percent=0.5 \
    --threshold-rule=percent=1.0
fi

echo
echo "alertas por e-mail vão para os admins de faturamento da conta ${BILLING_ACCOUNT}."
