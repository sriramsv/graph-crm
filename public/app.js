const state = {
  contacts: [],
  network: null,
  nodesDataSet: null,
  edgesDataSet: null,
  currentDetailId: null,
  meContactId: null,
  localGraphRootId: null,
  allRelationships: [],
  spouseMap: new Map(),
}

// -- Theme --

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme)
  document.getElementById('theme-toggle').textContent = theme === 'dark' ? '☀' : '☽'
}

function initTheme() {
  const stored = localStorage.getItem('theme')
  const theme = stored || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
  applyTheme(theme)
}

document.getElementById('theme-toggle').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme')
  const next = current === 'dark' ? 'light' : 'dark'
  localStorage.setItem('theme', next)
  applyTheme(next)
})

initTheme()

async function api(path, options) {
  try {
    return await apiRequest(path, options)
  } catch (err) {
    if (err.status === 401) window.location.href = '/login.html'
    throw err
  }
}

// -- Tabs --

function switchTab(view) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view))
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `${view}-view`))
  if (view === 'graph' && state.network) {
    state.network.redraw()
  }
  if (view === 'settings') {
    loadApiKeyList()
  }
}

function csvField(value) {
  const str = value == null ? '' : String(value)
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
}

function computeSpouseMap() {
  const byId = new Map(allContactsFull.map((c) => [c.id, c]))
  const map = new Map()
  for (const r of state.allRelationships) {
    if (r.type !== 'spouse') continue
    const a = byId.get(r.source_id)
    const b = byId.get(r.target_id)
    if (a && b) {
      map.set(r.source_id, b.name)
      map.set(r.target_id, a.name)
    }
  }
  return map
}

document.getElementById('export-directory-btn').addEventListener('click', () => {
  const spouseMap = state.spouseMap
  const headers = ['name', 'email', 'phone', 'company', 'title', 'date_of_birth', 'address', 'spouse']
  const lines = [headers.join(',')]
  for (const c of allContactsFull) {
    const row = { ...c, spouse: spouseMap.get(c.id) || '' }
    lines.push(headers.map((h) => csvField(row[h])).join(','))
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'contacts.csv'
  a.click()
  URL.revokeObjectURL(url)
})

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.view))
})

// -- Graph rendering --

function renderGraph(dataNodes, dataEdges) {
  const nodes = dataNodes.map((n) => ({
    id: n.id,
    label: n.label,
    title: n.company ? `${n.label} — ${n.company}` : n.label,
    color:
      n.id === state.meContactId
        ? { background: '#f9ab00', border: '#e37400' }
        : { background: '#1a73e8', border: '#0b57d0' },
    borderWidth: n.id === state.meContactId ? 3 : 1,
  }))
  const edges = dataEdges.map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    label: e.label,
    arrows: 'to',
    font: { size: 10, color: '#5f6368', strokeWidth: 0 },
  }))

  state.nodesDataSet = new vis.DataSet(nodes)
  state.edgesDataSet = new vis.DataSet(edges)

  const container = document.getElementById('network')
  const options = {
    nodes: {
      shape: 'dot',
      size: 18,
      font: {
        color: getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#1f1f1f',
        size: 14,
      },
    },
    edges: {
      color: { color: '#c4c7c5', highlight: '#1a73e8' },
      smooth: { type: 'continuous' },
    },
    physics: {
      solver: 'forceAtlas2Based',
      forceAtlas2Based: { gravitationalConstant: -60, springLength: 120 },
      stabilization: { iterations: 150 },
    },
    interaction: { hover: true },
  }

  if (state.network) state.network.destroy()
  state.network = new vis.Network(container, { nodes: state.nodesDataSet, edges: state.edgesDataSet }, options)

  state.network.on('click', (params) => {
    if (params.nodes.length > 0) {
      showContactDetail(params.nodes[0]).catch((err) => console.error('showContactDetail failed:', err))
    } else {
      hideDetail()
    }
  })
}

async function loadGraph() {
  const data = await api('/api/graph')
  state.contacts = data.nodes
  state.localGraphRootId = null
  document.getElementById('local-graph-banner').classList.add('hidden')
  renderGraph(data.nodes, data.edges)
}

