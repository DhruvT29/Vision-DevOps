-- CreateTable
CREATE TABLE "Collection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Collection_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SavedRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "collectionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "endpointId" TEXT,
    "method" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "headersJson" TEXT NOT NULL DEFAULT '{}',
    "body" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SavedRequest_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Assertion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "savedRequestId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "pathExpr" TEXT,
    "operator" TEXT NOT NULL,
    "expected" TEXT,
    CONSTRAINT "Assertion_savedRequestId_fkey" FOREIGN KEY ("savedRequestId") REFERENCES "SavedRequest" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Scenario" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Scenario_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScenarioStep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scenarioId" TEXT NOT NULL,
    "savedRequestId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "extractionsJson" TEXT NOT NULL DEFAULT '[]',
    CONSTRAINT "ScenarioStep_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "Scenario" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ScenarioStep_savedRequestId_fkey" FOREIGN KEY ("savedRequestId") REFERENCES "SavedRequest" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Collection_projectId_idx" ON "Collection"("projectId");

-- CreateIndex
CREATE INDEX "SavedRequest_collectionId_idx" ON "SavedRequest"("collectionId");

-- CreateIndex
CREATE INDEX "Assertion_savedRequestId_idx" ON "Assertion"("savedRequestId");

-- CreateIndex
CREATE INDEX "Scenario_projectId_idx" ON "Scenario"("projectId");

-- CreateIndex
CREATE INDEX "ScenarioStep_scenarioId_idx" ON "ScenarioStep"("scenarioId");
