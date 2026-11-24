import { basename } from "node:path";

import type { ArchEdge, ArchScan, ArchService } from "./scan.js";

export type ArchView = "container" | "context" | "deploy";

export interface ArchDiagram {
  mermaid: string;
  notes: string[];
}

const MAX_CONTAINER_NODES = 20;

function mermaidId(value: string): string {
  const token = value.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_");
  return /^[A-Za-z_]/.test(token) ? token : `n_${token}`;
}

function uniqueIdFactory(): (value: string) => string {
  const used = new Set<string>();
  return (value: string) => {
    const base = mermaidId(value);
    if (!used.has(base)) {
      used.add(base);
      return base;
    }
    let index = 2;
    while (used.has(`${base}_${index}`)) index += 1;
    const id = `${base}_${index}`;
    used.add(id);
    return id;
  };
}

function portLabel(service: ArchService): string {
  const first = service.ports[0];
  if (!first) return "";
  const match = /(\d{2,5})/.exec(first);
  return match?.[1] ? ` :${match[1]}` : "";
}

function esc(value: string): string {
  return value.replace(/"/g, "'");
}

function buildContainer(scan: ArchScan, notes: string[]): string {
  const services = scan.services;
  const collapse = services.filter((service) => service.kind === "service");
  const keep = services.filter((service) => service.kind !== "service");
  const tooMany = services.length > MAX_CONTAINER_NODES;

  const nextId = uniqueIdFactory();
  const idByService = new Map<string, string>();
  const lines: string[] = ["flowchart LR"];

  const edgeNodes = keep.filter((service) => service.kind === "edge");
  const dataNodes = keep.filter((service) => service.kind === "datastore");
  const appNodes = tooMany ? [] : collapse;

  if (edgeNodes.length > 0) {
    lines.push('  subgraph edge_zone["Edge"]');
    for (const service of edgeNodes) {
      const id = nextId(service.id);
      idByService.set(service.id, id);
      lines.push(`    ${id}["${esc(service.label + portLabel(service))}"]`);
    }
    lines.push("  end");
  }

  if (appNodes.length > 0) {
    lines.push('  subgraph app_zone["Services"]');
    for (const service of appNodes) {
      const id = nextId(service.id);
      idByService.set(service.id, id);
      lines.push(`    ${id}["${esc(service.label + portLabel(service))}"]`);
    }
    lines.push("  end");
  }

  if (tooMany) {
    const id = "services_collapsed";
    lines.push(`  ${id}["${collapse.length} services"]`);
    for (const service of collapse) idByService.set(service.id, id);
    notes.push(
      `${collapse.length} services collapsed into one node (container budget ${MAX_CONTAINER_NODES}); use view="deploy" or filter the scan.`,
    );
  }

  if (dataNodes.length > 0) {
    lines.push('  subgraph data_zone["Data"]');
    for (const service of dataNodes) {
      const id = nextId(service.id);
      idByService.set(service.id, id);
      lines.push(`    ${id}[("${esc(service.label)}")]`);
    }
    lines.push("  end");
  }

  const seen = new Set<string>();
  for (const edge of scan.edges) {
    const from = idByService.get(edge.from);
    const to = idByService.get(edge.to);
    if (!from || !to || from === to) continue;
    const key = `${from}->${to}:${edge.label ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`  ${from} -->${edge.label ? `|${edge.label}|` : ""} ${to}`);
  }

  return lines.join("\n");
}

function buildContext(scan: ArchScan, notes: string[]): string {
  const name = basename(scan.root) || "System";
  const datastores = scan.services.filter((service) => service.kind === "datastore");
  const edges = scan.services.filter((service) => service.kind === "edge");
  const lines: string[] = ["flowchart LR", "  User([User])"];
  lines.push(`  System["${esc(name)}"]`);
  lines.push("  User -->|HTTPS| System");

  if (edges.length > 0) {
    lines.push(`  System -->|"${edges.length} edge nodes"| EdgeZone["Edge layer"]`);
  }
  if (datastores.length > 0) {
    lines.push('  subgraph storage["Storage"]');
    for (const store of datastores) {
      lines.push(`    ${mermaidId(store.id)}[("${esc(store.label)}")]`);
    }
    lines.push("  end");
    lines.push("  System --> storage");
  }
  if (scan.services.length === 0) {
    notes.push("No services were detected, so the context diagram contains only the system node.");
  }
  return lines.join("\n");
}

function buildDeploy(scan: ArchScan, notes: string[]): string {
  const nextId = uniqueIdFactory();
  const lines: string[] = ["flowchart TB", '  subgraph host["Host"]'];
  const idByService = new Map<string, string>();
  for (const service of scan.services) {
    const id = nextId(service.id);
    idByService.set(service.id, id);
    const ports = service.ports.length > 0 ? ` ${service.ports.join(",")}` : "";
    lines.push(`    ${id}["${esc(service.label + ports)}"]`);
  }
  lines.push("  end");

  const seen = new Set<string>();
  for (const edge of scan.edges) {
    const from = idByService.get(edge.from);
    const to = idByService.get(edge.to);
    if (!from || !to || from === to) continue;
    const key = `${from}->${to}:${edge.label ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`  ${from} -.->${edge.label ? `|${edge.label}|` : ""} ${to}`);
  }
  if (scan.services.length > 25) {
    notes.push("Deploy view is dense; consider splitting by host or network.");
  }
  return lines.join("\n");
}

export function buildArchDiagram(scan: ArchScan, view: ArchView = "container"): ArchDiagram {
  const notes: string[] = [];
  let mermaid: string;
  switch (view) {
    case "context":
      mermaid = buildContext(scan, notes);
      break;
    case "deploy":
      mermaid = buildDeploy(scan, notes);
      break;
    default:
      mermaid = buildContainer(scan, notes);
      break;
  }
  if (scan.unknowns.length > 0) notes.push(...scan.unknowns);
  return { mermaid, notes };
}

export function summarizeScan(scan: ArchScan): string {
  const counts = { edge: 0, service: 0, datastore: 0 };
  for (const service of scan.services) counts[service.kind] += 1;
  const edgeCount = countEdges(scan.edges);
  return [
    `services: ${scan.services.length} (edge ${counts.edge}, app ${counts.service}, data ${counts.datastore})`,
    `edges: ${edgeCount}`,
    `sources: ${scan.sources.length}`,
    `unknowns: ${scan.unknowns.length}`,
  ].join(" · ");
}

function countEdges(edges: ArchEdge[]): number {
  return edges.length;
}