// Ensures "me" and the connecting chain are part of every local graph, even if
// they'd otherwise fall outside the subgraph's depth radius — so every local
// graph shows how that person connects back to you.
function mergePathIntoGraph(data, path) {
  const nodeIds = new Set(data.nodes.map((n) => n.id))
  const me = state.contacts.find((c) => c.id === state.meContactId)
  if (me && !nodeIds.has(me.id)) {
    data.nodes.push({ id: me.id, label: me.label, company: me.company })
    nodeIds.add(me.id)
  }

  let prevId = state.meContactId
  for (const step of path) {
    const stepContact = step.contact
    if (!nodeIds.has(stepContact.id)) {
      data.nodes.push({ id: stepContact.id, label: stepContact.name, company: stepContact.company })
      nodeIds.add(stepContact.id)
    }
    const from = step.fromThem ? stepContact.id : prevId
    const to = step.fromThem ? prevId : stepContact.id
    if (!data.edges.some((e) => e.from === from && e.to === to && e.label === step.type)) {
      data.edges.push({ id: `path:${from}:${to}:${step.type}`, from, to, label: step.type, notes: null })
    }
    prevId = stepContact.id
  }
}

async function loadLocalGraph(rootId, depth) {
  const data = await api(`/api/contacts/${rootId}/subgraph?depth=${depth || 1}`)

  if (state.meContactId != null && rootId !== state.meContactId) {
    const pathResult = await api(`/api/contacts/${rootId}/path-to-me`)
    if (pathResult.path) mergePathIntoGraph(data, pathResult.path)
  }

  state.localGraphRootId = rootId
  const root = state.contacts.find((c) => c.id === rootId)
  const banner = document.getElementById('local-graph-banner')
  document.getElementById('local-graph-label').textContent = `Local graph: ${root ? root.label : ''}`
  banner.classList.remove('hidden')
  renderGraph(data.nodes, data.edges)
  state.network.selectNodes([rootId])
}

document.getElementById('exit-local-graph').addEventListener('click', async () => {
  await loadGraph()
})

