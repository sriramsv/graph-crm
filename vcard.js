// Minimal vCard (2.1/3.0/4.0) parser covering the fields this CRM cares about.

function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '')
}

function parseLine(line) {
  const colonIdx = line.indexOf(':')
  if (colonIdx === -1) return null
  const rawKey = line.slice(0, colonIdx)
  const value = line.slice(colonIdx + 1)
  const [name, ...params] = rawKey.split(';')
  return { name: name.toUpperCase(), params, value }
}

function decodeValue(value) {
  return value.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\')
}

function formatDate(value) {
  const digits = value.replace(/[^0-9]/g, '')
  if (digits.length >= 8) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
  }
  return null
}

function parseVCards(text) {
  const unfolded = unfold(text)
  const blocks = unfolded.split(/BEGIN:VCARD/i).slice(1)

  return blocks
    .map((block) => {
      const lines = block.split('\n').filter((l) => l.trim() && !/^END:VCARD/i.test(l.trim()))
      const contact = {
        name: null,
        email: null,
        phone: null,
        company: null,
        title: null,
        address: null,
        date_of_birth: null,
      }
      let fallbackName = null

      for (const rawLine of lines) {
        const parsed = parseLine(rawLine.trim())
        if (!parsed) continue
        const value = decodeValue(parsed.value)

        switch (parsed.name) {
          case 'FN':
            contact.name = value.trim()
            break
          case 'N': {
            const parts = value.split(';')
            const [family, given] = parts
            fallbackName = [given, family].filter(Boolean).join(' ').trim()
            break
          }
          case 'EMAIL':
            if (!contact.email) contact.email = value.trim()
            break
          case 'TEL':
            if (!contact.phone) contact.phone = value.trim()
            break
          case 'ORG':
            contact.company = value.split(';')[0].trim()
            break
          case 'TITLE':
            contact.title = value.trim()
            break
          case 'BDAY':
            contact.date_of_birth = formatDate(value.trim())
            break
          case 'ADR': {
            const parts = value.split(';')
            const address = parts.filter(Boolean).join(', ').trim()
            if (address) contact.address = address
            break
          }
          default:
            break
        }
      }

      if (!contact.name) contact.name = fallbackName
      return contact
    })
    .filter((c) => c.name)
}

module.exports = { parseVCards }
