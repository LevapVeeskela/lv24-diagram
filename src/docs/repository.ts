import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya",
};

export function slugify(value: string): string {
  const transliterated = value
    .toLowerCase()
    .split("")
    .map((char) => TRANSLIT[char] ?? char)
    .join("");
  return (
    transliterated
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "diagram"
  );
}

export function contentHash(mermaid: string): string {
  return createHash("sha256").update(mermaid.trim()).digest("hex").slice(0, 16);
}

export interface DiagramManifestEntry {
  index: string;
  title: string;
  slug: string;
  hash: string;
  updatedAt: string;
  png?: boolean;
  svg?: boolean;
}

export interface BrainLink {
  publishedHash?: string;
  noteId?: string;
  publishedAt?: string;
  project?: string;
}

export interface DiagramManifest {
  version: 1;
  diagrams: Record<string, DiagramManifestEntry>;
  brain?: BrainLink;
}

const MANIFEST_FILE = ".diagrams.json";

export async function readManifest(dir: string): Promise<DiagramManifest> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, MANIFEST_FILE), "utf8")) as DiagramManifest;
    if (parsed && parsed.version === 1 && parsed.diagrams) return parsed;
  } catch {
    // Missing or broken manifest is not fatal: the directory scan below is authoritative.
  }
  return { version: 1, diagrams: {} };
}

export async function writeManifest(dir: string, manifest: DiagramManifest): Promise<void> {
  await writeFile(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function nextIndex(dir: string): Promise<string> {
  let max = 0;
  try {
    for (const name of await readdir(dir)) {
      const match = /^(\d{2})-/.exec(name);
      if (match?.[1]) max = Math.max(max, Number(match[1]));
    }
  } catch {
    // Directory does not exist yet.
  }
  return String(max + 1).padStart(2, "0");
}

export interface SaveDiagramInput {
  dir: string;
  title: string;
  mermaid: string;
  png?: Buffer;
  svg?: string;
  source?: string;
  forceIndex?: string;
}

export interface SaveDiagramResult {
  index: string;
  slug: string;
  files: string[];
  hash: string;
  readme: string;
}

function readmeRow(entry: DiagramManifestEntry): string {
  const files = [`[.mmd](${entry.index}-${entry.slug}.mmd)`];
  if (entry.svg) files.push(`[.svg](${entry.index}-${entry.slug}.svg)`);
  if (entry.png) files.push(`[.png](${entry.index}-${entry.slug}.png)`);
  return `| ${entry.index} | ${entry.title} | ${files.join(" ")} | ${entry.updatedAt} |`;
}

function mergeReadme(existing: string, entry: DiagramManifestEntry): string {
  const header = ["# Architecture diagrams", "", "| № | Схема | Файлы | Обновлено |", "|---|-------|-------|-----------|"];
  const rows = new Map<string, string>();
  for (const line of existing.split(/\r?\n/)) {
    const match = /^\|\s*(\d{2})\s*\|/.exec(line);
    if (match?.[1]) rows.set(match[1], line);
  }
  rows.set(entry.index, readmeRow(entry));
  const body = [...rows.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, line]) => line);
  return [...header, ...body, ""].join("\n");
}

export async function saveDiagram(input: SaveDiagramInput): Promise<SaveDiagramResult> {
  await mkdir(input.dir, { recursive: true });
  const manifest = await readManifest(input.dir);
  const slug = slugify(input.title);
  const existing = Object.values(manifest.diagrams).find((entry) => entry.slug === slug);
  const index = input.forceIndex ?? existing?.index ?? (await nextIndex(input.dir));
  const base = `${index}-${slug}`;
  const hash = contentHash(input.mermaid);
  const updatedAt = new Date().toISOString().slice(0, 10);

  const files: string[] = [];
  const mmdPath = join(input.dir, `${base}.mmd`);
  await writeFile(mmdPath, `${input.mermaid.trim()}\n`, "utf8");
  files.push(mmdPath);

  if (input.png) {
    const pngPath = join(input.dir, `${base}.png`);
    await writeFile(pngPath, input.png);
    files.push(pngPath);
  }
  if (input.svg) {
    const svgPath = join(input.dir, `${base}.svg`);
    await writeFile(svgPath, input.svg, "utf8");
    files.push(svgPath);
  }

  const entry: DiagramManifestEntry = {
    index,
    title: input.title,
    slug,
    hash,
    updatedAt,
    ...(input.png ? { png: true } : {}),
    ...(input.svg ? { svg: true } : {}),
  };
  manifest.diagrams[slug] = entry;
  await writeManifest(input.dir, manifest);

  const readmePath = join(input.dir, "README.md");
  let existingReadme = "";
  try {
    existingReadme = await readFile(readmePath, "utf8");
  } catch {
    existingReadme = "";
  }
  const readme = mergeReadme(existingReadme, entry);
  await writeFile(readmePath, readme, "utf8");
  files.push(readmePath);

  return { index, slug, files, hash, readme };
}

export function summarizeManifest(manifest: DiagramManifest): string {
  const entries = Object.values(manifest.diagrams).sort((a, b) => a.index.localeCompare(b.index));
  if (entries.length === 0) return "no diagrams recorded";
  return entries.map((entry) => `${entry.index}-${entry.slug} (${entry.hash})`).join(", ");
}
