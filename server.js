const express = require('express')
const session = require('express-session')
const FileStore = require('session-file-store')(session)
const path = require('path')
const prisma = require('./prisma/client')
const auth = require('./auth')
const family = require('./family')
const { parseVCards } = require('./vcard')
const { parseCSV } = require('./csv')

const app = express()
const PORT = process.env.PORT || 3000
const DATA_DIR = process.env.DATA_DIR || __dirname

app.use(express.json({ limit: '50mb' }))
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'File is too large to import (max 50MB).' })
  }
  if (err.status === 400 && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed request body.' })
  }
  next(err)
})

app.use(
  session({
    store: new FileStore({ path: path.join(DATA_DIR, '.sessions'), logFn: () => {} }),
    secret: auth.getOrCreateSessionSecret(),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 },
  })
)

// -- Auth --

app.get('/api/auth/status', async (req, res) => {
  res.json({
    hasCredential: await auth.hasAnyCredential(),
    authenticated: !!(req.session && req.session.contactId),
  })
})

app.post('/api/auth/register/options', async (req, res) => {
  try {
    res.json(await auth.getRegistrationOptions(req))
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

app.post('/api/auth/register/verify', async (req, res) => {
  try {
    res.json(await auth.verifyRegistration(req, req.body.response, req.body.name))
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

app.post('/api/auth/login/options', async (req, res) => {
  try {
    res.json(await auth.getAuthenticationOptions(req))
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

app.post('/api/auth/login/verify', async (req, res) => {
  try {
    res.json(await auth.verifyAuthentication(req, req.body.response))
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.status(204).end())
})

app.use(auth.requireAuth)
app.use(express.static(path.join(__dirname, 'public')))

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function validateContact(body) {
  if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
    return 'name is required'
  }
  if (body.date_of_birth) {
    if (!ISO_DATE_RE.test(body.date_of_birth) || Number.isNaN(Date.parse(body.date_of_birth))) {
      return 'date_of_birth must be a valid date in YYYY-MM-DD format'
    }
  }
  return null
}

function formatTimestamp(date) {
  if (!date) return null
  return date.toISOString().replace('T', ' ').slice(0, 19)
}

function toContactJson(c) {
  return {
    id: c.id,
    name: c.name,
    email: c.email,
    company: c.company,
    title: c.title,
    phone: c.phone,
    date_of_birth: c.dateOfBirth,
    address: c.address,
    notes: c.notes,
    created_at: formatTimestamp(c.createdAt),
  }
}

function toRelationshipJson(r) {
  return {
    id: r.id,
    source_id: r.sourceId,
    target_id: r.targetId,
    type: r.type,
    notes: r.notes,
    created_at: formatTimestamp(r.createdAt),
  }
}

function toInteractionJson(i) {
  return {
    id: i.id,
    contact_id: i.contactId,
    type: i.type,
    content: i.content,
    occurred_at: formatTimestamp(i.occurredAt),
    created_at: formatTimestamp(i.createdAt),
  }
}

function contactDataFromBody(body) {
  return {
    name: body.name.trim(),
    email: body.email || null,
    company: body.company || null,
    title: body.title || null,
    phone: body.phone || null,
    dateOfBirth: body.date_of_birth || null,
    address: body.address || null,
    notes: body.notes || null,
  }
}

// -- Contacts --

app.get('/api/contacts', async (req, res) => {
  const contacts = await prisma.contact.findMany({ orderBy: { name: 'asc' } })
  res.json(contacts.map(toContactJson))
})

function normalizePhoneForDedup(phone) {
  if (!phone) return null
  const digits = phone.replace(/[^0-9]/g, '')
  if (digits.length < 7) return null
  return digits.slice(-10)
}

app.get('/api/contacts/duplicates', async (req, res) => {
  const contacts = await prisma.contact.findMany()

  const byName = new Map()
  const byPhone = new Map()
  for (const c of contacts) {
    const nameKey = c.name.trim().toLowerCase()
    if (!byName.has(nameKey)) byName.set(nameKey, [])
    byName.get(nameKey).push(c)

    const phoneKey = normalizePhoneForDedup(c.phone)
    if (phoneKey) {
      if (!byPhone.has(phoneKey)) byPhone.set(phoneKey, [])
      byPhone.get(phoneKey).push(c)
    }
  }

  res.json({
    byName: Array.from(byName.values()).filter((g) => g.length > 1).map((g) => g.map(toContactJson)),
    byPhone: Array.from(byPhone.values()).filter((g) => g.length > 1).map((g) => g.map(toContactJson)),
  })
})

app.post('/api/contacts/merge', async (req, res) => {
  const { primary_id, duplicate_ids } = req.body
  if (!primary_id || !Array.isArray(duplicate_ids) || duplicate_ids.length === 0) {
    return res.status(400).json({ error: 'primary_id and duplicate_ids are required' })
  }

  let primary = await prisma.contact.findUnique({ where: { id: primary_id } })
  if (!primary) return res.status(400).json({ error: 'primary contact not found' })

  const fillableFields = ['email', 'company', 'title', 'phone', 'dateOfBirth', 'address', 'notes']

  for (const dupId of duplicate_ids) {
    if (dupId === primary_id) continue
    const dup = await prisma.contact.findUnique({ where: { id: dupId } })
    if (!dup) continue

    const updates = {}
    for (const field of fillableFields) {
      if (!primary[field] && dup[field]) updates[field] = dup[field]
    }
    if (Object.keys(updates).length > 0) {
      primary = await prisma.contact.update({ where: { id: primary_id }, data: updates })
    }

    await Promise.all([
      prisma.interaction.updateMany({ where: { contactId: dupId }, data: { contactId: primary_id } }),
      prisma.credential.updateMany({ where: { contactId: dupId }, data: { contactId: primary_id } }),
      prisma.institutionAffiliation.updateMany({ where: { contactId: dupId }, data: { contactId: primary_id } }),
    ])

    const dupMemberships = await prisma.familyUnitMember.findMany({ where: { contactId: dupId } })
    for (const m of dupMemberships) {
      const existing = await prisma.familyUnitMember.findUnique({
        where: { familyUnitId_contactId: { familyUnitId: m.familyUnitId, contactId: primary_id } },
      })
      if (existing) {
        await prisma.familyUnitMember.delete({ where: { id: m.id } })
      } else {
        await prisma.familyUnitMember.update({ where: { id: m.id }, data: { contactId: primary_id } })
      }
    }

    if ((await auth.getMeContactId()) === dupId) {
      await auth.setMeContactId(primary_id)
    }

    await prisma.contact.delete({ where: { id: dupId } })
  }

  res.json(toContactJson(await prisma.contact.findUnique({ where: { id: primary_id } })))
})

app.post('/api/contacts', async (req, res) => {
  const error = validateContact(req.body)
  if (error) return res.status(400).json({ error })

  const contact = await prisma.contact.create({ data: contactDataFromBody(req.body) })
  res.status(201).json(toContactJson(contact))
})

app.get('/api/contacts/:id', async (req, res) => {
  const contact = await prisma.contact.findUnique({ where: { id: Number(req.params.id) } })
  if (!contact) return res.status(404).json({ error: 'contact not found' })
  res.json(toContactJson(contact))
})

app.put('/api/contacts/:id', async (req, res) => {
  const id = Number(req.params.id)
  const existing = await prisma.contact.findUnique({ where: { id } })
  if (!existing) return res.status(404).json({ error: 'contact not found' })

  const error = validateContact(req.body)
  if (error) return res.status(400).json({ error })

  const contact = await prisma.contact.update({ where: { id }, data: contactDataFromBody(req.body) })
  res.json(toContactJson(contact))
})

app.delete('/api/contacts', async (req, res) => {
  if (req.query.confirm !== 'DELETE_ALL') {
    return res.status(400).json({ error: 'confirmation required' })
  }
  const result = await prisma.contact.deleteMany({})
  res.json({ deleted: result.count })
})

app.delete('/api/contacts/:id', async (req, res) => {
  try {
    await prisma.contact.delete({ where: { id: Number(req.params.id) } })
  } catch (err) {
    return res.status(404).json({ error: 'contact not found' })
  }
  res.status(204).end()
})

app.post('/api/contacts/import', async (req, res) => {
  const { vcard } = req.body
  if (!vcard || typeof vcard !== 'string') {
    return res.status(400).json({ error: 'vcard text is required' })
  }

  let parsed
  try {
    parsed = parseVCards(vcard)
  } catch (err) {
    return res.status(400).json({ error: 'could not parse vCard file' })
  }

  const existingContacts = await prisma.contact.findMany({ select: { email: true, phone: true } })
  const existingEmails = new Set(existingContacts.map((c) => c.email).filter(Boolean))
  const existingPhones = new Set(existingContacts.map((c) => normalizePhoneForDedup(c.phone)).filter(Boolean))

  let imported = 0
  let skipped = 0
  const errors = []
  const toCreate = []

  for (const c of parsed) {
    const error = validateContact(c)
    if (error) {
      errors.push(`${c.name || '(unnamed)'}: ${error}`)
      continue
    }
    if (c.email && existingEmails.has(c.email)) {
      skipped++
      continue
    }
    const normalizedPhone = normalizePhoneForDedup(c.phone)
    if (normalizedPhone && existingPhones.has(normalizedPhone)) {
      skipped++
      continue
    }
    toCreate.push({
      name: c.name.trim(),
      email: c.email || null,
      company: c.company || null,
      title: c.title || null,
      phone: c.phone || null,
      dateOfBirth: c.date_of_birth || null,
      address: c.address || null,
    })
    if (c.email) existingEmails.add(c.email)
    if (normalizedPhone) existingPhones.add(normalizedPhone)
    imported++
  }

  if (toCreate.length > 0) {
    await prisma.contact.createMany({ data: toCreate })
  }

  res.json({ imported, skipped, total: parsed.length, errors })
})

// -- Relationships (live model: family.js / FamilyUnit — see CLAUDE.md) --

app.get('/api/relationships', async (req, res) => {
  const rels = await family.getAllRelationships()
  res.json(rels.map(toRelationshipJson))
})

app.post('/api/relationships', async (req, res) => {
  const { source_id, target_id, type, notes } = req.body
  if (!source_id || !target_id) {
    return res.status(400).json({ error: 'source_id and target_id are required' })
  }
  if (source_id === target_id) {
    return res.status(400).json({ error: 'a contact cannot have a relationship with itself' })
  }

  const [source, target] = await Promise.all([
    prisma.contact.findUnique({ where: { id: source_id } }),
    prisma.contact.findUnique({ where: { id: target_id } }),
  ])
  if (!source || !target) {
    return res.status(400).json({ error: 'source_id or target_id does not exist' })
  }

  try {
    const rel = await family.createRelationship(source_id, target_id, type || 'knows', notes)
    res.status(201).json(toRelationshipJson(rel))
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

app.post('/api/relationships/import', async (req, res) => {
  const { csv } = req.body
  if (!csv || typeof csv !== 'string') {
    return res.status(400).json({ error: 'csv text is required' })
  }

  let rows
  try {
    rows = parseCSV(csv)
  } catch (err) {
    return res.status(400).json({ error: 'could not parse CSV file' })
  }

  const allContacts = await prisma.contact.findMany({ select: { id: true, name: true, email: true } })
  const byEmail = new Map()
  const byName = new Map()
  for (const c of allContacts) {
    if (c.email) {
      const key = c.email.toLowerCase()
      if (!byEmail.has(key)) byEmail.set(key, [])
      byEmail.get(key).push(c)
    }
    const nameKey = c.name.toLowerCase()
    if (!byName.has(nameKey)) byName.set(nameKey, [])
    byName.get(nameKey).push(c)
  }

  function resolveContact(value) {
    if (!value) return { error: 'missing value' }
    const matches = value.includes('@')
      ? byEmail.get(value.toLowerCase()) || []
      : byName.get(value.toLowerCase()) || []
    if (matches.length === 0) return { error: `no contact found matching "${value}"` }
    if (matches.length > 1) return { error: `multiple contacts named "${value}" — use email instead` }
    return { id: matches[0].id }
  }

  const existingRels = await family.getAllRelationships()
  const dedupeKey = (a, b, type) => `${Math.min(a, b)}:${Math.max(a, b)}:${type}`
  const existingSet = new Set(existingRels.map((r) => dedupeKey(r.sourceId, r.targetId, r.type)))

  let imported = 0
  let skipped = 0
  const errors = []

  for (const [idx, r] of rows.entries()) {
    const rowNum = idx + 2 // account for header row, 1-indexed
    const sourceValue = r.source || r.from
    const targetValue = r.target || r.to
    if (!sourceValue || !targetValue) {
      errors.push(`row ${rowNum}: source and target are required`)
      continue
    }

    const source = resolveContact(sourceValue)
    if (source.error) {
      errors.push(`row ${rowNum}: ${source.error}`)
      continue
    }
    const target = resolveContact(targetValue)
    if (target.error) {
      errors.push(`row ${rowNum}: ${target.error}`)
      continue
    }
    if (source.id === target.id) {
      errors.push(`row ${rowNum}: source and target are the same contact`)
      continue
    }

    const type = r.type || 'knows'
    const key = dedupeKey(source.id, target.id, type)
    if (existingSet.has(key)) {
      skipped++
      continue
    }

    try {
      await family.createRelationship(source.id, target.id, type, r.notes || null)
      existingSet.add(key)
      imported++
    } catch (err) {
      errors.push(`row ${rowNum}: ${err.message}`)
    }
  }

  res.json({ imported, skipped, total: rows.length, errors })
})

app.delete('/api/relationships/:id', async (req, res) => {
  try {
    await family.deleteRelationship(req.params.id)
  } catch (err) {
    return res.status(err.status || 404).json({ error: err.message || 'relationship not found' })
  }
  res.status(204).end()
})

// -- Interactions (notes & conversations) --

app.get('/api/contacts/:id/interactions', async (req, res) => {
  const contactId = Number(req.params.id)
  const contact = await prisma.contact.findUnique({ where: { id: contactId } })
  if (!contact) return res.status(404).json({ error: 'contact not found' })

  const interactions = await prisma.interaction.findMany({
    where: { contactId },
    orderBy: { occurredAt: 'desc' },
  })
  res.json(interactions.map(toInteractionJson))
})

app.post('/api/contacts/:id/interactions', async (req, res) => {
  const contactId = Number(req.params.id)
  const contact = await prisma.contact.findUnique({ where: { id: contactId } })
  if (!contact) return res.status(404).json({ error: 'contact not found' })

  const { type, content, occurred_at } = req.body
  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'content is required' })
  }

  const interaction = await prisma.interaction.create({
    data: {
      contactId,
      type: type || 'note',
      content: content.trim(),
      occurredAt: occurred_at ? new Date(occurred_at) : undefined,
    },
  })
  res.status(201).json(toInteractionJson(interaction))
})

app.delete('/api/interactions/:id', async (req, res) => {
  try {
    await prisma.interaction.delete({ where: { id: Number(req.params.id) } })
  } catch (err) {
    return res.status(404).json({ error: 'interaction not found' })
  }
  res.status(204).end()
})

// -- Institutions --

function toInstitutionJson(inst) {
  return {
    id: inst.id,
    name: inst.name,
    type: inst.type,
    created_at: formatTimestamp(inst.createdAt),
    ...(inst.affiliations
      ? { member_count: inst.affiliations.length }
      : typeof inst._count === 'object'
        ? { member_count: inst._count.affiliations }
        : {}),
  }
}

function toAffiliationJson(a) {
  return {
    id: a.id,
    institution_id: a.institutionId,
    contact_id: a.contactId,
    role: a.role,
    start_date: a.startDate,
    end_date: a.endDate,
    created_at: formatTimestamp(a.createdAt),
    ...(a.institution ? { institution: toInstitutionJson(a.institution) } : {}),
    ...(a.contact ? { contact: toContactJson(a.contact) } : {}),
  }
}

const ISO_DATE_RE_INST = /^\d{4}-\d{2}-\d{2}$/
function validateDateField(value, fieldName) {
  if (value == null || value === '') return null
  if (!ISO_DATE_RE_INST.test(value) || Number.isNaN(Date.parse(value))) {
    return `${fieldName} must be a valid date in YYYY-MM-DD format`
  }
  return null
}

app.get('/api/institutions', async (req, res) => {
  const institutions = await prisma.institution.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { affiliations: true } } },
  })
  res.json(institutions.map(toInstitutionJson))
})

// Flat list of every affiliation, for building client-side filters/lookups
// without an N+1 fetch per institution.
app.get('/api/affiliations', async (req, res) => {
  const affiliations = await prisma.institutionAffiliation.findMany()
  res.json(affiliations.map(toAffiliationJson))
})

app.post('/api/institutions', async (req, res) => {
  const { name, type } = req.body
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' })
  }
  const institution = await prisma.institution.create({
    data: { name: name.trim(), type: type || 'organization' },
  })
  res.status(201).json(toInstitutionJson(institution))
})

app.get('/api/institutions/:id', async (req, res) => {
  const institution = await prisma.institution.findUnique({
    where: { id: Number(req.params.id) },
    include: { affiliations: { include: { contact: true } } },
  })
  if (!institution) return res.status(404).json({ error: 'institution not found' })
  res.json({
    ...toInstitutionJson(institution),
    members: institution.affiliations.map(toAffiliationJson),
  })
})

app.put('/api/institutions/:id', async (req, res) => {
  const id = Number(req.params.id)
  const existing = await prisma.institution.findUnique({ where: { id } })
  if (!existing) return res.status(404).json({ error: 'institution not found' })

  const { name, type } = req.body
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' })
  }
  const institution = await prisma.institution.update({
    where: { id },
    data: { name: name.trim(), type: type || existing.type },
  })
  res.json(toInstitutionJson(institution))
})

app.delete('/api/institutions/:id', async (req, res) => {
  try {
    await prisma.institution.delete({ where: { id: Number(req.params.id) } })
  } catch (err) {
    return res.status(404).json({ error: 'institution not found' })
  }
  res.status(204).end()
})

app.get('/api/contacts/:id/affiliations', async (req, res) => {
  const contactId = Number(req.params.id)
  const contact = await prisma.contact.findUnique({ where: { id: contactId } })
  if (!contact) return res.status(404).json({ error: 'contact not found' })

  const affiliations = await prisma.institutionAffiliation.findMany({
    where: { contactId },
    include: { institution: true },
    orderBy: { createdAt: 'desc' },
  })
  res.json(affiliations.map(toAffiliationJson))
})

app.post('/api/contacts/:id/affiliations', async (req, res) => {
  const contactId = Number(req.params.id)
  const contact = await prisma.contact.findUnique({ where: { id: contactId } })
  if (!contact) return res.status(404).json({ error: 'contact not found' })

  const { institution_id, institution_name, institution_type, role, start_date, end_date } = req.body
  if (!institution_id && !institution_name) {
    return res.status(400).json({ error: 'institution_id or institution_name is required' })
  }

  const startError = validateDateField(start_date, 'start_date')
  if (startError) return res.status(400).json({ error: startError })
  const endError = validateDateField(end_date, 'end_date')
  if (endError) return res.status(400).json({ error: endError })

  let institution
  if (institution_id) {
    institution = await prisma.institution.findUnique({ where: { id: institution_id } })
    if (!institution) return res.status(400).json({ error: 'institution_id does not exist' })
  } else {
    // Find-or-create by exact (case-insensitive) name, so re-typing the same
    // institution from the UI doesn't spawn duplicate records.
    const name = institution_name.trim()
    const candidates = await prisma.institution.findMany()
    institution = candidates.find((i) => i.name.toLowerCase() === name.toLowerCase())
    if (!institution) {
      institution = await prisma.institution.create({
        data: { name, type: institution_type || 'organization' },
      })
    }
  }

  const affiliation = await prisma.institutionAffiliation.create({
    data: {
      institutionId: institution.id,
      contactId,
      role: role || null,
      startDate: start_date || null,
      endDate: end_date || null,
    },
    include: { institution: true },
  })
  res.status(201).json(toAffiliationJson(affiliation))
})

app.delete('/api/affiliations/:id', async (req, res) => {
  try {
    await prisma.institutionAffiliation.delete({ where: { id: Number(req.params.id) } })
  } catch (err) {
    return res.status(404).json({ error: 'affiliation not found' })
  }
  res.status(204).end()
})

// -- Directory --

app.get('/api/directory', async (req, res) => {
  const contacts = await prisma.contact.findMany({ orderBy: { name: 'asc' } })
  const allRelationships = await family.getAllRelationships()
  const spouseRels = allRelationships.filter((r) => r.type === 'spouse')
  const contactsById = new Map(contacts.map((c) => [c.id, c]))

  const spouseByContactId = new Map()
  for (const r of spouseRels) {
    const source = contactsById.get(r.sourceId)
    const target = contactsById.get(r.targetId)
    if (source && target) {
      spouseByContactId.set(r.sourceId, target.name)
      spouseByContactId.set(r.targetId, source.name)
    }
  }

  res.json(
    contacts.map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email,
      phone: c.phone,
      company: c.company,
      title: c.title,
      date_of_birth: c.dateOfBirth,
      address: c.address,
      spouse: spouseByContactId.get(c.id) || null,
    }))
  )
})

