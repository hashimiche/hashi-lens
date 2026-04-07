# Hashi Lens

Hashi Lens is a full-stack TypeScript app for interacting with HashiCorp infrastructure using an Ollama-powered agent. It combines:

- Vault audit analysis (via [`vault-mcp-server`](https://github.com/czembower/vault-mcp-server/tree/split-upstream-changes))
- Vault operational queries/actions (via [`vault-audit-mcp`](https://github.com/czembower/vault-audit-mcp))
- A React UI with streaming responses and session-scoped history
- Documentation suggestions

This provides a natural language interface to reconcile Vault configuration against client activity and behaviors.

## Example Prompts

- `What is the current cluster status?`
- `Have there been any failed authentication events recently?`
- `Which Vault entities have access to the secret at kv/foo in the operations namespace?`
- `Which ACL policies have been used within the last 24 hours?`
- `Which auth roles associated with the mount auth/oidc have been used to login recently?`
- `Have there been secret access errors in the past two hours?`

## Stack

- Frontend: React 18 + Vite
- Backend: Express + TypeScript (`tsx` in dev)
- LLM provider: Ollama (local)
- MCP integration: stdio child-process clients for both MCP servers

## Architecture

- Browser client calls Express API (`/api/*` through Vite proxy in dev)
- Express server orchestrates tool execution through an LLM service
- Execution engine calls:
  - `vault-audit-mcp` (stdio)
  - `vault-mcp-server` (stdio)
- Vault authentication state is managed server-side (OIDC or token auth)

## Prerequisites

- Node.js 18+
- Built binaries (or runnable commands) for:
  - `vault-audit-mcp`
  - `vault-mcp-server`
- Vault cluster accessible from the backend
- Loki if you use audit queries (see the `vault-audit-mcp` project for details)
- Local Ollama runtime

Note that `vault-audit-mcp` and `vault-mcp-server` should be sourced from https://github.com/czembower?tab=repositories

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create env file:

```bash
cp .env.example .env
```

3. Configure `.env`.

## Environment Variables

- `LLM_PROVIDER`: `ollama`
- `OLLAMA_BASE_URL`: Ollama OpenAI-compatible endpoint (default `http://ollama.localhost:11434/v1`)
- `OLLAMA_MODEL`: local model name served by Ollama (default `qwen2.5:7b`)
- `OLLAMA_API_KEY`: optional placeholder value for client auth (default `ollama`)
- `VAULT_AUDIT_MCP_COMMAND`: command/path for audit MCP server (default `./vault-audit-mcp`)
- `VAULT_MCP_COMMAND`: command/path for Vault MCP server (default `./vault-mcp-server`)
- `HAL_MCP_COMMAND`: command/path for HAL MCP server (default `${HOME}/.hal/bin/hal-mcp`)
- `TERRAFORM_MCP_COMMAND`: command/path for Terraform MCP server
- `CONSUL_MCP_COMMAND`: command/path for Consul MCP server
- `NOMAD_MCP_COMMAND`: command/path for Nomad MCP server
- `BOUNDARY_MCP_COMMAND`: command/path for Boundary MCP server
- `TFE_MCP_COMMAND`: command/path for Terraform Enterprise MCP server
- `LOKI_URL`: passed to `vault-audit-mcp` (default `http://loki.localhost:3100`)
- `API_PORT`: backend port (default `9001`)
- `VITE_PORT`: frontend dev port (default `9000`)
- `VITE_HOSTNAME`: frontend host label (default `hal.localhost`)
- `VAULT_OIDC_REDIRECT_URI`: OIDC callback URL (default `http://localhost:8250/oidc/callback`)
- `VAULT_ADDR`: optional bootstrap Vault endpoint for local/sandbox mode
- `VAULT_TOKEN`: optional bootstrap token for local/sandbox mode
- `VAULT_SKIP_VERIFY`: optional TLS verify toggle (`true`/`false`) for local cert setups

Notes: MCP servers are started as local processes via stdio, not HTTP URLs.

If you prefer not to use the UI "connect" flow in local sandbox mode, set `VAULT_ADDR` (and optionally `VAULT_TOKEN`) in `.env`. Hashi Lens will bootstrap Vault context from these values at startup.

### Ollama Quick Start (no cloud API key)

1. Install and start Ollama.
2. Pull a model that supports your workflow, for example:

```bash
ollama pull qwen2.5:7b
```

3. Configure `.env`:

```bash
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
OLLAMA_MODEL=qwen2.5:7b

# optional but recommended for visual troubleshooting
LOKI_URL=http://loki.localhost:3100
```

If you see `model not found` errors in chat:

```bash
curl http://127.0.0.1:11434/api/tags
ollama pull qwen2.5:7b
```

Then restart Hashi Lens.

## Development

Run frontend and backend together:

```bash
npm run dev
```

- Backend: `http://localhost:9001` (or `API_PORT`)
- Frontend: `http://hal.localhost:9000` (or `VITE_HOSTNAME` + `VITE_PORT`)

The frontend proxies `/api` to the backend.

## Build

```bash
npm run build
```

Outputs:
- Server build under `dist/server`
- Client build under `dist/client`

## API Endpoints

Base backend endpoints:

- `GET /health`
- `POST /query`
- `POST /query/stream` (SSE stream)
- `GET /history`
- `POST /history/clear`
- `GET /tokens`
- `GET /suggestions`
- `POST /suggestions/clear`
- `GET /activities`
- `POST /activities/clear`
- `GET /auth/status`
- `POST /auth/login`
- `POST /auth/oidc/auth-url`
- `POST /auth/oidc/complete`
- `POST /auth/switch-cluster`
- `POST /auth/logout`

Session behavior:
- Session ID is read from `X-Session-ID` header.
- If omitted, backend uses `default` session.
- Frontend generates and persists a session ID in `localStorage`.

## Authentication

Hashi Lens supports:

- OIDC login flow (popup + local callback)
- Direct token-based login

Current token handling:
- Tokens are cached in memory only (per cluster)
- Periodic renewal checks clear expiring tokens and require re-authentication
- Logout attempts token revocation (`revoke-self`) for OIDC-managed tokens

## What the Agent Can Use

Audit-side capabilities include:
- search/aggregate/trace audit events
- fetch detailed event data by `request_id`

Vault-side capabilities include many `vault-mcp-server` tools (for example namespace, mount, secret, policy, auth-method, replication, health, metrics, and lease inspection).

Exact available tools are determined by the connected MCP servers and current versions.

## Project Structure

```text
src/
  client/    React UI
  server/    Express API, auth manager, LLM services, MCP clients
```

## Scripts

- `npm run dev`
- `npm run dev:server`
- `npm run dev:client`
- `npm run build`
- `npm run build:server`
- `npm run build:client`
- `npm run preview`
- `npm run type-check`

## Consolidated Notes

This section consolidates critical content that previously lived in:
`ARCHITECTURE.md`, `FILES_INDEX.md`, `GETTING_STARTED.md`, `LLM_PROVIDERS.md`,
`MCP_CONNECTION.md`, `MCP_STDIO.md`, `PROJECT_SUMMARY.md`,
`SETUP_COMPLETE.md`, and `TOKEN_MANAGEMENT.md`.

### End-to-End Runtime Flow

1. User sends a natural-language query from the React UI.
2. Backend (`Express`) forwards query + tool definitions to the selected LLM provider.
3. LLM decides on tool calls.
4. `ExecutionEngine` routes tool calls:
   - Audit tools -> `vault-audit-mcp` client
   - Vault tools -> `vault-mcp-server` client
5. Tool results are returned to the LLM for synthesis.
6. Final response (plus tool call/result metadata) is streamed back to UI.

### MCP Integration Details

- Current transport model is local-process execution via configured command paths.
- Ensure binaries are present and executable:
  - `VAULT_AUDIT_MCP_COMMAND`
  - `VAULT_MCP_COMMAND`
  - `HAL_MCP_COMMAND` (defaults to `${HOME}/.hal/bin/hal-mcp`)
- Typical verification:

```bash
./vault-audit-mcp --help
./vault-mcp-server --help
```

- Common failures:
  - `EACCES` or permission denied -> `chmod +x <binary>`
  - command not found / startup timeout -> fix command path in `.env`

### LLM Runtime

- Hashi Lens is configured for `LLM_PROVIDER=ollama`.
- Ensure your selected `OLLAMA_MODEL` is available in local Ollama.
- Restart server after model changes.

### Token and Large-Result Strategy

Hashi Lens expects summarized audit payloads for high-volume queries to avoid token overflow:

- Large audit result sets should be reduced to summary statistics + small representative samples.
- Follow-up narrowing queries (namespace/status/path/time) are preferred over returning raw bulk events.
- Aggregate/count-style tools are naturally compact and should be preferred for broad scans.

### Source of Truth Files

- Main entry points:
  - `src/server/index.ts`
  - `src/server/execution-engine.ts`
  - `src/server/auth/manager.ts`
  - `src/client/App.tsx`
  - `src/client/DocumentationSidebar.tsx`
- Start here for behavior changes instead of maintaining parallel docs.

### Operational Troubleshooting

- Auth appears stale or expired:
  - check `GET /auth/status`
  - re-authenticate via UI
  - logout/login to force token reset
- Tools not executing:
  - verify MCP command paths in `.env`
  - run binaries directly from shell
  - check backend logs for tool timeout / parse errors
- Frontend/backed mismatch:
  - confirm Vite proxy and backend port (`VITE_PORT` / `API_PORT`)
  - restart `npm run dev`

## License

See `LICENSE`.