async function showContactDetail(id) {
  const contact = state.contacts.find((c) => c.id === id)
  if (!contact) return
  state.currentDetailId = id

  const panel = document.getElementById('detail-panel')
  const content = document.getElementById('detail-content')
  const isMeView = id === state.meContactId
  const [interactions, pathResult] = await Promise.all([
    api(`/api/contacts/${id}/interactions`),
    isMeView ? Promise.resolve({ path: null }) : api(`/api/contacts/${id}/path-to-me`),
  ])
  const relatedContactsById = new Map(state.contacts.map((c) => [c.id, c]))
  const relationships = state.allRelationships.filter((r) => r.source_id === id || r.target_id === id)
  const CLOSE_FAMILY_TYPES = new Set(['spouse', 'parent_of', 'child_of', 'sibling', 'family'])
  const shownRelationships = isMeView ? relationships.filter((r) => CLOSE_FAMILY_TYPES.has(r.type)) : relationships
  const hiddenCount = relationships.length - shownRelationships.length

  let chainHtml = ''
  if (!isMeView && state.meContactId != null) {
    if (pathResult.path == null) {
      chainHtml = `<div class="field"><span class="label">Connection to you:</span> no path found</div>`
    } else {
      const steps = [
        `<span class="you-badge">You</span>`,
        ...pathResult.path.map((step) => {
          const typeLabel = step.fromThem ? `${step.type} (from them)` : step.type
          return `<span class="chain-arrow">→ ${escapeHtml(typeLabel)} →</span> ${escapeHtml(step.contact.name)}`
        }),
      ]
      chainHtml = `<div class="relationship-chain">${steps.join(' ')}</div>`
    }
  }

  content.innerHTML = `
    <h3>${id === state.meContactId ? '<span class="you-badge">You</span>' : ''}${escapeHtml(contact.label)}</h3>
    ${contact.title ? `<div class="field"><span class="label">Title:</span> ${escapeHtml(contact.title)}</div>` : ''}
    ${contact.company ? `<div class="field"><span class="label">Company:</span> ${escapeHtml(contact.company)}</div>` : ''}
    ${contact.email ? `<div class="field"><span class="label">Email:</span> ${escapeHtml(contact.email)}</div>` : ''}
    ${contact.phone ? `<div class="field"><span class="label">Phone:</span> ${escapeHtml(contact.phone)}</div>` : ''}
    ${contact.date_of_birth ? `<div class="field"><span class="label">DOB:</span> ${escapeHtml(contact.date_of_birth)}</div>` : ''}
    ${contact.address ? `<div class="field"><span class="label">Address:</span> ${escapeHtml(contact.address)}</div>` : ''}
    ${contact.notes ? `<div class="field"><span class="label">Notes:</span> ${escapeHtml(contact.notes)}</div>` : ''}
    ${chainHtml}

    <button type="button" class="primary small" id="view-local-graph-btn">View local graph</button>

    <div class="interactions-section">
      <h4>Relationships${isMeView && relationships.length ? ` (${relationships.length})` : ''}</h4>
      <ul class="relationship-list">
        ${shownRelationships
          .map((r) => {
            const otherId = r.source_id === id ? r.target_id : r.source_id
            const other = relatedContactsById.get(otherId)
            const isMe = otherId === state.meContactId
            const nameHtml = `${isMe ? '<span class="you-badge">You</span>' : ''}${escapeHtml(other ? other.label : 'Unknown')}`
            const typeLabel = r.source_id === id ? r.type : `${r.type} (from them)`
            return `
              <li data-id="${r.id}">
                <span><button type="button" class="rel-link" data-goto-id="${otherId}">${nameHtml}</button> <span class="rel-type">${escapeHtml(typeLabel)}</span></span>
                <button class="icon-btn tiny" data-delete-relationship="${r.id}">&times;</button>
              </li>`
          })
          .join('') || '<li class="empty">No relationships yet.</li>'}
        ${hiddenCount > 0 ? `<li class="empty">+${hiddenCount} more (friends, cousins, colleagues, etc.) — use "View local graph" for the full picture.</li>` : ''}
      </ul>
      ${!isMeView && state.meContactId != null ? `
        <div class="quick-add-me-row">
          <select id="quick-add-me-type">
            <option value="friend">friend</option>
            <option value="family">family</option>
            <option value="spouse">spouse</option>
            <option value="parent_of">parent_of</option>
            <option value="child_of">child_of</option>
            <option value="sibling">sibling</option>
            <option value="colleague">colleague</option>
            <option value="knows">knows</option>
          </select>
          <button type="button" class="primary small" id="quick-add-me-btn">Add relationship to me</button>
        </div>
      ` : ''}
      <button type="button" class="primary small" id="add-relationship-btn">Add relationship</button>
    </div>

    <div class="interactions-section">
      <h4>Notes & Conversations</h4>
      <form id="interaction-form">
        <select name="type">
          <option value="note">Note</option>
          <option value="call">Call</option>
          <option value="meeting">Meeting</option>
          <option value="email">Email</option>
          <option value="message">Message</option>
        </select>
        <textarea name="content" placeholder="What happened?" required></textarea>
        <button type="submit" class="primary small">Add</button>
      </form>
      <ul class="interaction-list">
        ${interactions
          .map(
            (i) => `
          <li data-id="${i.id}">
            <div class="interaction-meta">
              <span class="interaction-type">${escapeHtml(i.type)}</span>
              <span class="interaction-date">${escapeHtml(i.occurred_at)}</span>
              <button class="icon-btn tiny" data-delete-interaction="${i.id}">&times;</button>
            </div>
            <div class="interaction-content">${escapeHtml(i.content)}</div>
          </li>`
          )
          .join('') || '<li class="empty">No notes yet.</li>'}
      </ul>
    </div>

    <div class="actions">
      <button class="icon-btn" id="delete-contact-btn">Delete contact</button>
    </div>
  `
  panel.classList.remove('hidden')

  document.getElementById('delete-contact-btn').addEventListener('click', async () => {
    if (!confirm(`Delete ${contact.label}? This also removes their relationships.`)) return
    await api(`/api/contacts/${id}`, { method: 'DELETE' })
    hideDetail()
    await refreshAll()
  })

  document.getElementById('add-relationship-btn').addEventListener('click', () => {
    openRelationshipModal(id)
  })

  const quickAddMeBtn = document.getElementById('quick-add-me-btn')
  if (quickAddMeBtn) {
    quickAddMeBtn.addEventListener('click', async () => {
      const type = document.getElementById('quick-add-me-type').value
      try {
        await api('/api/relationships', {
          method: 'POST',
          body: JSON.stringify({ source_id: id, target_id: state.meContactId, type }),
        })
        await refreshAll()
        await showContactDetail(id)
      } catch (err) {
        alert(err.message)
      }
    })
  }

  document.getElementById('view-local-graph-btn').addEventListener('click', () => {
    loadLocalGraph(id, 1)
  })

  content.querySelectorAll('[data-goto-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      showContactDetail(Number(btn.dataset.gotoId)).catch((err) => console.error('showContactDetail failed:', err))
    })
  })

  content.querySelectorAll('[data-delete-relationship]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/relationships/${btn.dataset.deleteRelationship}`, { method: 'DELETE' })
      await refreshAll()
      await showContactDetail(id)
    })
  })

  document.getElementById('interaction-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const form = e.target
    const formData = new FormData(form)
    const payload = Object.fromEntries(formData.entries())
    try {
      await api(`/api/contacts/${id}/interactions`, { method: 'POST', body: JSON.stringify(payload) })
      await showContactDetail(id)
    } catch (err) {
      alert(err.message)
    }
  })

  content.querySelectorAll('[data-delete-interaction]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/interactions/${btn.dataset.deleteInteraction}`, { method: 'DELETE' })
      await showContactDetail(id)
    })
  })
}

function hideDetail() {
  document.getElementById('detail-panel').classList.add('hidden')
  state.currentDetailId = null
}

