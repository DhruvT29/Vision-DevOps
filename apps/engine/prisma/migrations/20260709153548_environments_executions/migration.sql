-- CreateTable
CREATE TABLE "Environment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "variablesJson" TEXT NOT NULL DEFAULT '{}',
    "authJson" TEXT NOT NULL DEFAULT '{"type":"none"}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Environment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Execution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "endpointId" TEXT,
    "environmentId" TEXT,
    "method" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "requestHeadersJson" TEXT NOT NULL DEFAULT '{}',
    "requestBody" TEXT,
    "status" INTEGER,
    "durationMs" INTEGER NOT NULL,
    "responseHeadersJson" TEXT NOT NULL DEFAULT '{}',
    "responseBody" TEXT,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Execution_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Environment_projectId_idx" ON "Environment"("projectId");

-- CreateIndex
CREATE INDEX "Execution_projectId_createdAt_idx" ON "Execution"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "Execution_endpointId_idx" ON "Execution"("endpointId");
