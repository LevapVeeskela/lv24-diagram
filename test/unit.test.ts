import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { interpolateEnv, ConfigError } from "../src/config.js";
import { detectDiagramType, parseMermaid } from "../src/mermaid/parse.js";
import { findCycle, graphDepth, lintMermaid } from "../src/mermaid/lint.js";
import { buildErDiagram, mermaidType } from "../src/schema/er.js";
import type { SchemaSnapshot } from "../src/schema/postgres.js";
import { assertReadOnlyQuery } from "../src/schema/postgres.js";
import { pngSize } from "../src/mermaid/render.js";
import { VERSION } from "../src/version.js";

test("version matches package.json", () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    version: string;
  };
  assert.equal(VERSION, pkg.version);
});

test("config interpolation replaces env and fails on missing variable", () => {
  assert.equal(interpolateEnv("postgres://u:${PW}@h", { PW: "secret" }), "postgres://u:secret@h");
  assert.throws(() => interpolateEnv("${MISSING}", {}), ConfigError);
});

test("detects mermaid diagram types", () => {
  assert.equal(detectDiagramType("flowchart LR\n A --> B"), "flowchart");
  assert.equal(detectDiagramType("sequenceDiagram\n A->>B: hi"), "sequence");
  assert.equal(detectDiagramType("erDiagram\n A ||--o{ B : id"), "er");
  assert.equal(detectDiagramType("gantt\n title x"), "unknown");
});

test("parses flowchart nodes, labels and edges", () => {
  const parsed = parseMermaid(`flowchart LR
    U[User] -->|HTTPS| N[nginx edge]
    N --> B[API]
    B -.-> D[(db)]
`);
  assert.deepEqual(
    parsed.nodes.map((node) => node.id).sort(),
    ["B", "D", "N", "U"],
  );
  assert.equal(parsed.nodes.find((node) => node.id === "N")?.label, "nginx edge");
  assert.equal(parsed.edges.length, 3);
  assert.equal(parsed.edges[0]?.label, "HTTPS");
});

test("parses sequence participants and messages", () => {
  const parsed = parseMermaid(`sequenceDiagram
    participant A as Admin
    participant B as API
    A->>B: POST /jobs
    B-->>A: 202
`);
  assert.equal(parsed.nodes.length, 2);
  assert.equal(parsed.edges.length, 2);
  assert.equal(parsed.nodes.find((node) => node.id === "A")?.label, "Admin");
});

test("parses er entities and relations", () => {
  const parsed = parseMermaid(`erDiagram
    places ||--o{ events : "place_id"
    places {
      uuid id PK
    }
`);
  assert.deepEqual(parsed.nodes.map((node) => node.id).sort(), ["events", "places"]);
  assert.equal(parsed.edges[0]?.label, "place_id");
});

test("lint reports node budget and cycles", () => {
  const nodes = Array.from({ length: 30 }, (_, index) => `N${index}[node ${index}]`).join("\n");
  const result = lintMermaid(`flowchart LR\n${nodes}\nN0 --> N1`);
  const rules = result.findings.map((finding) => finding.rule);
  assert.ok(rules.includes("node-budget"));
  assert.equal(result.ok, false);
});

test("cycle and depth are computed on a small graph", () => {
  const parsed = parseMermaid("flowchart LR\n A --> B\n B --> C\n C --> A");
  assert.deepEqual(findCycle(parsed).length > 0, true);
  assert.equal(graphDepth(parsed), 0);
  const dag = parseMermaid("flowchart LR\n A --> B\n B --> C");
  assert.equal(graphDepth(dag), 2);
});

test("empty diagram is an error", () => {
  const result = lintMermaid("flowchart LR\n%% nothing");
  assert.equal(result.ok, false);
  assert.equal(result.stats.nodes, 0);
});

const snapshot: SchemaSnapshot = {
  tables: [
    { schema: "public", name: "places", kind: "table", estimatedRows: 1000 },
    { schema: "public", name: "events", kind: "table", estimatedRows: 500 },
  ],
  columns: [
    { schema: "public", table: "places", name: "id", dataType: "uuid", isNullable: false, isPrimaryKey: true, isUnique: true, position: 1 },
    { schema: "public", table: "places", name: "name", dataType: "character varying", isNullable: true, isPrimaryKey: false, isUnique: false, position: 2 },
    { schema: "public", table: "events", name: "id", dataType: "uuid", isNullable: false, isPrimaryKey: true, isUnique: true, position: 1 },
    { schema: "public", table: "events", name: "place_id", dataType: "uuid", isNullable: true, isPrimaryKey: false, isUnique: false, position: 2 },
  ],
  foreignKeys: [
    { schema: "public", table: "events", column: "place_id", refSchema: "public", refTable: "places", refColumn: "id", constraintName: "events_place_fk" },
  ],
};

test("er diagram marks keys and relations", () => {
  const er = buildErDiagram(snapshot, { maxEntities: 10 });
  assert.match(er.mermaid, /^erDiagram/);
  assert.match(er.mermaid, /places \{/);
  assert.match(er.mermaid, /uuid id PK/);
  assert.match(er.mermaid, /uuid place_id FK/);
  assert.match(er.mermaid, /places \|\|--o\{ events : "place_id"/);
  assert.deepEqual(er.skipped, []);
});

test("er diagram respects entity budget", () => {
  const er = buildErDiagram(snapshot, { maxEntities: 1 });
  assert.deepEqual(er.included, ["places"]);
  assert.deepEqual(er.skipped, ["events"]);
  assert.doesNotMatch(er.mermaid, /events \{/);
  assert.equal(er.skippedRelations, 1, "dropped relation is reported, not silent");
  assert.deepEqual(er.droppedRelations, [{ from: "events", to: "places", column: "place_id" }]);
});

test("er columns carry keys but no nullable comments", () => {
  const er = buildErDiagram(snapshot, { maxEntities: 10 });
  assert.doesNotMatch(er.mermaid, /"null"/);
  assert.match(er.mermaid, /uuid id PK/);
});

test("pngSize reads real pixels from IHDR", () => {
  const buffer = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(buffer, 0);
  buffer.writeUInt32BE(1264, 16);
  buffer.writeUInt32BE(1297, 20);
  assert.deepEqual(pngSize(buffer), { width: 1264, height: 1297 });
  assert.equal(pngSize(Buffer.alloc(10)), undefined);
  assert.equal(pngSize(Buffer.alloc(24)), undefined);
});

test("er type mapping is mermaid-safe", () => {
  assert.equal(mermaidType("timestamp with time zone"), "timestamptz");
  assert.equal(mermaidType("character varying"), "varchar");
  assert.equal(mermaidType("some custom type"), "some_custom_type");
});

test("read-only guard accepts selects and rejects writes", () => {
  assert.equal(assertReadOnlyQuery("select 1;"), "select 1");
  assert.equal(assertReadOnlyQuery("with x as (select 1) select * from x"), "with x as (select 1) select * from x");
  assert.throws(() => assertReadOnlyQuery("delete from places"), /Only SELECT/);
  assert.throws(() => assertReadOnlyQuery("select 1; drop table places"), /one statement/);
  assert.equal(assertReadOnlyQuery("select * from t where x = 'a;b'"), "select * from t where x = 'a;b'");
});
