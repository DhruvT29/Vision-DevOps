import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import {
  ClassDeclaration,
  Decorator,
  InterfaceDeclaration,
  MethodDeclaration,
  Node,
  Project,
  SourceFile,
  SyntaxKind,
} from 'ts-morph';
import type {
  BodyField,
  EndpointAuth,
  EndpointParam,
  HttpMethod,
} from '@vision/shared';

const HTTP_DECORATORS: Record<string, HttpMethod> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
  Head: 'HEAD',
  Options: 'OPTIONS',
  All: 'ALL',
};

export interface ExtractedEndpoint {
  method: HttpMethod;
  fullPath: string;
  handlerName: string;
  params: EndpointParam[];
  bodyFields: BodyField[] | null;
  bodyTypeName: string | null;
  auth: EndpointAuth;
  filePath: string;
  line: number;
}

export interface ExtractedController {
  className: string;
  filePath: string;
  endpoints: ExtractedEndpoint[];
}

export interface ExtractedModule {
  name: string;
  filePath: string;
  /** class names from the @Module({ controllers: [...] }) array */
  controllerClassNames: string[];
}

export interface NestExtraction {
  globalPrefix: string | null;
  modules: ExtractedModule[];
  controllers: ExtractedController[];
}

/**
 * Static analysis of a NestJS source tree via ts-morph. The target project is
 * never executed — everything is read from decorators in the AST.
 */
@Injectable()
export class NestExtractorService {
  private readonly logger = new Logger(NestExtractorService.name);

  extract(stackDir: string): NestExtraction {
    const srcDir = fs.existsSync(path.join(stackDir, 'src'))
      ? path.join(stackDir, 'src')
      : stackDir;

    // Parse-only project: no type-check pass, files added explicitly so we
    // never crawl node_modules.
    const project = new Project({
      compilerOptions: {
        allowJs: false,
        experimentalDecorators: true,
        skipLibCheck: true,
      },
      skipAddingFilesFromTsConfig: true,
    });
    const glob = `${srcDir.replace(/\\/g, '/')}/**/*.ts`;
    project.addSourceFilesAtPaths([glob, `!**/*.spec.ts`, `!**/*.d.ts`]);

    const files = project.getSourceFiles();
    this.logger.log(`Parsing ${files.length} source files under ${srcDir}`);

    const globalPrefix = this.findGlobalPrefix(files);
    const modules: ExtractedModule[] = [];
    const controllers: ExtractedController[] = [];

    for (const file of files) {
      for (const cls of file.getClasses()) {
        if (cls.getDecorator('Module')) {
          const mod = this.extractModule(cls, file);
          if (mod) modules.push(mod);
        }
        if (cls.getDecorator('Controller')) {
          controllers.push(this.extractController(cls, file, globalPrefix));
        }
      }
    }

    return { globalPrefix, modules, controllers };
  }

  // ── Global prefix (e.g. app.setGlobalPrefix('api')) ───────────────────────

