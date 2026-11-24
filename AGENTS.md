# AGENTS.md — lv24-diagram

Rules for agents working in this repository.

## Shape

- Node 22.5+, ESM, strict TypeScript, no bundler: `tsc` emits `dist/`, tests run with `node:test`.
- Layers: `src/mermaid` (parse/lint/render), `src/schema` (Postgres + ER), `src/arch` (scan/diagram),
  `src/drawio` (MCP client), `src/docs` (repository + manifest), `src/brain` (CLI adapter),
  `src/http` (opt-in HTTP render service: server/routes/auth/storage/queue, PNG cap, OpenAPI),
  `src/mcp` (tool surface), `src/cli.ts` (entry point).
- Dependencies are pinned exactly; no `^`/`~`. Do not add a framework for something `node:*` covers.

## Non-negotiables

- **stdout belongs to MCP.** Every log line goes to stderr (`src/log.ts`). A stray `console.log`
  in a tool path corrupts the protocol.
- **No secrets.** Config accepts `${ENV}` or `passwordFile` (a file outside the repo, read and
  trimmed at load, never echoed by errors); notes and errors pass through `redactSecrets`.
  Never print a DSN with credentials, never read `.env*` contents in `arch_scan`.
- **Database stays read-only.** Keep the session read-only, keep the SQL guard, and never turn the
  guard into a permission claim. New queries must be catalog-only or explicitly SELECT.
- **No invented facts.** `arch_scan` reports unknowns instead of guessing; ER comes from the
  catalog; diagrams carry only what was observed.
- **Never bind to 0.0.0.0 on a workstation.** draw.io is `127.0.0.1`; `lv24-diagram serve` binds
  `127.0.0.1` by default. In a container bind the container interface and publish the port only on
  the internal Docker network, never on the host's public interface.
- **HTTP mode is token-gated and fail-closed.** `serve` requires a non-empty token from the variable
  named by `--token-env` (default `DIAGRAM_API_TOKEN`) and must exit before listening otherwise.
  Only `POST /v1/render` is authenticated; `/health`, `/docs`, `/docs-json` and `/{id}.png` are
  public by design.
- **Render limits belong to the service, not the caller.** 10–4000 input characters, 40 nodes,
  Mermaid `securityLevel: strict`, no `click` or `%%{init}%%`, concurrency 1, queue ≤ 4, 10 s
  timeout, PNG long side ≤ 2400 px. Redis is the only storage (`diagram:v1:png:<uuid>`, TTL 3600);
  never add an in-memory fallback.
- **HTTP logs never contain the token or diagram text.** Log route names, error classes and queue
  state only.

## Workflow

1. Change the smallest module that owns the behavior.
2. `npm run build && npm test` must be green.
3. Update `README.md`, `README.ru.md` and `CHANGELOG.md` in the same change when the tool surface or
   config changes.
4. Tool descriptions are the agent-facing API: keep them short, concrete, and honest about limits.

## Release

- Version in `package.json`, `src/version.ts` and `server.json` move together (a test checks the
  first two).
- npm publish is owner-gated; do not publish from a random session.
- Never commit `node_modules/`, `dist/` or local configs with credentials.
