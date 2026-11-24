# Changelog

All notable changes to this project are documented here. Format: Keep a Changelog, SemVer.

## [0.2.0] — 2026-11-25

### Added

- **HTTP mode (`lv24-diagram serve`)** for `diagram-api`: renders Mermaid to PNG and serves it by a
  public UUID URL. Flags: `--http-port` (default **3793**), `--host` (default **127.0.0.1**),
  `--redis-url`, `--token-env` (default `DIAGRAM_API_TOKEN`). A missing or empty token stops the
  process before it listens.
- `POST /v1/render` (token header `x-lv24-diagram-token`) returns `{id, width, height, bytes,
  mermaid}`; `GET /v1/diagrams/{uuid}.png` is public with `Cache-Control: public, max-age=3600,
  immutable`; `GET /health` reports Chromium, Redis and queue state; `GET /docs-json` and `GET /docs`
  expose OpenAPI 3 and Swagger UI.
- Render limits: 10–4000 input characters, 40 linted nodes, themes `default|base|dark|forest|neutral`,
  Mermaid `securityLevel: strict` with `click` and `%%{init}%%` rejected, concurrency **1**, queue
  **4**, timeout **10 s**, PNG long side **2400 px** (box-filter downscale). Queue overflow → 429
  `DIAGRAM_BUSY`; render/timeout/Chromium failure → 503 `DIAGRAM_UNAVAILABLE`.
- Redis-only PNG storage under `diagram:v1:png:<uuid>` with TTL **3600 s**. No in-memory fallback:
  an unavailable Redis yields 503 `STORAGE_UNAVAILABLE` on render and fetch.
- `swagger-ui-dist` and `redis` as pinned runtime dependencies; 21 new `node:test` cases (49 total)
  for auth, validation and findings, queue/429, storage 200/404/503, health, OpenAPI and PNG
  filters/downscale.

### Changed

- `renderMermaid` accepts `fullWidth` for HTTP renders; wide diagrams are rendered at intrinsic size
  instead of 100% of the page and then capped at 2400 px. Mermaid is always initialized with
  `securityLevel: "strict"` (the previous default, now explicit).

## [0.1.2] — 2026-11-24

### Added

- **`database.passwordFile`.** The password can now come from a file instead of an environment
  variable, which is the only option when the MCP host is already running and cannot be given a new
  `env` value. A relative path resolves against the config file's directory, the file is read and
  trimmed at load time, and it takes priority over `password`. A missing or empty file fails with
  the resolved path in the message and never echoes the contents. Keep the file outside
  repositories with an ACL limited to your user.
- Five config tests: parsing, relative-path resolution, file-over-inline priority, missing file and
  empty file.

## [0.1.1] — 2026-11-24

### Fixed

- **PNG dimensions were wrong.** `diagram_render`, saved diagrams and the CLI reported
  mermaid-isomorphic layout units as if they were pixels (2838×2911 vs the real 1264×1297 screenshot).
  `width`/`height` now return the true PNG pixel size parsed from the IHDR chunk (layout size when no
  PNG is produced), and the layout units are exposed separately as `layoutWidth`/`layoutHeight`, with
  `pngWidth`/`pngHeight` when a screenshot exists. No fields were removed.
- **PostGIS metadata polluted listings and ER.** Views are no longer listed by default (`includeViews`,
  `schema_tables.include_views`), and `spatial_ref_sys` is excluded via `database.excludeTables`.
  On the city database this removes 2 metadata views and the spatial reference table.
- **Dropped relations were silent.** `schema_er` now returns `skippedRelations` (count) and the first
  50 entries in `droppedRelations` when the entity budget cuts an FK, instead of quietly losing edges.
- **Nullable columns carried a misleading `"null"` comment** in the ER diagram; nullability belongs to
  `schema_columns`, not to Mermaid keys.
- README on the npm page was one commit behind (absolute paths in the OpenCode example); this release
  publishes the generic example.

## [0.1.0] — 2026-11-24

First public release. One MCP server replacing mermaid + dbhub + drawio for architecture work.

### Added

- `diagram_render` — Mermaid to SVG and PNG via mermaid-isomorphic + Chromium, PNG returned as an
  MCP image block.
- `diagram_lint` — readability budget: node count (soft/hard), graph depth, cycles, unlabeled-edge
  ratio, longest label, sequence participant and ER entity limits.
- `diagram_save` — canonical storage as `NN-slug.mmd/.svg/.png` with an idempotent `README.md` index
  and a manifest (`.diagrams.json`).
- `schema_tables`, `schema_columns`, `schema_query`, `schema_er` — PostgreSQL introspection through
  `pg_class` / `information_schema` / `pg_constraint`, read-only session, row-limited SELECT guard,
  Mermaid ER generation with PK/FK/UK markers and cardinality from uniqueness.
- `arch_scan`, `arch_diagram` — docker-compose services (including `!override`/`!reset` overlays),
  nginx `proxy_pass` with `set $var` and `upstream` expansion, package workspaces; container,
  context and deploy Mermaid views with explicit unknowns.
- `drawio_status`, `drawio_import_mermaid`, `drawio_export` — MCP client for the shared draw.io
  server at `127.0.0.1:3214` with reconnect-once semantics.
- `brain_context`, `brain_publish` — lv24-brain integration over the CLI: curated project state in,
  idempotent content-hash digest out, secret redaction, best-effort failure handling.
- CLI: `mcp`, `doctor`, `render`, `scan`, `brain`, `drawio start|status`, `init`, `version`.
- 21 unit tests covering parsing, lint rules, ER generation, compose/nginx scan, repository writes
  and secret redaction.

### Notes

- draw.io remains a separate process: it owns the editor and the extension WebSocket (3337).
- `schema_query` is guarded, not sandboxed; use a read-only database role.
