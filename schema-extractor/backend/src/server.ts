import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fs from "node:fs";
import crypto from "node:crypto";
import { z } from "zod";
import { Client } from "pg";
import { extractSchema, mapInterfaces } from "./extract.js";
import { extractMysql } from "./extractMysql.js";
import { scanInterfacesFromZip } from "./scan.js";
import type { InterfaceDef, SchemaExport } from "./types.js";
import { diffSchemas } from "./snapshotDiff.js";

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await app.register(multipart, {
  limits: { fileSize: 20 * 1024 * 1024 },
});

app.setErrorHandler((err, _req, reply) => {
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  reply.code(status).send({
    error: err.message || "Internal error",
  });
});

const ExtractSchema = z.object({
  connectionString: z.string().min(1),
  schema: z.string().optional(),
  includeSchemas: z.array(z.string()).optional(),
  excludeTables: z.array(z.string()).optional(),
  allowInsecureSSL: z.boolean().optional(),
});

const InterfacesImportSchema = z.object({
  snapshotId: z.string().min(1),
  interfaces: z.array(
    z.object({
      name: z.string(),
      source: z.string(),
      fields: z.array(
        z.object({
          name: z.string(),
          type: z.string(),
          nullable: z.boolean(),
        })
      ),
      mappedTo: z
        .object({
          table: z.string(),
          schema: z.string(),
          confidence: z.number(),
        })
        .nullable()
        .optional(),
    })
  ),
});

const TextToSqlSchema = z.object({
  connectionString: z.string().min(1),
  sql: z.string().min(1),
  limit: z.number().min(1).max(1000).optional(),
  allowInsecureSSL: z.boolean().optional(),
});

const snapshots = new Map<string, SchemaExport>();
const SNAPSHOT_FILE = new URL("./snapshots.json", import.meta.url).pathname;

function loadSnapshots() {
  try {
    const raw = fs.readFileSync(SNAPSHOT_FILE, "utf8");
    const obj = JSON.parse(raw);
    for (const [id, snap] of Object.entries(obj)) {
      snapshots.set(id, snap as SchemaExport);
    }
    app.log.info({ count: snapshots.size }, "loaded snapshots from disk");
  } catch {
    /* ignore */
  }
}

function persistSnapshots() {
  try {
    const obj: Record<string, SchemaExport> = {};
    for (const [id, snap] of snapshots.entries()) obj[id] = snap;
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (err) {
    app.log.error({ err }, "failed to persist snapshots");
  }
}

loadSnapshots();

app.get("/health", async () => ({ ok: true }));

app.post("/extract", async (req, reply) => {
  const body = ExtractSchema.parse(req.body);
  app.log.info(
    {
      allowInsecureSSL: body.allowInsecureSSL ?? null,
      envAllowInsecureSSL: process.env.ALLOW_INSECURE_SSL ?? null,
    },
    "extract request ssl flags"
  );
  const isMysql = body.connectionString.startsWith("mysql://");
  const schema = isMysql ? await extractMysql(body) : await extractSchema(body);
  const snapshotId = crypto.randomUUID();
  snapshots.set(snapshotId, schema);
  persistSnapshots();
  return reply.send({ snapshotId, schema });
});

app.get("/snapshots/:id", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const snapshot = snapshots.get(id);
  if (!snapshot) return reply.code(404).send({ error: "Not found" });
  return reply.send(snapshot);
});

app.get("/snapshots", async (_req, reply) => {
  const list = Array.from(snapshots.entries()).map(([id, snap]) => ({
    id,
    meta: snap.meta,
    counts: {
      tables: snap.tables.length,
      enums: snap.enums.length,
      indexes: snap.indexes.length,
      relationships: snap.relationships.length,
      interfaces: snap.interfaces.length,
    },
  }));
  return reply.send({ snapshots: list });
});

app.delete("/snapshots/:id", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const ok = snapshots.delete(id);
  if (ok) persistSnapshots();
  return reply.send({ deleted: ok });
});

app.post("/interfaces/import", async (req, reply) => {
  const body = InterfacesImportSchema.parse(req.body);
  const snapshot = snapshots.get(body.snapshotId);
  if (!snapshot) return reply.code(404).send({ error: "Not found" });

  const interfaces: InterfaceDef[] = body.interfaces;
  const { interfacesMapped, warnings } = mapInterfaces(
    interfaces,
    snapshot.tables
  );

  const baseWarnings = snapshot.warnings.filter(
    (w) => w.type !== "interface_unmapped"
  );

  const updated: SchemaExport = {
    ...snapshot,
    interfaces: interfacesMapped,
    warnings: [...baseWarnings, ...warnings],
  };

  snapshots.set(body.snapshotId, updated);
  persistSnapshots();
  return reply.send(updated);
});

app.post("/interfaces/scan-zip", async (req, reply) => {
  const file = await req.file();
  if (!file) return reply.code(400).send({ error: "File missing" });

  const chunks: Buffer[] = [];
  for await (const chunk of file.file) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  const interfaces = scanInterfacesFromZip(buffer);
  return reply.send({ interfaces });
});

app.post("/text-to-sql", async (_req, reply) => {
  try {
    const body = TextToSqlSchema.parse(_req.body);

    // basic safety: single statement, must start with SELECT/WITH, forbid mutations
    const sql = body.sql.trim();
    if (!/^(select|with)\b/i.test(sql)) {
      return reply.code(400).send({ error: "Only SELECT/WITH queries are allowed" });
    }
    const forbidden = /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|comment|copy|vacuum|set|do|call|prepare|execute)\b/i;
    if (forbidden.test(sql)) {
      return reply.code(400).send({ error: "Mutating statements are blocked" });
    }
    const semicolons = sql.split(";").filter((s) => s.trim().length > 0);
    if (semicolons.length > 1) {
      return reply.code(400).send({ error: "Only one statement is allowed" });
    }

    const allowInsecure =
      body.allowInsecureSSL || process.env.ALLOW_INSECURE_SSL === "true";
    const limit = Math.min(body.limit ?? 100, 1000);
    const client = new Client({
      connectionString: body.connectionString,
      ssl: allowInsecure ? { rejectUnauthorized: false } : undefined,
    });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL default_transaction_read_only = on");
      const wrappedSql = `SELECT * FROM (${sql}) AS subq LIMIT $1`;
      const res = await client.query(wrappedSql, [limit]);
      await client.query("COMMIT");
      return reply.send({
        rowCount: res.rowCount,
        rows: res.rows,
        fields: res.fields?.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
      });
    } catch (err: any) {
      await client.query("ROLLBACK");
      return reply.code(400).send({ error: err.message || "Query failed" });
    } finally {
      await client.end();
    }
  } catch (err: any) {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 400;
    return reply.code(status).send({ error: err.message || "Invalid request" });
  }
});

app.get("/snapshots/:id/diff/:otherId", async (req, reply) => {
  const { id, otherId } = req.params as { id: string; otherId: string };
  const a = snapshots.get(id);
  const b = snapshots.get(otherId);
  if (!a || !b) return reply.code(404).send({ error: "Not found" });
  const diff = diffSchemas(a, b);
  return reply.send({ diff, from: id, to: otherId });
});

const port = Number(process.env.PORT || 3001);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
