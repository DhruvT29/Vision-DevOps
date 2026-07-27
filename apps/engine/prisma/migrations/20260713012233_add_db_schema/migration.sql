-- AlterTable
ALTER TABLE "DeployTarget" ADD COLUMN "dbConfigJson" TEXT;

-- CreateTable
CREATE TABLE "DbSchemaCache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "targetId" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "database" TEXT NOT NULL,
    "schemaJson" TEXT NOT NULL,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DbSchemaCache_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "DeployTarget" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "DbSchemaCache_targetId_key" ON "DbSchemaCache"("targetId");