// -- Combined graph data --

function toNode(c) {
  return {
    id: c.id,
    label: c.name,
    company: c.company,
    title: c.title,
    email: c.email,
    phone: c.phone,
    date_of_birth: c.dateOfBirth,
    address: c.address,
    notes: c.notes,
  }
}

function toEdge(r) {
  return { id: r.id, from: r.sourceId, to: r.targetId, label: r.type, notes: r.notes }
}

app.get('/api/graph', async (req, res) => {
  const contacts = await prisma.contact.findMany()
  const relationships = await family.getAllRelationships()
  res.json({
    nodes: contacts.map(toNode),
    edges: relationships.map(toEdge),
  })
})

app.get('/api/contacts/:id/subgraph', async (req, res) => {
  const rootId = Number(req.params.id)
  const root = await prisma.contact.findUnique({ where: { id: rootId } })
  if (!root) return res.status(404).json({ error: 'contact not found' })

  const depth = Math.min(Math.max(Number(req.query.depth) || 1, 1), 4)
  const allRelationships = await family.getAllRelationships()

  const visited = new Set([rootId])
  let frontier = new Set([rootId])
  const includedEdges = new Map()

  for (let hop = 0; hop < depth; hop++) {
    const nextFrontier = new Set()
    for (const r of allRelationships) {
      const touchesFrontier = frontier.has(r.sourceId) || frontier.has(r.targetId)
      if (!touchesFrontier) continue
      includedEdges.set(r.id, r)
      const other = frontier.has(r.sourceId) ? r.targetId : r.sourceId
      if (!visited.has(other)) {
        visited.add(other)
        nextFrontier.add(other)
      }
    }
    if (nextFrontier.size === 0) break
    frontier = nextFrontier
  }

  const contacts = await prisma.contact.findMany({ where: { id: { in: Array.from(visited) } } })

  res.json({
    rootId,
    nodes: contacts.map(toNode),
    edges: Array.from(includedEdges.values()).map(toEdge),
  })
})

