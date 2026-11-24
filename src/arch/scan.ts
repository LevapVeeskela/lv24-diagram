import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";

import { parse as parseYaml } from "yaml";

export type ServiceKind = "edge" | "service" | "datastore";

export interface ArchService {
  id: string;
  label: string;
  kind: ServiceKind;
  image?: string;
  ports: string[];
  composeFile?: string;
}

export interface ArchEdge {
  from: string;
  to: string;
  label?: string;
}

export interface ArchScan {
  root: string;
  services: ArchService[];
  edges: ArchEdge[];
  packages: string[];
  unknowns: string[];
  sources: string[];
}

export interface ScanOptions {
  maxFiles?: number;
  signal?: AbortSignal;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  "tmp",
  "temp",
  "vendor",
  "target",
  "bin",
  "obj",
  ".venv",
  "venv",
  "__pycache__",
  ".idea",
  ".vscode",
  "artifacts",
  "logs",
]);

const COMPOSE_PATTERN = /^docker-compose.*\.ya?ml$/i;
const NGINX_PATTERN = /\.conf$/i;
const MAX_FILE_BYTES = 1_000_000;

interface WalkResult {
  compose: string[];
  nginx: string[];
  packages: string[];
  others: string[];
  visited: number;
}

async function walk(
  root: string,
  options: ScanOptions,
): Promise<WalkResult> {
  const maxFiles = Math.max(50, options.maxFiles ?? 4000);
  const result: WalkResult = { compose: [], nginx: [], packages: [], others: [], visited: 0 };
  const queue: string[] = [root];

  while (queue.length > 0) {
    if (options.signal?.aborted) break;
    const dir = queue.shift();
    if (!dir) break;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (result.visited >= maxFiles) return result;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Hidden directories (.git, .runtime, .cache, ...) are state, not architecture.
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.startsWith(".")) continue;
      result.visited += 1;
      if (COMPOSE_PATTERN.test(entry.name)) result.compose.push(full);
      else if (NGINX_PATTERN.test(entry.name)) result.nginx.push(full);
      else if (entry.name === "package.json") result.packages.push(full);
      else if (entry.name === "Dockerfile" || entry.name.startsWith("Dockerfile.")) {
        result.others.push(full);
      }
    }
  }
  return result;
}

function classify(image: string | undefined): ServiceKind {
  const value = (image ?? "").toLowerCase();
  if (/(nginx|traefik|caddy|haproxy|envoy)/.test(value)) return "edge";
  if (/(postgres|postgis|mysql|mariadb|mongo|redis|clickhouse|minio|elasticsearch|opensearch|rabbitmq|kafka|memcached)/.test(value)) {
    return "datastore";
  }
  return "service";
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === "string") return [value];
  return [];
}

interface ComposeService {
  image?: string;
  containerName?: string;
  ports: string[];
  dependsOn: string[];
}

function readComposeServices(document: unknown): Map<string, ComposeService> {
  const services = new Map<string, ComposeService>();
  if (!document || typeof document !== "object") return services;
  const root = document as Record<string, unknown>;
  const raw = root.services;
  if (!raw || typeof raw !== "object") return services;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const service = (value ?? {}) as Record<string, unknown>;
    const dependsRaw = service.depends_on;
    const dependsOn = Array.isArray(dependsRaw)
      ? dependsRaw.map(String)
      : dependsRaw && typeof dependsRaw === "object"
        ? Object.keys(dependsRaw as Record<string, unknown>)
        : [];
    services.set(name, {
      ...(typeof service.image === "string" ? { image: service.image } : {}),
      ...(typeof service.container_name === "string"
        ? { containerName: service.container_name }
        : {}),
      ports: asStringArray(service.ports),
      dependsOn,
    });
  }
  return services;
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/[^a-z0-9]/g, "");
}

interface NginxInfo {
  serverNames: string[];
  /** Resolved upstream hosts (variables and `upstream` blocks expanded). */
  targets: string[];
  /** Names that could not be resolved (missing variable / upstream). */
  unresolved: string[];
  /** True when the file actually routes traffic; fragments (limit_req etc.) are not nodes. */
  routes: boolean;
}

function stripPort(host: string): string {
  return host.replace(/:\d+$/, "");
}

