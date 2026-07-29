-- CreateTable
CREATE TABLE "institutions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "institution_affiliations" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "institution_id" INTEGER NOT NULL,
    "contact_id" INTEGER NOT NULL,
    "role" TEXT,
    "start_date" TEXT,
    "end_date" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "institution_affiliations_institution_id_fkey" FOREIGN KEY ("institution_id") REFERENCES "institutions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "institution_affiliations_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "institution_affiliations_institution_id_idx" ON "institution_affiliations"("institution_id");

-- CreateIndex
CREATE INDEX "institution_affiliations_contact_id_idx" ON "institution_affiliations"("contact_id");
