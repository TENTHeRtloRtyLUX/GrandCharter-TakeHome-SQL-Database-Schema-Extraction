import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { z } from "zod";
import { extractSchema, mapInterfaces } from "./extract.js";
import { scanInterfacesFromZip } from "./scan.js";
import type { InterfaceDef, SchemaExport } from "./types.js";

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await app.register(multipart, {
  limits: { fileSize: 20 * 1024 * 1024 },
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

const snapshots = new Map<string, SchemaExport>();

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
  const schema = await extractSchema(body);
  const snapshotId = crypto.randomUUID();
  snapshots.set(snapshotId, schema);
  return reply.send({ snapshotId, schema });
});

app.get("/snapshots/:id", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const snapshot = snapshots.get(id);
  if (!snapshot) return reply.code(404).send({ error: "Not found" });
  return reply.send(snapshot);
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

  const updated: SchemaExport = {
    ...snapshot,
    interfaces: interfacesMapped,
    warnings: [...snapshot.warnings, ...warnings],
  };

  snapshots.set(body.snapshotId, updated);
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
  return reply.code(501).send({
    error: "Text-to-SQL not configured",
    hint: "Provide an LLM provider and add a safe read-only execution layer.",
  });
});

const port = Number(process.env.PORT || 3001);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});