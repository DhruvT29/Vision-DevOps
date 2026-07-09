import { BadRequestException, Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import type { OpenProjectResponse, ProjectSummary } from '@vision/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ScannerService } from '../analysis/scanner.service';
import { StackDetectorService } from '../analysis/stack-detector.service';

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly detector: StackDetectorService,
    private readonly scanner: ScannerService,
  ) {}

  async open(rootPath: string): Promise<OpenProjectResponse> {
    const normalized = path.resolve(rootPath);
    if (!fs.existsSync(normalized) || !fs.statSync(normalized).isDirectory()) {
      throw new BadRequestException(`Not a directory: ${normalized}`);
    }

    const stacks = this.detector.detect(normalized);
    if (stacks.length === 0) {
      throw new BadRequestException(
        `No Node.js apps found under ${normalized} (no package.json within 3 levels)`,
      );
    }

    const project = await this.prisma.project.upsert({
      where: { rootPath: normalized },
      create: {
        name: path.basename(normalized),
        rootPath: normalized,
        detectedStacksJson: JSON.stringify(stacks),
      },
      update: {
        lastOpenedAt: new Date(),
        detectedStacksJson: JSON.stringify(stacks),
      },
    });

    const snapshot = await this.prisma.snapshot.create({
      data: { projectId: project.id },
    });

    this.scanner.runInBackground(snapshot.id, normalized, stacks);

    return {
      project: this.toSummary(project),
      snapshot: {
        id: snapshot.id,
        projectId: project.id,
        status: 'pending',
        createdAt: snapshot.createdAt.toISOString(),
      },
    };
  }

  async list(): Promise<ProjectSummary[]> {
    const projects = await this.prisma.project.findMany({
      orderBy: { lastOpenedAt: 'desc' },
    });
    return projects.map((p) => this.toSummary(p));
  }

  /** Latest completed (or otherwise most recent) snapshot for a project. */
  async latestSnapshot(projectId: string) {
    return (
      (await this.prisma.snapshot.findFirst({
        where: { projectId, status: 'completed' },
        orderBy: { createdAt: 'desc' },
      })) ??
      (await this.prisma.snapshot.findFirst({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
      }))
    );
  }

  private toSummary(p: {
    id: string;
    name: string;
    rootPath: string;
    detectedStacksJson: string;
    lastOpenedAt: Date;
    createdAt: Date;
  }): ProjectSummary {
    return {
      id: p.id,
      name: p.name,
      rootPath: p.rootPath,
      detectedStacks: JSON.parse(p.detectedStacksJson),
      lastOpenedAt: p.lastOpenedAt.toISOString(),
      createdAt: p.createdAt.toISOString(),
    };
  }
}
