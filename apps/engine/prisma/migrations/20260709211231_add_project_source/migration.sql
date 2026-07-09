-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "rootPath" TEXT NOT NULL,
    "detectedStacksJson" TEXT NOT NULL DEFAULT '[]',
    "source" TEXT NOT NULL DEFAULT 'local',
    "repoUrl" TEXT,
    "repoCloneUrl" TEXT,
    "repoBranch" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastOpenedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Project" ("createdAt", "detectedStacksJson", "id", "lastOpenedAt", "name", "rootPath") SELECT "createdAt", "detectedStacksJson", "id", "lastOpenedAt", "name", "rootPath" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE UNIQUE INDEX "Project_rootPath_key" ON "Project"("rootPath");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