async function refreshDetailIfOpen() {
  if (state.currentDetailId != null) await showContactDetail(state.currentDetailId)
}

document.getElementById('close-panel').addEventListener('click', hideDetail)

function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

// -- Contacts list view --

let allContactsFull = []

async function loadContactsTable() {
  allContactsFull = await api('/api/contacts')
  state.spouseMap = computeSpouseMap()
  renderContactsTable(allContactsFull)
}

function renderContactsTable(contacts) {
  const spouseMap = state.spouseMap
  const tbody = document.querySelector('#contacts-table tbody')
  tbody.innerHTML = ''
  contacts.forEach((c) => {
    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td>${escapeHtml(c.name)}</td>
      <td>${escapeHtml(c.email || '')}</td>
      <td>${escapeHtml(c.phone || '')}</td>
      <td>${escapeHtml(c.company || '')}</td>
      <td>${escapeHtml(c.title || '')}</td>
      <td>${escapeHtml(c.date_of_birth || '')}</td>
      <td>${escapeHtml(c.address || '')}</td>
      <td>${escapeHtml(spouseMap.get(c.id) || '')}</td>
      <td class="row-actions">
        <button class="icon-btn" data-edit-id="${c.id}">Edit</button>
        <button class="icon-btn" data-delete-id="${c.id}">Delete</button>
      </td>
    `
    tbody.appendChild(tr)
  })
  tbody.querySelectorAll('[data-delete-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/contacts/${btn.dataset.deleteId}`, { method: 'DELETE' })
      await refreshAll()
    })
  })
  tbody.querySelectorAll('[data-edit-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const contact = allContactsFull.find((c) => c.id === Number(btn.dataset.editId))
      if (contact) openContactModal(contact)
    })
  })
}

// -- Add Contact modal --

const contactModal = document.getElementById('contact-modal')
const contactForm = document.getElementById('contact-form')
const contactModalTitle = document.getElementById('contact-modal-title')

function openContactModal(contact) {
  contactForm.reset()
  const relSection = document.getElementById('contact-relationships-section')
  if (contact) {
    contactModalTitle.textContent = `Edit ${contact.name}`
    contactForm.querySelector('[name="id"]').value = contact.id
    contactForm.querySelector('[name="name"]').value = contact.name || ''
    contactForm.querySelector('[name="company"]').value = contact.company || ''
    contactForm.querySelector('[name="title"]').value = contact.title || ''
    contactForm.querySelector('[name="email"]').value = contact.email || ''
    contactForm.querySelector('[name="phone"]').value = contact.phone || ''
    contactForm.querySelector('[name="date_of_birth"]').value = contact.date_of_birth || ''
    contactForm.querySelector('[name="address"]').value = contact.address || ''
    contactForm.querySelector('[name="notes"]').value = contact.notes || ''
    relSection.classList.remove('hidden')
    editRelCombobox.reset()
    loadEditRelationships(contact.id)
  } else {
    contactModalTitle.textContent = 'New Contact'
    relSection.classList.add('hidden')
  }
  contactModal.showModal()
}

document.getElementById('add-contact-fab').addEventListener('click', () => openContactModal(null))
document.getElementById('cancel-contact').addEventListener('click', () => contactModal.close())

contactForm.addEventListener('submit', async (e) => {
  const formData = new FormData(contactForm)
  const payload = Object.fromEntries(formData.entries())
  const id = payload.id
  delete payload.id
  try {
    if (id) {
      await api(`/api/contacts/${id}`, { method: 'PUT', body: JSON.stringify(payload) })
      await refreshAll()
      await refreshDetailIfOpen()
    } else {
      await api('/api/contacts', { method: 'POST', body: JSON.stringify(payload) })
      await refreshAll()
      maybePromptRelationship()
    }
  } catch (err) {
    alert(err.message)
  }
})

function maybePromptRelationship() {
  if (state.contacts.length >= 2) {
    openRelationshipModal()
  }
}

// -- Add Relationship modal --

const relationshipModal = document.getElementById('relationship-modal')
const relationshipForm = document.getElementById('relationship-form')

// Keyword shortcuts for the person-picker comboboxes: typing e.g. "mother" surfaces
// whoever you actually have a parent_of relationship with, not a hardcoded name.
const RELATIONSHIP_KEYWORDS = {
  wife: { type: 'spouse', as: 'any' },
  husband: { type: 'spouse', as: 'any' },
  spouse: { type: 'spouse', as: 'any' },
  mother: { type: 'parent_of', as: 'target' },
  mom: { type: 'parent_of', as: 'target' },
  father: { type: 'parent_of', as: 'target' },
  dad: { type: 'parent_of', as: 'target' },
  parent: { type: 'parent_of', as: 'target' },
}

