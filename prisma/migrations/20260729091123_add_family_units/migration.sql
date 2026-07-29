-- CreateTable
CREATE TABLE "family_units" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "type" TEXT NOT NULL,
    "label" TEXT,
    "notes" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "family_unit_members" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "family_unit_id" INTEGER NOT NULL,
    "contact_id" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    CONSTRAINT "family_unit_members_family_unit_id_fkey" FOREIGN KEY ("family_unit_id") REFERENCES "family_units" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "family_unit_members_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "family_unit_members_family_unit_id_contact_id_key" ON "family_unit_members"("family_unit_id", "contact_id");
