import type { SchemaExport, PgTable, PgIndex, PgEnum, PgRelationship } from "./types.js";

function keyTable(t: PgTable) {
  return `${t.schema}.${t.name}`;
}

function keyIndex(i: PgIndex) {
  return `${i.schema}.${i.table}.${i.name}`;
}

function keyEnum(e: PgEnum) {
  return `${e.schema}.${e.name}`;
}

function keyRel(r: PgRelationship) {
  return `${r.from.schema}.${r.from.table}->${r.to.schema}.${r.to.table}.${r.fkName}`;
}

export function diffSchemas(a: SchemaExport, b: SchemaExport) {
  const tablesA = new Map(a.tables.map((t) => [keyTable(t), t]));
  const tablesB = new Map(b.tables.map((t) => [keyTable(t), t]));

  const addedTables: string[] = [];
  const removedTables: string[] = [];
  const changedTables: string[] = [];
  const columnChanges: { table: string; added: string[]; removed: string[]; changed: string[] }[] = [];
  const breakingChanges: string[] = [];

  for (const k of tablesA.keys()) if (!tablesB.has(k)) removedTables.push(k);
  for (const k of tablesB.keys()) if (!tablesA.has(k)) addedTables.push(k);

  for (const [k, tb] of tablesB.entries()) {
    const ta = tablesA.get(k);
    if (!ta) continue;
    const colA = new Map(ta.columns.map((c) => [c.name, c]));
    const colB = new Map(tb.columns.map((c) => [c.name, c]));
    const addedCols: string[] = [];
    const removedCols: string[] = [];
    const changedCols: string[] = [];
    for (const [name, cb] of colB.entries()) {
      const ca = colA.get(name);
      if (!ca) {
        addedCols.push(name);
        continue;
      }
      if (
        ca.type !== cb.type ||
        ca.nullable !== cb.nullable ||
        (ca.default || "") !== (cb.default || "")
      ) {
        changedCols.push(name);
        if (!cb.nullable && ca.nullable) {
          breakingChanges.push(`Column ${k}.${name} changed to NOT NULL`);
        }
        if (ca.type !== cb.type) {
          breakingChanges.push(`Column ${k}.${name} type changed from ${ca.type} to ${cb.type}`);
        }
      }
    }
    for (const name of colA.keys()) {
      if (!colB.has(name)) {
        removedCols.push(name);
        breakingChanges.push(`Column ${k}.${name} was removed`);
      }
    }
    if (addedCols.length || removedCols.length || changedCols.length) {
      columnChanges.push({
        table: k,
        added: addedCols,
        removed: removedCols,
        changed: changedCols,
      });
    }
    if (changedCols.length || removedCols.length || addedCols.length) {
      changedTables.push(`${k} (${Array.from(new Set([...addedCols, ...removedCols, ...changedCols])).join(",")})`);
    }
  }

  const enumsA = new Map(a.enums.map((e) => [keyEnum(e), e]));
  const enumsB = new Map(b.enums.map((e) => [keyEnum(e), e]));
  const addedEnums = Array.from(enumsB.keys()).filter((k) => !enumsA.has(k));
  const removedEnums = Array.from(enumsA.keys()).filter((k) => !enumsB.has(k));

  const idxA = new Map(a.indexes.map((i) => [keyIndex(i), i]));
  const idxB = new Map(b.indexes.map((i) => [keyIndex(i), i]));
  const addedIdx = Array.from(idxB.keys()).filter((k) => !idxA.has(k));
  const removedIdx = Array.from(idxA.keys()).filter((k) => !idxB.has(k));

  const relA = new Map(a.relationships.map((r) => [keyRel(r), r]));
  const relB = new Map(b.relationships.map((r) => [keyRel(r), r]));
  const addedRel = Array.from(relB.keys()).filter((k) => !relA.has(k));
  const removedRel = Array.from(relA.keys()).filter((k) => !relB.has(k));

  const interfacesA = new Map(a.interfaces.map((i) => [i.name.toLowerCase(), i]));
  const interfacesB = new Map(b.interfaces.map((i) => [i.name.toLowerCase(), i]));
  const addedInterfaces = Array.from(interfacesB.keys()).filter((k) => !interfacesA.has(k));
  const removedInterfaces = Array.from(interfacesA.keys()).filter((k) => !interfacesB.has(k));

  return {
    tables: { added: addedTables, removed: removedTables, changed: changedTables, columnChanges },
    enums: { added: addedEnums, removed: removedEnums },
    indexes: { added: addedIdx, removed: removedIdx },
    relationships: { added: addedRel, removed: removedRel },
    interfaces: { added: addedInterfaces, removed: removedInterfaces },
    breaking: breakingChanges,
  };
}
