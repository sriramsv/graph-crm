const fs = require('fs')
const path = require('path')
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { z } = require('zod')

const BASE_URL = process.env.GRAPH_CRM_URL || 'http://localhost:3000'
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const API_KEY_PATH = path.join(__dirname, '.api-key')

// The server only ever shows a generated key once (in the Settings UI popup), so it's
// never written to disk automatically. Paste it into GRAPH_CRM_API_KEY, or into a local
// .api-key file, when you generate one for this MCP server.
function getApiKey() {
  if (process.env.GRAPH_CRM_API_KEY) return process.env.GRAPH_CRM_API_KEY.trim()
  try {
    return fs.readFileSync(API_KEY_PATH, 'utf8').trim()
  } catch (err) {
    return null
  }
}

const server = new McpServer({ name: 'graph-crm', version: '1.0.0' })

async function api(path, options) {
  const apiKey = getApiKey()
  let res
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      ...options,
    })
  } catch (err) {
    throw new Error(`could not reach graph-crm server at ${BASE_URL} (is it running?): ${err.message}`)
  }
  if (res.status === 204) return null
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `request failed: ${res.status}`)
  return body
}

// Registers a tool whose handler just returns data (or throws). Success is wrapped as
// MCP JSON content automatically; thrown errors become an MCP error result automatically —
// no per-tool try/catch/json() boilerplate needed.
function tool(name, config, handler) {
  server.registerTool(name, config, async (args) => {
    try {
      const result = await handler(args)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: err.message }], isError: true }
    }
  })
}

// -- Contacts --

tool(
  'list_contacts',
  {
    title: 'List contacts',
    description:
      'List every person in the CRM with their core fields (name, email, phone, company, title, DOB, address, notes). ' +
      'This is the starting point for almost any task: use it to find a contact\'s id by name before calling other tools, ' +
      'or to get an overview of who is in the CRM. Does not include relationships — use get_contact or list_relationships for those.',
    inputSchema: {},
  },
  () => api('/api/contacts')
)

tool(
  'find_duplicate_contacts',
  {
    title: 'Find duplicate contacts',
    description:
      'Find groups of contacts that are likely duplicates of the same person, grouped by exact (case-insensitive) name match ' +
      'and separately by matching phone number (last 10 digits, ignoring formatting/country code). Use this before merge_contacts ' +
      'to decide what to merge — it does not change any data.',
    inputSchema: {},
  },
  () => api('/api/contacts/duplicates')
)

tool(
  'merge_contacts',
  {
    title: 'Merge duplicate contacts',
    description:
      'Merge one or more duplicate contacts into a single "primary" contact. All relationships, interactions, family-unit ' +
      'memberships, and the passkey credential (if any) belonging to the duplicates are reassigned to the primary; any field ' +
      '(email/phone/company/etc.) the primary is missing gets filled in from a duplicate that has it. The duplicate contacts ' +
      'are then deleted. Irreversible — use find_duplicate_contacts first and confirm with the user which contact should be ' +
      'the primary before calling this.',
    inputSchema: { primary_id: z.number(), duplicate_ids: z.array(z.number()).min(1) },
  },
  ({ primary_id, duplicate_ids }) =>
    api('/api/contacts/merge', { method: 'POST', body: JSON.stringify({ primary_id, duplicate_ids }) })
)

tool(
  'get_contact',
  {
    title: 'Get contact',
    description:
      'Get full detail on one contact by id: their core fields, every relationship they\'re part of, and their logged ' +
      'interactions (calls, meetings, notes). Use this when you already have a contact\'s id and need everything about them ' +
      'in one call, instead of separately calling list_relationships and list_interactions.',
    inputSchema: { id: z.number() },
  },
  async ({ id }) => {
    const [contact, allRelationships, interactions] = await Promise.all([
      api(`/api/contacts/${id}`),
      api('/api/relationships'),
      api(`/api/contacts/${id}/interactions`),
    ])
    const relationships = allRelationships.filter((r) => r.source_id === id || r.target_id === id)
    return { ...contact, relationships, interactions }
  }
)

tool(
  'create_contact',
  {
    title: 'Create contact',
    description: 'Create a new person in the CRM',
    inputSchema: {
      name: z.string().min(1),
      email: z.string().email().optional(),
      company: z.string().optional(),
      title: z.string().optional(),
      phone: z.string().optional(),
      date_of_birth: z.string().regex(ISO_DATE_RE, 'must be YYYY-MM-DD').optional(),
      address: z.string().optional(),
      notes: z.string().optional(),
    },
  },
  (args) => api('/api/contacts', { method: 'POST', body: JSON.stringify(args) })
)

