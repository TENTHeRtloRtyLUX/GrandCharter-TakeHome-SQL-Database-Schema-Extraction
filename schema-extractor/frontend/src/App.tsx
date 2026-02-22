import { useEffect, useMemo, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  type Edge,
  type Node,
  type ReactFlowInstance,
} from "react-flow-renderer";
import "react-flow-renderer/dist/style.css";
import toast, { Toaster } from "react-hot-toast";
import {
  extractSchema,
  importInterfaces,
  scanInterfacesZip,
  textToSql,
  listSnapshots,
  saveSnapshot,
  loadSnapshot,
  deleteSnapshot,
  listDatabases,
} from "./api";
import dagre from "dagre";

type PgColumn = {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  isPrimaryKey: boolean;
  isUnique: boolean;
  comment: string | null;
};

type PgTable = {
  name: string;
  schema: string;
  comment: string | null;
  rowEstimate?: number | null;
  columns: PgColumn[];
  primaryKey: { name: string; columns: string[] } | null;
  uniques: { name: string; columns: string[] }[];
  checks: { name: string; expression: string }[];
  foreignKeys: {
    name: string;
    columns: string[];
    refTable: string;
    refSchema: string;
    refColumns: string[];
    onUpdate: string | null;
    onDelete: string | null;
  }[];
};

type PgEnum = { name: string; schema: string; values: string[]; comment: string | null };
type PgIndex = {
  name: string;
  schema: string;
  table: string;
  columns: string[];
  isUnique: boolean;
  isPrimary: boolean;
  method: string | null;
  definition: string | null;
};
type PgRelationship = {
  name: string;
  type: "one_to_one" | "many_to_one" | "one_to_many" | "many_to_many";
  from: { table: string; schema: string; columns: string[] };
  to: { table: string; schema: string; columns: string[] };
  fkName: string;
};

type InterfaceDef = {
  name: string;
  source: string;
  fields: { name: string; type: string; nullable: boolean }[];
  mappedTo: {
    table: string;
    schema: string;
    confidence: number;
    fieldDiff?: {
      missingInTable: string[];
      extraInTable: string[];
      nullableMismatches: string[];
      typeMismatches: string[];
    };
  } | null;
};

type SchemaExport = {
  meta: {
    generatedAt: string;
    db: { engine: string; version: string | null; host: string; database: string };
  };
  enums: PgEnum[];
  tables: PgTable[];
  relationships: PgRelationship[];
  indexes: PgIndex[];
  interfaces: InterfaceDef[];
  warnings: { type: string; message: string }[];
};

