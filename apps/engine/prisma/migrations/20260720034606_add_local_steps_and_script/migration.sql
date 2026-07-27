-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_DeployTarget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "workingDir" TEXT NOT NULL,
    "preflightJson" TEXT NOT NULL DEFAULT '[]',
    "uploadJson" TEXT,
    "branch" TEXT,
    "stepsJson" TEXT NOT NULL DEFAULT '[]',
    "localPreJson" TEXT NOT NULL DEFAULT '[]',
    "localPostJson" TEXT NOT NULL DEFAULT '[]',
    "scriptPath" TEXT,
    "healthUrl" TEXT,
    "dbConfigJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeployTarget_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DeployTarget_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_DeployTarget" ("branch", "createdAt", "dbConfigJson", "healthUrl", "id", "name", "preflightJson", "projectId", "serverId", "stepsJson", "uploadJson", "workingDir") SELECT "branch", "createdAt", "dbConfigJson", "healthUrl", "id", "name", "preflightJson", "projectId", "serverId", "stepsJson", "uploadJson", "workingDir" FROM "DeployTarget";
DROP TABLE "DeployTarget";
ALTER TABLE "new_DeployTarget" RENAME TO "DeployTarget";
CREATE INDEX "DeployTarget_projectId_idx" ON "DeployTarget"("projectId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
