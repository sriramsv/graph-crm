// Minimal CSV parser supporting quoted fields with embedded commas/newlines.

function parseCSV(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  const chars = text.replace(/\r\n/g, '\n')

  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]
    if (inQuotes) {
      if (c === '"') {
        if (chars[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += c
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  const nonEmptyRows = rows.filter((r) => r.some((f) => f.trim() !== ''))
  if (nonEmptyRows.length === 0) return []

  const header = nonEmptyRows[0].map((h) => h.trim().toLowerCase())
  return nonEmptyRows.slice(1).map((r) => {
    const obj = {}
    header.forEach((key, idx) => {
      obj[key] = (r[idx] || '').trim()
    })
    return obj
  })
}

module.exports = { parseCSV }
