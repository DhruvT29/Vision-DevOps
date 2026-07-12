-- CreateTable
CREATE TABLE "EntityNode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "snapshotId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "line" INTEGER NOT NULL DEFAULT 1,
    "moduleId" TEXT,
    "columnsJson" TEXT NOT NULL DEFAULT '[]',
    CONSTRAINT "EntityNode_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "Snapshot" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "EntityNode_snapshotId_idx" ON "EntityNode"("snapshotId");