app.get('/api/contacts/:id/path-to-me', async (req, res) => {
  const targetId = Number(req.params.id)
  const meId = await auth.getMeContactId()
  if (meId == null) return res.json({ path: null })

  if (targetId === meId) return res.json({ path: [] })

  const allRelationships = await family.getAllRelationships()
  const adjacency = new Map() // contactId -> [{ otherId, type, fromThem }]
  for (const r of allRelationships) {
    if (!adjacency.has(r.sourceId)) adjacency.set(r.sourceId, [])
    if (!adjacency.has(r.targetId)) adjacency.set(r.targetId, [])
    adjacency.get(r.sourceId).push({ otherId: r.targetId, type: r.type, fromThem: false })
    adjacency.get(r.targetId).push({ otherId: r.sourceId, type: r.type, fromThem: true })
  }

  // BFS from me to target, capped so we don't chase huge unrelated components.
  const MAX_HOPS = 6
  const visited = new Set([meId])
  const queue = [{ id: meId, path: [] }]
  let result = null

  while (queue.length > 0) {
    const { id, path } = queue.shift()
    if (id === targetId) {
      result = path
      break
    }
    if (path.length >= MAX_HOPS) continue
    for (const edge of adjacency.get(id) || []) {
      if (visited.has(edge.otherId)) continue
      visited.add(edge.otherId)
      queue.push({ id: edge.otherId, path: [...path, { contactId: edge.otherId, type: edge.type, fromThem: edge.fromThem }] })
    }
  }

  if (!result) return res.json({ path: null })

  const contactIds = [meId, ...result.map((step) => step.contactId)]
  const contacts = await prisma.contact.findMany({ where: { id: { in: contactIds } } })
  const contactsById = new Map(contacts.map((c) => [c.id, toContactJson(c)]))

  res.json({
    path: result.map((step) => ({
      contact: contactsById.get(step.contactId),
      type: step.type,
      fromThem: step.fromThem,
    })),
  })
})