function nginxInfo(text: string): NginxInfo {
  const vars = new Map<string, string>();
  const upstreams = new Map<string, string[]>();
  const serverNames: string[] = [];
  const targets: string[] = [];
  const unresolved: string[] = [];
  let currentUpstream: string | undefined;
  let routes = false;

  const expand = (raw: string, seen: Set<string>): void => {
    const withoutScheme = raw.replace(/^https?:\/\//i, "").replace(/^["']|["']$/g, "");
    const hostToken = withoutScheme.split("/")[0]?.split(";")[0]?.trim() ?? "";
    if (!hostToken) return;
    if (hostToken.startsWith("$")) {
      const name = hostToken.slice(1).replace(/:\d+$/, "");
      if (seen.has(name)) return;
      seen.add(name);
      const value = vars.get(name);
      if (value) expand(value, seen);
      else unresolved.push(`$${name}`);
      return;
    }
    const host = stripPort(hostToken);
    const servers = upstreams.get(host);
    if (servers && servers.length > 0) {
      for (const server of servers) targets.push(stripPort(server));
      return;
    }
    targets.push(host);
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = (rawLine.split("#")[0] ?? "").trim();
    if (line.length === 0) continue;

    const set = /^set\s+\$([A-Za-z0-9_]+)\s+(.+);$/.exec(line);
    if (set?.[1] && set[2]) {
      vars.set(set[1], set[2].trim());
      continue;
    }

    const upstreamOpen = /^upstream\s+([A-Za-z0-9_.-]+)\s*\{/.exec(line);
    if (upstreamOpen?.[1]) {
      routes = true;
      currentUpstream = upstreamOpen[1];
      if (!upstreams.has(currentUpstream)) upstreams.set(currentUpstream, []);
      continue;
    }

    if (currentUpstream) {
      if (line.startsWith("}")) {
        currentUpstream = undefined;
        continue;
      }
      const server = /^server\s+([^;\s]+)/.exec(line);
      if (server?.[1] && !server[1].startsWith("$")) {
        upstreams.get(currentUpstream)?.push(server[1]);
      }
      continue;
    }

    const serverName = /^server_name\s+([^;]+);/.exec(line);
    if (serverName?.[1]) {
      routes = true;
      serverNames.push(
        ...serverName[1]
          .split(/\s+/)
          .map((item) => item.trim())
          .filter(Boolean),
      );
      continue;
    }

    const proxy = /^proxy_pass\s+([^;]+);/.exec(line);
    if (proxy?.[1]) {
      routes = true;
      expand(proxy[1], new Set<string>());
    }
  }

  return { serverNames, targets: [...new Set(targets)], unresolved: [...new Set(unresolved)], routes: routes || targets.length > 0 };
}

export async function scanArchitecture(
  root: string,
  options: ScanOptions = {},
): Promise<ArchScan> {
  const files = await walk(root, options);
  const unknowns: string[] = [];
  const sources: string[] = [];
  const services = new Map<string, ArchService>();
  const edges: ArchEdge[] = [];

  for (const file of files.compose) {
    let document: unknown;
    try {
      const text = await readFile(file, "utf8");
      // Docker Compose merge tags (!override / !reset) are irrelevant for topology
      // extraction and break plain YAML parsers.
      const sanitized = text.replace(/!override\b/g, "").replace(/!reset\b/g, "");
      document = parseYaml(sanitized);
    } catch (error) {
      unknowns.push(
        `Cannot parse ${relative(root, file)}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    sources.push(relative(root, file));
    const parsed = readComposeServices(document);
    for (const [name, service] of parsed) {
      const existing = services.get(name);
      if (existing) continue;
      services.set(name, {
        id: name,
        label: name,
        kind: classify(service.image),
        ...(service.image ? { image: service.image } : {}),
        ports: service.ports,
        composeFile: relative(root, file),
      });
      for (const dependency of service.dependsOn) {
        edges.push({ from: name, to: dependency, label: "depends" });
      }
    }
  }

  if (files.compose.length === 0) {
    unknowns.push("No docker-compose*.yml found; deployment topology is unknown.");
  }

  const byNormalized = new Map<string, string>();
  for (const [id, service] of services) {
    byNormalized.set(normalizeHost(id), id);
    const container = service.label;
    byNormalized.set(normalizeHost(container), id);
  }

  const edgeNodes = new Map<string, string>();
  for (const file of files.nginx) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    if (text.length > MAX_FILE_BYTES) continue;
    sources.push(relative(root, file));
    const { serverNames, targets, unresolved, routes } = nginxInfo(text);
    if (!routes) continue;
    for (const name of unresolved) {
      unknowns.push(`nginx variable "${name}" (${relative(root, file)}) has no set/upstream definition.`);
    }
    const nodeId = `nginx:${basename(file)}`;
    if (!edgeNodes.has(nodeId)) {
      edgeNodes.set(nodeId, nodeId);
      services.set(nodeId, {
        id: nodeId,
        label: serverNames[0] ?? basename(file),
        kind: "edge",
        ports: ["80", "443"],
      });
    }
    for (const target of targets) {
      const resolved = byNormalized.get(normalizeHost(target));
      if (resolved) {
        edges.push({ from: nodeId, to: resolved, label: "proxy" });
      } else if (!target.includes(".") || target.endsWith(".internal")) {
        unknowns.push(`nginx target "${target}" (${relative(root, file)}) is not a known compose service.`);
      }
    }
  }

  const packages: string[] = [];
  for (const file of files.packages) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as {
        name?: string;
        workspaces?: unknown;
      };
      if (parsed.name) packages.push(parsed.name);
      const workspaces = Array.isArray(parsed.workspaces)
        ? parsed.workspaces
        : parsed.workspaces && typeof parsed.workspaces === "object"
          ? ((parsed.workspaces as { packages?: unknown }).packages as unknown)
          : undefined;
      if (Array.isArray(workspaces)) {
        for (const workspace of workspaces) packages.push(String(workspace));
      }
    } catch {
      // package.json that is not JSON is not worth failing the scan over.
    }
  }

  const knownIds = new Set(services.keys());
  const dangling = edges.filter((edge) => !knownIds.has(edge.to));
  for (const edge of dangling) {
    unknowns.push(`"${edge.from}" depends on "${edge.to}", which is not defined in the scanned compose files.`);
  }

  return {
    root,
    services: [...services.values()],
    edges: edges.filter((edge) => knownIds.has(edge.to)),
    packages: [...new Set(packages)],
    unknowns: [...new Set(unknowns)],
    sources,
  };
}
