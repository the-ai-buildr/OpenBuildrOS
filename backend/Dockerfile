# =============================================================================
# OpenBuildrOS backend: Agno AgentOS (FastAPI) served by uvicorn.
# =============================================================================
FROM python:3.12-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONPATH=/app

WORKDIR /app

# Dependencies first so code edits do not invalidate the (slow) install layer.
COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY agents ./agents
COPY app ./app

# Run as an unprivileged user; tmp/ holds the SQLite file when DATABASE_URL is unset.
RUN useradd --system --uid 10001 --home-dir /app openbuildr \
    && mkdir -p /app/tmp \
    && chown openbuildr /app/tmp
USER openbuildr

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"

# WEB_CONCURRENCY sets the uvicorn worker count (default 1).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*", "--timeout-graceful-shutdown", "30"]

# -----------------------------------------------------------------------------
# test: runtime + the test suite and the fake OpenRouter used by the e2e stack.
# -----------------------------------------------------------------------------
FROM runtime AS test
COPY --chown=openbuildr tests ./tests
