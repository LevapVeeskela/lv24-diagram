# lv24-diagram documentation

Entry point for the repository's documentation. The product front door is the
[README](../README.md); the system design is [ARCHITECTURE.md](ARCHITECTURE.md); agent rules are
[AGENTS.md](../AGENTS.md).

## Start by audience

| If you are… | Read first | Then |
|---|---|---|
| Evaluating or installing | [README](../README.md) | [Install](../README.md#install) · [Configure](../README.md#configure) · [HTTP mode](../README.md#http-mode-diagram-api) |
| Changing the server | [ARCHITECTURE.md](ARCHITECTURE.md) | [design.md](design.md) · [AGENTS.md](../AGENTS.md) |
| Adding a tool or engine | [ARCHITECTURE.md](ARCHITECTURE.md) §9 | [design.md](design.md) · [CHANGELOG](../CHANGELOG.md) |
| Operating HTTP mode | [README: HTTP mode](../README.md#http-mode-diagram-api) | [ARCHITECTURE.md](ARCHITECTURE.md) §5.3 · §7 |
| Reviewing security | [SECURITY.md](../SECURITY.md) | [ARCHITECTURE.md](ARCHITECTURE.md) §8 · [AGENTS.md](../AGENTS.md) |
| An AI agent at session start | [AGENTS.md](../AGENTS.md) | [ARCHITECTURE.md](ARCHITECTURE.md) · this map |

## Architecture

| Doc | What it explains |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Context, components, layer DAG, flows, storage, deployment, guardrails, extension points |
| [design.md](design.md) | Why one server, why TypeScript, read-only DB rationale, unknown reporting, brain pointer |
| [architecture/README.md](architecture/README.md) | Generated index of numbered diagrams (`.mmd` is the source) |

Diagram sources and exports live in `docs/architecture/NN-*.mmd`, `.svg`, `.png`. Regenerate them
with `lv24-diagram` (or the repo's `node dist/src/cli.js render <file> --saved "<title>"`) instead of
editing generated files.

## Project documents

| Doc | What it covers |
|---|---|
| [README](../README.md) | Pitch, install, config, tools, HTTP API, draw.io, brain, development |
| [README.ru](../README.ru.md) | Russian translation of the front door |
| [AGENTS.md](../AGENTS.md) | Normative rules for agents changing this repository |
| [CHANGELOG.md](../CHANGELOG.md) | Released surface and exact limits per version |
| [SECURITY.md](../SECURITY.md) | Vulnerability reporting |
| [diagram.config.schema.json](../diagram.config.schema.json) | Config JSON Schema |
| [server.json](../server.json) | MCP Registry metadata |
| [LICENSE](../LICENSE) | Apache-2.0 |

## Version and status

The version is owned by `package.json`, `src/version.ts`, and `server.json`; a test asserts the first
two match. The current release is **0.2.1** (2026-11-25). HTTP mode arrived in 0.2.0; 0.2.1 only adds
`mcpName` for the MCP Registry. Do not use an installed CLI's `version` output as the repository
version — use the files above.
