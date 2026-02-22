export type ExtractResponse = {
  snapshotId: string | null;
  schema: unknown;
};

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";

export async function extractSchema(payload: {
  connectionString: string;
  schema?: string;
  includeSchemas?: string[];
  excludeTables?: string[];
  allowInsecureSSL?: boolean;
  saveSnapshot?: boolean;
}): Promise<ExtractResponse> {
  const res = await fetch(`${API_URL}/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || "Extraction failed");
  }
  return res.json();
}

export async function importInterfaces(payload: {
  snapshotId: string | null;
  interfaces: unknown[];
}): Promise<unknown> {
  const res = await fetch(`${API_URL}/interfaces/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || "Import failed");
  }
  return res.json();
}

export async function scanInterfacesZip(file: File): Promise<{
  interfaces: unknown[];
}> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_URL}/interfaces/scan-zip`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || "Scan failed");
  }
  return res.json();
}

export async function listSnapshots(): Promise<{
  snapshots: { id: string; meta: any; counts: any }[];
}> {
  const res = await fetch(`${API_URL}/snapshots`);
  if (!res.ok) throw new Error("Failed to list snapshots");
  return res.json();
}

export async function saveSnapshot(schema: unknown): Promise<{ snapshotId: string }> {
  const res = await fetch(`${API_URL}/snapshots/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schema }),
  });
  if (!res.ok) throw new Error("Failed to save snapshot");
  return res.json();
}

export async function loadSnapshot(id: string): Promise<unknown> {
  const res = await fetch(`${API_URL}/snapshots/${id}`);
  if (!res.ok) throw new Error("Snapshot not found");
  return res.json();
}

export async function deleteSnapshot(id: string): Promise<boolean> {
  const res = await fetch(`${API_URL}/snapshots/${id}`, { method: "DELETE" });
  if (!res.ok) return false;
  const data = await res.json();
  return data.deleted;
}

export async function textToSql(payload: {
  connectionString: string;
  sql: string;
  allowInsecureSSL?: boolean;
  limit?: number;
}): Promise<{
  rows?: unknown[];
  rowCount?: number;
  fields?: { name: string; dataTypeID: number }[];
  error?: string;
}> {
  const res = await fetch(`${API_URL}/text-to-sql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || "Text-to-SQL failed");
  }
  return data;
}

export async function listDatabases(payload: {
  connectionString: string;
  allowInsecureSSL?: boolean;
}): Promise<{ databases: string[] }> {
  const res = await fetch(`${API_URL}/databases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || "Failed to list databases");
  }
  return data;
}
