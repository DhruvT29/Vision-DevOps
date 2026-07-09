-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "rootPath" TEXT NOT NULL,
    "detectedStacksJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastOpenedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Snapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "statsJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Snapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ModuleNode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "snapshotId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    CONSTRAINT "ModuleNode_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "Snapshot" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Endpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "moduleId" TEXT NOT NULL,
    "layer" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "fullPath" TEXT NOT NULL,
    "handlerName" TEXT NOT NULL,
    "paramsJson" TEXT NOT NULL DEFAULT '[]',
    "bodyFieldsJson" TEXT,
    "bodyTypeName" TEXT,
    "authJson" TEXT NOT NULL DEFAULT '{"required":false,"guards":[],"roles":[]}',
    "filePath" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    CONSTRAINT "Endpoint_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "ModuleNode" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FrontendCall" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "snapshotId" TEXT NOT NULL,
    "client" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "rawUrl" TEXT NOT NULL,
    "resolvedPath" TEXT,
    "callerSymbol" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    CONSTRAINT "FrontendCall_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "Snapshot" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GraphEdge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "snapshotId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "confidence" REAL NOT NULL DEFAULT 1,
    "manual" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "GraphEdge_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "Snapshot" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_rootPath_key" ON "Project"("rootPath");

-- CreateIndex
CREATE INDEX "Snapshot_projectId_idx" ON "Snapshot"("projectId");

-- CreateIndex
CREATE INDEX "ModuleNode_snapshotId_idx" ON "ModuleNode"("snapshotId");

-- CreateIndex
CREATE INDEX "Endpoint_moduleId_idx" ON "Endpoint"("moduleId");

-- CreateIndex
CREATE INDEX "FrontendCall_snapshotId_idx" ON "FrontendCall"("snapshotId");

-- CreateIndex
CREATE INDEX "GraphEdge_snapshotId_idx" ON "GraphEdge"("snapshotId");