tool(
  'update_contact',
  {
    title: 'Update contact',
    description: 'Update fields on an existing contact (only provided fields are changed)',
    inputSchema: {
      id: z.number(),
      name: z.string().min(1).optional(),
      email: z.string().email().optional(),
      company: z.string().optional(),
      title: z.string().optional(),
      phone: z.string().optional(),
      date_of_birth: z.string().regex(ISO_DATE_RE, 'must be YYYY-MM-DD').optional(),
      address: z.string().optional(),
      notes: z.string().optional(),
    },
  },
  async ({ id, ...fields }) => {
    const existing = await api(`/api/contacts/${id}`)
    const merged = { ...existing, ...fields }
    return api(`/api/contacts/${id}`, { method: 'PUT', body: JSON.stringify(merged) })
  }
)

tool(
  'delete_all_contacts',
  {
    title: 'Delete ALL contacts',
    description:
      'Permanently delete every contact, relationship, and note in the CRM. Irreversible — requires confirm: true.',
    inputSchema: { confirm: z.literal(true) },
  },
  () => api('/api/contacts?confirm=DELETE_ALL', { method: 'DELETE' })
)

tool(
  'import_vcard',
  {
    title: 'Import contacts from vCard',
    description:
      'Bulk-import contacts from vCard (.vcf) text, as exported by Google Contacts or Apple Contacts. Deduplicates by email and phone.',
    inputSchema: { vcard: z.string().min(1) },
  },
  ({ vcard }) => api('/api/contacts/import', { method: 'POST', body: JSON.stringify({ vcard }) })
)

tool(
  'import_relationships_csv',
  {
    title: 'Bulk import relationships from CSV',
    description:
      'Bulk-create relationships from CSV text with columns source,target,type,notes. People are matched by exact email or exact name.',
    inputSchema: { csv: z.string().min(1) },
  },
  ({ csv }) => api('/api/relationships/import', { method: 'POST', body: JSON.stringify({ csv }) })
)

tool(
  'get_directory',
  {
    title: 'Get contact directory',
    description:
      'List every contact with their email, phone, company, title, date of birth, address, and inferred spouse — a flat ' +
      'export-style view. Prefer list_contacts for general lookups; use this specifically when the spouse field or a ' +
      'full-fields export is what\'s needed.',
    inputSchema: {},
  },
  () => api('/api/directory')
)

tool(
  'delete_contact',
  {
    title: 'Delete contact',
    description: 'Delete a contact and their relationships/interactions',
    inputSchema: { id: z.number() },
  },
  async ({ id }) => {
    await api(`/api/contacts/${id}`, { method: 'DELETE' })
    return { deleted: id }
  }
)

// -- Relationships --

tool(
  'list_relationships',
  {
    title: 'List relationships',
    description:
      'List every relationship (edge) in the CRM as {source_id, target_id, type}. This is the raw edge list for the whole ' +
      'graph — for "how is X related to me" prefer get_relationship_path_to_me, and for one contact\'s relationships prefer ' +
      'get_contact, which already filters this down for you.',
    inputSchema: {},
  },
  () => api('/api/relationships')
)

tool(
  'create_relationship',
  {
    title: 'Create relationship',
    description:
      'Create a relationship (edge) between two contacts, e.g. friend, family, spouse, colleague, works_with, reports_to, mentor, referred, customer_of',
    inputSchema: {
      source_id: z.number(),
      target_id: z.number(),
      type: z.string().default('knows'),
      notes: z.string().optional(),
    },
  },
  (args) => api('/api/relationships', { method: 'POST', body: JSON.stringify(args) })
)

tool(
  'delete_relationship',
  {
    title: 'Delete relationship',
    description: 'Delete a relationship by id (a string, e.g. "12:friend:3:4" — pass the id exactly as returned by list_relationships/create_relationship)',
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    await api(`/api/relationships/${id}`, { method: 'DELETE' })
    return { deleted: id }
  }
)

// -- Interactions (notes & conversations) --

tool(
  'list_interactions',
  {
    title: 'List interactions',
    description: 'List notes/conversations logged for a contact, most recent first',
    inputSchema: { contact_id: z.number() },
  },
  ({ contact_id }) => api(`/api/contacts/${contact_id}/interactions`)
)

tool(
  'add_interaction',
  {
    title: 'Add interaction',
    description: 'Log a note or conversation (call, meeting, email, message) with a contact',
    inputSchema: {
      contact_id: z.number(),
      type: z.enum(['note', 'call', 'meeting', 'email', 'message']).default('note'),
      content: z.string().min(1),
      occurred_at: z.string().optional().describe('ISO datetime; defaults to now'),
    },
  },
  ({ contact_id, ...rest }) =>
    api(`/api/contacts/${contact_id}/interactions`, { method: 'POST', body: JSON.stringify(rest) })
)

tool(
  'delete_interaction',
  {
    title: 'Delete interaction',
    description: 'Delete a logged interaction by id',
    inputSchema: { id: z.number() },
  },
  async ({ id }) => {
    await api(`/api/interactions/${id}`, { method: 'DELETE' })
    return { deleted: id }
  }
)

// -- Institutions (companies, schools, organizations) --

tool(
  'list_institutions',
  {
    title: 'List institutions',
    description: 'List all institutions (companies, schools, organizations) with their member count',
    inputSchema: {},
  },
  () => api('/api/institutions')
)

