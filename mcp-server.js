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

function json(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true }
}

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

// -- Contacts --

server.registerTool(
  'list_contacts',
  {
    title: 'List contacts',
    description:
      'List every person in the CRM with their core fields (name, email, phone, company, title, DOB, address, notes). ' +
      'This is the starting point for almost any task: use it to find a contact\'s id by name before calling other tools, ' +
      'or to get an overview of who is in the CRM. Does not include relationships — use get_contact or list_relationships for those.',
    inputSchema: {},
  },
  async () => {
    try {
      return json(await api('/api/contacts'))
    } catch (err) {
      return errorResult(err.message)
    }
  }
)

server.registerTool(
  'find_duplicate_contacts',
  {
    title: 'Find duplicate contacts',
    description:
      'Find groups of contacts that are likely duplicates of the same person, grouped by exact (case-insensitive) name match ' +
      'and separately by matching phone number (last 10 digits, ignoring formatting/country code). Use this before merge_contacts ' +
      'to decide what to merge — it does not change any data.',
    inputSchema: {},
  },
  async () => {
    try {
      return json(await api('/api/contacts/duplicates'))
    } catch (err) {
      return errorResult(err.message)
    }
  }
)

server.registerTool(
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
  async ({ primary_id, duplicate_ids }) => {
    try {
      return json(
        await api('/api/contacts/merge', { method: 'POST', body: JSON.stringify({ primary_id, duplicate_ids }) })
      )
    } catch (err) {
      return errorResult(err.message)
    }
  }
)

server.registerTool(
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
    try {
      const [contact, allRelationships, interactions] = await Promise.all([
        api(`/api/contacts/${id}`),
        api('/api/relationships'),
        api(`/api/contacts/${id}/interactions`),
      ])
      const relationships = allRelationships.filter((r) => r.source_id === id || r.target_id === id)
      return json({ ...contact, relationships, interactions })
    } catch (err) {
      return errorResult(err.message)
    }
  }
)

server.registerTool(
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
  async (args) => {
    try {
      return json(await api('/api/contacts', { method: 'POST', body: JSON.stringify(args) }))
    } catch (err) {
      return errorResult(err.message)
    }
  }
)

server.registerTool(
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
    try {
      const existing = await api(`/api/contacts/${id}`)
      const merged = { ...existing, ...fields }
      return json(await api(`/api/contacts/${id}`, { method: 'PUT', body: JSON.stringify(merged) }))
    } catch (err) {
      return errorResult(err.message)
    }
  }
)

server.registerTool(
  'delete_all_contacts',
  {
    title: 'Delete ALL contacts',
    description:
      'Permanently delete every contact, relationship, and note in the CRM. Irreversible — requires confirm: true.',
    inputSchema: { confirm: z.literal(true) },
  },
  async () => {
    try {
      return json(await api('/api/contacts?confirm=DELETE_ALL', { method: 'DELETE' }))
    } catch (err) {
      return errorResult(err.message)
    }
  }
)

server.registerTool(
  'import_vcard',
  {
    title: 'Import contacts from vCard',
    description:
      'Bulk-import contacts from vCard (.vcf) text, as exported by Google Contacts or Apple Contacts. Deduplicates by email and phone.',
    inputSchema: { vcard: z.string().min(1) },
  },
  async ({ vcard }) => {
    try {
      return json(await api('/api/contacts/import', { method: 'POST', body: JSON.stringify({ vcard }) }))
    } catch (err) {
      return errorResult(err.message)
    }
  }
)

server.registerTool(
  'import_relationships_csv',
  {
    title: 'Bulk import relationships from CSV',
    description:
      'Bulk-create relationships from CSV text with columns source,target,type,notes. People are matched by exact email or exact name.',
    inputSchema: { csv: z.string().min(1) },
  },
  async ({ csv }) => {
    try {
      return json(await api('/api/relationships/import', { method: 'POST', body: JSON.stringify({ csv }) }))
    } catch (err) {
      return errorResult(err.message)
    }
  }
)

server.registerTool(
  'get_directory',
  {
    title: 'Get contact directory',
    description:
      'List every contact with their email, phone, company, title, date of birth, address, and inferred spouse — a flat ' +
      'export-style view. Prefer list_contacts for general lookups; use this specifically when the spouse field or a ' +
      'full-fields export is what\'s needed.',
    inputSchema: {},
  },
  async () => {
    try {
      return json(await api('/api/directory'))
    } catch (err) {
      return errorResult(err.message)
    }
  }
)

server.registerTool(
  'delete_contact',
  {
    title: 'Delete contact',
    description: 'Delete a contact and their relationships/interactions',
    inputSchema: { id: z.number() },
  },
  async ({ id }) => {
    try {
      await api(`/api/contacts/${id}`, { method: 'DELETE' })
      return json({ deleted: id })
    } catch (err) {
      return errorResult(err.message)
    }
  }
)

// -- Relationships --

