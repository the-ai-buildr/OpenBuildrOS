# =============================================================================
# OpenBuildrOS computer supervisor: starts one computer container per bot.
# The only service that holds the Docker socket.
# =============================================================================
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install -r requirements.txt
COPY supervisor.py ./

EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --start-interval=2s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/health', timeout=4)"
# Runs as root: it talks to the Docker socket. It never runs bot code itself.
CMD ["uvicorn", "supervisor:app", "--host", "0.0.0.0", "--port", "8090"]
