import type { SchemaSnapshot, TableInfo } from "./postgres.js";

export interface ErOptions {
  /** Maximum number of entities in the diagram (default 12). */
  maxEntities?: number;
  includeColumns?: boolean;
  /** Columns rendered per entity before truncation (default 24). */
  maxColumnsPerEntity?: number;
}

export interface ErResult {
  mermaid: string;
  included: string[];
  skipped: string[];
  truncatedColumns: string[];
}

const TYPE_MAP: Record<string, string> = {
  "character varying": "varchar",
  character: "char",
  "timestamp with time zone": "timestamptz",
  "timestamp without time zone": "timestamp",
  "time with time zone": "timetz",
  "time without time zone": "time",
  "double precision": "float8",
  "real": "float4",
  "integer": "int",
  "smallint": "int2",
  "bigint": "int8",
  boolean: "bool",
  "USER-DEFINED": "text",
  "ARRAY": "array",
  "json": "json",
  "jsonb": "jsonb",
  "uuid": "uuid",
  "numeric": "numeric",
  "bytea": "bytea",
  "interval": "interval",
  "date": "date",
  "text": "text",
};

export function mermaidType(dataType: string): string {
  const lower = dataType.trim().toLowerCase();
  const mapped = TYPE_MAP[lower];
  if (mapped) return mapped;
  if (lower.endsWith("[]")) return "array";
  const token = lower.replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return token.length > 0 ? token : "text";
}

export function mermaidIdentifier(value: string): string {
  const token = value.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_");
  if (token.length === 0) return "entity";
  return /^[A-Za-z_]/.test(token) ? token : `e_${token}`;
}

function joinKeys(keys: string[]): string {
  return keys.join(", ");
}

export function buildErDiagram(snapshot: SchemaSnapshot, options: ErOptions = {}): ErResult {
  const maxEntities = Math.max(1, options.maxEntities ?? 12);
  const includeColumns = options.includeColumns !== false;
  const maxColumns = Math.max(1, options.maxColumnsPerEntity ?? 24);

  const ranked = [...snapshot.tables].sort((a: TableInfo, b: TableInfo) => {
    if (b.estimatedRows !== a.estimatedRows) return b.estimatedRows - a.estimatedRows;
    return a.name.localeCompare(b.name);
  });
  const includedTables = ranked.slice(0, maxEntities);
  const includedNames = new Set(includedTables.map((table) => table.name));
  const skipped = ranked.slice(maxEntities).map((table) => table.name);

  const fkByTable = new Map<string, Set<string>>();
  for (const fk of snapshot.foreignKeys) {
    const key = `${fk.schema}.${fk.table}`;
    const set = fkByTable.get(key) ?? new Set<string>();
    set.add(fk.column);
    fkByTable.set(key, set);
  }

  const lines: string[] = ["erDiagram"];
  const truncatedColumns: string[] = [];

  if (includeColumns) {
    for (const table of includedTables) {
      const entity = mermaidIdentifier(table.name);
      const columns = snapshot.columns
        .filter((column) => column.schema === table.schema && column.table === table.name)
        .sort((a, b) => a.position - b.position);
      const visible = columns.slice(0, maxColumns);
      if (columns.length > visible.length) truncatedColumns.push(table.name);

      lines.push(`  ${entity} {`);
      for (const column of visible) {
        const keys: string[] = [];
        if (column.isPrimaryKey) keys.push("PK");
        if (fkByTable.get(`${column.schema}.${column.table}`)?.has(column.name)) keys.push("FK");
        if (column.isUnique && !column.isPrimaryKey) keys.push("UK");
        const suffix = keys.length > 0 ? ` ${joinKeys(keys)}` : "";
        const comment = column.isNullable ? ' "null"' : "";
        lines.push(`    ${mermaidType(column.dataType)} ${mermaidIdentifier(column.name)}${suffix}${comment}`);
      }
      lines.push("  }");
    }
  }

  for (const fk of snapshot.foreignKeys) {
    if (!includedNames.has(fk.table) || !includedNames.has(fk.refTable)) continue;
    if (fk.schema !== fk.refSchema) continue;
    const column = snapshot.columns.find(
      (candidate) =>
        candidate.schema === fk.schema &&
        candidate.table === fk.table &&
        candidate.name === fk.column,
    );
    const childCardinality = column?.isUnique ? "o|" : "o{";
    lines.push(
      `  ${mermaidIdentifier(fk.refTable)} ||--${childCardinality} ${mermaidIdentifier(fk.table)} : "${fk.column}"`,
    );
  }

  return {
    mermaid: lines.join("\n"),
    included: includedTables.map((table) => table.name),
    skipped,
    truncatedColumns,
  };
}
