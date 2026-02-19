export type ExtractResponse = {
  snapshotId: string;
  schema: unknown;
};

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";

export async function extractSchema(payload: {
  connectionString: string;
  schema?: string;
  includeSchemas?: string[];
  excludeTables?: string[];
  allowInsecureSSL?: boolean;
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
  snapshotId: string;
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
