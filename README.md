# OpenBuildrOS

Open source platform for autonomous AI coworkers. Build bots from the UI, give each one its own computer
(browser, files, shell), let them work together as **teams** and **workflows**, and put them on a schedule
as **routines**. Three admin agents run the platform; **Platform Builder** builds everything else from plain
language.

Built on [Agno AgentOS](https://docs.agno.com) (FastAPI) with models served through [OpenRouter](https://openrouter.ai),
a Next.js web UI with its own auth, and Postgres. Every agent and team also speaks
[AG-UI](https://docs.ag-ui.com) and A2A, so other clients can use them.

```
 Browser ──► web (Next.js :3000) ──► backend (Agno AgentOS :8000) ──► OpenRouter
              │ Basic auth (optional)   │ OS_SECURITY_KEY bearer auth
              │ /api/os proxy adds key  │ admin agents, Studio, scheduler, policy gateway
              │                         ├──► Postgres (sessions, runs, built components, audit log)
              │                         └──► supervisor ──► one computer container per bot
              │                                             (Chromium + workspace + shell, no DB access)
```

## What you can do

| | |
| --- | --- |
| **Agents** | Click **+ Create** → Agent, or ask Platform Builder. Pick tools from the palette, including **computer**. |
| **Teams** | Create → Team and pick member agents. The team leader delegates; each member's work shows as an activity line in the reply. |
| **Workflows** | Create → Workflow and order the agents as steps; each step gets the previous step's output. |
| **Routines** | Ask the Builder ("every weekday at 9, have the researcher summarise AI news"). **Routines** lists them; run now, pause, or resume. |
| **Channels** | Every conversation is a server-side session. Pick up any channel later, from any browser; runs still going reattach. |
| **Computers** | A bot with the computer tool gets its own browser (logins persist), workspace, and shell. The side panel shows its live screen and an audit trail of what it did, and what policy refused. |

Admin agents can never be a team member or workflow step, so nothing built from the UI can reach their
privileged tools.

## Admin agents

These are the default agents from Agno's AgentOS template, adapted for OpenBuildrOS. They are defined in code
(`backend/agents/`) and always served.

| Agent | Id | What it does |
| --- | --- | --- |
| Platform Builder | `platform-builder` | Turns plain language into agents, teams, workflows, and routines with Agno Studio (`StudioTools`), and publishes them so they appear in the sidebar. Archiving, deleting versions, and deleting routines pause for your approval in the UI. |
| Platform Manager | `platform-manager` | Read-only. Reports usage, tokens, runs, latency, failures, traces, and built components (`AgentOSTools`). |
| Platform Engineer | `platform-engineer` | Read-only. Reads the backend source and explains how it is wired, with file paths (`WorkspaceContextProvider`). `.env` files are excluded. |

### Building in the UI

1. Click **+ Create**, choose Agent, Team, or Workflow, and fill in the form. Or just ask Platform Builder
   in chat ("Build a research agent that searches the web and cites sources").
2. The Builder discovers the exact tool and model names in the registry, calls Studio's `create_agent`,
   `create_team`, or `create_workflow` with `publish=true`, and reports the published version.
3. The new component appears in the sidebar. Select it and chat.

New agents can only use what the Studio registry declares (`backend/app/registry.py`): calculator, web search,
file generation (JSON/CSV/TXT/HTML), and, when computers are on, **computer**. The UI reads this list from
`GET /palette`. Adding a capability is a reviewed code change to that file. Archiving components and deleting
versions or schedules pause for your approval in the UI.

## Bot computers

Each bot that has the **computer** tool works on its own machine:

- `browse`, `read_page`, `click`, `type_text`: a headless Chromium whose profile (cookies, logins) persists;
- `list_files`, `read_file`, `write_file`: the bot's workspace;
- `run_shell`: commands in the workspace, as an unprivileged user, with a minimal environment and a timeout.

Every action goes through one gateway in the backend (`backend/app/computer.py`):

1. **Policy** (`backend/app/policy.py`, `COMPUTER_POLICY`): JSON `deny` and `allow` rules that match on tool,
   bot id, host, and a regex over the URL, command, or path. Deny wins; anything no allow rule matches is
   refused. Browsing private, loopback, link-local, and cloud-metadata addresses is always refused unless
   `allow_private_hosts` is set. A malformed policy stops the backend from starting.
2. **Audit**: every decision is written to the `openbuildr_audit` table before the action runs, and again if
   it fails. `GET /audit?bot_id=` reads it; the UI shows it under the live screen.
3. Only then is the bot's computer called. A refusal goes back to the model as text, and the chat shows the
   call as **refused** with the rule that refused it.

`COMPUTER_MODE` picks how computers run:

| Mode | How | Use for |
| --- | --- | --- |
| `per-bot` (default) | The supervisor (`supervisor/`) starts one container per bot on first use, from `openbuildros-computer`, and stops it after `COMPUTER_IDLE_MINUTES`. Each has its own workspace volume, all capabilities dropped, `no-new-privileges`, PID/memory/CPU limits, and sits on the `computers` network, which cannot reach Postgres. Set `COMPUTER_RUNTIME=runsc` to run them under gVisor. | Production |
| `shared` | One computer service (`--profile shared-computer`) keeps bots apart by directory and browser context. Shell commands share one container. | Local development, tests |
| `off` | No computer tool. | Deployments that don't need it |

The supervisor is the only service with the Docker socket, and it only ever starts containers from the
computer image with those fixed limits. Treat it as privileged: anyone who controls it controls Docker.

## Quickstart (Docker)

Prerequisites: Docker with Compose v2, GNU Make, OpenSSL, and an OpenRouter API key.

```bash
make env      # creates .env with generated OS_SECURITY_KEY, DB_PASSWORD, COMPUTER_TOKEN, SUPERVISOR_TOKEN
# edit .env: set OPENROUTER_API_KEY, and UI_PASSWORD if anyone else can reach the UI
make up       # builds the images (including the bot computer) and waits until every service is healthy
```

Open http://localhost:3000.

| Command | What it does |
| --- | --- |
| `make up` / `make down` | Start / stop the stack (data is kept in the `pgdata` volume) |
| `make logs`, `make ps` | Follow logs, show health |
| `make clean` | Stop and **delete** the database volume |
| `make install` | Local dev dependencies (`backend/.venv`, `frontend/node_modules`) |
| `make dev-backend`, `make dev-frontend` | Hot-reload dev servers (backend uses SQLite, `RUNTIME_ENV=dev`) |
| `make lint`, `make test` | Lint/format/type checks and tests for the backend, frontend, computer, and supervisor |
| `make e2e` | Build the full stack (per-bot computers included) against a fake model and run the Playwright journeys |
| `make lock` | Re-resolve each Python service's `requirements.txt` from its `requirements.in` |

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
| `OPENROUTER_MAX_RETRIES`, `OPENROUTER_TIMEOUT` | no | Retries for transient model failures (default 3) and request timeout in seconds (default 120). |
| `OPENROUTER_FALLBACK_MODELS` | no | Comma-separated models OpenRouter fails over to. |
| `WEB_CONCURRENCY` | no | uvicorn worker processes. More than 1 requires `REDIS_URL`. |
| `REDIS_URL` | with >1 worker | Shares resumable run streams across workers (`docker compose --profile scale up -d`). |
| `CORS_ORIGINS` | no | Extra browser origins allowed to call the API directly. |
| `COMPUTER_MODE` | no | `per-bot` (default), `shared`, or `off`; see [Bot computers](#bot-computers). |
| `COMPUTER_TOKEN` | when computers are on | Shared secret between the backend and bot computers. |
| `SUPERVISOR_TOKEN` | in `per-bot` mode | Shared secret between the backend and the supervisor. |
| `COMPUTER_POLICY` | no | JSON deny/allow rules for computer actions. Default: allow all but private-network browsing. |
| `COMPUTER_MEMORY`, `COMPUTER_CPUS`, `COMPUTER_IDLE_MINUTES`, `COMPUTER_RUNTIME` | no | Per-bot container limits (default `2g`, `1`), idle shutdown (default 30), and an optional runtime such as `runsc`. |

## APIs

The backend is a standard AgentOS. Every endpoint needs `Authorization: Bearer $OS_SECURITY_KEY`.

- **AgentOS REST**: `/agents`, `/teams`, `/workflows` and their `/runs` (form fields `message`, `stream`,
  `session_id`, `user_id`; SSE when streaming), resumable runs with `background=true` +
  `/runs/{run_id}/resume` and `/cancel`, `/continue` for approvals, `/sessions`, `/schedules`, traces,
  metrics, components. With `RUNTIME_ENV=dev`, interactive docs are at http://localhost:8000/docs. You can
  also connect the backend to [os.agno.com](https://os.agno.com).
- **OpenBuildrOS**: `GET /palette` (tools new agents may use), `GET /computers/{bot_id}/screen` (PNG of a
  running computer), `GET /audit?bot_id=&limit=` (computer actions and decisions).
- **AG-UI**: `POST /ag-ui/{agent_id}/agui` and `POST /ag-ui/teams/{team_id}/agui` for every agent and team,
  including ones built at runtime, for CopilotKit or any AG-UI client (`backend/app/agui.py`).
- **A2A**: agent cards at `/a2a/agents/{id}/.well-known/agent-card.json`, messages at
  `/a2a/agents/{id}/v1/message:send` and `:stream`, for every agent including built ones.

The backend port is published on `127.0.0.1` only. The UI reaches the backend over the internal Compose network.

```bash
curl -N -H "Authorization: Bearer $OS_SECURITY_KEY" \
  -F message="Is the platform healthy?" -F stream=true \
  http://localhost:8000/agents/platform-manager/runs
```

## Resilience

- **Model calls.** Transient failures (connection errors, 408, 409, 429, 5xx) are retried by the OpenAI SDK with
  exponential backoff, jitter, and `Retry-After`. The retry happens before any token streams, so output is never
  duplicated. 4xx errors such as a bad key fail fast. Every request has a timeout, and OpenRouter can fail over to
  `OPENROUTER_FALLBACK_MODELS`. There is no extra retry library: one layer, in the client that knows the protocol.
- **Dropped streams.** The UI starts every run with `background=true`, so the agent keeps running on the server if
  the browser disconnects. Each event carries an `event_index`. When a stream ends early or the network fails, the UI
  calls AgentOS's `POST /agents/{id}/runs/{run_id}/resume` with the last index it saw. It retries up to five times
  with exponential backoff and jitter, and shows "Reconnecting (n/5)…" meanwhile. Replayed events at or below that
  index are dropped, so nothing repeats or goes missing (`frontend/lib/resilient.ts`). Completed runs are replayed
  from the database once the in-memory buffer has expired.
- **Stop** cancels the run on the server (`/cancel`), since aborting the request would leave a background run going.
- **Reopening a channel** whose run is still going reattaches to it through `/resume` from the first event.

## Production notes

- Put the web service behind a TLS-terminating reverse proxy. Set `UI_PASSWORD`, or add your own SSO in front.
- Every image runs as a non-root user (except the supervisor, which needs the Docker socket) and has a
  health check; Compose sets CPU and memory limits.
- Bot computers can browse the internet. Narrow that with `COMPUTER_POLICY` allow rules (for example
  `{"tool": "browse", "host": "*.example.com"}`), and use `COMPUTER_RUNTIME=runsc` where gVisor is available.
- The UI proxy forwards only the endpoints the UI uses (`frontend/lib/proxy-rules.ts`), not the whole
  admin API, and stamps every run with the signed-in UI user (`UI_USERNAME`) so the browser cannot pick its
  own identity. Studio records that user as the owner of what it builds.
- Studio components, sessions, schedules, traces, and the audit log live in Postgres. Back up the `pgdata`
  volume, and the per-bot `obr-computer-*-workspace` volumes if bots keep files you need.
- Agno telemetry is off by default (`AGNO_TELEMETRY=false` in `backend/app/settings.py`, `telemetry=False` on AgentOS).

## Development

```
backend/
  app/main.py        AgentOS entrypoint: admin agents, registry, scheduler, A2A, extra routes
  app/agui.py        AG-UI for every agent and team, resolved per request
  app/computer.py    Computer toolkit and gateway (policy, audit, then the bot's computer)
  app/policy.py      Deny/allow rules and the private-network guard
  app/audit.py       The audit log table
  app/settings.py    Environment settings and the OpenRouter model factory
  app/db.py          Postgres or SQLite from DATABASE_URL
  app/registry.py    What Platform Builder may build with
  app/functions.py   Deterministic workflow steps
  agents/            builder.py, manager.py, engineer.py, studio.py (admin agents stay out of teams)
  tests/             pytest suite and fake_llm.py (scripted OpenAI-compatible server)
computer/            The bot computer: FastAPI over Playwright, workspace files, and a shell
supervisor/          Starts and stops one computer container per bot
frontend/
  app/components/    Workspace, Sidebar, ChatView, ToolCard, CreateDialog, RoutinesDialog, ComputerPanel
  app/api/os/        Server-side proxy to AgentOS
  lib/               SSE parser, resumable streams, chat state, tool cards, API client, proxy rules
  proxy.ts           Optional Basic auth
  tests/, e2e/       Vitest unit tests, Playwright journeys
```

Tests never call OpenRouter. `backend/tests/fake_llm.py` is an OpenAI-compatible server with scripted replies.
It can make the Builder call Studio's real `create_agent`, `create_team`, `create_workflow`, `create_schedule`,
and `archive_component`, and make built agents use their computer, so the tests cover the full path: UI →
proxy → AgentOS → Studio → database → the new agent, team, or workflow answering → its computer, policy, and
audit log.

The Hyperframes video pipeline from the original PRD is out of scope for this version.
