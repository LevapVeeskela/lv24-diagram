import pg from "pg";

import type { DatabaseConfig } from "../config.js";

export type TableKind = "table" | "partitioned" | "view" | "matview";

export interface TableInfo {
  schema: string;
  name: string;
  kind: TableKind;
  estimatedRows: number;
}

export interface ColumnInfo {
  schema: string;
  table: string;
  name: string;
  dataType: string;
  isNullable: boolean;
  isPrimaryKey: boolean;
  isUnique: boolean;
  defaultExpression?: string;
  position: number;
}

export interface ForeignKeyInfo {
  schema: string;
  table: string;
  column: string;
  refSchema: string;
  refTable: string;
  refColumn: string;
  constraintName: string;
}

export interface SchemaSnapshot {
  tables: TableInfo[];
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

const FORBIDDEN = new RegExp(
  "\\b(insert|update|delete|merge|drop|alter|truncate|create|grant|revoke|copy|call|do|vacuum|analyze|comment|security|reindex|cluster|refresh)\\b",
  "i",
);

function stripLiterals(sql: string): string {
  return sql
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""')
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "$$$$");
}

/** Guardrail, not a permission boundary: the DB user must still be read-only. */
export function assertReadOnlyQuery(sql: string): string {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (trimmed.length === 0) throw new Error("SQL is empty");
  const withoutLiterals = stripLiterals(trimmed);
  if (withoutLiterals.includes(";")) throw new Error("Only one statement is allowed");
  if (!/^(select|with)\b/i.test(trimmed)) {
    throw new Error("Only SELECT / WITH queries are allowed");
  }
  if (FORBIDDEN.test(withoutLiterals)) {
    throw new Error("Query contains a write/DDL keyword and was rejected");
  }
  return trimmed;
}

export class PostgresIntrospector {
  #client?: pg.Client;

  constructor(private readonly config: DatabaseConfig) {}

  async #connect(): Promise<pg.Client> {
    if (this.#client) return this.#client;
    const client = new pg.Client({
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
      ssl: this.config.ssl,
      application_name: "lv24-diagram",
      connectionTimeoutMillis: 10_000,
    });
    await client.connect();
    await client.query("set session characteristics as transaction read only");
    await client.query(`set statement_timeout = ${Math.max(1, Math.floor(this.config.statementTimeoutMs))}`);
    this.#client = client;
    return client;
  }

  async tables(pattern?: string): Promise<TableInfo[]> {
    const client = await this.#connect();
    const { rows } = await client.query<{
      schema: string;
      name: string;
      kind: TableKind;
      estimated_rows: string;
    }>(
      `select n.nspname as schema,
              c.relname as name,
              case c.relkind when 'r' then 'table' when 'p' then 'partitioned'
                             when 'v' then 'view'  when 'm' then 'matview' end as kind,
              greatest(c.reltuples, 0)::bigint as estimated_rows
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r','p','v','m')
          and n.nspname = any($1::text[])
          and ($2::text is null or c.relname like $2)
        order by n.nspname, c.relname`,
      [this.config.schemas, pattern ?? null],
    );
    return rows.map((row) => ({
      schema: row.schema,
      name: row.name,
      kind: row.kind,
      estimatedRows: Number(row.estimated_rows),
    }));
  }

