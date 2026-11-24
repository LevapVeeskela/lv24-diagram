import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildArchDiagram, summarizeScan } from "../src/arch/diagram.js";
import { scanArchitecture } from "../src/arch/scan.js";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lv24-diagram-arch-"));
  await writeFile(
    join(root, "docker-compose.yml"),
    `services:
  web:
    image: node:22
    ports:
      - "3000:3000"
    depends_on:
      - api
  api:
    image: node:22
  db:
    image: postgis/postgis:16-3.4
`,
    "utf8",
  );
  await mkdir(join(root, "infra", "nginx"), { recursive: true });
  await writeFile(
    join(root, "infra", "nginx", "site.conf"),
    `server {
  listen 80;
  server_name lv24.by;
  location /api/ {
    proxy_pass http://api:3000;
  }
  location / {
    proxy_pass http://web:3000;
  }
  location /unknown/ {
    proxy_pass http://ghost:9999;
  }
}
`,
    "utf8",
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "demo-app", workspaces: ["packages/*"] }),
    "utf8",
  );
  await writeFile(join(root, ".env"), "DB_PASSWORD=do-not-read\n", "utf8");
  return root;
}

test("scan finds compose services, nginx edges and packages", async () => {
  const root = await fixture();
  const scan = await scanArchitecture(root);

  const ids = scan.services.map((service) => service.id).sort();
  assert.deepEqual(ids, ["api", "db", "nginx:site.conf", "web"]);

  const db = scan.services.find((service) => service.id === "db");
  assert.equal(db?.kind, "datastore");

  const nginx = scan.services.find((service) => service.id === "nginx:site.conf");
  assert.equal(nginx?.kind, "edge");

  const proxyEdges = scan.edges.filter((edge) => edge.from === "nginx:site.conf");
  assert.deepEqual(proxyEdges.map((edge) => edge.to).sort(), ["api", "web"]);

  assert.ok(scan.edges.some((edge) => edge.from === "web" && edge.to === "api"));
  assert.ok(scan.packages.includes("demo-app"));
  assert.ok(scan.unknowns.some((unknown) => unknown.includes("ghost")));
  assert.match(summarizeScan(scan), /services: 4/);
});

test("scan never reads .env contents", async () => {
  const root = await fixture();
  const scan = await scanArchitecture(root);
  const serialized = JSON.stringify(scan);
  assert.equal(serialized.includes("do-not-read"), false);
  assert.equal(serialized.includes(".env"), false);
});

test("container diagram groups kinds and keeps edges", async () => {
  const root = await fixture();
  const scan = await scanArchitecture(root);
  const diagram = buildArchDiagram(scan, "container");
  assert.match(diagram.mermaid, /^flowchart LR/);
  assert.match(diagram.mermaid, /subgraph data_zone/);
  assert.match(diagram.mermaid, /nginx_site_conf/);
  assert.match(diagram.mermaid, /-->?\|proxy\|/);
});

test("context and deploy views render without services", async () => {
  const root = await mkdtemp(join(tmpdir(), "lv24-diagram-empty-"));
  const scan = await scanArchitecture(root);
  const context = buildArchDiagram(scan, "context");
  assert.match(context.mermaid, /User/);
  assert.ok(context.notes.some((note) => note.includes("No docker-compose")));

  const deploy = buildArchDiagram(scan, "deploy");
  assert.match(deploy.mermaid, /subgraph host/);
});
