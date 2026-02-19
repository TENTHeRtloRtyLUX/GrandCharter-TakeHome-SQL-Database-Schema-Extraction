import { useMemo, useState } from "react";
import { extractSchema, importInterfaces, scanInterfacesZip } from "./api";

type SchemaExport = {
  enums?: unknown[];
  tables?: { name: string; schema: string; columns: { name: string; type: string }[] }[];
  relationships?: unknown[];
  indexes?: unknown[];
  views?: unknown[];
  warnings?: { type: string; message: string }[];
};

export default function App() {
  const [connectionString, setConnectionString] = useState("");
  const [schema, setSchema] = useState("public");
  const [includeSchemas, setIncludeSchemas] = useState("public");
  const [excludeTables, setExcludeTables] = useState("");
  const [allowInsecureSSL, setAllowInsecureSSL] = useState(true);
  const [interfacesJson, setInterfacesJson] = useState("[]");
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [result, setResult] = useState<SchemaExport | null>(null);

  const stats = useMemo(() => {
    if (!result) return null;
    return {
      tables: result.tables?.length || 0,
      enums: result.enums?.length || 0,
      relationships: result.relationships?.length || 0,
      indexes: result.indexes?.length || 0,
      views: result.views?.length || 0,
    };
  }, [result]);

  async function onExtract() {
    setError(null);
    setLoading(true);
    try {
      const payload = {
        connectionString,
        schema,
        includeSchemas: includeSchemas
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        excludeTables: excludeTables
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        allowInsecureSSL,
      };
      const res = await extractSchema(payload);
      setSnapshotId(res.snapshotId);
      setResult(res.schema as SchemaExport);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  async function onImportInterfaces() {
    if (!snapshotId) return;
    setError(null);
    setLoading(true);
    try {
      const parsed = JSON.parse(interfacesJson);
      const updated = await importInterfaces({
        snapshotId,
        interfaces: parsed,
      });
      setResult(updated as SchemaExport);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid JSON");
    } finally {
      setLoading(false);
    }
  }

  async function onScanZip() {
    if (!zipFile) return;
    setError(null);
    setLoading(true);
    try {
      const res = await scanInterfacesZip(zipFile);
      setInterfacesJson(JSON.stringify(res.interfaces, null, 2));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setLoading(false);
    }
  }

  function onDownload() {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "schema.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="page">
      <header className="hero">
        <div>
          <div className="eyebrow">Schema Extraction</div>
          <h1>Blueprint your Postgres database.</h1>
          <p>
            Extract schema, relationships, enums, indexes, and optional interface
            mappings in one click.
          </p>
        </div>
        <div className="hero-card">
          <label>
            Connection String
            <input
              value={connectionString}
              onChange={(e) => setConnectionString(e.target.value)}
              placeholder="postgres://user:pass@host:5432/db?sslmode=require"
            />
          </label>
          <div className="row">
            <label>
              Default Schema
              <input
                value={schema}
                onChange={(e) => setSchema(e.target.value)}
                placeholder="public"
              />
            </label>
            <label>
              Include Schemas (comma)
              <input
                value={includeSchemas}
                onChange={(e) => setIncludeSchemas(e.target.value)}
                placeholder="public, billing"
              />
            </label>
          </div>
          <label>
            Exclude Tables (comma)
            <input
              value={excludeTables}
              onChange={(e) => setExcludeTables(e.target.value)}
              placeholder="audit_log, temp_*"
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={allowInsecureSSL}
              onChange={(e) => setAllowInsecureSSL(e.target.checked)}
            />
            Allow self-signed SSL certificates
          </label>
          <button disabled={loading} onClick={onExtract}>
            {loading ? "Extracting..." : "Extract Schema"}
          </button>
          {error && <div className="error">{error}</div>}
        </div>
      </header>

      {result && (
        <section className="panel">
          <div className="panel-header">
            <h2>Snapshot Summary</h2>
            <button className="ghost" onClick={onDownload}>
              Download JSON
            </button>
          </div>
          {stats && (
            <div className="stats">
              <div>Tables: {stats.tables}</div>
              <div>Enums: {stats.enums}</div>
              <div>Relationships: {stats.relationships}</div>
              <div>Indexes: {stats.indexes}</div>
              <div>Views: {stats.views}</div>
            </div>
          )}
          {result.warnings && result.warnings.length > 0 && (
            <div className="warnings">
              {result.warnings.map((w, i) => (
                <div key={i}>
                  {w.type}: {w.message}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="panel grid">
        <div>
          <h2>Interface Import</h2>
          <p>
            Paste an array of interface objects to map them to tables.
            Structure should match the JSON spec.
          </p>
          <div className="upload">
            <input
              type="file"
              accept=".zip"
              onChange={(e) => setZipFile(e.target.files?.[0] || null)}
            />
            <button disabled={loading || !zipFile} onClick={onScanZip}>
              Scan Zip
            </button>
          </div>
          <textarea
            value={interfacesJson}
            onChange={(e) => setInterfacesJson(e.target.value)}
            rows={10}
          />
          <button disabled={loading || !snapshotId} onClick={onImportInterfaces}>
            {snapshotId ? "Import Interfaces" : "Extract First"}
          </button>
        </div>
        <div>
          <h2>Preview</h2>
          <pre className="json">{JSON.stringify(result, null, 2)}</pre>
        </div>
      </section>
    </div>
  );
}
