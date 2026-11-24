# Security policy

## Reporting

Report vulnerabilities privately to the maintainer (GitHub: @LevapVeeskela). Do not open a public
issue with an exploit or with credentials. Include the version, the tool name, and a minimal
reproduction. Expect an acknowledgement within a week.

## Scope and design boundaries

- **Local by default.** The MCP server speaks stdio only and opens no listening socket. The
  draw.io server it talks to is expected on `127.0.0.1`; this package never binds `0.0.0.0`.
- **Database access is read-only by construction.** The session is set
  `transaction read only`, statements get a timeout, and `schema_query` accepts a single
  SELECT/WITH with a row limit. This is a guardrail: use a database role that cannot write.
- **Secrets.** Configuration values support `${ENV}` placeholders only. Anything written to
  lv24-brain passes through `redactSecrets` (`user:pass@`, `password=`, `token=`, `secret=`,
  `apikey=`). `arch_scan` never reads `.env*` contents.
- **No telemetry, no network calls** beyond the configured database, the local draw.io endpoint and
  the local `brain` binary.

## Known limitations

- The SQL guard works by keyword and shape checks; it is not a SQL parser. A read-only DB role is
  the actual boundary.
- `arch_scan` is heuristic: it reports unresolved nginx targets and missing compose files as
  unknowns rather than drawing guesses.
- Mermaid rendering executes diagram source in a local Chromium instance; treat untrusted Mermaid as
  untrusted input and render it in a throwaway profile.