tool(
  'get_institution',
  {
    title: 'Get institution',
    description: 'Get an institution by id, including everyone affiliated with it (role, start/end dates)',
    inputSchema: { id: z.number() },
  },
  ({ id }) => api(`/api/institutions/${id}`)
)

tool(
  'create_institution',
  {
    title: 'Create institution',
    description: 'Create a new institution (company, school, organization). Prefer add_affiliation with institution_name if you just want to link a contact to one — it finds-or-creates automatically.',
    inputSchema: { name: z.string().min(1), type: z.string().default('organization') },
  },
  (args) => api('/api/institutions', { method: 'POST', body: JSON.stringify(args) })
)

tool(
  'delete_institution',
  {
    title: 'Delete institution',
    description: 'Delete an institution and all its affiliations',
    inputSchema: { id: z.number() },
  },
  async ({ id }) => {
    await api(`/api/institutions/${id}`, { method: 'DELETE' })
    return { deleted: id }
  }
)

tool(
  'list_affiliations',
  {
    title: 'List a contact\'s affiliations',
    description: 'List every institution a contact is affiliated with (role, start/end dates)',
    inputSchema: { contact_id: z.number() },
  },
  ({ contact_id }) => api(`/api/contacts/${contact_id}/affiliations`)
)

tool(
  'add_affiliation',
  {
    title: 'Add affiliation',
    description:
      'Link a contact to an institution, e.g. "Jane worked at Acme as Engineer 2018-2022". Pass either ' +
      'institution_id (if you already have it from list_institutions) or institution_name, which finds an ' +
      'existing institution by exact case-insensitive name match or creates one if none exists.',
    inputSchema: {
      contact_id: z.number(),
      institution_id: z.number().optional(),
      institution_name: z.string().optional(),
      institution_type: z.string().optional().describe('used only when creating a new institution, e.g. "company" or "school"'),
      role: z.string().optional(),
      start_date: z.string().regex(ISO_DATE_RE, 'must be YYYY-MM-DD').optional(),
      end_date: z.string().regex(ISO_DATE_RE, 'must be YYYY-MM-DD').optional().describe('omit if still current'),
    },
  },
  ({ contact_id, ...rest }) =>
    api(`/api/contacts/${contact_id}/affiliations`, { method: 'POST', body: JSON.stringify(rest) })
)

tool(
  'delete_affiliation',
  {
    title: 'Delete affiliation',
    description: 'Remove a contact\'s affiliation with an institution by affiliation id',
    inputSchema: { id: z.number() },
  },
  async ({ id }) => {
    await api(`/api/affiliations/${id}`, { method: 'DELETE' })
    return { deleted: id }
  }
)

// -- Graph --

tool(
  'get_graph',
  {
    title: 'Get graph',
    description: 'Get the full graph of people (nodes) and relationships (edges)',
    inputSchema: {},
  },
  () => api('/api/graph')
)

tool(
  'get_subgraph',
  {
    title: 'Get local subgraph',
    description:
      'Get the local neighborhood graph (nodes and edges) within N hops of a given contact — e.g. depth 1 is just their ' +
      'direct connections, depth 2 also includes friends-of-friends. Use for "who is X connected to" questions or before ' +
      'rendering a focused view; use get_graph instead if you need the whole CRM.',
    inputSchema: { contact_id: z.number(), depth: z.number().min(1).max(4).default(1) },
  },
  ({ contact_id, depth }) => api(`/api/contacts/${contact_id}/subgraph?depth=${depth || 1}`)
)

tool(
  'get_relationship_path_to_me',
  {
    title: 'Get relationship path to "me"',
    description:
      'Find the shortest chain of relationships connecting a given contact back to the "me" contact (e.g. "You → spouse → ' +
      'Akshata → friend → Mahi"). Use this to answer "how do I know X" / "how is X related to me" questions directly — ' +
      'it does the graph traversal for you, so prefer it over manually walking list_relationships yourself.',
    inputSchema: { contact_id: z.number() },
  },
  ({ contact_id }) => api(`/api/contacts/${contact_id}/path-to-me`)
)

// -- "Me" (who are you) --

tool(
  'get_me',
  {
    title: 'Get "me" contact',
    description: 'Get the contact designated as the CRM owner ("me"), if one has been set',
    inputSchema: {},
  },
  () => api('/api/me')
)

tool(
  'set_me',
  {
    title: 'Set "me" contact',
    description: 'Designate which contact represents the CRM owner ("me")',
    inputSchema: { contact_id: z.number() },
  },
  ({ contact_id }) => api('/api/me', { method: 'PUT', body: JSON.stringify({ contact_id }) })
)

tool(
  'clear_me',
  {
    title: 'Clear "me" contact',
    description: 'Unset the "me" designation',
    inputSchema: {},
  },
  async () => {
    await api('/api/me', { method: 'DELETE' })
    return { cleared: true }
  }
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error('graph-crm MCP server failed to start:', err)
  process.exit(1)
})