server.registerTool(
  'list_relationships',
  {
    title: 'List relationships',
    description:
      'List every relationship (edge) in the CRM as {source_id, target_id, type}. This is the raw edge list for the whole ' +
      'graph — for "how is X related to me" prefer get_relationship_path_to_me, and for one contact\'s relationships prefer ' +
      'get_contact, which already filters this down for you.',
    inputSchema: {},
  },
  async () => {
    try {
      return json(await api('/api/relationships'))
    } catch (err) {
      return errorResult(err.message)
    }
  }
)

server.registerTool(
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
  async (args) => {
    try {
      return json(await api('/api/relationships', { method: 'POST', body: JSON.stringify(args) }))
    } catch (err) {
      return errorResult(err.message)
    }
  }
)

server.registerTool(
  'delete_relationship',
  {
    title: 'Delete relationship',
    description: 'Delete a relationship by id',
    inputSchema: { id: z.number() },
  },
  async ({ id }) => {
    try {
      await api(`/api/relationships/${id}`, { method: 'DELETE' })
      return json({ deleted: id })
    } catch (err) {
      return errorResult(err.message)
    }
  }
)

// -- Interactions (notes & conversations) --

server.registerTool(
  'list_interactions',
  {
    title: 'List interactions',
    description: 'List notes/conversations logged for a contact, most recent first',
    inputSchema: { contact_id: z.number() },
  },
  async ({ contact_id }) => {
    try {
      return json(await api(`/api/contacts/${contact_id}/interactions`))
    } catch (err) {
      return errorResult(err.message)
    }
  }
)

server.registerTool(
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
  async ({ contact_id, ...rest }) => {
    try {
      return json(
        await api(`/api/contacts/${contact_id}/interactions`, { method: 'POST', body: JSON.stringify(rest) })
      )
    } catch (err) {
      return errorResult(err.message)
    }
  }
)

server.registerTool(
  'delete_interaction',
  {
    title: 'Delete interaction',
    description: 'Delete a logged interaction by id',
    inputSchema: { id: z.number() },
  },
  async ({ id }) => {
    try {
      await api(`/api/interactions/${id}`, { method: 'DELETE' })
      return json({ deleted: id })
    } catch (err) {
      return errorResult(err.message)
    }
  }
)

// -- Graph --

server.registerTool(
  'get_graph',
  {
    title: 'Get graph',
    description: 'Get the full graph of people (nodes) and relationships (edges)',
    inputSchema: {},
  },
  async () => {
    try {
      return json(await api('/api/graph'))
    } catch (err) {
      return errorResult(err.message)
    }
  }
)

server.registerTool(
  'get_subgraph',
  {
    title: 'Get local subgraph',
    description:
      'Get the local neighborhood graph (nodes and edges) within N hops of a given contact — e.g. depth 1 is just their ' +
      'direct connections, depth 2 also includes friends-of-friends. Use for "who is X connected to" questions or before ' +
      'rendering a focused view; use get_graph instead if you need the whole CRM.',
    inputSchema: { contact_id: z.number(), depth: z.number().min(1).max(4).default(1) },
  },
  async ({ contact_id, depth }) => {
    try {
      return json(await api(`/api/contacts/${contact_id}/subgraph?depth=${depth || 1}`))
    } catch (err) {
      return errorResult(err.message)
    }
  }
)

server.registerTool(
  'get_relationship_path_to_me',
  {
    title: 'Get relationship path to "me"',
    description:
      'Find the shortest chain of relationships connecting a given contact back to the "me" contact (e.g. "You → spouse → ' +
      'Akshata → friend → Mahi"). Use this to answer "how do I know X" / "how is X related to me" questions directly — ' +
      'it does the graph traversal for you, so prefer it over manually walking list_relationships yourself.',
    inputSchema: { contact_id: z.number() },
  },
  async ({ contact_id }) => {
    try {
      return json(await api(`/api/contacts/${contact_id}/path-to-me`))
    } catch (err) {
      return errorResult(err.message)
    }
  }
)

// -- "Me" (who are you) --

server.registerTool(
  'get_me',
  {
    title: 'Get "me" contact',
    description: 'Get the contact designated as the CRM owner ("me"), if one has been set',
    inputSchema: {},
  },
  async () => {
    try {
      return json(await api('/api/me'))
    } catch (err) {
      return errorResult(err.message)
    }
  }
)

server.registerTool(
  'set_me',
  {
    title: 'Set "me" contact',
    description: 'Designate which contact represents the CRM owner ("me")',
    inputSchema: { contact_id: z.number() },
  },
  async ({ contact_id }) => {
    try {
      return json(await api('/api/me', { method: 'PUT', body: JSON.stringify({ contact_id }) }))
    } catch (err) {
      return errorResult(err.message)
    }
  }
)

server.registerTool(
  'clear_me',
  {
    title: 'Clear "me" contact',
    description: 'Unset the "me" designation',
    inputSchema: {},
  },
  async () => {
    try {
      await api('/api/me', { method: 'DELETE' })
      return json({ cleared: true })
    } catch (err) {
      return errorResult(err.message)
    }
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
