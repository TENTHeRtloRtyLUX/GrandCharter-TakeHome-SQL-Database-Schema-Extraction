export type SchemaExport = {
  meta: {
    generatedAt: string;
    db: {
      engine: "postgres";
      version: string | null;
      host: string;
      database: string;
    };
    source: {
      schema: string;
      filters: {
        includeSchemas: string[];
        excludeTables: string[];
      };
    };
  };
  enums: PgEnum[];
  tables: PgTable[];
  views: PgView[];
  relationships: PgRelationship[];
  indexes: PgIndex[];
  interfaces: InterfaceDef[];
  warnings: WarningDef[];
};

export type PgEnum = {
  name: string;
  schema: string;
  values: string[];
  comment: string | null;
};

export type PgColumn = {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  isPrimaryKey: boolean;
  isUnique: boolean;
  isGenerated: boolean;
  comment: string | null;
};

export type PgForeignKey = {
  name: string;
  columns: string[];
  refTable: string;
  refSchema: string;
  refColumns: string[];
  onUpdate: string | null;
  onDelete: string | null;
};

export type PgTable = {
  name: string;
  schema: string;
  comment: string | null;
  columns: PgColumn[];
  primaryKey: { name: string; columns: string[] } | null;
  uniques: { name: string; columns: string[] }[];
  checks: { name: string; expression: string }[];
  foreignKeys: PgForeignKey[];
};

export type PgView = {
  name: string;
  schema: string;
  definition: string | null;
  columns: { name: string; type: string }[];
};

export type PgRelationship = {
  name: string;
  type: "one_to_one" | "one_to_many" | "many_to_one" | "many_to_many";
  from: { table: string; schema: string; columns: string[] };
  to: { table: string; schema: string; columns: string[] };
  fkName: string;
};

export type PgIndex = {
  name: string;
  schema: string;
  table: string;
  columns: string[];
  isUnique: boolean;
  isPrimary: boolean;
  method: string | null;
  definition: string | null;
};

export type InterfaceDef = {
  name: string;
  source: string;
  fields: { name: string; type: string; nullable: boolean }[];
  mappedTo: { table: string; schema: string; confidence: number } | null;
};

export type WarningDef = {
  type: string;
  message: string;
  source?: string;
};

export type ExtractRequest = {
  connectionString: string;
  schema?: string;
  includeSchemas?: string[];
  excludeTables?: string[];
  allowInsecureSSL?: boolean;
};

export type InterfacesImport = {
  interfaces: InterfaceDef[];
};
