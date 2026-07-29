# Graph CRM

A personal, single-user CRM that visualizes contacts and their relationships as a graph. Node/Express + Prisma backend (SQLite by default), vanilla JS frontend (no build step), WebAuthn passkey login, and an MCP server exposing the full API so Claude can read/write the CRM directly.

## Setup

```bash
npm install
cp .env.example .env
npx prisma migrate deploy
npm start              # http://localhost:3000
```

First visit walks you through creating a passkey (Face ID / Touch ID / security key / device screen lock). See `.env.example` for optional configuration (custom port, `RP_ID`/`ORIGIN` if not running on `localhost:3000`, etc).

```bash
npm run dev             # auto-restart on file changes
npx prisma migrate dev --name <name>   # after editing prisma/schema.prisma
```

There's no test suite or linter — see `CLAUDE.md` for architecture notes if you're working on this codebase.

## Docker

```bash
docker build -t graph-crm .
docker run -p 3000:3000 -v graph-crm-data:/app/data graph-crm
```

The `/app/data` volume holds everything stateful: the SQLite database, the session store, and generated secrets (session secret, passkey data lives in the DB itself). Without a mounted volume, all of that is lost when the container is removed.

If you're serving this behind a domain other than `localhost:3000`, set `RP_ID` and `ORIGIN` (see `.env.example`) — WebAuthn passkeys are bound to the origin they were created on and won't work if it changes.

## Swapping the database backend

The app uses Prisma, so moving off SQLite doesn't require touching any application code — only `prisma/schema.prisma` and the connection string. Everything else (`family.js`, the REST API, `mcp-server.js`, the frontend) talks to Prisma's generated client, not to SQLite directly.

General steps, then Postgres/MySQL specifics below:

1. Change the `provider` in `prisma/schema.prisma`'s `datasource` block.
2. Point `DATABASE_URL` at the new database.
3. Delete `prisma/migrations/` and generate a fresh initial migration against the new provider (`npx prisma migrate dev --name init`) — the existing migration history was written for SQLite's SQL dialect and won't replay cleanly on a different engine. There's no automatic data carry-over; if you need existing contacts, export them first (Settings → API keys → generate one → pull data via the `list_contacts`/`get_directory` endpoints or MCP tools, then re-import after switching).
4. `npx prisma generate` to rebuild the client.

### Postgres

```bash
docker run -d --name graph-crm-pg -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=graphcrm -p 5432:5432 postgres:16
```

`prisma/schema.prisma`:
```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

`.env`:
```
DATABASE_URL="postgresql://postgres:devpass@localhost:5432/graphcrm"
```

```bash
rm -rf prisma/migrations
npx prisma migrate dev --name init
npm start
```

For a hosted Postgres (Supabase, Neon, RDS, etc.), just swap the connection string — most give you a ready-made `postgresql://...` URL. Neon/Supabase's pooled connection strings work fine with Prisma; if you hit prepared-statement errors behind a pooler, add `?pgbouncer=true` to the URL (Prisma's documented workaround).

### MySQL

```bash
docker run -d --name graph-crm-mysql -e MYSQL_ROOT_PASSWORD=devpass -e MYSQL_DATABASE=graphcrm -p 3306:3306 mysql:8
```

`prisma/schema.prisma`:
```prisma
datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}
```

`.env`:
```
DATABASE_URL="mysql://root:devpass@localhost:3306/graphcrm"
```

```bash
rm -rf prisma/migrations
npx prisma migrate dev --name init
npm start
```

### Provider-specific things worth checking after switching

- The `Credential.publicKey` field is `Bytes` — MySQL maps this to `LONGBLOB`, Postgres to `BYTEA`; both work fine with Prisma's client, no schema changes needed.
- `ApiKey.lastUsedAt` and other `DateTime?` fields are nullable on all providers. Postgres stores `timestamptz` under Prisma's default mapping; MySQL's `DATETIME` has no timezone awareness — only matters if you care about exact cross-timezone display of `lastUsedAt`/`createdAt`.
- Both Postgres and MySQL enforce foreign keys and unique constraints the same way SQLite does here (`onDelete: Cascade`, `@@unique`), so the cascade-delete behavior used throughout `family.js`/`server.js` (deleting a contact cleans up their relationships, interactions, credentials, etc.) carries over unchanged.
- Running Postgres/MySQL in Docker alongside the app: add both as services in a `docker-compose.yml` (not included here — this repo ships a single-container `Dockerfile` since SQLite needs no separate DB service) and point `DATABASE_URL` at the DB service's hostname instead of `localhost`.
