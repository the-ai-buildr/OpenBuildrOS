# OpenBuildrOS

Open source agent builder platform. Chat with three admin agents, and use **Platform Builder** to create new
agents from the UI. New agents are published at runtime and show up next to the admin agents, ready to use.

Built on [Agno AgentOS](https://docs.agno.com) (FastAPI) with models served through [OpenRouter](https://openrouter.ai),
a Next.js web UI, and Postgres.

```
 Browser ──► web (Next.js :3000) ──► backend (Agno AgentOS :8000) ──► OpenRouter
              │ Basic auth (optional)   │ OS_SECURITY_KEY bearer auth
              │ /api/os proxy adds key  │ Studio registry + admin agents
              └─────────────────────────┴──► Postgres (sessions, runs, traces, built agents)
```

## Admin agents

These are the default agents from Agno's AgentOS template, adapted for OpenBuildrOS. They are defined in code
(`backend/agents/`) and always served.

| Agent | Id | What it does |
| --- | --- | --- |
| Platform Builder | `platform-builder` | Turns plain language into new agents with Agno Studio (`StudioTools`). Publishes them so they appear under **Your agents**. Archiving and deleting versions pause for your approval in the UI. |
| Platform Manager | `platform-manager` | Read-only. Reports usage, tokens, runs, latency, failures, traces, and built components (`AgentOSTools`). |
| Platform Engineer | `platform-engineer` | Read-only. Reads the backend source and explains how it is wired, with file paths (`WorkspaceContextProvider`). `.env` files are excluded. |

### Building an agent in the UI

1. Click **+ Create agent**, give it a name and purpose, and tick the tools it may use. Or just ask
   Platform Builder in chat ("Build a research agent that searches the web and cites sources").
2. The Builder discovers the exact tool and model names in the registry, calls `create_agent` with
   `publish=true`, and reports the published version.
3. The new agent appears under **Your agents**. Select it and chat.

New agents can only use what the Studio registry declares (`backend/app/registry.py`): calculator, web search,
and file generation (JSON/CSV/TXT/HTML); the UI reads this list from `GET /palette`. Adding a capability is a
reviewed code change to that file. The Builder creates agents only (Studio's team and workflow builders are
switched off), so a user-built agent can never include an admin agent.

## Quickstart (Docker)

Prerequisites: Docker with Compose v2, GNU Make, OpenSSL, and an OpenRouter API key.

```bash
make env      # creates .env with a generated OS_SECURITY_KEY and DB_PASSWORD
# edit .env: set OPENROUTER_API_KEY, and UI_PASSWORD if anyone else can reach the UI
make up       # builds the images and waits until every service is healthy
```

Open http://localhost:3000.

| Command | What it does |
| --- | --- |
| `make up` / `make down` | Start / stop the stack (data is kept in the `pgdata` volume) |
| `make logs`, `make ps` | Follow logs, show health |
| `make clean` | Stop and **delete** the database volume |
| `make install` | Local dev dependencies (`backend/.venv`, `frontend/node_modules`) |
| `make dev-backend`, `make dev-frontend` | Hot-reload dev servers (backend uses SQLite, `RUNTIME_ENV=dev`) |
| `make lint`, `make test` | Lint/format/type checks and unit + integration tests for both apps |
| `make e2e` | Build the full stack against a fake model and run the Playwright journey |
| `make lock` | Re-resolve `backend/requirements.txt` from `requirements.in` |

## Configuration

All settings are environment variables; `.env.example` documents each one.

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | yes | OpenRouter key. Only the backend container sees it. |
| `OS_SECURITY_KEY` | yes | Bearer token for the AgentOS API. The web server adds it to proxied calls; the browser never sees it. |
| `DB_PASSWORD` | yes | Postgres password (use URL-safe characters; `make env` generates hex). |
| `UI_PASSWORD`, `UI_USERNAME` | recommended | HTTP Basic auth in front of the whole UI. |
| `OPENROUTER_MODEL_ID` | no | Default model for every agent (default `anthropic/claude-sonnet-4.5`). Must support tool calling. |
| `RUNTIME_ENV` | no | `prd` (default) refuses to start without the two keys; `dev` relaxes that and enables `/docs`. |
| `WEB_CONCURRENCY` | no | uvicorn worker processes. |
| `CORS_ORIGINS` | no | Extra browser origins allowed to call the API directly. |

## APIs

The backend is a standard AgentOS. Every endpoint needs `Authorization: Bearer $OS_SECURITY_KEY`.

- **AgentOS REST**: `GET /agents`, `GET /palette` (tools new agents may use), `POST /agents/{id}/runs` (form fields `message`, `stream`, `session_id`,
  `user_id`; SSE when streaming), `POST /agents/{id}/runs/{run_id}/continue`, sessions, traces, metrics,
  components. With `RUNTIME_ENV=dev`, interactive docs are at http://localhost:8000/docs. You can also connect the
  backend to [os.agno.com](https://os.agno.com).
- **AG-UI**: `POST /ag-ui/{agent_id}/agui` for each admin agent, for CopilotKit or any AG-UI client.
- **A2A**: agent cards at `/a2a/agents/{id}/.well-known/agent-card.json`, messages at
  `/a2a/agents/{id}/v1/message:send` and `:stream`, for every agent including built ones.

The backend port is published on `127.0.0.1` only. The UI reaches the backend over the internal Compose network.

```bash
curl -N -H "Authorization: Bearer $OS_SECURITY_KEY" \
  -F message="Is the platform healthy?" -F stream=true \
  http://localhost:8000/agents/platform-manager/runs
```

## Production notes

- Put the web service behind a TLS-terminating reverse proxy. Set `UI_PASSWORD`, or add your own SSO in front.
- Both images run as non-root users and have health checks; Compose sets CPU and memory limits.
- The UI proxy forwards only the five endpoints the UI uses (`frontend/lib/proxy-rules.ts`), not the whole
  admin API, and stamps every run with the signed-in UI user (`UI_USERNAME`) so the browser cannot pick its
  own identity. Studio records that user as the owner of agents it builds.
- Studio components, sessions, and traces live in Postgres. Back up the `pgdata` volume.
- Agno telemetry is off by default (`AGNO_TELEMETRY=false` in `backend/app/settings.py`, `telemetry=False` on AgentOS).

## Development

```
backend/
  app/main.py        AgentOS entrypoint: admin agents, registry, AG-UI, A2A, auth
  app/settings.py    Environment settings and the OpenRouter model factory
  app/db.py          Postgres or SQLite from DATABASE_URL
  app/registry.py    What Platform Builder may build with
  app/functions.py   Deterministic workflow steps
  agents/            builder.py, manager.py, engineer.py
  tests/             pytest suite and fake_llm.py (scripted OpenAI-compatible server)
frontend/
  app/components/    Workspace, Sidebar, ChatView, CreateAgentDialog
  app/api/os/        Server-side proxy to AgentOS
  lib/               SSE parser, chat state, API client, proxy rules
  proxy.ts           Optional Basic auth
  tests/, e2e/       Vitest unit tests, Playwright journey
```

Tests never call OpenRouter. `backend/tests/fake_llm.py` is an OpenAI-compatible server with scripted replies.
It can make the Builder call Studio's real `create_agent` and `archive_component`, so the tests cover the full
path: UI → proxy → AgentOS → Studio → database → the new agent answering.

The Hyperframes video pipeline from the original PRD is out of scope for this version.