  private findGlobalPrefix(files: SourceFile[]): string | null {
    for (const file of files) {
      if (path.basename(file.getFilePath()) !== 'main.ts') continue;
      for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const expr = call.getExpression().getText();
        if (!expr.endsWith('.setGlobalPrefix')) continue;
        const arg = call.getArguments()[0];
        const lit = arg?.asKind(SyntaxKind.StringLiteral);
        if (lit) return lit.getLiteralValue();
      }
    }
    return null;
  }

  // ── Modules ────────────────────────────────────────────────────────────────

  private extractModule(cls: ClassDeclaration, file: SourceFile): ExtractedModule | null {
    const name = cls.getName();
    if (!name) return null;

    const controllerClassNames: string[] = [];
    const arg = cls.getDecorator('Module')?.getArguments()[0];
    const obj = arg?.asKind(SyntaxKind.ObjectLiteralExpression);
    const controllersProp = obj?.getProperty('controllers')?.asKind(SyntaxKind.PropertyAssignment);
    const arr = controllersProp?.getInitializer()?.asKind(SyntaxKind.ArrayLiteralExpression);
    if (arr) {
      for (const el of arr.getElements()) controllerClassNames.push(el.getText());
    }

    return { name, filePath: file.getFilePath(), controllerClassNames };
  }

  // ── Controllers & endpoints ────────────────────────────────────────────────

  private extractController(
    cls: ClassDeclaration,
    file: SourceFile,
    globalPrefix: string | null,
  ): ExtractedController {
    const basePath = this.controllerBasePath(cls.getDecorator('Controller')!);
    const classGuards = this.guardsOf(cls.getDecorators());
    const classRoles = this.rolesOf(cls.getDecorators());

    const endpoints: ExtractedEndpoint[] = [];
    for (const method of cls.getMethods()) {
      const route = this.routeDecorator(method);
      if (!route) continue;

      const subPath = this.firstStringArg(route.decorator) ?? '';
      const fullPath = this.joinPath(globalPrefix, basePath, subPath);
      const methodGuards = this.guardsOf(method.getDecorators());
      const methodRoles = this.rolesOf(method.getDecorators());
      const guards = [...new Set([...classGuards, ...methodGuards])];
      const roles = [...new Set([...classRoles, ...methodRoles])];

      const { bodyFields, bodyTypeName } = this.extractBody(method);

      endpoints.push({
        method: route.httpMethod,
        fullPath,
        handlerName: method.getName(),
        params: this.extractParams(method, fullPath),
        bodyFields,
        bodyTypeName,
        auth: { required: guards.length > 0, guards, roles },
        filePath: file.getFilePath(),
        line: method.getStartLineNumber(),
      });
    }

    return { className: cls.getName() ?? '(anonymous)', filePath: file.getFilePath(), endpoints };
  }

  private controllerBasePath(decorator: Decorator): string {
    const arg = decorator.getArguments()[0];
    if (!arg) return '';
    const lit = arg.asKind(SyntaxKind.StringLiteral);
    if (lit) return lit.getLiteralValue();
    // @Controller({ path: 'x', ... }) form
    const obj = arg.asKind(SyntaxKind.ObjectLiteralExpression);
    const pathProp = obj?.getProperty('path')?.asKind(SyntaxKind.PropertyAssignment);
    const pathLit = pathProp?.getInitializer()?.asKind(SyntaxKind.StringLiteral);
    return pathLit?.getLiteralValue() ?? '';
  }

  private routeDecorator(
    method: MethodDeclaration,
  ): { decorator: Decorator; httpMethod: HttpMethod } | null {
    for (const dec of method.getDecorators()) {
      const httpMethod = HTTP_DECORATORS[dec.getName()];
      if (httpMethod) return { decorator: dec, httpMethod };
    }
    return null;
  }

  private firstStringArg(decorator: Decorator): string | null {
    const arg = decorator.getArguments()[0];
    return arg?.asKind(SyntaxKind.StringLiteral)?.getLiteralValue() ?? null;
  }

  private joinPath(...parts: (string | null)[]): string {
    const cleaned = parts
      .filter((p): p is string => !!p)
      .map((p) => p.replace(/^\/+|\/+$/g, ''))
      .filter((p) => p.length > 0);
    return '/' + cleaned.join('/');
  }

  // ── Auth ───────────────────────────────────────────────────────────────────

  private guardsOf(decorators: Decorator[]): string[] {
    const guards: string[] = [];
    for (const dec of decorators) {
      if (dec.getName() !== 'UseGuards') continue;
      for (const arg of dec.getArguments()) guards.push(arg.getText());
    }
    return guards;
  }

  private rolesOf(decorators: Decorator[]): string[] {
    const roles: string[] = [];
    for (const dec of decorators) {
      if (dec.getName() !== 'Roles') continue;
      for (const arg of dec.getArguments()) {
        // Role.ADMIN → ADMIN; 'admin' → admin
        const text = arg.getText();
        const lit = arg.asKind(SyntaxKind.StringLiteral);
        roles.push(lit ? lit.getLiteralValue() : text.split('.').pop() ?? text);
      }
    }
    return roles;
  }

  // ── Params & body ──────────────────────────────────────────────────────────

  private extractParams(method: MethodDeclaration, fullPath: string): EndpointParam[] {
    const params: EndpointParam[] = [];

    // Path params derived from the route pattern — always correct even when
    // the handler takes the whole params object.
    for (const match of fullPath.matchAll(/:([A-Za-z0-9_]+)/g)) {
      params.push({ name: match[1], source: 'path' });
    }

    for (const p of method.getParameters()) {
      const queryDec = p.getDecorators().find((d) => d.getName() === 'Query');
      if (!queryDec) continue;
      const name = this.firstStringArg(queryDec);
      if (name) {
        params.push({
          name,
          source: 'query',
          type: p.getTypeNode()?.getText(),
          optional: p.hasQuestionToken() || p.hasInitializer(),
        });
      }
    }
    return params;
  }

  private extractBody(method: MethodDeclaration): {
    bodyFields: BodyField[] | null;
    bodyTypeName: string | null;
  } {
    for (const p of method.getParameters()) {
      const bodyDec = p.getDecorators().find((d) => d.getName() === 'Body');
      if (!bodyDec) continue;

      const typeName = p.getTypeNode()?.getText() ?? null;
      const decl = p
        .getType()
        .getSymbol()
        ?.getDeclarations()?.[0];

      if (decl && (Node.isClassDeclaration(decl) || Node.isInterfaceDeclaration(decl))) {
        return { bodyFields: this.fieldsOf(decl), bodyTypeName: typeName };
      }
      return { bodyFields: null, bodyTypeName: typeName };
    }
    return { bodyFields: null, bodyTypeName: null };
  }

  private fieldsOf(decl: ClassDeclaration | InterfaceDeclaration): BodyField[] {
    const fields: BodyField[] = [];
    for (const prop of decl.getProperties()) {
      const validators = Node.isPropertyDeclaration(prop)
        ? prop.getDecorators().map((d) => d.getName())
        : [];
      fields.push({
        name: prop.getName(),
        type: prop.getTypeNode()?.getText() ?? 'unknown',
        optional: prop.hasQuestionToken() || validators.includes('IsOptional'),
        validators,
      });
    }
    return fields;
  }
}
