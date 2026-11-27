# lv24-diagram

Architecture-as-code MCP server for real projects: render and lint Mermaid diagrams, build ER
diagrams from a **live** PostgreSQL schema, scan a repository into an architecture view, drive a
shared draw.io editor, and keep [lv24-brain](https://github.com/LevapVeeskela/lv24-brain) in sync.

One server instead of three (mermaid + dbhub + drawio), with the workflow glue those tools lack.
**Docs:** [Architecture](docs/ARCHITECTURE.md) · [Docs map](docs/README.md) · [Agent entry](AGENTS.md).

```text
agent ──stdio──> lv24-diagram ──┬── mermaid-isomorphic + chromium   (SVG/PNG)
                                ├── pg (read-only catalog queries)  (tables/columns/FK → ER)
                                ├── docker-compose + nginx + package.json (arch scan)
                                ├── MCP client → 127.0.0.1:3214     (draw.io editor)
                                └── brain CLI                        (context in, digest out)
```

## Status

| Item | Value |
|---|---|
| Version | **0.2.1** (2026-11-25) — owned by `package.json`, `src/version.ts`, `server.json` |
| License / package | Apache-2.0 · public npm `lv24-diagram` · MCP Registry `io.github.LevapVeeskela/lv24-diagram` |
| Runtime | Node ≥ 22.5, ESM, strict TypeScript; Chromium for rendering |
| Ship state | 0.2.1 published; HTTP mode since 0.2.0; no functional change in 0.2.1 |
| Verification | `npm test` — 49 `node:test` cases (see [CHANGELOG](CHANGELOG.md)) |

## Why another MCP

- **Checks before pretty pictures.** `diagram_lint` enforces node, depth, cycle, and label budgets.
- **ER from the catalog, not memory.** `pg_class`, `information_schema`, and `pg_constraint`; no guesses.
- **Architecture from files.** Compose, nginx `proxy_pass`/`set`/`upstream`, packages; unknowns reported.
- **Brain in the loop.** Project context in; one idempotent digest out.

## Install

```bash
node -v                      # >= 22.5
npm i -g lv24-diagram
lv24-diagram version
```

Windows: install under the Node you actually use (`npm prefix -g` tells you where). Rendering needs
Chromium; if it is missing, run `npm i -g lv24-diagram --allow-scripts=lv24-diagram` or
`npx playwright install chromium` from the package directory.

## Configure

```bash
cd <repo> && lv24-diagram init      # writes diagram.config.json
```

```jsonc
{
  "docs": { "dir": "docs/architecture", "theme": "default" },
  "database": {
    "kind": "postgres", "host": "127.0.0.1", "port": 5432,
    "database": "app", "user": "readonly_user",
    "password": "${APP_DB_PASSWORD}",             // env substitution
    "passwordFile": "C:/Users/me/.config/lv24-diagram/db-password", // wins over password
    "schemas": ["public"], "excludeTables": ["spatial_ref_sys"],
    "includeViews": false, "statementTimeoutMs": 15000, "maxRows": 500
  },
  "drawio": { "url": "http://127.0.0.1:3214/mcp", "editorUrl": "http://127.0.0.1:3214/" },
  "arch": { "maxFiles": 4000 },
  "brain": { "enabled": true, "project": "my-project" }
}
```

Discovery order: `--config`, `$DIAGRAM_CONFIG`, `./diagram.config.json`,
`~/.config/lv24-diagram/config.json`. `${VAR}` is expanded at load time; a missing variable is a
hard error. The full key list is in [diagram.config.schema.json](diagram.config.schema.json).

Secrets: use `passwordFile` when the MCP host is already running and cannot receive a new environment
variable. A relative path resolves against the config directory; the file is trimmed at load and wins
over `password`. A missing or empty file is a hard error that names the path and never echoes the
contents. Keep it outside repositories with an owner-only ACL.

## OpenCode

```jsonc
{
  "mcp": { "servers": { "lv24-diagram": {
    "type": "local",
    "command": ["node", "<npm-prefix>/node_modules/lv24-diagram/dist/src/cli.js", "mcp"]
  } } }
}
```

Use the absolute script path; do not route the server through `npx`.

## Tools

| Tool | What it does |
|---|---|
| `diagram_render` | Mermaid → SVG + PNG (image content block) |
| `diagram_lint` | Readability budget: nodes, depth, cycles, edge labels, label length |
| `diagram_save` | Store `NN-slug.{mmd,svg,png}`, update `README.md` index, publish to brain |
| `schema_tables` | Tables/views with row estimates from PostgreSQL |
| `schema_columns` | Columns, types, nullability, PK/UK |
| `schema_query` | One read-only `SELECT`/`WITH`, row-limited |
| `schema_er` | Mermaid `erDiagram` from the live schema, optionally rendered and saved |
| `arch_scan` | Compose + nginx + packages → services, edges, unknowns |
| `arch_diagram` | `container` / `context` / `deploy` Mermaid view from the scan |
| `drawio_status` | Health of the shared draw.io server and connected documents |
| `drawio_import_mermaid` | Mermaid → native draw.io cells (replace/add/new-page) |
| `drawio_export` | Page → PNG / SVG / XML at an absolute path |
| `brain_context` | Goal, next action, active items from lv24-brain |
| `brain_publish` | Idempotent digest note for the saved diagram set |

CLI: `mcp`, `serve`, `doctor`, `render`, `scan`, `brain`, `init`, `version`.

## HTTP mode (diagram-api)

`lv24-diagram serve` runs an opt-in HTTP service that renders Mermaid to PNG and serves the image
by a public UUID URL (used by the city AI diagram desk). The stdio MCP command is unchanged.

```bash
export DIAGRAM_API_TOKEN="..."      # required, must not be empty
lv24-diagram serve --http-port 3793 --redis-url redis://127.0.0.1:6379
```

| Endpoint | Auth | Behaviour |
|---|---|---|
| `GET /health` | no | `{status, chromium, storage, queue}` |
| `POST /v1/render` | `x-lv24-diagram-token` | Mermaid → PNG, stored for one hour |
| `GET /v1/diagrams/{uuid}.png` | no | `image/png`, `Cache-Control: public, max-age=3600, immutable` |
| `GET /docs-json` · `GET /docs` | no | OpenAPI 3 JSON · Swagger UI |

```bash
curl -s http://127.0.0.1:3793/health
```

Request body: `mermaid` 10–4000 characters, `theme` `default|base|dark|forest|neutral`, optional
`title` 1–80. Rendering is capped at **40 nodes** and uses Mermaid `securityLevel: strict`; `click`
and `%%{init}%%` are rejected with 400 `DIAGRAM_INVALID` plus `findings[]`. Concurrency is **1**, the
waiting queue is **4**, the render timeout is **10 s**, and the PNG long side is capped at **2400 px**.
A full queue returns 429 `DIAGRAM_BUSY`; a render failure, timeout, or missing Chromium returns
503 `DIAGRAM_UNAVAILABLE`.

PNGs live in Redis under `diagram:v1:png:<uuid>` with TTL **3600 s**; there is no in-memory fallback.
When Redis is unavailable, render and fetch return 503 `STORAGE_UNAVAILABLE`, and `/health` reports
`storage: "down"`. A missing or empty token stops the process before it listens.

The default bind is `127.0.0.1`. In a container, bind the container interface and publish only on an
internal Docker network — never on the host's public interface. Logs go to stderr and contain neither
the token nor diagram text.

## draw.io

The editor is one shared HTTP server per machine (port **3214**, WebSocket **3337**), because two
instances fight over the extension port.

```bash
lv24-diagram drawio start        # headless editor on 127.0.0.1:3214
```

Open `http://127.0.0.1:3214/` once to connect a document; without it the tools return
`No connected Draw.io documents` (expected, not a fault). Keep the tab visible — Chrome moves
background tabs to bfcache and drops the WebSocket.

## Brain sync

`brain_context` runs `brain open . --json` and returns `goal`, `next_action`, `active`.
`diagram_save`, `schema_er`, and `arch_diagram` publish one digest unless `publish_to_brain: false`;
publishing is skipped when the manifest content hash was already published (note id and hash live in
`docs/architecture/.diagrams.json`). Notes contain names, counts, and paths only; `redactSecrets`
strips `user:pass@` and `password=`/`token=` patterns. If the brain CLI is missing or the project is
unregistered, the diagram is still saved and the sync failure is reported.

## Security

- Everything is local: stdio transport; draw.io bound to `127.0.0.1`.
- Database access is read-only by construction: read-only session, `db_datareader`/`SELECT`-only
  role, and a SQL guard that is explicitly a **guardrail, not a permission boundary**.
- No secrets in configs, notes, or diagrams (`${ENV}` or `passwordFile`; errors reveal paths only);
  `arch_scan` never reads `.env*` contents.

## Development

```bash
npm install
npm run build
npm test               # node:test, 49 tests
node dist/src/cli.js doctor
```

## Documentation

| Doc | What it covers |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System context, components, layer DAG, flows, storage, deployment, guardrails |
| [docs/README.md](docs/README.md) | Documentation map by audience |
| [docs/design.md](docs/design.md) | Rationale for the one-server design and its trade-offs |
| [docs/architecture/README.md](docs/architecture/README.md) | Generated index of numbered diagrams; `.mmd` is the source, `.svg`/`.png` are generated |
| [AGENTS.md](AGENTS.md) · [CHANGELOG.md](CHANGELOG.md) · [SECURITY.md](SECURITY.md) | Agent rules · released surface and limits · vulnerability reporting |

## License

Apache-2.0.
