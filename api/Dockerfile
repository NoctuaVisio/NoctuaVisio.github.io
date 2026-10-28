# Build context is the REPO ROOT (the static site lives there):
#   docker build -f api/Dockerfile -t noctua-api .
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    SITE_ROOT=/app/site \
    PORT=8080

WORKDIR /app

COPY api/requirements.txt /app/api/requirements.txt
RUN pip install --no-cache-dir -r /app/api/requirements.txt

# The static site, stripped of anything that is not meant to be public.
COPY . /app/site
RUN rm -rf /app/site/api /app/site/infra /app/site/.git /app/site/models

COPY api /app/api

EXPOSE 8080
# --forwarded-allow-ips: Cloud Run terminates TLS at its proxy, so without
# trusting X-Forwarded-Proto uvicorn builds redirects as http:// — which breaks
# the directory redirect that /inspection/<slug> relies on.
CMD exec uvicorn api.main:app --host 0.0.0.0 --port ${PORT} --forwarded-allow-ips='*'

