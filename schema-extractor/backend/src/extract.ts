import { Client } from "pg";
import type {
  ExtractRequest,
  InterfaceDef,
  PgColumn,
  PgEnum,
  PgIndex,
  PgRelationship,
  PgTable,
  PgView,
  SchemaExport,
  WarningDef,
} from "./types.js";

const ACTION_MAP: Record<string, string> = {
  a: "NO ACTION",
  r: "RESTRICT",
  c: "CASCADE",
  n: "SET NULL",
  d: "SET DEFAULT",
};

const DEFAULT_SCHEMA = "public";

function normalizeType(dataType: string, udtName: string): string {
  if (dataType === "USER-DEFINED") return udtName;
  return dataType;
}

function normalizeColumns(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function classifyRelationship(
  fromColumns: string[],
  tableUniques: { name: string; columns: string[] }[],
  pkColumns: string[]
): "one_to_one" | "many_to_one" {
  const colsKey = fromColumns.join("|");
  const hasUnique = tableUniques.some((u) => u.columns.join("|") === colsKey);
  const isPk = pkColumns.join("|") === colsKey;
  if (hasUnique || isPk) return "one_to_one";
  return "many_to_one";
}

export function mapInterfaces(
  interfaces: InterfaceDef[],
  tables: PgTable[]
): { interfacesMapped: InterfaceDef[]; warnings: WarningDef[] } {
  const warnings: WarningDef[] = [];
  const interfacesMapped: InterfaceDef[] = interfaces.map((iface) => {
    const match = tables.find(
      (t) => t.name.toLowerCase() === iface.name.toLowerCase()
    );
    if (match) {
      return {
        ...iface,
        mappedTo: { table: match.name, schema: match.schema, confidence: 0.9 },
      };
    }
    warnings.push({
      type: "interface_unmapped",
      message: `Interface ${iface.name} has no matching table`,
      source: iface.source,
    });
    return { ...iface, mappedTo: null };
  });
  return { interfacesMapped, warnings };
}

export async function extractSchema(
  request: ExtractRequest,
  interfaces: InterfaceDef[] = []
): Promise<SchemaExport> {
  const includeSchemas =
    request.includeSchemas && request.includeSchemas.length > 0
      ? request.includeSchemas
      : [request.schema || DEFAULT_SCHEMA];
  const excludeTables = request.excludeTables || [];

  const allowInsecure =
    request.allowInsecureSSL || process.env.ALLOW_INSECURE_SSL === "true";
  const connectionString = (() => {
    if (!allowInsecure) return request.connectionString;
    try {
      const url = new URL(request.connectionString);
      url.searchParams.delete("sslmode");
      url.searchParams.delete("sslrootcert");
      url.searchParams.delete("sslcert");
      url.searchParams.delete("sslkey");
      return url.toString();
    } catch {
      return request.connectionString;
    }
  })();
  const client = new Client({
    connectionString,
    ssl: allowInsecure ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();

  try {
    const versionRes = await client.query("SHOW server_version");
    const version = versionRes.rows[0]?.server_version ?? null;

    const tablesRes = await client.query(
      `
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_schema = ANY($1)
        AND table_type = 'BASE TABLE'
      ORDER BY table_schema, table_name;
      `,
      [includeSchemas]
    );

    const tableRows = tablesRes.rows.filter(
      (row) => !excludeTables.includes(row.table_name)
    );

    const columnsRes = await client.query(
      `
      SELECT c.table_schema,
             c.table_name,
             c.column_name,
             c.data_type,
             c.udt_name,
             c.is_nullable,
             c.column_default,
             c.is_generated,
             pgd.description
      FROM information_schema.columns c
      LEFT JOIN pg_catalog.pg_statio_all_tables st
        ON st.schemaname = c.table_schema AND st.relname = c.table_name
      LEFT JOIN pg_catalog.pg_description pgd
        ON pgd.objoid = st.relid AND pgd.objsubid = c.ordinal_position
      WHERE c.table_schema = ANY($1)
      ORDER BY c.table_schema, c.table_name, c.ordinal_position;
      `,
      [includeSchemas]
    );

    const constraintsRes = await client.query(
      `
      SELECT n.nspname AS schema,
             c.relname AS table,
             con.conname,
             con.contype,
             array_agg(att.attname ORDER BY ord.ordinality) AS columns,
             conf.relname AS ref_table,
             rn.nspname AS ref_schema,
             array_agg(ratt.attname ORDER BY ord2.ordinality) AS ref_columns,
             con.confupdtype,
             con.confdeltype,
             pg_get_constraintdef(con.oid) AS condef
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN LATERAL unnest(con.conkey) WITH ORDINALITY ord(attnum, ordinality)
        ON true
      LEFT JOIN pg_attribute att
        ON att.attrelid = con.conrelid AND att.attnum = ord.attnum
      LEFT JOIN pg_class conf ON conf.oid = con.confrelid
      LEFT JOIN pg_namespace rn ON rn.oid = conf.relnamespace
      LEFT JOIN LATERAL unnest(con.confkey) WITH ORDINALITY ord2(attnum, ordinality)
        ON true
      LEFT JOIN pg_attribute ratt
        ON ratt.attrelid = con.confrelid AND ratt.attnum = ord2.attnum
      WHERE n.nspname = ANY($1)
      GROUP BY n.nspname, c.relname, con.conname, con.contype,
               conf.relname, rn.nspname, con.confupdtype, con.confdeltype, con.oid
      ORDER BY n.nspname, c.relname, con.conname;
      `,
      [includeSchemas]
    );

    const indexesRes = await client.query(
      `
      SELECT n.nspname AS schema,
             c.relname AS table,
             i.relname AS name,
             ix.indisunique,
             ix.indisprimary,
             am.amname AS method,
             pg_get_indexdef(ix.indexrelid) AS definition,
             array_agg(a.attname ORDER BY ord.ordinality) AS columns
      FROM pg_index ix
      JOIN pg_class c ON c.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_am am ON i.relam = am.oid
      LEFT JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY ord(attnum, ordinality)
        ON true
      LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ord.attnum
      WHERE n.nspname = ANY($1)
      GROUP BY n.nspname, c.relname, i.relname, ix.indisunique,
               ix.indisprimary, am.amname, ix.indexrelid
      ORDER BY n.nspname, c.relname, i.relname;
      `,
      [includeSchemas]
    );

    const enumsRes = await client.query(
      `
      SELECT n.nspname AS schema,
             t.typname AS name,
             array_agg(e.enumlabel ORDER BY e.enumsortorder) AS values,
             obj_description(t.oid, 'pg_type') AS comment
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = ANY($1)
      GROUP BY n.nspname, t.typname, t.oid
      ORDER BY n.nspname, t.typname;
      `,
      [includeSchemas]
    );

    const viewsRes = await client.query(
      `
      SELECT table_schema, table_name, view_definition
      FROM information_schema.views
      WHERE table_schema = ANY($1)
      ORDER BY table_schema, table_name;
      `,
      [includeSchemas]
    );

    const viewColumnsRes = await client.query(
      `
      SELECT table_schema, table_name, column_name, data_type, udt_name
      FROM information_schema.columns
      WHERE table_schema = ANY($1)
      ORDER BY table_schema, table_name, ordinal_position;
      `,
      [includeSchemas]
    );

    const tablesMap = new Map<string, PgTable>();
    for (const row of tableRows) {
      const key = `${row.table_schema}.${row.table_name}`;
      tablesMap.set(key, {
        name: row.table_name,
        schema: row.table_schema,
        comment: null,
        columns: [],
        primaryKey: null,
        uniques: [],
        checks: [],
        foreignKeys: [],
      });
    }

    for (const row of columnsRes.rows) {
      const key = `${row.table_schema}.${row.table_name}`;
      const table = tablesMap.get(key);
      if (!table) continue;
      const column: PgColumn = {
        name: row.column_name,
        type: normalizeType(row.data_type, row.udt_name),
        nullable: row.is_nullable === "YES",
        default: row.column_default ?? null,
        isPrimaryKey: false,
        isUnique: false,
        isGenerated: row.is_generated === "ALWAYS",
        comment: row.description ?? null,
      };
      table.columns.push(column);
    }

    const relationships: PgRelationship[] = [];

    for (const row of constraintsRes.rows) {
      const key = `${row.schema}.${row.table}`;
      const table = tablesMap.get(key);
      if (!table) continue;

      if (row.contype === "p") {
        const cols = normalizeColumns(row.columns);
        table.primaryKey = { name: row.conname, columns: cols };
        for (const col of table.columns) {
          if (cols.includes(col.name)) col.isPrimaryKey = true;
        }
      }

      if (row.contype === "u") {
        const cols = normalizeColumns(row.columns);
        table.uniques.push({ name: row.conname, columns: cols });
        for (const col of table.columns) {
          if (cols.includes(col.name)) col.isUnique = true;
        }
      }

      if (row.contype === "c") {
        table.checks.push({
          name: row.conname,
          expression: row.condef ?? "",
        });
      }

      if (row.contype === "f") {
        const fk = {
          name: row.conname,
          columns: normalizeColumns(row.columns),
          refTable: row.ref_table,
          refSchema: row.ref_schema,
          refColumns: normalizeColumns(row.ref_columns),
          onUpdate: ACTION_MAP[row.confupdtype] || null,
          onDelete: ACTION_MAP[row.confdeltype] || null,
        };
        table.foreignKeys.push(fk);

        const pkCols = normalizeColumns(table.primaryKey?.columns);
        const relType = classifyRelationship(
          fk.columns,
          table.uniques,
          pkCols
        );

        relationships.push({
          name: `${table.name}_${fk.refTable}`,
          type: relType,
          from: { table: table.name, schema: table.schema, columns: fk.columns },
          to: {
            table: fk.refTable,
            schema: fk.refSchema,
            columns: fk.refColumns,
          },
          fkName: fk.name,
        });
      }
    }

    const indexes: PgIndex[] = indexesRes.rows.map((row) => ({
      name: row.name,
      schema: row.schema,
      table: row.table,
      columns: row.columns || [],
      isUnique: row.indisunique,
      isPrimary: row.indisprimary,
      method: row.method ?? null,
      definition: row.definition ?? null,
    }));

    const enums: PgEnum[] = enumsRes.rows.map((row) => ({
      name: row.name,
      schema: row.schema,
      values: row.values || [],
      comment: row.comment ?? null,
    }));

    const views: PgView[] = viewsRes.rows.map((row) => ({
      name: row.table_name,
      schema: row.table_schema,
      definition: row.view_definition ?? null,
      columns: [],
    }));

    const viewsMap = new Map<string, PgView>();
    for (const v of views) viewsMap.set(`${v.schema}.${v.name}`, v);

    for (const row of viewColumnsRes.rows) {
      const key = `${row.table_schema}.${row.table_name}`;
      const view = viewsMap.get(key);
      if (!view) continue;
      view.columns.push({
        name: row.column_name,
        type: normalizeType(row.data_type, row.udt_name),
      });
    }

    const tables = Array.from(tablesMap.values());
    const { interfacesMapped, warnings } = mapInterfaces(interfaces, tables);

    const schemaExport: SchemaExport = {
      meta: {
        generatedAt: new Date().toISOString(),
        db: {
          engine: "postgres",
          version,
          host: new URL(request.connectionString).hostname,
          database: new URL(request.connectionString).pathname.replace("/", ""),
        },
        source: {
          schema: request.schema || DEFAULT_SCHEMA,
          filters: { includeSchemas, excludeTables },
        },
      },
      enums,
      tables,
      views,
      relationships,
      indexes,
      interfaces: interfacesMapped,
      warnings,
    };

    return schemaExport;
  } finally {
    await client.end();
  }
}
