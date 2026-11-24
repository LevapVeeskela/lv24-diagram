# Changelog

All notable changes to this project are documented here. Format: Keep a Changelog, SemVer.

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