function getKeywordContacts(word) {
  if (state.meContactId == null) return []
  const meId = state.meContactId

  if (word === 'me') {
    const me = state.contacts.find((c) => c.id === meId)
    return me ? [me] : []
  }

  const rule = RELATIONSHIP_KEYWORDS[word]
  if (!rule) return []

  const ids = []
  for (const r of state.allRelationships) {
    if (r.type !== rule.type) continue
    if (rule.as === 'any') {
      if (r.source_id === meId) ids.push(r.target_id)
      else if (r.target_id === meId) ids.push(r.source_id)
    } else if (rule.as === 'target' && r.target_id === meId) {
      ids.push(r.source_id)
    } else if (rule.as === 'source' && r.source_id === meId) {
      ids.push(r.target_id)
    }
  }
  return ids.map((id) => state.contacts.find((c) => c.id === id)).filter(Boolean)
}

function setupCombobox(container, onSelect) {
  const input = container.querySelector('.combobox-input')
  const hidden = container.querySelector('input[type="hidden"]')
  const optionsEl = container.querySelector('.combobox-options')
  let highlighted = -1

  function render(filterText) {
    const q = filterText.trim().toLowerCase()
    const keywordMatches = getKeywordContacts(q)
    const textMatches = state.contacts.filter((c) => c.label.toLowerCase().includes(q))
    const seen = new Set(keywordMatches.map((c) => c.id))
    const matches = [...keywordMatches, ...textMatches.filter((c) => !seen.has(c.id))].slice(0, 50)

    optionsEl.innerHTML = matches.length
      ? matches
          .map(
            (c, i) =>
              `<div class="combobox-option${i === highlighted ? ' highlighted' : ''}" data-id="${c.id}">${escapeHtml(c.label)}</div>`
          )
          .join('')
      : `<div class="combobox-option empty">No matches</div>`

    optionsEl.classList.remove('hidden')

    optionsEl.querySelectorAll('.combobox-option[data-id]').forEach((el) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault()
        select(Number(el.dataset.id), el.textContent)
      })
    })
  }

  function select(id, label) {
    hidden.value = id
    input.value = label
    optionsEl.classList.add('hidden')
    if (onSelect) onSelect(id)
  }

  function clear() {
    hidden.value = ''
  }

  input.addEventListener('input', () => {
    clear()
    highlighted = -1
    render(input.value)
  })
  input.addEventListener('focus', () => {
    if (!container.classList.contains('locked')) render(input.value)
  })
  input.addEventListener('blur', () => {
    setTimeout(() => optionsEl.classList.add('hidden'), 100)
  })
  input.addEventListener('keydown', (e) => {
    const items = optionsEl.querySelectorAll('.combobox-option[data-id]')
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      highlighted = Math.min(highlighted + 1, items.length - 1)
      render(input.value)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      highlighted = Math.max(highlighted - 1, 0)
      render(input.value)
    } else if (e.key === 'Enter' && highlighted >= 0 && items[highlighted]) {
      e.preventDefault()
      const el = items[highlighted]
      select(Number(el.dataset.id), el.textContent)
    }
  })

  return {
    reset() {
      input.value = ''
      hidden.value = ''
      container.classList.remove('locked')
      input.disabled = false
    },
    lockTo(id, label) {
      select(id, label)
      container.classList.add('locked')
      input.disabled = true
    },
  }
}

const comboboxes = {
  source_id: setupCombobox(relationshipForm.querySelector('[data-field="source_id"]')),
  target_id: setupCombobox(relationshipForm.querySelector('[data-field="target_id"]')),
}

function openRelationshipModal(presetSourceId) {
  comboboxes.source_id.reset()
  comboboxes.target_id.reset()

  if (presetSourceId != null) {
    const contact = state.contacts.find((c) => c.id === presetSourceId)
    if (contact) comboboxes.source_id.lockTo(contact.id, contact.label)
  }

  relationshipModal.showModal()
  const focusTarget = presetSourceId != null ? 'target_id' : 'source_id'
  setTimeout(() => relationshipForm.querySelector(`[data-field="${focusTarget}"] .combobox-input`).focus(), 0)
}

document.getElementById('cancel-relationship').addEventListener('click', () => relationshipModal.close())

relationshipForm.addEventListener('submit', async (e) => {
  const sourceId = relationshipForm.querySelector('[name="source_id"]').value
  const targetId = relationshipForm.querySelector('[name="target_id"]').value
  if (!sourceId || !targetId) {
    e.preventDefault()
    alert('Please select both people from the suggestions list.')
    return
  }

  const formData = new FormData(relationshipForm)
  const payload = Object.fromEntries(formData.entries())
  payload.source_id = Number(sourceId)
  payload.target_id = Number(targetId)
  try {
    await api('/api/relationships', { method: 'POST', body: JSON.stringify(payload) })
    await refreshAll()
    await refreshDetailIfOpen()
  } catch (err) {
    alert(err.message)
  }
})


