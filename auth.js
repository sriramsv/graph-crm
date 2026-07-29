const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server')
const prisma = require('./prisma/client')

const RP_NAME = 'Graph CRM'
const RP_ID = process.env.RP_ID || 'localhost'
const ORIGIN = process.env.ORIGIN || `http://${RP_ID}:${process.env.PORT || 3000}`

const DATA_DIR = process.env.DATA_DIR || __dirname
const SESSION_SECRET_PATH = path.join(DATA_DIR, '.session-secret')

function getOrCreateSessionSecret() {
  if (fs.existsSync(SESSION_SECRET_PATH)) {
    return fs.readFileSync(SESSION_SECRET_PATH, 'utf8').trim()
  }
  const key = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(SESSION_SECRET_PATH, key, { mode: 0o600 })
  return key
}

function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex')
}

// -- API keys (multiple, named, hashed at rest, shown in full only once) --

async function listApiKeys() {
  const keys = await prisma.apiKey.findMany({ orderBy: { createdAt: 'desc' } })
  return keys.map((k) => ({
    id: k.id,
    label: k.label,
    keyPrefix: k.keyPrefix,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
  }))
}

async function createApiKey(label) {
  if (!label || !label.trim()) {
    throw Object.assign(new Error('label is required'), { status: 400 })
  }
  const rawKey = crypto.randomBytes(32).toString('base64url')
  const created = await prisma.apiKey.create({
    data: {
      label: label.trim(),
      keyHash: hashApiKey(rawKey),
      keyPrefix: rawKey.slice(0, 8),
    },
  })
  // The raw key is returned exactly once — it is never stored or retrievable again.
  return { id: created.id, label: created.label, key: rawKey, keyPrefix: created.keyPrefix, createdAt: created.createdAt }
}

async function revokeApiKeyById(id) {
  await prisma.apiKey.delete({ where: { id } })
}

async function verifyApiKey(rawKey) {
  if (!rawKey) return false
  const record = await prisma.apiKey.findUnique({ where: { keyHash: hashApiKey(rawKey) } })
  if (!record) return false
  // Don't block the request on this — it's just bookkeeping for the Settings UI.
  prisma.apiKey.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } }).catch(() => {})
  return true
}

async function getMeContactId() {
  const row = await prisma.appSetting.findUnique({ where: { key: 'me_contact_id' } })
  return row && row.value ? Number(row.value) : null
}

async function setMeContactId(contactId) {
  await prisma.appSetting.upsert({
    where: { key: 'me_contact_id' },
    create: { key: 'me_contact_id', value: String(contactId) },
    update: { value: String(contactId) },
  })
}

async function hasAnyCredential() {
  const count = await prisma.credential.count()
  return count > 0
}

// -- Registration (first-time passkey setup) --

async function getRegistrationOptions(req) {
  if (await hasAnyCredential()) {
    throw Object.assign(new Error('A passkey is already registered for this CRM'), { status: 400 })
  }

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: 'owner',
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  })
  req.session.currentChallenge = options.challenge
  return options
}

async function verifyRegistration(req, response, contactName) {
  const expectedChallenge = req.session.currentChallenge
  if (!expectedChallenge) throw Object.assign(new Error('no challenge in progress'), { status: 400 })

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
  })
  if (!verification.verified || !verification.registrationInfo) {
    throw Object.assign(new Error('passkey registration could not be verified'), { status: 400 })
  }

  // Tie the passkey to the existing "me" contact if one is already set;
  // otherwise create a new contact from the provided name and set it as "me".
  let contactId = await getMeContactId()
  if (contactId == null) {
    if (!contactName || !contactName.trim()) {
      throw Object.assign(new Error('name is required to create your contact'), { status: 400 })
    }
    const contact = await prisma.contact.create({ data: { name: contactName.trim() } })
    contactId = contact.id
    await setMeContactId(contactId)
  }

  const { credential } = verification.registrationInfo
  await prisma.credential.create({
    data: {
      contactId,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey),
      counter: BigInt(credential.counter),
      transports: response.response.transports ? JSON.stringify(response.response.transports) : null,
    },
  })

  req.session.currentChallenge = undefined
  req.session.contactId = contactId
  return { verified: true }
}

// -- Authentication (subsequent logins) --

async function getAuthenticationOptions(req) {
  const credentials = await prisma.credential.findMany()
  if (credentials.length === 0) {
    throw Object.assign(new Error('no passkey registered yet'), { status: 400 })
  }

  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: 'preferred',
    allowCredentials: credentials.map((c) => ({
      id: c.credentialId,
      transports: c.transports ? JSON.parse(c.transports) : undefined,
    })),
  })
  req.session.currentChallenge = options.challenge
  return options
}

async function verifyAuthentication(req, response) {
  const expectedChallenge = req.session.currentChallenge
  if (!expectedChallenge) throw Object.assign(new Error('no challenge in progress'), { status: 400 })

  const credential = await prisma.credential.findUnique({ where: { credentialId: response.id } })
  if (!credential) throw Object.assign(new Error('unknown passkey'), { status: 400 })

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    credential: {
      id: credential.credentialId,
      publicKey: new Uint8Array(credential.publicKey),
      counter: Number(credential.counter),
      transports: credential.transports ? JSON.parse(credential.transports) : undefined,
    },
  })
  if (!verification.verified) {
    throw Object.assign(new Error('passkey authentication failed'), { status: 401 })
  }

  await prisma.credential.update({
    where: { id: credential.id },
    data: { counter: BigInt(verification.authenticationInfo.newCounter) },
  })

  req.session.currentChallenge = undefined
  req.session.contactId = credential.contactId
  return { verified: true }
}

// -- Middleware --

const PUBLIC_PATHS = new Set(['/login.html', '/login.js', '/util.js', '/style.css'])

async function requireAuth(req, res, next) {
  try {
    if (PUBLIC_PATHS.has(req.path) || req.path.startsWith('/api/auth/')) return next()

    const authHeader = req.get('authorization')
    const bearerKey = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null
    if (bearerKey && (await verifyApiKey(bearerKey))) return next()

    if (req.session && req.session.contactId) return next()

    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'not authenticated' })
    }
    res.redirect('/login.html')
  } catch (err) {
    next(err)
  }
}

module.exports = {
  RP_ID,
  ORIGIN,
  hasAnyCredential,
  getMeContactId,
  setMeContactId,
  getRegistrationOptions,
  verifyRegistration,
  getAuthenticationOptions,
  verifyAuthentication,
  requireAuth,
  listApiKeys,
  createApiKey,
  revokeApiKeyById,
  getOrCreateSessionSecret,
}
