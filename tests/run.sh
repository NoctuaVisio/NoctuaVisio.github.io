#!/usr/bin/env bash
# Every page, with the query each one needs to render something real.
#
# Checks per page: scripts evaluate without throwing; every handler the HTML
# names exists; every data-i18n key has a translation; the flows that only run
# after an await (the login gate, the share list) complete; the grid contains
# every row the viewer may open, with the buttons their role allows; and
# nothing rendered an error block — which is the only check a try/catch cannot
# hide from.
#
# `<persona>@<page>` checks a page as somebody else. The hub is checked three
# times because the three viewers are the whole point of it: an admin sees
# every asset with every action, a client sees what was granted to them with
# none, and a visitor sees only what is public.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node tests/page-boot.mjs \
  index.html \
  admin/edit/index.html \
  'editor@admin/edit/index.html?asset=forklift' \
  'client@admin/edit/index.html?asset=forklift' \
  'anon@admin/edit/index.html?asset=forklift' \
  asset/index.html \
  'client@asset/index.html?slug=forklift' \
  inspection/index.html \
  privacy/index.html \
  terms/index.html \
  assets/index.html \
  'client@assets/index.html' \
  'editor@assets/index.html' \
  'anon@assets/index.html' \
  'assets/index.html?asset=forklift' \
  'client@assets/index.html?asset=forklift'
