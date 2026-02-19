import AdmZip from "adm-zip";
import path from "node:path";
import type { InterfaceDef } from "./types.js";

const TS_EXTENSIONS = new Set([".ts", ".tsx"]);

function isTsFile(filePath: string): boolean {
  return TS_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function extractFields(block: string): { name: string; type: string; nullable: boolean }[] {
  const lines = block
    .split(/[\n;]/)
    .map((line) => line.trim())
    .filter(Boolean);

  const fields: { name: string; type: string; nullable: boolean }[] = [];
  for (const line of lines) {
    const match = line.match(/^([A-Za-z0-9_]+)(\?)?\s*:\s*([^;]+)$/);
    if (!match) continue;
    const name = match[1];
    const optional = Boolean(match[2]);
    const rawType = match[3].trim();
    const nullable =
      optional || /\bnull\b/.test(rawType) || /\bundefined\b/.test(rawType);
    fields.push({ name, type: rawType, nullable });
  }
  return fields;
}

function lineNumberAt(source: string, index: number): number {
  if (index <= 0) return 1;
  return source.slice(0, index).split("\n").length;
}

function extractInterfacesFromSource(
  source: string,
  relativePath: string
): InterfaceDef[] {
  const interfaces: InterfaceDef[] = [];

  const interfaceRegex =
    /(?:export\s+)?interface\s+([A-Za-z0-9_]+)\s*{([\s\S]*?)}/g;
  const typeRegex =
    /(?:export\s+)?type\s+([A-Za-z0-9_]+)\s*=\s*{([\s\S]*?)}\s*;/g;

  for (const match of source.matchAll(interfaceRegex)) {
    const name = match[1];
    const block = match[2] || "";
    const line = lineNumberAt(source, match.index || 0);
    interfaces.push({
      name,
      source: `${relativePath}:${line}`,
      fields: extractFields(block),
      mappedTo: null,
    });
  }

  for (const match of source.matchAll(typeRegex)) {
    const name = match[1];
    const block = match[2] || "";
    const line = lineNumberAt(source, match.index || 0);
    interfaces.push({
      name,
      source: `${relativePath}:${line}`,
      fields: extractFields(block),
      mappedTo: null,
    });
  }

  return interfaces;
}

export function scanInterfacesFromZip(zipBuffer: Buffer): InterfaceDef[] {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  const interfaces: InterfaceDef[] = [];

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const entryPath = entry.entryName.replace(/\\/g, "/");
    if (!isTsFile(entryPath)) continue;
    const source = entry.getData().toString("utf8");
    interfaces.push(...extractInterfacesFromSource(source, entryPath));
  }

  return interfaces;
}
