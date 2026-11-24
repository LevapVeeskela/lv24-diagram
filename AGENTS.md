# AGENTS.md — lv24-diagram

Rules for agents working in this repository.

## Shape

- Node 22.5+, ESM, strict TypeScript, no bundler: `tsc` emits `dist/`, tests run with `node:test`.
- Layers: `src/mermaid` (parse/lint/render), `src/schema` (Postgres + ER), `src/arch` (scan/diagram),
  `src/drawio` (MCP client), `src/docs` (repository + manifest), `src/brain` (CLI adapter),
  `src/mcp` (tool surface), `src/cli.ts` (entry point).
- Dependencies are pinned exactly; no `^`/`~`. Do not add a framework for something `node:*` covers.

## Non-negotiables

- **stdout belongs to MCP.** Every log line goes to stderr (`src/log.ts`). A stray `console.log`
  in a tool path corrupts the protocol.
- **No secrets.** Config accepts `${ENV}` only; notes and errors pass through `redactSecrets`.
  Never print a DSN with credentials, never read `.env*` contents in `arch_scan`.
- **Database stays read-only.** Keep the session read-only, keep the SQL guard, and never turn the
  guard into a permission claim. New queries must be catalog-only or explicitly SELECT.
- **No invented facts.** `arch_scan` reports unknowns instead of guessing; ER comes from the
  catalog; diagrams carry only what was observed.
- **Never bind to 0.0.0.0.** draw.io is `127.0.0.1`; the package opens no listening socket of its own.

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
