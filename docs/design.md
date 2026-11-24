# Design decisions

Short record of the choices behind v0.1.0. Update this file when a decision changes.

## One server, three engines

`mermaid`, `dbhub` and `drawio` were installed separately and the agent glued them together on every
task: pick a database, write Mermaid, open the editor, export, copy files into `docs/`. The glue was
the actual product gap.

- **Mermaid** is rendered in-process with `mermaid-isomorphic` + Playwright. Rendering is the only
  part that needs Chromium; everything else works without it.
- **Schema** is read directly with `pg`. DBHub stays useful for generic multi-engine work, but for
  ER diagrams one engine, catalog-only queries and a read-only session are simpler and safer.
- **draw.io** is *not* reimplemented. It owns an editor and a WebSocket bridge (port 3337); running a
  second instance per project breaks the extension port. We speak MCP to the single shared server at
  `127.0.0.1:3214` and proxy a small, curated subset of its tools.

## TypeScript, not Go

Mermaid is a JavaScript library and its renderer needs a browser. A Go core would shell out to Node
anyway. The package is a thin, typed layer over three mature libraries, so the cost of Node is real
but the alternatives are worse.

## Read-only database, explicitly a guardrail

The session is set to read-only, statements get a timeout, and `schema_query` accepts one SELECT/WITH
with a row limit. None of this is a permission boundary: a determined caller could still abuse a
permissive role. The boundary is the database role (`SELECT`-only / `db_datareader`), and the docs say
so in each place the guard is described.

## ER shape from the catalog, not from migrations

Migrations describe intent; the catalog describes reality. Tables are ranked by `reltuples` (cheap,
never a scan), columns come from `information_schema`, PK/UK from `pg_index`, relations from
`pg_constraint`. Cardinality uses single-column uniqueness: a unique FK becomes `o|`, otherwise `o{`.

## Architecture scan reports unknowns

Heuristics that silently guess are worse than no diagram. The scanner extracts compose services
(including `!override` / `!reset` merge tags), nginx `proxy_pass` targets with `set $var` and
`upstream` expansion, and package workspaces. Anything unresolved — a missing compose file, an nginx
variable without a definition, an upstream that is not a service — becomes an entry in `unknowns`,
not a made-up node.

## Budgets are part of the API

`diagram_lint` encodes the readability rules from long practice: 15 nodes for an overview (25 hard),
depth ≤ 3, short edge labels, no cycles in flows. The linter is advisory by default and returns
structured findings so an agent can fix a diagram before exporting it.

## Brain sync is a pointer, not a copy

Brain stores curated conclusions; the repository stores the artifacts. We publish one note per
content hash with the directory, diagram list, hash and timestamp — not the diagram bodies and not
the schema. Repeated saves with unchanged content are skipped, so brain does not fill with noise.
The manifest (`docs/architecture/.diagrams.json`) keeps the last note id and hash.

Brain is called through its CLI (`brain open`, `brain note`), not as MCP-in-MCP: the CLI already owns
project resolution, redaction and storage, and a subprocess keeps failure handling simple. Every
brain failure is reported but never blocks saving a diagram.

## What is deliberately missing

- No raw multi-engine SQL (only PostgreSQL, catalog-first).
- No diagram hosting, no cloud render, no external upload of internal schemas.
- No automatic decision records in brain: decisions stay owner-accepted.
- No draw.io reimplementation, no bundled editor.
