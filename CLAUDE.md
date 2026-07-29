# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal, single-user CRM that visualizes contacts and their relationships as a graph (vis-network). Node/Express + Prisma/SQLite backend, vanilla JS frontend (no build step), WebAuthn passkey login, and an MCP server exposing the full HTTP API so Claude can read/write the CRM directly.

## Commands

```
npm start              # run the server (http://localhost:3000)
npm run dev            # run with --watch (auto-restart on file change)
npx prisma migrate dev --name <name>   # create + apply a schema migration
npx prisma generate     # regenerate the Prisma client after schema changes
node --check <file>     # syntax-check a file (no test suite exists)
```

There is no test suite, linter, or build step. Restart the server (`npm start`) after editing `server.js`, `auth.js`, `prisma/schema.prisma`, or anything under `public/` that isn't picked up by a browser refresh — there's no hot reload outside `npm run dev`'s watch on server-side files.

## Architecture

**Three processes/entry points, one SQLite DB (`crm.db`):**
- `server.js` — Express HTTP API + serves `public/` statically. This is the single source of truth; all mutations go through it.
- `mcp-server.js` — a thin MCP wrapper. It has **no direct DB access** — every tool call is a `fetch` to `server.js`'s HTTP API (see the `api()` helper). When adding a capability, add the REST endpoint in `server.js` first, then wrap it here; don't let this file grow its own business logic.
- `public/app.js` / `public/login.js` — vanilla JS frontend, no framework, no bundler. Both include `public/util.js` for a shared `apiRequest()` fetch wrapper.

**Auth (`auth.js`):** WebAuthn passkeys via `@simplewebauthn/server`, one passkey tied to a specific `Contact` (not a separate `User` table — the CRM owner *is* a contact, referenced by the `me_contact_id` key in `AppSetting`). Sessions are file-backed (`session-file-store`, `.sessions/`) so they survive server restarts. Two auth paths into every request via `auth.requireAuth`: a session cookie, or an `Authorization: Bearer <key>` header checked against hashed `ApiKey` rows — the latter is what `mcp-server.js` uses (reads the raw key from `.api-key` or `GRAPH_CRM_API_KEY` env var; the server only ever shows a generated key once, at creation time, and never stores or logs the raw value). `PUBLIC_PATHS` in `auth.js` is the allowlist of routes reachable pre-login (login page + its assets) — anything else 401s (API) or redirects to `/login.html` (pages).

**Relationship data model — two parallel representations, this is the most important thing to understand:**
- `Relationship` (pairwise `source_id -> type -> target_id` edges) is the **live, actively-used** model. Nearly everything in `server.js` — the graph endpoints, relationship inference, MCP tools — reads/writes this table.
- `FamilyUnit` / `FamilyUnitMember` (GEDCOM-style: a unit has members with a `role` — `spouse`/`child` for family units, `member` for everything else like friend/colleague circles) was introduced as an intended replacement, with `migrate-to-family-units.js` as a one-time migration script from `Relationship` to it. **That migration has not been finished** — the schema comment on `Relationship` says "superseded by FamilyUnit" but the runtime code was never moved over. Don't assume `FamilyUnit` is authoritative; check what `server.js` actually queries.
- Relationship-type inference lives in `server.js` (`runFamilyInference` and friends): creating a `spouse`/`parent_of`/`child_of`/`sibling` edge auto-derives the inverse (`parent_of` ↔ `child_of`), shared children between spouses, `grandparent_of`/`grandchild_of` from two-hop `parent_of` chains, and `cousin` from siblings' children (recursively — siblings of a cousin are also cousins). `INVERSE_RELATIONSHIP_TYPES` and `FAMILY_CHAIN_TYPES` in `server.js` define which types trigger which inference.

**Contacts:** `vcard.js` parses vCard (.vcf) imports (Google/Apple Contacts export format); `csv.js` parses the bulk-relationship-import CSV format. Both are dedup-aware (email + normalized phone for contacts; exact source/target/type for relationships).

**Frontend structure:** `public/index.html` is a single page with tab-switched `<section>` views (Graph/Contacts/Settings) rather than separate pages; `public/app.js` renders all of them into the same DOM and manages a `state` object as the client-side cache (`state.contacts`, `state.allRelationships`, `state.meContactId`, etc.) — most render functions read from `state` rather than re-fetching, so keep `state` in sync (via `refreshAll()`) after any mutation instead of fetching fresh data ad hoc.
