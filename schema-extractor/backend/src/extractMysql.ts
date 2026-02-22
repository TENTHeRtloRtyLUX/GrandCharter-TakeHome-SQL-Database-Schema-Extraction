import mysql from "mysql2/promise";
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
} from "./types.js";
import { mapInterfaces } from "./extract.js";

export async function extractMysql(
  request: ExtractRequest,
  interfaces: InterfaceDef[] = []
): Promise<SchemaExport> {
  const url = new URL(request.connectionString);
  const database = url.pathname.replace("/", "");
  const allowInsecure = request.allowInsecureSSL || process.env.ALLOW_INSECURE_SSL === "true";
  const connection = await mysql.createConnection({ uri: request.connectionString, ssl: allowInsecure ? { rejectUnauthorized: false } : undefined });

  try {
    const [tablesRows] = await connection.execute(
      `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, TABLE_COMMENT
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_TYPE='BASE TABLE'
       ORDER BY TABLE_NAME`,
      [database]
    );

    const tablesMap = new Map<string, PgTable>();
    for (const row of tablesRows as any[]) {
      const key = `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`;
      tablesMap.set(key, {
        name: row.TABLE_NAME,
        schema: row.TABLE_SCHEMA,
        comment: row.TABLE_COMMENT || null,
        columns: [],
        primaryKey: null,
        uniques: [],
        checks: [],
        foreignKeys: [],
      });
    }

    const [cols] = await connection.execute(
      `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [database]
    );
    for (const row of cols as any[]) {
      const key = `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`;
      const t = tablesMap.get(key);
      if (!t) continue;
      const col: PgColumn = {
        name: row.COLUMN_NAME,
        type: row.COLUMN_TYPE,
        nullable: row.IS_NULLABLE === "YES",
        default: row.COLUMN_DEFAULT ?? null,
        isPrimaryKey: row.COLUMN_KEY === "PRI",
        isUnique: row.COLUMN_KEY === "UNI",
        isGenerated: row.EXTRA?.includes("auto_increment"),
        comment: null,
      };
      t.columns.push(col);
    }

    const [constraints] = await connection.execute(
      `SELECT tc.TABLE_SCHEMA, tc.TABLE_NAME, tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE, GROUP_CONCAT(kcu.COLUMN_NAME ORDER BY kcu.ORDINAL_POSITION) AS cols
       FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
       JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
         ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA AND tc.TABLE_NAME = kcu.TABLE_NAME
       WHERE tc.TABLE_SCHEMA = ? AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY','UNIQUE')
       GROUP BY tc.TABLE_SCHEMA, tc.TABLE_NAME, tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE`,
      [database]
    );
    for (const row of constraints as any[]) {
      const key = `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`;
      const t = tablesMap.get(key);
      if (!t) continue;
      const colsArr = (row.cols as string).split(",");
      if (row.CONSTRAINT_TYPE === "PRIMARY KEY") {
        t.primaryKey = { name: row.CONSTRAINT_NAME, columns: colsArr };
        t.columns.forEach((c) => {
          if (colsArr.includes(c.name)) c.isPrimaryKey = true;
        });
      } else if (row.CONSTRAINT_TYPE === "UNIQUE") {
        t.uniques.push({ name: row.CONSTRAINT_NAME, columns: colsArr });
        t.columns.forEach((c) => {
          if (colsArr.includes(c.name)) c.isUnique = true;
        });
      }
    }

    const relationships: PgRelationship[] = [];
    const [fkRows] = await connection.execute(
      `SELECT kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.CONSTRAINT_NAME,
              kcu.COLUMN_NAME, kcu.REFERENCED_TABLE_SCHEMA, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME
       FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
       JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND rc.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA
       WHERE kcu.TABLE_SCHEMA = ? AND kcu.REFERENCED_TABLE_NAME IS NOT NULL`,
      [database]
    );
    for (const row of fkRows as any[]) {
      const key = `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`;
      const t = tablesMap.get(key);
      if (!t) continue;
      const fk = {
        name: row.CONSTRAINT_NAME,
        columns: [row.COLUMN_NAME],
        refTable: row.REFERENCED_TABLE_NAME,
        refSchema: row.REFERENCED_TABLE_SCHEMA,
        refColumns: [row.REFERENCED_COLUMN_NAME],
        onUpdate: null,
        onDelete: null,
      };
      t.foreignKeys.push(fk);
      relationships.push({
        name: `${t.name}_${fk.refTable}`,
        type: "many_to_one",
        from: { table: t.name, schema: t.schema, columns: fk.columns },
        to: { table: fk.refTable, schema: fk.refSchema, columns: fk.refColumns },
        fkName: fk.name,
      });
    }

    const [idxRows] = await connection.execute(
      `SELECT TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, NON_UNIQUE, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
       FROM INFORMATION_SCHEMA.STATISTICS
       WHERE TABLE_SCHEMA = ?
       GROUP BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, NON_UNIQUE`,
      [database]
    );
    const indexes: PgIndex[] = (idxRows as any[]).map((r) => ({
      name: r.INDEX_NAME,
      schema: r.TABLE_SCHEMA,
      table: r.TABLE_NAME,
      columns: r.cols ? r.cols.split(",") : [],
      isUnique: r.NON_UNIQUE === 0,
      isPrimary: r.INDEX_NAME === "PRIMARY",
      method: null,
      definition: null,
    }));

    // MySQL enums: columns where DATA_TYPE='enum'
    const enums: PgEnum[] = [];
    const [enumRows] = await connection.execute(
      `SELECT TABLE_SCHEMA, COLUMN_NAME, COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND DATA_TYPE='enum'`,
      [database]
    );
    for (const row of enumRows as any[]) {
      const values = (row.COLUMN_TYPE as string)
        .replace(/^enum\(/i, "")
        .replace(/\)$/, "")
        .split(/,(?=(?:[^']*'[^']*')*[^']*$)/)
        .map((v) => v.trim().replace(/^'/, "").replace(/'$/, ""));
      enums.push({ name: row.COLUMN_NAME, schema: row.TABLE_SCHEMA, values, comment: null });
    }

    const views: PgView[] = [];

    const tables = Array.from(tablesMap.values());
    const { interfacesMapped, warnings } = mapInterfaces(interfaces, tables);

    const schemaExport: SchemaExport = {
      meta: {
        generatedAt: new Date().toISOString(),
        db: {
          engine: "mysql",
          version: null,
          host: url.hostname,
          database: database,
        },
        source: {
          schema: database,
          filters: { includeSchemas: [database], excludeTables: [] },
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
    await connection.end();
  }
}
