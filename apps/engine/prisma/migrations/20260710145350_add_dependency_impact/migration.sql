-- AlterTable
ALTER TABLE "GraphEdge" ADD COLUMN "metaJson" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ModuleNode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "snapshotId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "isGlobal" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "ModuleNode_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "Snapshot" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ModuleNode" ("filePath", "id", "kind", "name", "snapshotId") SELECT "filePath", "id", "kind", "name", "snapshotId" FROM "ModuleNode";
DROP TABLE "ModuleNode";
ALTER TABLE "new_ModuleNode" RENAME TO "ModuleNode";
CREATE INDEX "ModuleNode_snapshotId_idx" ON "ModuleNode"("snapshotId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