// -- Import from Google/Apple Contacts (.vcf) --

document.getElementById('import-btn').addEventListener('click', () => {
  document.getElementById('import-file-input').click()
})

document.getElementById('import-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0]
  e.target.value = ''
  if (!file) return

  const resultEl = document.getElementById('import-result')
  resultEl.textContent = 'Importing...'
  resultEl.className = 'import-result'

  const vcard = await file.text()
  try {
    const result = await api('/api/contacts/import', { method: 'POST', body: JSON.stringify({ vcard }) })
    await refreshAll()
    let message = `Imported ${result.imported} of ${result.total} contact(s).`
    if (result.skipped) message += ` Skipped ${result.skipped} duplicate(s) (matching email).`
    if (result.errors.length) message += ` ${result.errors.length} error(s): ${result.errors.join('; ')}`
    resultEl.textContent = message
    resultEl.className = 'import-result success'
  } catch (err) {
    resultEl.textContent = err.message
    resultEl.className = 'import-result error'
  }
})

// -- Refresh --

async function refreshAll() {
  state.allRelationships = await api('/api/relationships')
  await Promise.all([loadGraph(), loadContactsTable()])
}

function renderProfileNav() {
  const btn = document.getElementById('profile-nav-btn')
  const me = state.contacts.find((c) => c.id === state.meContactId)
  if (!me) {
    btn.classList.add('hidden')
    return
  }
  btn.textContent = `👤 ${me.label}`
  btn.classList.remove('hidden')
}

async function goToProfile() {
  if (state.meContactId == null) return
  switchTab('graph')
  await loadLocalGraph(state.meContactId, 1)
  await showContactDetail(state.meContactId)
}

document.getElementById('profile-nav-btn').addEventListener('click', goToProfile)

async function afterMeSet() {
  renderProfileNav()
  await loadLocalGraph(state.meContactId, 1)
  await showContactDetail(state.meContactId)
}

function setupWelcomeOverlay() {
  const overlay = document.getElementById('welcome-overlay')
  const createForm = document.getElementById('welcome-create-form')

  const welcomeCombo = setupCombobox(document.getElementById('welcome-combobox'), async (id) => {
    await api('/api/me', { method: 'PUT', body: JSON.stringify({ contact_id: id }) })
    state.meContactId = id
    overlay.classList.add('hidden')
    renderMeCurrent()
    await afterMeSet()
  })

  createForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    const formData = new FormData(createForm)
    const payload = Object.fromEntries(formData.entries())
    try {
      const contact = await api('/api/contacts', { method: 'POST', body: JSON.stringify(payload) })
      await api('/api/me', { method: 'PUT', body: JSON.stringify({ contact_id: contact.id }) })
      state.meContactId = contact.id
      overlay.classList.add('hidden')
      await refreshAll()
      renderMeCurrent()
      await afterMeSet()
    } catch (err) {
      alert(err.message)
    }
  })

  document.getElementById('welcome-skip-btn').addEventListener('click', () => {
    localStorage.setItem('welcome_skipped', '1')
    overlay.classList.add('hidden')
  })

  if (state.meContactId == null && !localStorage.getItem('welcome_skipped')) {
    overlay.classList.remove('hidden')
    welcomeCombo.reset()
  }
}

async function init() {
  const me = await api('/api/me')
  state.meContactId = me.contact ? me.contact.id : null
  await refreshAll()
  renderProfileNav()
  if (state.meContactId != null) {
    await afterMeSet()
  }
  setupMePicker()
  setupWelcomeOverlay()
}

init()

// -- Global search --

function focusNodeInGraph(id) {
  if (!state.network) return
  state.network.selectNodes([id])
  state.network.focus(id, { scale: 1.2, animation: { duration: 400, easingFunction: 'easeInOutQuad' } })
  showContactDetail(id)
}