  async columns(tables: string[]): Promise<ColumnInfo[]> {
    if (tables.length === 0) return [];
    const client = await this.#connect();
    const { rows } = await client.query<{
      schema: string;
      table: string;
      name: string;
      data_type: string;
      is_nullable: boolean;
      column_default: string | null;
      position: number;
      is_primary_key: boolean;
      is_unique: boolean;
    }>(
      `with pk as (
         select ns.nspname as schema, rel.relname as table, att.attname as column
           from pg_constraint con
           join pg_class rel on rel.oid = con.conrelid
           join pg_namespace ns on ns.oid = rel.relnamespace
           join unnest(con.conkey) as k(attnum) on true
           join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
          where con.contype = 'p' and ns.nspname = any($1::text[])
       ), uq as (
         select ns.nspname as schema, rel.relname as table, att.attname as column
           from pg_index i
           join pg_class rel on rel.oid = i.indrelid
           join pg_namespace ns on ns.oid = rel.relnamespace
           join pg_attribute att on att.attrelid = i.indrelid and att.attnum = i.indkey[0]
          where i.indisunique and i.indnkeyatts = 1 and ns.nspname = any($1::text[])
       )
       select c.table_schema as schema,
              c.table_name as table,
              c.column_name as name,
              c.data_type,
              (c.is_nullable = 'YES') as is_nullable,
              c.column_default,
              c.ordinal_position as position,
              (pk.column is not null) as is_primary_key,
              (uq.column is not null) as is_unique
         from information_schema.columns c
         left join pk on pk.schema = c.table_schema and pk.table = c.table_name and pk.column = c.column_name
         left join uq on uq.schema = c.table_schema and uq.table = c.table_name and uq.column = c.column_name
        where c.table_schema = any($1::text[])
          and c.table_name = any($2::text[])
        order by c.table_schema, c.table_name, c.ordinal_position`,
      [this.config.schemas, tables],
    );
    return rows.map((row) => ({
      schema: row.schema,
      table: row.table,
      name: row.name,
      dataType: row.data_type,
      isNullable: row.is_nullable,
      isPrimaryKey: row.is_primary_key,
      isUnique: row.is_unique,
      ...(row.column_default ? { defaultExpression: row.column_default } : {}),
      position: row.position,
    }));
  }

  async foreignKeys(tables?: string[]): Promise<ForeignKeyInfo[]> {
    const client = await this.#connect();
    const { rows } = await client.query<{
      schema: string;
      table: string;
      column: string;
      ref_schema: string;
      ref_table: string;
      ref_column: string;
      constraint_name: string;
    }>(
      `select ns.nspname as schema,
              rel.relname as table,
              att.attname as column,
              fns.nspname as ref_schema,
              frel.relname as ref_table,
              fatt.attname as ref_column,
              con.conname as constraint_name
         from pg_constraint con
         join pg_class rel on rel.oid = con.conrelid
         join pg_namespace ns on ns.oid = rel.relnamespace
         join pg_class frel on frel.oid = con.confrelid
         join pg_namespace fns on fns.oid = frel.relnamespace
         join lateral unnest(con.conkey, con.confkey) as k(attnum, fattnum) on true
         join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
         join pg_attribute fatt on fatt.attrelid = con.confrelid and fatt.attnum = k.fattnum
        where con.contype = 'f'
          and ns.nspname = any($1::text[])
          and ($2::text[] is null or rel.relname = any($2::text[]))
        order by ns.nspname, rel.relname, con.conname`,
      [this.config.schemas, tables && tables.length > 0 ? tables : null],
    );
    return rows.map((row) => ({
      schema: row.schema,
      table: row.table,
      column: row.column,
      refSchema: row.ref_schema,
      refTable: row.ref_table,
      refColumn: row.ref_column,
      constraintName: row.constraint_name,
    }));
  }

  async snapshot(tables: string[]): Promise<SchemaSnapshot> {
    const [columns, foreignKeys] = await Promise.all([
      this.columns(tables),
      this.foreignKeys(tables),
    ]);
    const known = new Set(tables);
    const all = await this.tables();
    return {
      tables: all.filter((table) => known.has(table.name)),
      columns,
      foreignKeys,
    };
  }

  async query(sql: string): Promise<QueryResult> {
    const statement = assertReadOnlyQuery(sql);
    const client = await this.#connect();
    const limit = Math.max(1, Math.floor(this.config.maxRows));
    const result = await client.query<Record<string, unknown>>({
      text: `select * from (${statement}) as lv24_query limit $1`,
      values: [limit + 1],
    });
    const rows = result.rows;
    const fields = result.fields;
    const truncated = rows.length > limit;
    const visible = truncated ? rows.slice(0, limit) : rows;
    return {
      columns: fields.map((field) => field.name),
      rows: visible as Record<string, unknown>[],
      rowCount: visible.length,
      truncated,
    };
  }

  async close(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    if (client) await client.end().catch(() => undefined);
  }
}