function ResultTable({ rows, fields }: { rows: any[]; fields: { name: string; dataTypeID?: number }[] }) {
  const limited = rows.slice(0, 50);
  return (
    <div className="result-table-wrapper">
      <table className="result-table">
        <thead>
          <tr>
            {fields.map((f) => (
              <th key={f.name}>{f.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {limited.map((row, idx) => (
            <tr key={idx}>
              {fields.map((f) => (
                <td key={f.name}>{formatCell((row as any)?.[f.name])}</td>
              ))}
            </tr>
          ))}
          {rows.length > limited.length && (
            <tr>
              <td colSpan={fields.length} className="muted small">
                Showing {limited.length} of {rows.length} rows
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function formatCell(value: any) {
  if (value === null || value === undefined) return "∅";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function renderDiffGroup(title: string, group: { added?: string[]; removed?: string[]; changed?: string[] } | undefined) {
  if (!group) return null;
  const has =
    (group.added && group.added.length) ||
    (group.removed && group.removed.length) ||
    (group.changed && group.changed.length);
  if (!has) return null;
  return (
    <div className="list-row column">
      <div className="mono">{title}</div>
      <div className="muted small">Added: {group.added?.length || 0} · Removed: {group.removed?.length || 0} · Changed: {group.changed?.length || 0}</div>
      <div className="diff">
        {group.added?.length ? <div><strong>Added:</strong> {group.added.join(", ")}</div> : null}
        {group.removed?.length ? <div><strong>Removed:</strong> {group.removed.join(", ")}</div> : null}
        {group.changed?.length ? <div><strong>Changed:</strong> {group.changed.join(", ")}</div> : null}
      </div>
    </div>
  );
}

function TableDetail({ table }: { table: PgTable }) {
  if (!table) return null;
  return (
    <div className="table-detail">
      <div className="table-header">
        <div>
          <div className="pill">{table.schema}</div>
          <h3>{table.name}</h3>
          {table.comment && <p className="muted">{table.comment}</p>}
        </div>
        {table.rowEstimate != null && (
          <div className="pill ghost">~{table.rowEstimate.toLocaleString()} rows</div>
        )}
      </div>
      <div className="section">
        <h4>Columns</h4>
        <div className="column-list">
          {table.columns.map((col) => (
            <div key={col.name} className="column-card">
              <div className="column-title">
                <span className="mono">{col.name}</span>
                <span className="muted">{col.type}</span>
              </div>
              <div className="badges">
                {col.isPrimaryKey && <span className="pill">PK</span>}
                {col.isUnique && !col.isPrimaryKey && <span className="pill">Unique</span>}
                {!col.nullable && <span className="pill ghost">NOT NULL</span>}
              </div>
              {col.default && <div className="muted">Default: {col.default}</div>}
              {col.comment && <div className="muted">{col.comment}</div>}
            </div>
          ))}
        </div>
      </div>
      {table.foreignKeys.length > 0 && (
        <div className="section">
          <h4>Foreign Keys</h4>
          <div className="list">
            {table.foreignKeys.map((fk) => (
              <div key={fk.name} className="list-row">
                <div>
                  <div className="mono">{fk.name}</div>
                  <div className="muted">
                    {fk.columns.join(", ")} → {fk.refSchema}.{fk.refTable}(
                    {fk.refColumns.join(", ")})
                  </div>
                </div>
                <div className="badges">
                  {fk.onUpdate && <span className="pill ghost">on update {fk.onUpdate}</span>}
                  {fk.onDelete && <span className="pill ghost">on delete {fk.onDelete}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [connectionString, setConnectionString] = useState("");
  const [schema, setSchema] = useState("");
  const [excludeTables, setExcludeTables] = useState("");
  const [allowInsecureSSL, setAllowInsecureSSL] = useState(true);
  const [interfacesJson, setInterfacesJson] = useState("[]");
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [result, setResult] = useState<SchemaExport | null>(null);
  const [tableFilter, setTableFilter] = useState("");
  const [schemaFilter, setSchemaFilter] = useState<string>("all");
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [openIndexGroups, setOpenIndexGroups] = useState<Set<string>>(
    () => new Set()
  );
  const [focusGraphOnSelection, setFocusGraphOnSelection] = useState(true);
  const [showRelLabels, setShowRelLabels] = useState(false);
  const [compactGraph, setCompactGraph] = useState(false);
  const [interfaceFilter, setInterfaceFilter] = useState<"all" | "mapped" | "unmapped" | "mismatch">("all");
  const [textSqlInput, setTextSqlInput] = useState("");
  const [textSqlResult, setTextSqlResult] = useState<string | null>(null);
  const [textSqlError, setTextSqlError] = useState<string | null>(null);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance | null>(null);
  const [snapshotList, setSnapshotList] = useState<{ id: string; meta: any; counts: any }[]>([]);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const [textSqlLimit, setTextSqlLimit] = useState(100);
  const [textRows, setTextRows] = useState<any[] | null>(null);
  const [textFields, setTextFields] = useState<{ name: string; dataTypeID?: number }[] | null>(null);
  const [diffResult, setDiffResult] = useState<any | null>(null);
  const [diffTarget, setDiffTarget] = useState<string>("");
  const [dbList, setDbList] = useState<string[]>([]);
  const [dbListLoading, setDbListLoading] = useState(false);
  const [selectedDb, setSelectedDb] = useState("");
  const hasDbList = dbList.length > 0;

  const stats = useMemo(() => {
    if (!result) return null;
    const unmapped = result.interfaces?.filter((i) => !i.mappedTo).length || 0;
    const mismatched =
      result.interfaces?.filter((i) => {
        const d = i.mappedTo?.fieldDiff;
        return (
          d &&
          (d.missingInTable.length +
            d.extraInTable.length +
            d.nullableMismatches.length +
            d.typeMismatches.length >
            0)
        );
      }).length || 0;
    return {
      tables: result.tables?.length || 0,
      enums: result.enums?.length || 0,
      relationships: result.relationships?.length || 0,
      indexes: result.indexes?.length || 0,
      interfaces: result.interfaces?.length || 0,
      interfacesUnmapped: unmapped,
      interfacesMismatched: mismatched,
    };
  }, [result]);

  useEffect(() => {
    refreshSnapshots(true);
  }, []);

  useEffect(() => {
    try {
      const url = new URL(connectionString);
      const db = url.pathname.replace("/", "");
      setSelectedDb(db);
    } catch {
      setSelectedDb("");
    }
  }, [connectionString]);

  async function runDiff(targetId: string) {
    if (!snapshotId || !targetId) return;
    try {
      const res = await fetch(
        `${import.meta.env.VITE_API_URL || "http://localhost:3001"}/snapshots/${snapshotId}/diff/${targetId}`
      );
      if (!res.ok) throw new Error("Diff failed");
      const data = await res.json();
      setDiffResult(data.diff);
      setDiffTarget(targetId);
      toast.success("Diff computed");
    } catch (err) {
      toast.error("Unable to compute diff");
    }
  }

  async function refreshSnapshots(silent = false) {
    try {
      const res = await listSnapshots();
      setSnapshotList(res.snapshots || []);
    } catch (err) {
      if (!silent) toast.error("Failed to load snapshots");
    }
  }

  async function loadDatabases() {
    if (!connectionString) return toast.error("Enter a connection string");
    setDbListLoading(true);
    try {
      const res = await listDatabases({
        connectionString,
        allowInsecureSSL,
      });
      setDbList(res.databases || []);
      toast.success("Databases loaded");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to list databases");
    } finally {
      setDbListLoading(false);
    }
  }

  const filteredTables = useMemo(() => {
    if (!result) return [];
    const q = tableFilter.toLowerCase();
    return result.tables.filter(
      (t) =>
        !q ||
        t.name.toLowerCase().includes(q) ||
        t.schema.toLowerCase().includes(q)
    ).filter((t) => schemaFilter === "all" || t.schema === schemaFilter);
  }, [result, tableFilter, schemaFilter]);

  const selectedTableObj = useMemo(() => {
    if (!result || !selectedTable) return null;
    return result.tables.find(
      (t) => `${t.schema}.${t.name}` === selectedTable
    );
  }, [result, selectedTable]);

  const graphData = useMemo(() => {
    if (!result) return { nodes: [] as Node[], edges: [] as Edge[] };

    const baseStyle = {
      padding: 8,
      borderRadius: 10,
      border: "1px solid #2d3445",
      background: "#12151e",
      color: "#e8ecf3",
    };

    const allNodes: Node[] = result.tables.map((t) => ({
      id: `${t.schema}.${t.name}`,
      data: { label: `${t.schema}.${t.name}` },
      position: { x: 0, y: 0 },
      style: baseStyle,
      width: 160,
      height: 40,
    }));

    const allEdges: Edge[] = result.relationships.map((r) => ({
      id: r.fkName,
      source: `${r.from.schema}.${r.from.table}`,
      target: `${r.to.schema}.${r.to.table}`,
      label: showRelLabels ? r.type.replace(/_/g, " ") : undefined,
      animated: true,
      style: { stroke: "#4fb0ff" },
      data: { type: r.type },
    }));

    if (focusGraphOnSelection && selectedTable) {
      const tableId = selectedTable;
      const edges = allEdges.filter(
        (e) => e.source === tableId || e.target === tableId
      );
      const nodeIds = new Set<string>([tableId]);
      edges.forEach((e) => {
        nodeIds.add(e.source);
        nodeIds.add(e.target);
      });
      const neighbors = Array.from(nodeIds).filter((id) => id !== tableId);
      const radius = 260;
      const center = { x: 320, y: 220 };
      const step = (2 * Math.PI) / Math.max(neighbors.length, 1);
      const nodes = allNodes
        .filter((n) => nodeIds.has(n.id))
        .map((n) => {
          if (n.id === tableId) {
            return { ...n, position: center, style: { ...baseStyle, border: "1px solid #4fb0ff" } };
          }
          const idx = neighbors.indexOf(n.id);
          const angle = idx * step;
          return {
            ...n,
            position: {
              x: center.x + radius * Math.cos(angle),
              y: center.y + radius * Math.sin(angle),
            },
          };
        });
      return { nodes, edges };
    }

    // Compact auto-layout using dagre
    const g = new dagre.graphlib.Graph();
    const count = result.tables.length;
    const nodesep = Math.max(35, Math.min(90, 1200 / Math.max(10, count)));
    const ranksepBase = compactGraph ? 110 : 90;
    const ranksep = Math.max(ranksepBase, Math.min(180, 1800 / Math.max(10, count)));
    g.setGraph({ rankdir: compactGraph ? "LR" : "TB", nodesep, ranksep });
    g.setDefaultEdgeLabel(() => ({}));

    allNodes.forEach((n) => g.setNode(n.id, { width: n.width ?? 160, height: n.height ?? 40 }));
    allEdges.forEach((e) => g.setEdge(e.source, e.target));

    dagre.layout(g);

    const laidOut = allNodes.map((n) => {
      const nodeWithPos = g.node(n.id);
      const x = Number.isFinite(nodeWithPos?.x) ? nodeWithPos.x : 0;
      const y = Number.isFinite(nodeWithPos?.y) ? nodeWithPos.y : 0;
      return {
        ...n,
        position: { x, y },
      };
    });

    return { nodes: laidOut, edges: allEdges };
  }, [result, selectedTable, focusGraphOnSelection, showRelLabels, compactGraph]);

  const indexesByTable = useMemo(() => {
    if (!result) return new Map<string, PgIndex[]>();
    const map = new Map<string, PgIndex[]>();
    for (const idx of result.indexes || []) {
      const key = `${idx.schema}.${idx.table}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(idx);
    }
    return map;
  }, [result]);

  const schemas = useMemo(() => {
    if (!result) return [];
    const set = new Set<string>();
    result.tables.forEach((t) => set.add(t.schema));
    return Array.from(set).sort();
  }, [result]);

  const schemaStats = useMemo(() => {
    if (!result) return [];
    const statsMap = new Map<string, { tables: number; indexes: number; enums: number }>();
    for (const s of schemas) {
      statsMap.set(s, { tables: 0, indexes: 0, enums: 0 });
    }
    for (const t of result.tables) {
      const curr = statsMap.get(t.schema);
      if (curr) curr.tables += 1;
    }
    for (const idx of result.indexes || []) {
      const curr = statsMap.get(idx.schema);
      if (curr) curr.indexes += 1;
    }
    for (const en of result.enums || []) {
      const curr = statsMap.get(en.schema);
      if (curr) curr.enums += 1;
    }
    return Array.from(statsMap.entries()).map(([schema, stats]) => ({
      schema,
      ...stats,
    }));
  }, [result, schemas]);

  async function onExtract() {
    setLoading(true);
    try {
        const payload = {
          connectionString,
          schema: schema.trim() || undefined,
          excludeTables: excludeTables
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          allowInsecureSSL,
        };
      const res = await extractSchema(payload);
      setSnapshotId(res.snapshotId);
      setSelectedSnapshotId(res.snapshotId);
      const schemaResult = res.schema as SchemaExport;
      setResult(schemaResult);
      if (schemaResult.tables?.[0]) {
        setSelectedTable(`${schemaResult.tables[0].schema}.${schemaResult.tables[0].name}`);
      }
      toast.success("Schema extracted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Extraction failed");
    } finally {
      setLoading(false);
    }
  }

  async function onImportInterfaces() {
    if (!snapshotId) return toast.error("Extract first");
    setLoading(true);
    try {
      let parsed = JSON.parse(interfacesJson);
      if (Array.isArray(parsed) && parsed.length > 0 && Array.isArray(parsed[0])) {
        parsed = parsed.flat();
      }
      if (!Array.isArray(parsed)) {
        throw new Error("Interfaces JSON must be an array of objects");
      }
      const updated = await importInterfaces({
        snapshotId,
        interfaces: parsed,
      });
      setResult(updated as SchemaExport);
      toast.success("Interfaces mapped");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setLoading(false);
    }
  }

  async function onScanZip() {
    if (!zipFile) return toast.error("Select a zip");
    setLoading(true);
    try {
      const res = await scanInterfacesZip(zipFile);
      setInterfacesJson(JSON.stringify(res.interfaces, null, 2));
      toast.success("Interfaces extracted from zip");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Scan failed");
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

  async function loadSnapshotById(id: string) {
    try {
      const snap = (await loadSnapshot(id)) as SchemaExport;
      setResult(snap);
      setSnapshotId(id);
      setSelectedSnapshotId(id);
      if (snap.tables?.[0]) {
        setSelectedTable(`${snap.tables[0].schema}.${snap.tables[0].name}`);
      }
      toast.success("Snapshot loaded");
    } catch (err) {
      toast.error("Failed to load snapshot");
    }
  }

  return (
    <div className="page">
      <Toaster position="top-right" />
      <header className="hero">
        <div>
          <div className="eyebrow">Schema Extraction</div>
          <h1>Blueprint your SQL database.</h1>
          <p>
            Extract schema, relationships, enums, indexes, and code interfaces with one run.
          </p>
          <p className="muted small">
            Snapshots are saved locally on the backend; load them here to browse past extractions or compute diffs
            between runs.
          </p>
          <div className="panel-actions" style={{ marginTop: 8 }}>
            <button className="ghost small" onClick={refreshSnapshots}>Refresh snapshots</button>
            <select
              className="inline-input"
              value={selectedSnapshotId || ""}
              onChange={(e) => {
                const id = e.target.value;
                if (id) loadSnapshotById(id);
              }}
            >
              <option value="">Load saved snapshot</option>
              {snapshotList.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.meta?.db?.database || "db"} ({s.counts?.tables ?? 0} tables)
                </option>
              ))}
            </select>
            {selectedSnapshotId && (
              <button
                className="ghost small"
                onClick={async () => {
                  if (!selectedSnapshotId) return;
                  const ok = await deleteSnapshot(selectedSnapshotId);
                  if (ok) {
                    toast.success("Snapshot deleted");
                    setResult(null);
                    setSnapshotId(null);
                    setSelectedSnapshotId(null);
                    refreshSnapshots();
                  } else {
                    toast.error("Delete failed");
                  }
                }}
              >
                Delete snapshot
              </button>
            )}
            {result && (
              <button
                className="ghost small"
                onClick={async () => {
                  try {
                    const res = await saveSnapshot(result);
                    setSnapshotId(res.snapshotId);
                    setSelectedSnapshotId(res.snapshotId);
                    await refreshSnapshots(true);
                    toast.success("Snapshot saved");
                  } catch {
                    toast.error("Failed to save snapshot");
                  }
                }}
              >
                Save snapshot now
              </button>
            )}
          </div>
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
            <button className="ghost" type="button" disabled={dbListLoading} onClick={loadDatabases}>
              {dbListLoading ? "Loading DBs..." : "List Databases"}
            </button>
            {dbList.length > 0 && (
              <select
                className="inline-input"
                value={selectedDb || ""}
                onChange={(e) => {
                  const db = e.target.value;
                  if (!db) return;
                  try {
                    const url = new URL(connectionString);
                    url.pathname = `/${db}`;
                    setConnectionString(url.toString());
                    setSelectedDb(db);
                  } catch {
                    toast.error("Invalid connection string");
                  }
                }}
              >
                {!selectedDb && <option value="">Select database</option>}
                {selectedDb && <option value={selectedDb}>{selectedDb} (current)</option>}
                {dbList
                  .filter((db) => db !== selectedDb)
                  .map((db) => (
                  <option key={db} value={db}>
                    {db}
                  </option>
                ))}
              </select>
            )}
          </div>
          {hasDbList && (
            <>
              <div className="row">
                <label>
                  Default Schema (optional)
                  <input
                    value={schema}
                    onChange={(e) => setSchema(e.target.value)}
                    placeholder="public"
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
            </>
          )}
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
              <div>Interfaces: {stats.interfaces}</div>
              <div className="muted small">
                Unmapped: {stats.interfacesUnmapped} | Mismatched: {stats.interfacesMismatched}
              </div>
            </div>
          )}
          {snapshotList.length > 1 && (
            <div className="panel-actions" style={{ marginTop: 8 }}>
              <select
                className="inline-input"
                value={diffTarget}
                onChange={(e) => setDiffTarget(e.target.value)}
              >
                <option value="">Select snapshot to diff against</option>
                {snapshotList
                  .filter((s) => s.id !== snapshotId)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.meta?.db?.database || "db"} ({s.counts?.tables ?? 0} tables)
                    </option>
                  ))}
              </select>
              <button
                className="ghost small"
                disabled={!diffTarget}
                onClick={() => diffTarget && runDiff(diffTarget)}
              >
                Compute diff
              </button>
            </div>
          )}
          {schemaStats && schemaStats.length > 1 && (
            <div className="schema-stats">
              {schemaStats.map((s) => (
                <div key={s.schema} className="schema-card">
                  <div className="mono">{s.schema}</div>
                  <div className="muted small">
                    {s.tables} tables · {s.indexes} idx · {s.enums} enums
                  </div>
                </div>
              ))}
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

      {result && (
        <section className="panel">
          <div className="panel-header">
            <h2>Tables</h2>
            <div className="panel-actions">
              <select
                className="inline-input"
                value={schemaFilter}
                onChange={(e) => setSchemaFilter(e.target.value)}
              >
                <option value="all">All schemas</option>
                {schemas.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <input
                className="inline-input"
                placeholder="Search tables..."
                value={tableFilter}
                onChange={(e) => setTableFilter(e.target.value)}
              />
            </div>
          </div>
          <div className="tables-grid">
            <div className="table-list">
              {filteredTables.map((t) => {
                const key = `${t.schema}.${t.name}`;
                const isActive = key === selectedTable;
                return (
                  <button
                    key={key}
                    className={`table-item ${isActive ? "active" : ""}`}
                    onClick={() => setSelectedTable(key)}
                  >
                    <div className="table-title-line">
                      <span className="pill small">{t.schema}</span>
                      <span className="table-name">{t.name}</span>
                    </div>
                    {t.comment && <div className="muted small">{t.comment}</div>}
                  </button>
                );
              })}
            </div>
            <div className="table-detail-pane">
              {selectedTableObj ? (
                <TableDetail table={selectedTableObj} />
              ) : (
                <div className="muted">Select a table to see details.</div>
              )}
            </div>
          </div>
        </section>
      )}

      {result && (
        <section className="panel">
          <div className="panel-header">
            <h2>Relationships</h2>
            <div className="panel-actions">
              <button
                className="ghost small"
                onClick={() => flowInstance?.fitView({ padding: 0.2, duration: 400 })}
              >
                Fit
              </button>
              <button
                className="ghost small"
                onClick={() => flowInstance?.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 400 })}
              >
                Reset
              </button>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={focusGraphOnSelection}
                  onChange={(e) => setFocusGraphOnSelection(e.target.checked)}
                />
                Focus on selected table
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={showRelLabels}
                  onChange={(e) => setShowRelLabels(e.target.checked)}
                />
                Show relationship types
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={compactGraph}
                  onChange={(e) => setCompactGraph(e.target.checked)}
                />
                Compact (left-to-right) layout
              </label>
            </div>
          </div>
          {result.relationships && result.relationships.length > 0 ? (
            <div style={{ height: 360, border: "1px solid #e0d6c7", borderRadius: 12, background: "#0f1116" }}>
              <ReactFlow
                nodes={graphData.nodes}
                edges={graphData.edges}
                fitView
                fitViewOptions={{ padding: 0.2 }}
                proOptions={{ hideAttribution: true }}
                onInit={(inst) => setFlowInstance(inst)}
                style={{ width: "100%", height: "100%" }}
              >
                <MiniMap />
                <Controls />
                <Background gap={12} color="#f0e6d8" />
              </ReactFlow>
            </div>
          ) : (
            <div className="muted small">No relationships found in this extraction.</div>
          )}
        </section>
      )}

      {result && Array.isArray(result.enums) && result.enums.length > 0 && (
        <section className="panel">
          <h2>Enums</h2>
          <div className="list">
            {result.enums.map((e, idx) => {
              const values = Array.isArray((e as any).values) ? (e as any).values : [];
              return (
              <div key={`${e.schema}.${e.name}`} className="list-row">
                <div>
                  <div className="mono">
                    {e.schema}.{e.name}
                  </div>
                  <div className="muted">{values.join(", ") || "—"}</div>
                </div>
                {e.comment && <div className="muted">{e.comment}</div>}
              </div>
              );
            })}
          </div>
        </section>
      )}

      {result && Array.isArray(result.indexes) && result.indexes.length > 0 && (
        <section className="panel">
          <h2>Indexes</h2>
          <div className="indexes-grid">
            {schemas.map((schemaName) => {
              const tableEntries = Array.from(indexesByTable.entries()).filter(([k]) =>
                k.startsWith(`${schemaName}.`)
              );
              if (tableEntries.length === 0) return null;
              return (
                <div key={schemaName} className="indexes-card">
                  <div className="group-header">
                    <div className="title-block">
                      <div className="mono">{schemaName}</div>
                      <div className="meta">{tableEntries.length} table(s)</div>
                    </div>
                  </div>
                  <div className="list nested compact">
                    {tableEntries.map(([key, items]) => {
                      const isOpen = openIndexGroups.has(key);
                      const [, tableName] = key.split(".");
                      return (
                        <div key={key} className="list-row column table-group">
                          <div
                            className="group-header"
                            onClick={() => {
                              const next = new Set(openIndexGroups);
                              if (isOpen) next.delete(key);
                              else next.add(key);
                              setOpenIndexGroups(next);
                            }}
                          >
                            <div className="title-block">
                              <div className="mono">{tableName}</div>
                              <div className="muted meta">
                                {items.length} index{items.length === 1 ? "" : "es"}
                              </div>
                            </div>
                            <button className="ghost small">{isOpen ? "Hide" : "Show"}</button>
                          </div>
                          {isOpen && (
                            <div className="list nested">
                              {items.map((idx) => {
                        const cols = Array.isArray((idx as any).columns)
                          ? (idx as any).columns
                          : [];
                        return (
                          <div key={`${idx.schema}.${idx.name}`} className="list-row">
                            <div className="left">
                              <div className="mono">{idx.name}</div>
                              <div className="muted">
                                {cols.join(", ") || "—"} ({idx.method || "btree"})
                              </div>
                            </div>
                            <div className="right badges">
                              {idx.isPrimary && <span className="pill">Primary</span>}
                              {idx.isUnique && !idx.isPrimary && <span className="pill">Unique</span>}
                            </div>
                          </div>
                        );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="panel grid">
        <div>
          <h2>Interface Import</h2>
          <p className="muted">
            Upload a .zip of your TypeScript sources or paste interface JSON, then map to tables.
          </p>
          <div className="upload">
            <input
              id="interface-zip"
              className="file-input"
              type="file"
              accept=".zip"
              onChange={(e) => setZipFile(e.target.files?.[0] || null)}
            />
            <label className="file-label" htmlFor="interface-zip">
              <span className="file-button">Choose File</span>
              <span className="file-name">{zipFile ? zipFile.name : "No file chosen"}</span>
            </label>
            <button disabled={loading || !zipFile} onClick={onScanZip}>
              Scan Zip
            </button>
          </div>
          <textarea
            value={interfacesJson}
            onChange={(e) => setInterfacesJson(e.target.value)}
            rows={10}
          />
          <button disabled={loading} onClick={onImportInterfaces}>
            Import Interfaces
          </button>
          {diffResult && (
              <div className="warnings" style={{ marginTop: 12 }}>
                <div className="muted small">Diff (from {snapshotId} to {diffTarget}):</div>
                <div className="list">
                  {renderDiffGroup("Tables", diffResult.tables)}
                  {diffResult.tables?.columnChanges?.length ? (
                    <div className="list-row column">
                      <div className="mono">Column changes</div>
                      <div className="diff">
                        {diffResult.tables.columnChanges.map((c: any) => (
                          <div key={c.table} className="muted small">
                            <strong>{c.table}</strong> — added: {c.added.length} · removed: {c.removed.length} · changed: {c.changed.length}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {renderDiffGroup("Indexes", diffResult.indexes)}
                  {renderDiffGroup("Enums", diffResult.enums)}
                  {renderDiffGroup("Relationships", diffResult.relationships)}
                  {renderDiffGroup("Interfaces", diffResult.interfaces)}
                  {diffResult.breaking && diffResult.breaking.length > 0 && (
                    <div className="list-row column">
                      <div className="mono">Breaking changes</div>
                      <div className="diff">
                        {diffResult.breaking.map((b: string, i: number) => (
                          <div key={i} className="muted small">- {b}</div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <pre className="json">{JSON.stringify(diffResult, null, 2)}</pre>
              </div>
            )}
        </div>
        <div>
          <div className="panel-header">
            <h2>Preview</h2>
            <div className="panel-actions">
              <select
                className="inline-input"
                value={interfaceFilter}
                onChange={(e) => setInterfaceFilter(e.target.value as any)}
              >
                <option value="all">All interfaces</option>
                <option value="mapped">Mapped</option>
                <option value="unmapped">Unmapped</option>
                <option value="mismatch">Mismatched fields</option>
              </select>
            </div>
          </div>
          <div className="list">
            {result &&
              result.interfaces
                .filter((iface) => {
                  if (interfaceFilter === "mapped") return iface.mappedTo !== null;
                  if (interfaceFilter === "unmapped") return iface.mappedTo === null;
                  if (interfaceFilter === "mismatch")
                    return Boolean(iface.mappedTo?.fieldDiff) &&
                      ((iface.mappedTo?.fieldDiff?.missingInTable?.length || 0) > 0 ||
                        (iface.mappedTo?.fieldDiff?.extraInTable?.length || 0) > 0 ||
                        (iface.mappedTo?.fieldDiff?.nullableMismatches?.length || 0) > 0 ||
                        (iface.mappedTo?.fieldDiff?.typeMismatches?.length || 0) > 0);
                  return true;
                })
                .map((iface, idx) => (
                  <div key={`${iface.name}-${idx}`} className="list-row column">
                    <div className="left">
                      <div className="mono">{iface.name}</div>
                      <div className="muted small">{iface.source}</div>
                      {iface.mappedTo ? (
                        <div className="badges">
                          <span className="pill">mapped → {iface.mappedTo.schema}.{iface.mappedTo.table}</span>
                          {iface.mappedTo.fieldDiff &&
                            ((iface.mappedTo.fieldDiff.missingInTable.length +
                              iface.mappedTo.fieldDiff.extraInTable.length +
                              iface.mappedTo.fieldDiff.nullableMismatches.length +
                              iface.mappedTo.fieldDiff.typeMismatches.length) > 0) && (
                              <span className="pill ghost">fields differ</span>
                            )}
                        </div>
                      ) : (
                        <div className="badges">
                          <span className="pill ghost">unmapped</span>
                        </div>
                      )}
                      {iface.mappedTo?.fieldDiff && (
                        <div className="diff">
                          {iface.mappedTo.fieldDiff.missingInTable.length > 0 && (
                            <div>
                              <div className="muted">Missing in table:</div>
                              <div className="mono small">
                                {iface.mappedTo.fieldDiff.missingInTable.join(", ")}
                              </div>
                            </div>
                          )}
                          {iface.mappedTo.fieldDiff.extraInTable.length > 0 && (
                            <div>
                              <div className="muted">Extra in table:</div>
                              <div className="mono small">
                                {iface.mappedTo.fieldDiff.extraInTable.join(", ")}
                              </div>
                            </div>
                          )}
                          {iface.mappedTo.fieldDiff.nullableMismatches.length > 0 && (
                            <div>
                              <div className="muted">Nullability diff:</div>
                              <div className="mono small">
                                {iface.mappedTo.fieldDiff.nullableMismatches.join(", ")}
                              </div>
                            </div>
                          )}
                          {iface.mappedTo.fieldDiff.typeMismatches.length > 0 && (
                            <div>
                              <div className="muted">Type diff:</div>
                              <div className="mono small">
                                {iface.mappedTo.fieldDiff.typeMismatches.join(", ")}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
          </div>
          <h3>Raw JSON</h3>
          <pre className="json">
            {result ? JSON.stringify(result, null, 2) : "Run an extraction to see JSON."}
          </pre>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Text to SQL (add-on)</h2>
          <div className="muted small">Read-only execution; mutations are blocked</div>
        </div>
        <div className="grid">
          <div className="list column">
            <textarea
              value={textSqlInput}
              onChange={(e) => setTextSqlInput(e.target.value)}
              rows={4}
              placeholder="Write a read-only SELECT/WITH query. Mutations are blocked."
            />
            <label className="small muted">
              Row limit
              <input
                className="inline-input"
                type="number"
                min={1}
                max={1000}
                value={textSqlLimit}
                onChange={(e) => setTextSqlLimit(Number(e.target.value) || 100)}
              />
            </label>
          </div>
          <div className="json">
            {textSqlError ? (
              `Error: ${textSqlError}`
            ) : textRows && textFields ? (
              <ResultTable rows={textRows} fields={textFields} />
            ) : textSqlResult ? (
              textSqlResult
            ) : (
              "Results will appear here"
            )}
          </div>
        </div>
        <button
          disabled={!snapshotId || loading || !textSqlInput.trim()}
          onClick={async () => {
            if (!snapshotId) return toast.error("Extract first");
            const sqlTrim = textSqlInput.trim();
            if (!/^(select|with)/i.test(sqlTrim) || /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|comment|copy|vacuum|set|do|call|prepare|execute)\b/i.test(sqlTrim)) {
              return setTextSqlError("Only read-only SELECT/WITH queries are allowed.");
            }
            setTextSqlError(null);
            setTextSqlResult(null);
            setTextRows(null);
            setTextFields(null);
            setLoading(true);
            try {
              const res = await textToSql({
                connectionString,
                sql: textSqlInput,
                allowInsecureSSL,
                limit: textSqlLimit,
              });
              if (res.error) {
                setTextSqlError(res.error);
              } else {
                setTextSqlResult(JSON.stringify(res, null, 2));
                if (res.rows && res.fields) {
                  setTextRows(res.rows as any[]);
                  setTextFields(res.fields as any[]);
                }
              }
            } catch (err) {
              setTextSqlError(err instanceof Error ? err.message : "Text-to-SQL failed");
            } finally {
              setLoading(false);
            }
          }}
        >
          Run read-only query
        </button>
      </section>
    </div>
  );
}
