-- CreateTable
CREATE TABLE "Server" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "username" TEXT NOT NULL,
    "encryptedAuthJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "DeployTarget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "workingDir" TEXT NOT NULL,
    "preflightJson" TEXT NOT NULL DEFAULT '[]',
    "uploadJson" TEXT,
    "stepsJson" TEXT NOT NULL DEFAULT '[]',
    "healthUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeployTarget_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DeployTarget_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "targetId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "stepsJson" TEXT NOT NULL DEFAULT '[]',
    "log" TEXT NOT NULL DEFAULT '',
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "Deployment_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "DeployTarget" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "DeployTarget_projectId_idx" ON "DeployTarget"("projectId");

-- CreateIndex
CREATE INDEX "Deployment_targetId_startedAt_idx" ON "Deployment"("targetId", "startedAt");

-- CreateIndex
CREATE INDEX "Deployment_projectId_startedAt_idx" ON "Deployment"("projectId", "startedAt");