// -- App settings ("me") --

app.get('/api/me', async (req, res) => {
  const meId = await auth.getMeContactId()
  if (meId == null) return res.json({ contact: null })
  const contact = await prisma.contact.findUnique({ where: { id: meId } })
  res.json({ contact: contact ? toContactJson(contact) : null })
})

app.put('/api/me', async (req, res) => {
  const { contact_id } = req.body
  if (!contact_id) return res.status(400).json({ error: 'contact_id is required' })
  const contact = await prisma.contact.findUnique({ where: { id: contact_id } })
  if (!contact) return res.status(400).json({ error: 'contact not found' })

  await auth.setMeContactId(contact_id)
  res.json({ contact: toContactJson(contact) })
})

app.delete('/api/me', async (req, res) => {
  await prisma.appSetting.deleteMany({ where: { key: 'me_contact_id' } })
  res.status(204).end()
})

// -- API keys (multiple, named, generated from Settings; usable for the HTTP API and MCP) --

app.get('/api/settings/api-keys', async (req, res) => {
  res.json(await auth.listApiKeys())
})

app.post('/api/settings/api-keys', async (req, res) => {
  try {
    res.status(201).json(await auth.createApiKey(req.body.label))
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

app.delete('/api/settings/api-keys/:id', async (req, res) => {
  try {
    await auth.revokeApiKeyById(Number(req.params.id))
  } catch (err) {
    return res.status(404).json({ error: 'api key not found' })
  }
  res.status(204).end()
})

app.listen(PORT, () => {
  console.log(`graph-crm running at http://localhost:${PORT}`)
})
