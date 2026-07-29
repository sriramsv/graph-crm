// One-off migration: read legacy pairwise `relationships` rows and populate
// FamilyUnit/FamilyUnitMember. Leaves the `relationships` table untouched as a backup.
const prisma = require('./prisma/client')

async function main() {
  const existingUnits = await prisma.familyUnit.count()
  if (existingUnits > 0) {
    console.log(`family_units already has ${existingUnits} rows — refusing to run twice. Delete them first if you want to re-run.`)
    process.exit(1)
  }

  const allRels = await prisma.relationship.findMany()
  console.log(`Migrating ${allRels.length} legacy relationships...`)

  // contactId -> household FamilyUnit id (as spouse or as child)
  const spouseUnitOf = new Map()
  const childUnitOf = new Map()

  async function createHousehold() {
    return prisma.familyUnit.create({ data: { type: 'household' } })
  }

  async function addMember(unitId, contactId, role) {
    await prisma.familyUnitMember.upsert({
      where: { familyUnitId_contactId: { familyUnitId: unitId, contactId } },
      create: { familyUnitId: unitId, contactId, role },
      update: {},
    })
  }

  // Pass 1: spouse edges establish household units.
  const spouseRels = allRels.filter((r) => r.type === 'spouse')
  const spousePairsSeen = new Set()
  for (const r of spouseRels) {
    const [a, b] = [r.sourceId, r.targetId].sort((x, y) => x - y)
    const key = `${a}:${b}`
    if (spousePairsSeen.has(key)) continue
    spousePairsSeen.add(key)

    let unitId = spouseUnitOf.get(a) || spouseUnitOf.get(b)
    if (!unitId) {
      const unit = await createHousehold()
      unitId = unit.id
    }
    await addMember(unitId, a, 'spouse')
    await addMember(unitId, b, 'spouse')
    spouseUnitOf.set(a, unitId)
    spouseUnitOf.set(b, unitId)
  }
  console.log(`Pass 1 (spouse): ${spousePairsSeen.size} pairs`)

  // Pass 2: parent_of edges — merge into the child's existing unit, the parent's
  // existing unit, or create a new one, so both parents of a child converge on one unit.
  const parentRels = allRels.filter((r) => r.type === 'parent_of')
  let parentEdgesProcessed = 0
  for (const r of parentRels) {
    const parentId = r.sourceId
    const childId = r.targetId

    let unitId = childUnitOf.get(childId) || spouseUnitOf.get(parentId)
    if (!unitId) {
      const unit = await createHousehold()
      unitId = unit.id
    }
    await addMember(unitId, parentId, 'spouse')
    await addMember(unitId, childId, 'child')
    spouseUnitOf.set(parentId, unitId)
    childUnitOf.set(childId, unitId)
    parentEdgesProcessed++
  }
  console.log(`Pass 2 (parent_of): ${parentEdgesProcessed} edges`)

  // Pass 3: sibling edges without a matching parent_of pair yet — create a
  // parentless household unit with both as children, unless they already share one.
  const siblingRels = allRels.filter((r) => r.type === 'sibling')
  const siblingPairsSeen = new Set()
  let siblingUnitsCreated = 0
  for (const r of siblingRels) {
    const [a, b] = [r.sourceId, r.targetId].sort((x, y) => x - y)
    const key = `${a}:${b}`
    if (siblingPairsSeen.has(key)) continue
    siblingPairsSeen.add(key)

    const unitA = childUnitOf.get(a)
    const unitB = childUnitOf.get(b)
    if (unitA && unitA === unitB) continue // already siblings via a shared parent unit

    let unitId = unitA || unitB
    if (!unitId) {
      const unit = await createHousehold()
      unitId = unit.id
      siblingUnitsCreated++
    }
    await addMember(unitId, a, 'child')
    await addMember(unitId, b, 'child')
    childUnitOf.set(a, unitId)
    childUnitOf.set(b, unitId)
  }
  console.log(`Pass 3 (sibling): ${siblingPairsSeen.size} pairs, ${siblingUnitsCreated} new parentless household units`)

  // Pass 4: everything else becomes a 2-member circle of the original type,
  // except child_of (inverse of parent_of, already covered) and the fully-derived
  // grandparent_of/grandchild_of/cousin types, which are dropped from storage.
  const SKIP_TYPES = new Set(['spouse', 'parent_of', 'child_of', 'sibling', 'grandparent_of', 'grandchild_of', 'cousin'])
  const otherRels = allRels.filter((r) => !SKIP_TYPES.has(r.type))
  const otherPairsSeen = new Set()
  let otherUnitsCreated = 0
  for (const r of otherRels) {
    const [a, b] = [r.sourceId, r.targetId].sort((x, y) => x - y)
    const key = `${a}:${b}:${r.type}`
    if (otherPairsSeen.has(key)) continue
    otherPairsSeen.add(key)

    const unit = await prisma.familyUnit.create({ data: { type: r.type, notes: r.notes || null } })
    await addMember(unit.id, a, 'member')
    await addMember(unit.id, b, 'member')
    otherUnitsCreated++
  }
  console.log(`Pass 4 (other types): ${otherUnitsCreated} circles created`)

  const totalUnits = await prisma.familyUnit.count()
  const totalMembers = await prisma.familyUnitMember.count()
  console.log(`Done. family_units: ${totalUnits}, family_unit_members: ${totalMembers}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