function setupGlobalSearch() {
  const input = document.getElementById('global-search')
  const resultsEl = document.getElementById('search-results')
  let highlighted = -1

  function render() {
    const q = input.value.trim().toLowerCase()
    if (!q) {
      resultsEl.classList.add('hidden')
      renderContactsTable(allContactsFull)
      return
    }

    const matches = state.contacts.filter((c) => c.label.toLowerCase().includes(q)).slice(0, 50)

    resultsEl.innerHTML = matches.length
      ? matches
          .map(
            (c, i) =>
              `<div class="combobox-option${i === highlighted ? ' highlighted' : ''}" data-id="${c.id}">${escapeHtml(c.label)}</div>`
          )
          .join('')
      : `<div class="combobox-option empty">No matches</div>`
    resultsEl.classList.remove('hidden')

    resultsEl.querySelectorAll('.combobox-option[data-id]').forEach((el) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault()
        selectResult(Number(el.dataset.id))
      })
    })

    if (document.getElementById('list-view').classList.contains('active')) {
      renderContactsTable(allContactsFull.filter((c) => c.name.toLowerCase().includes(q)))
    }
  }

  function selectResult(id) {
    resultsEl.classList.add('hidden')
    input.value = ''
    switchTab('graph')
    focusNodeInGraph(id)
  }

  input.addEventListener('input', () => {
    highlighted = -1
    render()
  })
  input.addEventListener('focus', render)
  input.addEventListener('blur', () => setTimeout(() => resultsEl.classList.add('hidden'), 100))
  input.addEventListener('keydown', (e) => {
    const items = resultsEl.querySelectorAll('.combobox-option[data-id]')
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      highlighted = Math.min(highlighted + 1, items.length - 1)
      render()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      highlighted = Math.max(highlighted - 1, 0)
      render()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (highlighted >= 0 && items[highlighted]) {
        selectResult(Number(items[highlighted].dataset.id))
      } else if (items.length === 1 && items[0].dataset.id) {
        selectResult(Number(items[0].dataset.id))
      }
    } else if (e.key === 'Escape') {
      input.blur()
      resultsEl.classList.add('hidden')
    }
  })
}

setupGlobalSearch()

// -- Bulk import relationships (.csv) --

document.getElementById('import-relationships-btn').addEventListener('click', () => {
  document.getElementById('import-relationships-file-input').click()
})

document.getElementById('import-relationships-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0]
  e.target.value = ''
  if (!file) return

  const resultEl = document.getElementById('import-relationships-result')
  resultEl.textContent = 'Importing...'
  resultEl.className = 'import-result'

  const csv = await file.text()
  try {
    const result = await api('/api/relationships/import', { method: 'POST', body: JSON.stringify({ csv }) })
    await refreshAll()
    let message = `Imported ${result.imported} of ${result.total} relationship(s).`
    if (result.skipped) message += ` Skipped ${result.skipped} duplicate(s).`
    if (result.errors.length) message += ` ${result.errors.length} error(s): ${result.errors.join('; ')}`
    resultEl.textContent = message
    resultEl.className = 'import-result success'
  } catch (err) {
    resultEl.textContent = err.message
    resultEl.className = 'import-result error'
  }
})

// -- Danger zone: delete all contacts --

const deleteAllConfirmInput = document.getElementById('delete-all-confirm-input')
const deleteAllBtn = document.getElementById('delete-all-btn')

deleteAllConfirmInput.addEventListener('input', () => {
  deleteAllBtn.disabled = deleteAllConfirmInput.value !== 'DELETE'
})

deleteAllBtn.addEventListener('click', async () => {
  const count = allContactsFull.length
  const reallySure = confirm(
    `This will permanently delete all ${count} contact(s), their relationships, and all notes. This cannot be undone.\n\nAre you absolutely sure?`
  )
  if (!reallySure) return

  try {
    const result = await api('/api/contacts?confirm=DELETE_ALL', { method: 'DELETE' })
    deleteAllConfirmInput.value = ''
    deleteAllBtn.disabled = true
    hideDetail()
    await refreshAll()
    alert(`Deleted ${result.deleted} contact(s).`)
  } catch (err) {
    alert(err.message)
  }
})

// -- "Who are you?" (me) --

function renderMeCurrent() {
  const el = document.getElementById('me-current')
  const me = state.contacts.find((c) => c.id === state.meContactId)
  if (!me) {
    el.textContent = 'Not set yet.'
    el.className = 'import-result'
    return
  }
  el.innerHTML = `You are set to <strong>${escapeHtml(me.label)}</strong>. <button type="button" id="clear-me-btn" class="icon-btn">Clear</button>`
  el.className = 'import-result success'
  document.getElementById('clear-me-btn').addEventListener('click', async () => {
    await api('/api/me', { method: 'DELETE' })
    state.meContactId = null
    renderMeCurrent()
    renderProfileNav()
    await loadGraph()
    await refreshDetailIfOpen()
  })
}

function setupMePicker() {
  const meCombo = setupCombobox(document.getElementById('me-combobox'), async (id) => {
    await api('/api/me', { method: 'PUT', body: JSON.stringify({ contact_id: id }) })
    state.meContactId = id
    meCombo.reset()
    renderMeCurrent()
    renderProfileNav()
    await loadGraph()
    await refreshDetailIfOpen()
  })
  renderMeCurrent()
}

// -- Relationships section inside the edit-contact modal --

