# lv24-diagram

Architecture-as-code MCP server for real projects: render and lint Mermaid diagrams, build ER
diagrams from a **live** PostgreSQL schema, scan a repository into an architecture view, drive a
shared draw.io editor, and keep [lv24-brain](https://github.com/LevapVeeskela/lv24-brain) in sync.

One server instead of three (mermaid + dbhub + drawio), with the workflow glue those tools lack.

```text
agent ──stdio──> lv24-diagram ──┬── mermaid-isomorphic + chromium   (SVG/PNG)
                                ├── pg (read-only catalog queries)  (tables/columns/FK → ER)
                                ├── docker-compose + nginx + package.json (arch scan)
                                ├── MCP client → 127.0.0.1:3214     (draw.io editor)
                                └── brain CLI                        (context in, digest out)
```

## Why another MCP

- **Checks before pretty pictures.** `diagram_lint` enforces readability budgets (nodes, depth,
  cycles, edge labels, label length) so overview diagrams stay readable.
- **ER from the database, not from memory.** Column names are the classic silent error; the schema
  tools read `pg_class` / `information_schema` / `pg_constraint` and never guess.
- **Architecture from the repository.** `arch_scan` reads compose services, nginx `proxy_pass`
  targets (including `set $var` and `upstream` blocks) and packages, and reports what it could not
  resolve instead of inventing it.
- **Brain in the loop.** `brain_context` seeds a diagram with the project's actual goal; `brain_publish`
  writes one idempotent note (content hash) pointing at `docs/architecture/`.

## Install

```bash
node -v                      # >= 22.5
npm i -g lv24-diagram
lv24-diagram version
```

Windows: install under the Node you actually use (`npm prefix -g` tells you where). The package
spawns the binary by absolute path from the OpenCode config, not through `npx`.

Mermaid rendering needs Chromium. If it is missing:

```bash
npm i -g lv24-diagram --allow-scripts=lv24-diagram
# or, from the package directory:
npx playwright install chromium
```

## Configure

```bash
cd <repo> && lv24-diagram init      # writes diagram.config.json
```

```jsonc
{
  "docs": { "dir": "docs/architecture", "theme": "default", "backgroundColor": "#ffffff" },
  "database": {
    "kind": "postgres",
    "host": "127.0.0.1",
    "port": 5432,
    "database": "app",
    "user": "readonly_user",
    "password": "${APP_DB_PASSWORD}",   // never a literal secret
    "schemas": ["public"],
    "statementTimeoutMs": 15000,
    "maxRows": 500
  },
  "drawio": { "url": "http://127.0.0.1:3214/mcp", "editorUrl": "http://127.0.0.1:3214/" },
  "arch": { "maxFiles": 4000 },
  "brain": { "enabled": true, "project": "my-project" }
}
```

Discovery order: `--config`, `$DIAGRAM_CONFIG`, `./diagram.config.json`,
`~/.config/lv24-diagram/config.json`. `${VAR}` is expanded at load time; a missing variable is a
hard error.

## OpenCode

```jsonc
{
  "mcp": {
    "servers": {
      "lv24-diagram": {
        "type": "local",
        "command": [
          "C:/nvm4w/nodejs/node.exe",
          "C:/nvm4w/nodejs/node_modules/lv24-diagram/dist/src/cli.js",
          "mcp"
        ]
      }
    }
  }
}
```

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

CLI: `mcp`, `doctor`, `render`, `scan`, `brain`, `init`, `version`.

## draw.io

The editor is one shared HTTP server per machine (port **3214**, WebSocket **3337**), because two
instances fight over the extension port. It can run headless and serve the editor:

```bash
lv24-diagram drawio start        # node drawio-mcp-server --editor --transport http --http-port 3214 --extension-port 3337 --host 127.0.0.1
```

Open `http://127.0.0.1:3214/` once — the page connects a document, and the draw.io tools work.
Without an open editor they return `No connected Draw.io documents`; that is expected, not a fault.
Keep the tab visible: Chrome moves background tabs to bfcache and drops the WebSocket.

## Brain sync

- `brain_context` runs `brain open . --json` and returns `goal`, `next_action`, `active`.
- `diagram_save` / `schema_er` / `arch_diagram` call `brain_publish` unless
  `publish_to_brain: false`.
- Publishing is skipped when the manifest content hash was already published; the note id and hash
  live in `docs/architecture/.diagrams.json`.
- Notes contain names, counts and paths only. `redactSecrets` strips `user:pass@` and
  `password=`/`token=` patterns before anything is written.
- If the brain CLI is missing or the project is unregistered, the diagram is still saved; the tool
  reports the sync failure instead of failing the work.

## Security

- Everything is local: stdio transport, draw.io bound to `127.0.0.1`.
- Database access is read-only by construction: the session is set to read-only, the user should be
  `db_datareader`/`SELECT`-only, and the SQL guard is explicitly a **guardrail, not a permission
  boundary**.
- No secrets in configs, notes or diagrams; `${ENV}` only.
- `arch_scan` skips hidden directories and never reads `.env*` contents — only presence of files.

## Development

```bash
npm install
npm run build
npm test               # node:test, 21 tests
node dist/src/cli.js doctor
```

See [AGENTS.md](AGENTS.md) for repository rules and [docs/design.md](docs/design.md) for decisions.

## License

Apache-2.0.
