// Live relationship model backed by FamilyUnit/FamilyUnitMember instead of the
// legacy pairwise Relationship table. Every function here returns/accepts objects
// shaped exactly like the old Relationship rows ({ id, sourceId, targetId, type,
// notes, createdAt }) so the rest of server.js — toEdge/toRelationshipJson, the
// graph/subgraph/path-to-me/directory endpoints — needs no changes.
//
// Storage: a "household" FamilyUnit holds spouses (role 'spouse') and their
// children (role 'child'). Everything else (friend, colleague, family, knows,
// etc.) is a small circle of 'member's in a unit typed with that relationship
// name. grandparent_of/grandchild_of/cousin are never stored — they're derived
// at read time by walking household units, and can't be created/deleted directly.
const prisma = require('./prisma/client')

const DERIVED_TYPES = new Set(['grandparent_of', 'grandchild_of', 'cousin'])

function pairKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`
}

async function findHouseholdAs(contactId, role) {
  const m = await prisma.familyUnitMember.findFirst({
    where: { contactId, role, familyUnit: { type: 'household' } },
  })
  return m ? m.familyUnitId : null
}

async function ensureMember(unitId, contactId, role) {
  await prisma.familyUnitMember.upsert({
    where: { familyUnitId_contactId: { familyUnitId: unitId, contactId } },
    create: { familyUnitId: unitId, contactId, role },
    update: { role },
  })
}

async function createHousehold() {
  return prisma.familyUnit.create({ data: { type: 'household' } })
}

// -- Writing --

async function createRelationship(sourceId, targetId, type, notes) {
  if (DERIVED_TYPES.has(type)) {
    throw Object.assign(
      new Error(`"${type}" is derived automatically from parent/sibling data and can't be created directly`),
      { status: 400 }
    )
  }

  const edge = { sourceId, targetId, type, notes: notes || null, createdAt: new Date() }

  if (type === 'spouse') {
    const unitId = (await findHouseholdAs(sourceId, 'spouse')) || (await findHouseholdAs(targetId, 'spouse')) || (await createHousehold()).id
    await ensureMember(unitId, sourceId, 'spouse')
    await ensureMember(unitId, targetId, 'spouse')
    return { ...edge, id: `${unitId}:spouse:${pairKey(sourceId, targetId)}` }
  }

  if (type === 'parent_of' || type === 'child_of') {
    const [parentId, childId] = type === 'parent_of' ? [sourceId, targetId] : [targetId, sourceId]
    const unitId = (await findHouseholdAs(childId, 'child')) || (await findHouseholdAs(parentId, 'spouse')) || (await createHousehold()).id
    await ensureMember(unitId, parentId, 'spouse')
    await ensureMember(unitId, childId, 'child')
    return { ...edge, id: `${unitId}:parent_of:${parentId}:${childId}` }
  }

  if (type === 'sibling') {
    const unitA = await findHouseholdAs(sourceId, 'child')
    const unitB = await findHouseholdAs(targetId, 'child')
    let unitId
    if (unitA && unitB && unitA !== unitB) {
      // Each already has different known parents on record — add both into A's
      // unit as children too, rather than silently discarding either parent link.
      unitId = unitA
      await ensureMember(unitId, targetId, 'child')
    } else {
      unitId = unitA || unitB || (await createHousehold()).id
      await ensureMember(unitId, sourceId, 'child')
      await ensureMember(unitId, targetId, 'child')
    }
    return { ...edge, id: `${unitId}:sibling:${pairKey(sourceId, targetId)}` }
  }

  // Everything else: a small circle of "member"s typed with the relationship name.
  // Reuse an existing circle of this exact type if these two people are already
  // both in one (avoids piling up duplicate 2-member units on repeated calls).
  const existing = await prisma.familyUnitMember.findMany({
    where: { contactId: { in: [sourceId, targetId] }, familyUnit: { type } },
    include: { familyUnit: { include: { members: true } } },
  })
  const sharedUnit = existing.find((m) => m.familyUnit.members.some((mm) => mm.contactId !== m.contactId && [sourceId, targetId].includes(mm.contactId)))
  const unitId = sharedUnit ? sharedUnit.familyUnitId : (await prisma.familyUnit.create({ data: { type, notes: notes || null } })).id
  await ensureMember(unitId, sourceId, 'member')
  await ensureMember(unitId, targetId, 'member')
  return { ...edge, id: `${unitId}:${type}:${pairKey(sourceId, targetId)}` }
}

async function deleteRelationship(id) {
  if (id.startsWith('derived:')) {
    throw Object.assign(new Error('this relationship is derived automatically and has no direct edge to delete — remove the underlying parent/sibling relationship instead'), { status: 400 })
  }

  const [unitIdStr, type, ...rest] = id.split(':')
  const unitId = Number(unitIdStr)
  const unit = await prisma.familyUnit.findUnique({ where: { id: unitId }, include: { members: true } })
  if (!unit) throw Object.assign(new Error('relationship not found'), { status: 404 })

  if (type === 'spouse' || type === 'sibling') {
    const [a, b] = rest.map(Number)
    if (type === 'sibling' && unit.members.some((m) => m.role === 'spouse')) {
      throw Object.assign(
        new Error('these two share recorded parents in this household — edit the parent relationship instead of the sibling label'),
        { status: 400 }
      )
    }
    await prisma.familyUnitMember.deleteMany({ where: { familyUnitId: unitId, contactId: { in: [a, b] } } })
  } else if (type === 'parent_of' || type === 'child_of') {
    const [first, second] = rest.map(Number)
    const childId = type === 'parent_of' ? second : first
    await prisma.familyUnitMember.deleteMany({ where: { familyUnitId: unitId, contactId: childId, role: 'child' } })
  } else {
    // Any other type (friend/colleague/etc): the whole unit represents this one fact.
    await prisma.familyUnit.delete({ where: { id: unitId } })
    return
  }

  const remaining = await prisma.familyUnitMember.count({ where: { familyUnitId: unitId } })
  if (remaining === 0) await prisma.familyUnit.delete({ where: { id: unitId } })
}