const editRelCombobox = setupCombobox(document.getElementById('edit-rel-combobox'))

async function loadEditRelationships(contactId) {
  const relatedContactsById = new Map(state.contacts.map((c) => [c.id, c]))
  const relationships = state.allRelationships.filter(
    (r) => r.source_id === contactId || r.target_id === contactId
  )

  const list = document.getElementById('contact-relationships-list')
  list.innerHTML =
    relationships
      .map((r) => {
        const otherId = r.source_id === contactId ? r.target_id : r.source_id
        const other = relatedContactsById.get(otherId)
        const isMe = otherId === state.meContactId
        const otherLabel = isMe ? '<span class="you-badge">You</span>' : escapeHtml(other ? other.label : 'Unknown')
        const typeLabel = r.source_id === contactId ? r.type : `${r.type} (from them)`
        return `
          <li data-id="${r.id}">
            <span>${otherLabel} <span class="rel-type">${escapeHtml(typeLabel)}</span></span>
            <button class="icon-btn tiny" data-delete-edit-relationship="${r.id}">&times;</button>
          </li>`
      })
      .join('') || '<li class="empty">No relationships yet.</li>'

  list.querySelectorAll('[data-delete-edit-relationship]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/relationships/${btn.dataset.deleteEditRelationship}`, { method: 'DELETE' })
      await refreshAll()
      await loadEditRelationships(contactId)
      await refreshDetailIfOpen()
    })
  })
}

document.getElementById('edit-rel-add-btn').addEventListener('click', async () => {
  const contactId = Number(contactForm.querySelector('[name="id"]').value)
  const targetHidden = document.querySelector('#edit-rel-combobox input[type="hidden"]')
  const targetId = Number(targetHidden.value)
  const type = document.getElementById('edit-rel-type').value

  if (!contactId || !targetId) {
    alert('Please select a person from the suggestions list.')
    return
  }
  if (contactId === targetId) {
    alert('A contact cannot have a relationship with itself.')
    return
  }

  try {
    await api('/api/relationships', {
      method: 'POST',
      body: JSON.stringify({ source_id: contactId, target_id: targetId, type }),
    })
    editRelCombobox.reset()
    await refreshAll()
    await loadEditRelationships(contactId)
    await refreshDetailIfOpen()
  } catch (err) {
    alert(err.message)
  }
})

// -- Security settings --

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' })
  window.location.href = '/login.html'
})

function formatRelativeDate(isoString) {
  if (!isoString) return 'never'
  const diffMs = Date.now() - new Date(isoString).getTime()
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days}d ago`
}

async function loadApiKeyList() {
  const keys = await api('/api/settings/api-keys')
  const list = document.getElementById('api-key-list')
  list.innerHTML =
    keys
      .map(
        (k) => `
      <li data-id="${k.id}">
        <span>
          ${escapeHtml(k.label)}
          <span class="rel-type">${escapeHtml(k.keyPrefix)}… · created ${formatRelativeDate(k.createdAt)} · last used ${formatRelativeDate(k.lastUsedAt)}</span>
        </span>
        <button class="icon-btn tiny" data-revoke-api-key="${k.id}">&times;</button>
      </li>`
      )
      .join('') || '<li class="empty">No API keys yet.</li>'

  list.querySelectorAll('[data-revoke-api-key]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Revoke this API key? Anything using it will lose access immediately.')) return
      await api(`/api/settings/api-keys/${btn.dataset.revokeApiKey}`, { method: 'DELETE' })
      await loadApiKeyList()
    })
  })
}

function showApiKeyReveal(key) {
  document.getElementById('api-key-reveal-value').textContent = key
  document.getElementById('api-key-reveal-modal').showModal()
}

document.getElementById('create-api-key-btn').addEventListener('click', async () => {
  const input = document.getElementById('new-api-key-label')
  const label = input.value.trim()
  if (!label) {
    alert('Give the key a label so you can identify it later.')
    return
  }
  try {
    const created = await api('/api/settings/api-keys', { method: 'POST', body: JSON.stringify({ label }) })
    input.value = ''
    await loadApiKeyList()
    showApiKeyReveal(created.key)
  } catch (err) {
    alert(err.message)
  }
})

document.getElementById('copy-api-key-btn').addEventListener('click', async () => {
  const value = document.getElementById('api-key-reveal-value').textContent
  await navigator.clipboard.writeText(value)
  const btn = document.getElementById('copy-api-key-btn')
  const original = btn.textContent
  btn.textContent = 'Copied!'
  setTimeout(() => (btn.textContent = original), 1500)
})

document.getElementById('close-api-key-reveal-btn').addEventListener('click', () => {
  document.getElementById('api-key-reveal-modal').close()
  document.getElementById('api-key-reveal-value').textContent = ''
})
