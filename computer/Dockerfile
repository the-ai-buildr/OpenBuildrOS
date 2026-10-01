# =============================================================================
# OpenBuildrOS computer: one bot's headless Chromium, workspace, and shell.
# Started per bot by the supervisor (COMPUTER_MODE=per-bot) or once for all bots
# (COMPUTER_MODE=shared).
#
# Microsoft's Playwright image ships Chromium with every system library it needs,
# pinned to the same Playwright release as requirements.txt.
# =============================================================================
FROM mcr.microsoft.com/playwright/python:v1.56.0-noble

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    WORKSPACE_ROOT=/workspace

WORKDIR /app
COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY computer.py ./
# pwuser (uid 1001) is the image's unprivileged user.
RUN mkdir -p /workspace && chown pwuser /workspace
USER pwuser

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=2s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=4)"
CMD ["python", "-m", "uvicorn", "computer:app", "--host", "0.0.0.0", "--port", "8080"]
