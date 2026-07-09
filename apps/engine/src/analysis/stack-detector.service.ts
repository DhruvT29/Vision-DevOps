import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import type { DetectedStack } from '@vision/shared';

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'out',
  'coverage',
  'uploads',
  '.turbo',
]);

const MAX_DEPTH = 3;

/**
 * Walks a project root looking for package.json files (excluding vendored/build
 * dirs) and classifies each app dir by its dependencies.
 */
@Injectable()
export class StackDetectorService {
  private readonly logger = new Logger(StackDetectorService.name);

  detect(rootPath: string): DetectedStack[] {
    const stacks: DetectedStack[] = [];
    this.walk(rootPath, rootPath, 0, stacks);
    return stacks;
  }

  private walk(rootPath: string, dir: string, depth: number, out: DetectedStack[]) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const stack = this.classify(rootPath, dir, pkgPath);
      if (stack) out.push(stack);
    }

    if (depth >= MAX_DEPTH) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.')) {
        continue;
      }
      this.walk(rootPath, path.join(dir, entry.name), depth + 1, out);
    }
  }

  private classify(rootPath: string, dir: string, pkgPath: string): DetectedStack | null {
    let pkg: { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    } catch (e) {
      this.logger.warn(`Unparseable package.json at ${pkgPath}`);
      return null;
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const rel = path.relative(rootPath, dir) || '.';

    let kind: DetectedStack['kind'] | null = null;
    if (deps['@nestjs/core']) kind = 'nest';
    else if (deps['next']) kind = 'next';
    else if (deps['react']) kind = 'react';
    else if (Object.keys(deps).length > 0) kind = 'unknown-node';

    if (!kind) return null;
    return { kind, dir: rel.replace(/\\/g, '/'), label: pkg.name };
  }
}
