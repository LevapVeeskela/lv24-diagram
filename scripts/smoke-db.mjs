// End-to-end smoke test of the schema → ER → render → save path.
// Requires a reachable PostgreSQL; reads connection settings from env.
//   SMOKE_PG_HOST, SMOKE_PG_PORT, SMOKE_PG_DB, SMOKE_PG_USER, SMOKE_PG_PASSWORD
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PostgresIntrospector } from "../dist/src/schema/postgres.js";
import { buildErDiagram } from "../dist/src/schema/er.js";
import { renderMermaid } from "../dist/src/mermaid/render.js";
import { saveDiagram } from "../dist/src/docs/repository.js";

const introspector = new PostgresIntrospector({
  kind: "postgres",
  host: process.env.SMOKE_PG_HOST ?? "127.0.0.1",
  port: Number(process.env.SMOKE_PG_PORT ?? 5432),
  database: process.env.SMOKE_PG_DB ?? "smoke",
  user: process.env.SMOKE_PG_USER ?? "postgres",
  password: process.env.SMOKE_PG_PASSWORD ?? "",
  ssl: false,
  schemas: ["public"],
  includeViews: false,
  excludeTables: ["spatial_ref_sys"],
  statementTimeoutMs: 15000,
  maxRows: 50,
});

try {
  const tables = await introspector.tables();
  const snapshot = await introspector.snapshot(tables.map((table) => table.name));
  const er = buildErDiagram(snapshot, { maxEntities: 10 });

  console.log("tables:", tables.map((table) => `${table.name}(${table.estimatedRows})`).join(", "));
  console.log("columns:", snapshot.columns.length, "foreign keys:", snapshot.foreignKeys.length);
  console.log(
    "er budget:",
    `included ${er.included.length}, skipped ${er.skipped.length}, skippedRelations ${er.skippedRelations}`,
  );
  console.log("mermaid:\n" + er.mermaid);

  const rendered = await renderMermaid(er.mermaid, { png: true });
  const dir = await mkdtemp(join(tmpdir(), "lv24-diagram-smoke-"));
  const saved = await saveDiagram({
    dir,
    title: "Smoke ER",
    mermaid: er.mermaid,
    svg: rendered.svg,
    ...(rendered.png ? { png: rendered.png } : {}),
  });
  console.log(
    "rendered:",
    `layout ${rendered.layoutWidth.toFixed(0)}x${rendered.layoutHeight.toFixed(0)}`,
    `png ${rendered.pngWidth}x${rendered.pngHeight}`,
    "png bytes:",
    rendered.png?.byteLength ?? 0,
  );
  console.log("saved:", saved.files.join(", "));

  const query = await introspector.query("select name from places order by name");
  console.log("query rows:", JSON.stringify(query.rows));
} finally {
  await introspector.close();
}
