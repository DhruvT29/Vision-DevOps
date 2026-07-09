import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { Project } from 'ts-morph';
import type { HttpMethod } from '@vision/shared';
import { ExtractedController, ExtractedModule } from './nest-extractor.service';

const APP_ROUTER_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/**
 * Next.js API surface:
 *  - App Router:   app/**\/route.ts → exported GET/POST/... handlers
 *  - Pages Router: pages/api/**     → default handler (method usually branched
 *    at runtime, so recorded as ALL)
 * Route paths derive from the folder structure; [param] → :param.
 */
@Injectable()
export class NextExtractorService {
  private readonly logger = new Logger(NextExtractorService.name);

  extract(stackDir: string): { modules: ExtractedModule[]; controllers: ExtractedController[] } {
    const controllers: ExtractedController[] = [];
    const moduleNames = new Map<string, string>(); // top segment → module file

    const appDir = ['app', 'src/app']
      .map((d) => path.join(stackDir, d))
      .find((d) => fs.existsSync(d));
    const pagesApiDir = ['pages/api', 'src/pages/api']
      .map((d) => path.join(stackDir, d))
      .find((d) => fs.existsSync(d));

    if (appDir) this.walkAppRouter(appDir, appDir, controllers, moduleNames);
    if (pagesApiDir) this.walkPagesApi(pagesApiDir, pagesApiDir, controllers, moduleNames);

    const modules: ExtractedModule[] = [...moduleNames.entries()].map(([name, filePath]) => ({
      name,
      filePath,
      controllerClassNames: [name],
    }));

    if (controllers.length > 0) {
      this.logger.log(`Next.js: ${controllers.length} route files found`);
    }
    return { modules, controllers };
  }

  private walkAppRouter(
    root: string,
    dir: string,
    controllers: ExtractedController[],
    moduleNames: Map<string, string>,
  ) {
    for (const entry of this.entries(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules') {
        this.walkAppRouter(root, full, controllers, moduleNames);
        continue;
      }
      if (!/^route\.(ts|js|tsx|jsx)$/.test(entry.name)) continue;

      const rel = path.relative(root, dir).replace(/\\/g, '/');
      const routePath = this.toRoutePath(rel);
      const groupName = this.groupOf(rel, 'next-app');
      moduleNames.set(groupName, full);

      const methods = this.exportedMethods(full);
      controllers.push({
        className: groupName,
        filePath: full,
        endpoints: methods.map((m) => ({
          method: m.method,
          fullPath: routePath,
          handlerName: m.method,
          params: [...routePath.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => ({
            name: match[1],
            source: 'path' as const,
          })),
          bodyFields: null,
          bodyTypeName: null,
          auth: { required: false, guards: [], roles: [] },
          filePath: full,
          line: m.line,
        })),
      });
    }
  }

  private walkPagesApi(
    root: string,
    dir: string,
    controllers: ExtractedController[],
    moduleNames: Map<string, string>,
  ) {
    for (const entry of this.entries(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.walkPagesApi(root, full, controllers, moduleNames);
        continue;
      }
      if (!/\.(ts|js)$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue;

      const rel = path
        .relative(root, full)
        .replace(/\\/g, '/')
        .replace(/\.(ts|js)$/, '')
        .replace(/\/index$/, '');
      const routePath = '/api' + this.toRoutePath(rel);
      const groupName = this.groupOf(rel, 'next-pages-api');
      moduleNames.set(groupName, full);

      controllers.push({
        className: groupName,
        filePath: full,
        endpoints: [
          {
            method: 'ALL' as HttpMethod,
            fullPath: routePath,
            handlerName: 'handler',
            params: [...routePath.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => ({
              name: match[1],
              source: 'path' as const,
            })),
            bodyFields: null,
            bodyTypeName: null,
            auth: { required: false, guards: [], roles: [] },
            filePath: full,
            line: 1,
          },
        ],
      });
    }
  }

  /** "api/users/[id]" → "/api/users/:id"; strips (groups) and @slots. */
  private toRoutePath(rel: string): string {
    const segments = rel
      .split('/')
      .filter((s) => s && !s.startsWith('(') && !s.startsWith('@'))
      .map((s) =>
        s.startsWith('[[...') ? ':rest?' : s.startsWith('[...') ? ':rest' : s.startsWith('[') ? `:${s.slice(1, -1)}` : s,
      );
    return '/' + segments.join('/');
  }

  private groupOf(rel: string, fallback: string): string {
    const seg = rel.split('/').filter((s) => s && !s.startsWith('(') && !s.startsWith('['));
    // group under e.g. "api/users" → "users"
    const meaningful = seg[0] === 'api' ? seg[1] : seg[0];
    return meaningful ?? fallback;
  }

  private exportedMethods(filePath: string): { method: HttpMethod; line: number }[] {
    const project = new Project({
      compilerOptions: { allowJs: true, skipLibCheck: true },
      skipAddingFilesFromTsConfig: true,
    });
    const file = project.addSourceFileAtPath(filePath);
    const out: { method: HttpMethod; line: number }[] = [];
    for (const [name, decls] of file.getExportedDeclarations()) {
      if (APP_ROUTER_METHODS.includes(name)) {
        out.push({ method: name as HttpMethod, line: decls[0]?.getStartLineNumber() ?? 1 });
      }
    }
    return out;
  }

  private entries(dir: string): fs.Dirent[] {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  }
}
