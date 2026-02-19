# Schema Extractor

Backend + frontend to extract PostgreSQL schema, relationships, enums, indexes, and optional interface mappings.

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
  "excludeTables": ["audit_log"]
}
```

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

## Frontend

```
cd frontend
npm install
npm run dev
```

Set `VITE_API_URL` if the backend is not on `http://localhost:3001`.

## Prerequisites

- Node.js installed (so `node` and `npm` are available).
- Network access to the Postgres host.

## Notes

- Text-to-SQL is stubbed (`/text-to-sql`) and requires an LLM provider + safety layer to enable.
- Interface mapping currently uses name matching; can be extended to structural matching.

## Design Decisions

- **Stack choice**: Node.js + TypeScript + Fastify for a lightweight API; React + Vite for a minimal UI.
- **Postgres introspection**: Uses `information_schema` and `pg_catalog` to capture tables, columns, keys, constraints, indexes, enums, and views.
- **Relationships**: Derived from foreign keys; relationship type inferred from FK column uniqueness/PK overlap.
- **Interfaces**: Zip upload scanning for TypeScript `interface` and `type = {}` blocks; mapping is name-based.
- **Snapshots**: In-memory for simplicity; can be persisted if needed.
- **SSL handling**: Supports `allowInsecureSSL` for self-signed chains; can be upgraded to CA bundle verification.

## AI Tooling

- AI assistance: Used to scaffold architecture, code, and UI, then iterated based on runtime errors and feedback.
- Manual verification: Each feature was validated locally and adjusted for SSL, schema visibility, and parsing issues.
