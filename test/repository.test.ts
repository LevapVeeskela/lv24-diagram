import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  contentHash,
  readManifest,
  saveDiagram,
  slugify,
  summarizeManifest,
} from "../src/docs/repository.js";
import { redactSecrets } from "../src/brain/client.js";

test("slugify transliterates and normalises", () => {
  assert.equal(slugify("Схема данных"), "shema-dannyh");
  assert.equal(slugify("Architecture / Container!"), "architecture-container");
  assert.equal(slugify("***"), "diagram");
});

test("content hash ignores trailing whitespace", () => {
  assert.equal(contentHash("flowchart LR\n A --> B\n"), contentHash("flowchart LR\n A --> B"));
  assert.notEqual(contentHash("flowchart LR\n A --> B"), contentHash("flowchart LR\n A --> C"));
});

test("saveDiagram writes mmd/svg/png, index and manifest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lv24-diagram-docs-"));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const first = await saveDiagram({
    dir,
    title: "Context diagram",
    mermaid: "flowchart LR\n A --> B",
    svg: "<svg/>",
    png,
  });
  assert.equal(first.index, "01");
  assert.equal(first.slug, "context-diagram");
  assert.deepEqual(
    first.files.map((file) => file.split(/[\\/]/).pop()).sort(),
    ["01-context-diagram.mmd", "01-context-diagram.png", "01-context-diagram.svg", "README.md"],
  );

  const second = await saveDiagram({
    dir,
    title: "ER diagram",
    mermaid: "erDiagram\n A ||--o{ B : id",
    svg: "<svg/>",
  });
  assert.equal(second.index, "02");

  const readme = await readFile(join(dir, "README.md"), "utf8");
  assert.match(readme, /\| 01 \| Context diagram \|/);
  assert.match(readme, /\| 02 \| ER diagram \|/);

  const manifest = await readManifest(dir);
  assert.equal(Object.keys(manifest.diagrams).length, 2);
  assert.match(summarizeManifest(manifest), /01-context-diagram/);

  const again = await saveDiagram({
    dir,
    title: "Context diagram",
    mermaid: "flowchart LR\n A --> C",
    svg: "<svg/>",
  });
  assert.equal(again.index, "01", "same slug keeps its index");
  const readme2 = await readFile(join(dir, "README.md"), "utf8");
  assert.equal((readme2.match(/\| 01 \|/g) ?? []).length, 1, "index row is replaced, not duplicated");
});

test("brain notes never keep credentials", () => {
  const redacted = redactSecrets("postgres://user:pa55@db:5432/app password=hunter2 token=abc");
  assert.equal(redacted.includes("pa55"), false);
  assert.equal(redacted.includes("hunter2"), false);
  assert.equal(redacted.includes("abc"), false);
  assert.match(redacted, /postgres:\/\/\*\*\*@db/);
});