// -- Reading --

async function getAllRelationships() {
  const units = await prisma.familyUnit.findMany({ include: { members: true } })

  const edges = []
  const childToParents = new Map() // childId -> [parentId]
  const parentToChildren = new Map() // parentId -> [childId]
  const siblingPairs = new Set()

  for (const unit of units) {
    const spouses = unit.members.filter((m) => m.role === 'spouse')
    const children = unit.members.filter((m) => m.role === 'child')
    const plainMembers = unit.members.filter((m) => m.role === 'member')

    if (unit.type === 'household') {
      for (let i = 0; i < spouses.length; i++) {
        for (let j = i + 1; j < spouses.length; j++) {
          edges.push(makeEdge(unit, spouses[i].contactId, spouses[j].contactId, 'spouse'))
        }
      }
      for (const s of spouses) {
        for (const c of children) {
          edges.push(makeEdge(unit, s.contactId, c.contactId, 'parent_of'))
          edges.push(makeEdge(unit, c.contactId, s.contactId, 'child_of'))
          if (!parentToChildren.has(s.contactId)) parentToChildren.set(s.contactId, [])
          parentToChildren.get(s.contactId).push(c.contactId)
          if (!childToParents.has(c.contactId)) childToParents.set(c.contactId, [])
          childToParents.get(c.contactId).push(s.contactId)
        }
      }
      for (let i = 0; i < children.length; i++) {
        for (let j = i + 1; j < children.length; j++) {
          edges.push(makeEdge(unit, children[i].contactId, children[j].contactId, 'sibling'))
          siblingPairs.add(pairKey(children[i].contactId, children[j].contactId))
        }
      }
    } else {
      for (let i = 0; i < plainMembers.length; i++) {
        for (let j = i + 1; j < plainMembers.length; j++) {
          edges.push(makeEdge(unit, plainMembers[i].contactId, plainMembers[j].contactId, unit.type))
        }
      }
    }
  }

  edges.push(...deriveGrandparentEdges(parentToChildren, childToParents))
  edges.push(...deriveCousinEdges(siblingPairs, parentToChildren))

  return edges
}

function makeEdge(unit, sourceId, targetId, type) {
  return {
    id: `${unit.id}:${type}:${type === 'parent_of' || type === 'child_of' ? `${sourceId}:${targetId}` : pairKey(sourceId, targetId)}`,
    sourceId,
    targetId,
    type,
    notes: unit.notes || null,
    createdAt: unit.createdAt,
  }
}

function deriveGrandparentEdges(parentToChildren, childToParents) {
  const edges = []
  const seen = new Set()
  for (const [parentId, children] of parentToChildren) {
    const grandparents = childToParents.get(parentId) || []
    for (const grandparentId of grandparents) {
      for (const childId of children) {
        if (grandparentId === childId) continue
        const key = `${grandparentId}:${childId}`
        if (seen.has(key)) continue
        seen.add(key)
        edges.push({ id: `derived:grandparent_of:${key}`, sourceId: grandparentId, targetId: childId, type: 'grandparent_of', notes: null, createdAt: new Date() })
        edges.push({ id: `derived:grandchild_of:${childId}:${grandparentId}`, sourceId: childId, targetId: grandparentId, type: 'grandchild_of', notes: null, createdAt: new Date() })
      }
    }
  }
  return edges
}

function deriveCousinEdges(siblingPairs, parentToChildren) {
  const edges = []
  const cousinPairs = new Set()

  const siblingsOf = new Map()
  for (const key of siblingPairs) {
    const [a, b] = key.split(':').map(Number)
    if (!siblingsOf.has(a)) siblingsOf.set(a, new Set())
    if (!siblingsOf.has(b)) siblingsOf.set(b, new Set())
    siblingsOf.get(a).add(b)
    siblingsOf.get(b).add(a)
  }

  for (const key of siblingPairs) {
    const [p1, p2] = key.split(':').map(Number)
    const children1 = parentToChildren.get(p1) || []
    const children2 = parentToChildren.get(p2) || []
    for (const c1 of children1) {
      for (const c2 of children2) {
        if (c1 === c2) continue
        cousinPairs.add(pairKey(c1, c2))
      }
    }
  }

  // Siblings of a cousin are also cousins — expand to a fixed point.
  let frontier = Array.from(cousinPairs)
  while (frontier.length > 0) {
    const nextFrontier = []
    for (const key of frontier) {
      const [a, b] = key.split(':').map(Number)
      for (const [x, y] of [[a, b], [b, a]]) {
        for (const sibOfX of siblingsOf.get(x) || []) {
          if (sibOfX === y) continue
          const k = pairKey(sibOfX, y)
          if (cousinPairs.has(k)) continue
          cousinPairs.add(k)
          nextFrontier.push(k)
        }
      }
    }
    frontier = nextFrontier
  }

  for (const key of cousinPairs) {
    const [a, b] = key.split(':').map(Number)
    edges.push({ id: `derived:cousin:${key}`, sourceId: a, targetId: b, type: 'cousin', notes: null, createdAt: new Date() })
  }
  return edges
}

module.exports = { createRelationship, deleteRelationship, getAllRelationships, DERIVED_TYPES }
