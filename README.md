# Schema Extractor

Backend + frontend to extract database schema (Postgres + MySQL/MariaDB), relationships, enums, indexes, snapshots, diffs (with breaking-change flags), and interface mappings with field-level checks. Includes a read‑only Text-to-SQL runner.

## Demo Links
- Demo: Local (run frontend and backend locally).

## Run Locally

1. Start the backend:
```
cd backend
npm install
npm run dev
```

2. Start the frontend (in a new terminal):
```
cd frontend
npm install
npm run dev
```

3. Open `http://localhost:5173` in your browser.

## Backend

```
cd backend
npm install
npm run dev
```

Server listens on `http://localhost:3001`.

`VITE_API_URL` (frontend) should point to the backend base URL. Default is `http://localhost:3001`.

If the database uses a self-signed certificate, start the backend with:

```
setx ALLOW_INSECURE_SSL true
# open a new PowerShell window, then
cd backend
npm run dev
```

### POST /extract
Payload:

```json
{
  "connectionString": "postgres://user:pass@host:5432/db?sslmode=require",
  "schema": "public",
  "includeSchemas": ["public"],
  "excludeTables": ["audit_log"],
  "allowInsecureSSL": false
}
```

Supports `postgres://...` and `mysql://...` URIs (MySQL/MariaDB). For MySQL, enums are parsed from column enum types; constraints/indexes come from `INFORMATION_SCHEMA`.

### POST /interfaces/import
Payload:

```json
{
  "snapshotId": "...",
  "interfaces": [
    {
      "name": "UserDTO",
      "source": "src/models/user.ts:12",
      "fields": [
        { "name": "id", "type": "string", "nullable": false }
      ],
      "mappedTo": null
    }
  ]
}
```

### POST /interfaces/scan-zip
Upload a `.zip` of your codebase to extract TypeScript interfaces/types.

### GET /snapshots
List saved snapshots (persisted to `backend/src/snapshots.json`).

### POST /snapshots/save
Save the current extraction result as a snapshot. This is user‑initiated from the UI (no automatic snapshotting on extract).

### GET /snapshots/:id
Fetch a snapshot.

### DELETE /snapshots/:id
Delete a snapshot and persist the change.

### GET /snapshots/:id/diff/:otherId
Return structural diffs (added/removed/changed tables, indexes, enums, relationships, interfaces) plus column-level changes and breaking-change notes between two snapshots.

### POST /text-to-sql
Run a *single* read-only SELECT/WITH query. The backend blocks DML/DDL, enforces read-only transaction, and applies a LIMIT (default 100, max 1000). Payload:
```json
{
  "connectionString": "postgres://...",
  "sql": "select * from users",
  "limit": 100,
  "allowInsecureSSL": false
}
```

## Frontend

```
cd frontend
npm install
npm run dev
```

Set `VITE_API_URL` if the backend is not on `http://localhost:3001`.

Key UI features:
- Enter credentials, extract schema; download JSON.
- Browse tables (columns, PK/FK, indexes), enums, grouped indexes, relationships graph (fit/reset/compact/focus toggles).
- Interfaces: upload zip or paste JSON; view mapped/unmapped/mismatched with field-level diffs; filter by status.
- Snapshots: load/delete saved runs, compute diffs against another snapshot, view diff summary + raw JSON.
- Text-to-SQL: client-side lint against DML, run read-only query with row limit; results shown in table.
- Indexes: responsive grid layout with wrapping and overflow-safe labels.

## Prerequisites

- Node.js installed (so `node` and `npm` are available).
- Network access to the target DB host (Postgres or MySQL/MariaDB).

## Notes

- Snapshots persist to `backend/src/snapshots.json` and are only saved when explicitly requested via the UI.
- Text-to-SQL executes user-entered read-only SQL (no LLM); mutations and multiple statements are blocked server-side.
- Interface mapping is name-based with field-level diff (missing/extra/type/nullability).

## Design Decisions

- **Stack choice**: Node.js + TypeScript + Fastify for a lightweight API; React + Vite for a minimal UI.
- **Postgres introspection**: Uses `information_schema` and `pg_catalog` to capture tables, columns, keys, constraints, indexes, enums, and views.
- **MySQL introspection**: Uses `INFORMATION_SCHEMA` for tables/columns/PK/FK/indexes; enums parsed from column enum definitions.
- **Relationships**: Derived from foreign keys; relationship type inferred from FK column uniqueness/PK overlap.
- **Interfaces**: Zip upload scanning for TypeScript `interface` and `type = {}` blocks; name-based mapping plus field-level diff warnings.
- **Snapshots**: Persisted to disk; can be listed, loaded, deleted, and diffed.
- **SSL handling**: Supports `allowInsecureSSL` for self-signed chains; can be upgraded to CA bundle verification.

## AI Tooling

- AI assistance: Used to scaffold architecture, code, and UI, then iterated based on runtime errors and feedback.
- Manual verification: Each feature was validated locally and adjusted for SSL, schema visibility, and parsing issues.
