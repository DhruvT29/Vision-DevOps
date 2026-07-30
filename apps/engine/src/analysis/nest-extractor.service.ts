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
  PropertyDeclaration,
  ReturnStatement,
  SourceFile,
  SyntaxKind,
} from 'ts-morph';
import type {
  BodyField,
  EndpointAuth,
  EndpointParam,
  EntityColumn,
  HttpMethod,
  TableTouchKind,
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
  /** module class names from the @Module({ imports: [...] }) array — best-effort, may include external modules */
  importedModuleNames?: string[];
  /** decorated with @Global() — providers reachable everywhere without imports */
  isGlobal?: boolean;
}

/** Raw import statements crossing module folders — coupling @Module doesn't declare. */
export interface ModuleFileDependency {
  /** importing module name */
  from: string;
  /** imported module name */
  to: string;
  /** total cross-module import statements */
  count: number;
  /** sample of importing → imported absolute file paths (capped at 20) */
  files: { from: string; to: string }[];
  /** symbols crossing the boundary with usage counts, highest first (capped at 15) */
  symbols: { name: string; count: number }[];
}

/** A foreign-key relation declared (or inferred) on an entity. */
export interface ExtractedRelation {
  /** declaring property (or the implicit column name) */
  property: string;
  /** raw target reference — a class name, table name, or import alias */
  target: string;
  /** resolved target class name (filled by resolveRelationsAndInferFks) */
  resolvedTarget?: string;
  /** the DB column backing this FK, when known (@JoinColumn name or `<prop>Id`) */
  joinColumn?: string;
  /** heuristic guess (implicit `xxxId` column with no relation decorator) */
  inferred?: boolean;
}

/** TypeORM @Entity class — one database table. */
export interface ExtractedEntity {
  className: string;
  tableName: string;
  filePath: string;
  line: number;
  columns: EntityColumn[];
  /** relation targets with the declaring property */
  relations: ExtractedRelation[];
  /** module owning the entity's folder (filled after ownership resolution) */
  ownerModule?: string;
}

/** One place where a module reads/writes an entity's table. */
export interface ExtractedTableTouch {
  /** module name */
  module: string;
  /** entity class name */
  entity: string;
  via: TableTouchKind;
  /** absolute path of the file where the access happens */
  file: string;
}

export interface NestExtraction {
  globalPrefix: string | null;
  modules: ExtractedModule[];
  controllers: ExtractedController[];
  fileDependencies: ModuleFileDependency[];
  entities: ExtractedEntity[];
  tableTouches: ExtractedTableTouch[];
}

const COLUMN_DECORATORS = new Set([
  'Column',
  'PrimaryColumn',
  'PrimaryGeneratedColumn',
  'CreateDateColumn',
  'UpdateDateColumn',
  'DeleteDateColumn',
  'VersionColumn',
  'ObjectIdColumn',
]);

const RELATION_DECORATORS = new Set(['ManyToOne', 'OneToMany', 'OneToOne', 'ManyToMany']);

/** query/query-builder methods whose string args may reference a table */
const SQL_CALL_RE =
  /\.(query|createQueryBuilder|from|leftJoin|leftJoinAndSelect|innerJoin|innerJoinAndSelect|rightJoin)$/;

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

    const entities: ExtractedEntity[] = [];

    for (const file of files) {
      for (const cls of file.getClasses()) {
        if (cls.getDecorator('Module')) {
          const mod = this.extractModule(cls, file);
          if (mod) modules.push(mod);
        }
        if (cls.getDecorator('Controller')) {
          controllers.push(this.extractController(cls, file, globalPrefix));
        }
        if (cls.getDecorator('Entity')) {
          const ent = this.extractEntity(cls, file);
          if (ent) entities.push(ent);
        }
      }
    }

    const ownerOf = this.buildOwnerResolver(modules, srcDir);
    for (const ent of entities) ent.ownerModule = ownerOf(ent.filePath);

    this.resolveRelationsAndInferFks(entities);

    const fileDependencies = this.extractFileDependencies(project, ownerOf);
    const tableTouches = this.extractTableTouches(project, entities, ownerOf);

    return { globalPrefix, modules, controllers, fileDependencies, entities, tableTouches };
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

    const arg = cls.getDecorator('Module')?.getArguments()[0];
    const obj = arg?.asKind(SyntaxKind.ObjectLiteralExpression);

    const controllerClassNames: string[] = [];
    const controllersProp = obj?.getProperty('controllers')?.asKind(SyntaxKind.PropertyAssignment);
    const arr = controllersProp?.getInitializer()?.asKind(SyntaxKind.ArrayLiteralExpression);
    if (arr) {
      for (const el of arr.getElements()) controllerClassNames.push(el.getText());
    }

    const importedModuleNames: string[] = [];
    const importsProp = obj?.getProperty('imports')?.asKind(SyntaxKind.PropertyAssignment);
    const importsArr = importsProp?.getInitializer()?.asKind(SyntaxKind.ArrayLiteralExpression);
    if (importsArr) {
      for (const el of importsArr.getElements()) {
        const imported = this.importedModuleName(el);
        if (imported && !importedModuleNames.includes(imported)) importedModuleNames.push(imported);
      }
    }

    return {
      name,
      filePath: file.getFilePath(),
      controllerClassNames,
      importedModuleNames,
      isGlobal: !!cls.getDecorator('Global'),
    };
  }

  // ── Cross-module file imports (hidden coupling) ────────────────────────────

  /**
   * Raw `import`/`export ... from` statements that cross module folder
   * boundaries — coupling the @Module wiring doesn't declare (shared DTOs,
   * entities, helpers). A module "owns" its directory subtree, deepest module
   * winning. Modules defined directly at the src root (typically AppModule)
   * own nothing, so root-level shared files don't smear every import into one
   * bucket.
   */
  /**
   * File path → owning module name. A module owns its directory subtree,
   * deepest module winning; modules defined directly at the src root
   * (typically AppModule) own nothing, so root-level shared files don't smear
   * every import into one bucket.
   */
  private buildOwnerResolver(modules: ExtractedModule[], srcDir: string) {
    const srcRoot = srcDir.replace(/\\/g, '/');
    const owners = modules
      .map((m) => ({ name: m.name, dir: path.dirname(m.filePath).replace(/\\/g, '/') }))
      .filter((m) => m.dir !== srcRoot)
      .sort((a, b) => b.dir.length - a.dir.length);
    return (filePath: string): string | undefined =>
      owners.find((o) => filePath.startsWith(o.dir + '/'))?.name;
  }

  private extractFileDependencies(
    project: Project,
    ownerOf: (filePath: string) => string | undefined,
  ): ModuleFileDependency[] {
    interface PairAcc {
      from: string;
      to: string;
      count: number;
      files: { from: string; to: string }[];
      symbolCounts: Map<string, number>;
    }
    const byPair = new Map<string, PairAcc>();

    for (const file of project.getSourceFiles()) {
      const fromPath = file.getFilePath();
      const fromModule = ownerOf(fromPath);
      if (!fromModule) continue;

      // lazy identifier-frequency index for this file — usage count of an
      // imported symbol = occurrences of its local name minus the import itself
      let idCounts: Map<string, number> | null = null;
      const usageOf = (localName: string) => {
        if (!idCounts) {
          const counts = new Map<string, number>();
          file.forEachDescendant((node) => {
            if (node.getKind() === SyntaxKind.Identifier) {
              const t = node.getText();
              counts.set(t, (counts.get(t) ?? 0) + 1);
            }
          });
          idCounts = counts;
        }
        return Math.max(0, (idCounts.get(localName) ?? 0) - 1);
      };

      for (const decl of [...file.getImportDeclarations(), ...file.getExportDeclarations()]) {
        const target = decl.getModuleSpecifierSourceFile();
        if (!target) continue; // package import or unresolved path alias
        const toPath = target.getFilePath();
        const toModule = ownerOf(toPath);
        if (!toModule || toModule === fromModule) continue;

        const key = `${fromModule}->${toModule}`;
        let dep = byPair.get(key);
        if (!dep) {
          byPair.set(
            key,
            (dep = { from: fromModule, to: toModule, count: 0, files: [], symbolCounts: new Map() }),
          );
        }
        dep.count++;
        if (dep.files.length < 20) dep.files.push({ from: fromPath, to: toPath });

        const addSymbol = (name: string, usage: number) =>
          dep!.symbolCounts.set(name, (dep!.symbolCounts.get(name) ?? 0) + usage);
        if (Node.isImportDeclaration(decl)) {
          for (const spec of decl.getNamedImports()) {
            addSymbol(spec.getName(), usageOf(spec.getAliasNode()?.getText() ?? spec.getName()));
          }
          const def = decl.getDefaultImport()?.getText();
          if (def) addSymbol(def, usageOf(def));
          const ns = decl.getNamespaceImport()?.getText();
          if (ns) addSymbol(ns, usageOf(ns));
        } else {
          // export { X } from '...' — re-exported symbols count as one use
          for (const spec of decl.getNamedExports()) addSymbol(spec.getName(), 1);
        }
      }
    }

    return [...byPair.values()].map(({ symbolCounts, ...dep }) => ({
      ...dep,
      symbols: [...symbolCounts]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 15),
    }));
  }

  // ── Database entities (TypeORM) ────────────────────────────────────────────

  private extractEntity(cls: ClassDeclaration, file: SourceFile): ExtractedEntity | null {
    const name = cls.getName();
    if (!name) return null;

    // @Entity('users') or @Entity({ name: 'users' }); default = snake_case
    const arg = cls.getDecorator('Entity')?.getArguments()[0];
    let tableName = arg?.asKind(SyntaxKind.StringLiteral)?.getLiteralValue() ?? null;
    if (!tableName) {
      const obj = arg?.asKind(SyntaxKind.ObjectLiteralExpression);
      const nameProp = obj?.getProperty('name')?.asKind(SyntaxKind.PropertyAssignment);
      tableName =
        nameProp?.getInitializer()?.asKind(SyntaxKind.StringLiteral)?.getLiteralValue() ?? null;
    }
    tableName ??= this.snakeCase(name);

    const columns: EntityColumn[] = [];
    const relations: ExtractedRelation[] = [];
    for (const prop of cls.getProperties()) {
      const decorators = prop.getDecorators();
      const colDec = decorators.find((d) => COLUMN_DECORATORS.has(d.getName()));
      if (colDec) {
        const dn = colDec.getName();
        columns.push({
          name: this.columnName(prop, colDec),
          type: prop.getTypeNode()?.getText(),
          isPrimaryKey:
            dn === 'PrimaryColumn' ||
            dn === 'PrimaryGeneratedColumn' ||
            dn === 'ObjectIdColumn' ||
            undefined,
        });
      }
      const relDec = decorators.find((d) => RELATION_DECORATORS.has(d.getName()));
      if (relDec) {
        const target = this.relationTarget(relDec);
        if (target) {
          relations.push({
            property: prop.getName(),
            target,
            joinColumn: this.joinColumnName(prop),
          });
        }
      }
    }

    return {
      className: name,
      tableName,
      filePath: file.getFilePath(),
      line: cls.getStartLineNumber(),
      columns,
      relations,
    };
  }

  /** Column DB name: explicit `@Column({ name })` wins, else the property name. */
  private columnName(prop: PropertyDeclaration, dec: Decorator): string {
    const obj = dec.getArguments()[0]?.asKind(SyntaxKind.ObjectLiteralExpression);
    const nameProp = obj?.getProperty('name')?.asKind(SyntaxKind.PropertyAssignment);
    return (
      nameProp?.getInitializer()?.asKind(SyntaxKind.StringLiteral)?.getLiteralValue() ??
      prop.getName()
    );
  }

  /**
   * The entity a relation decorator points at. Handles every common form:
   *   @ManyToOne(() => User)      @ManyToOne(type => User)
   *   @ManyToOne(() => (User))    @ManyToOne(() => { return User })
   *   @ManyToOne(() => models.User)   @ManyToOne('User')
   * Returns the referenced class/table name text, or null if unresolvable.
   */
  private relationTarget(dec: Decorator): string | null {
    const first = dec.getArguments()[0];
    if (!first) return null;
    // string form: @ManyToOne('User', ...)
    const str = first.asKind(SyntaxKind.StringLiteral)?.getLiteralValue();
    if (str) return str;
    // arrow form: pull the returned expression
    const arrow = first.asKind(SyntaxKind.ArrowFunction);
    if (!arrow) return null;
    let body: Node | undefined = arrow.getBody();
    // block body: () => { return User }
    if (body && Node.isBlock(body)) {
      const ret = body
        .getStatements()
        .find((s): s is ReturnStatement => Node.isReturnStatement(s));
      body = ret?.getExpression();
    }
    // unwrap parentheses: () => (User)
    while (body && Node.isParenthesizedExpression(body)) body = body.getExpression();
    if (!body) return null;
    if (Node.isIdentifier(body)) return body.getText();
    // property access: () => models.User → last segment
    if (Node.isPropertyAccessExpression(body)) return body.getName();
    return null;
  }

  /** FK column name declared via @JoinColumn({ name: 'x' }) on the same property. */
  private joinColumnName(prop: PropertyDeclaration): string | undefined {
    const jc = prop.getDecorator('JoinColumn');
    if (!jc) return undefined;
    const obj = jc.getArguments()[0]?.asKind(SyntaxKind.ObjectLiteralExpression);
    const nameProp = obj?.getProperty('name')?.asKind(SyntaxKind.PropertyAssignment);
    return nameProp?.getInitializer()?.asKind(SyntaxKind.StringLiteral)?.getLiteralValue();
  }

  /** TypeORM's default naming: "UserAddress" → "user_address". */
  private snakeCase(name: string): string {
    return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  }

  /**
   * Normalized lookup keys for a class or table name: lowercased+stripped, plus
   * a naive de-pluralized form so `users`/`User`/`userId` all meet at `user`.
   */
  private nameVariants(s: string): string[] {
    const base = s.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!base) return [];
    const out = new Set([base]);
    if (/ies$/.test(base)) out.add(base.slice(0, -3) + 'y');
    else if (/(ses|xes|zes|ches|shes)$/.test(base)) out.add(base.slice(0, -2));
    else if (/s$/.test(base) && !/ss$/.test(base)) out.add(base.slice(0, -1));
    return [...out];
  }

  /**
   * Second pass over all entities: resolve each relation's raw target to a real
   * class (by class name, table name, or de-pluralized alias), flag the backing
   * FK columns, and add *inferred* FK relations for bare `xxxId` columns that
   * have no relation decorator but whose stem resolves to a known table.
   */
  private resolveRelationsAndInferFks(entities: ExtractedEntity[]): void {
    const byClassName = new Map(entities.map((e) => [e.className, e]));
    // variant key → class name (first writer wins on collision)
    const index = new Map<string, string>();
    for (const e of entities) {
      for (const key of [...this.nameVariants(e.className), ...this.nameVariants(e.tableName)]) {
        if (!index.has(key)) index.set(key, e.className);
      }
    }
    const resolve = (raw: string): ExtractedEntity | undefined => {
      if (byClassName.has(raw)) return byClassName.get(raw);
      for (const key of this.nameVariants(raw)) {
        const cls = index.get(key);
        if (cls) return byClassName.get(cls);
      }
      return undefined;
    };

    for (const ent of entities) {
      const relatedClasses = new Set<string>();
      const usedColumns = new Set<string>();

      // 1) resolve declared relations + flag their backing columns
      for (const rel of ent.relations) {
        const target = resolve(rel.target);
        if (!target) continue;
        rel.resolvedTarget = target.className;
        relatedClasses.add(target.className);
        // prefer an explicit @JoinColumn, else the conventional `<property>Id`
        const colName = rel.joinColumn ?? `${rel.property}Id`;
        const col =
          ent.columns.find((c) => c.name === colName) ??
          ent.columns.find((c) => c.name === this.snakeCase(colName));
        if (col) {
          col.isForeignKey = true;
          col.refTable = target.tableName;
          rel.joinColumn = col.name;
          usedColumns.add(col.name);
        }
      }

      // 2) infer FKs from bare `xxxId` / `xxx_id` columns
      for (const col of ent.columns) {
        if (usedColumns.has(col.name)) continue;
        const stem = col.name.match(/^(.*?)_?id$/i)?.[1];
        if (!stem) continue; // plain `id` and non-*id columns
        const target = resolve(stem);
        if (!target || target.className === ent.className) continue;
        if (relatedClasses.has(target.className)) continue; // already related
        relatedClasses.add(target.className);
        col.isForeignKey = true;
        col.refTable = target.tableName;
        ent.relations.push({
          property: col.name,
          target: target.className,
          resolvedTarget: target.className,
          joinColumn: col.name,
          inferred: true,
        });
      }
    }
  }

  /**
   * Every place a module reads/writes an entity's table:
   *  - `repository`: @InjectRepository(Entity)
   *  - `import`:     the entity class imported across a module boundary
   *  - `relation`:   an entity declaring a FK to another module's entity
   *  - `raw-sql`:    table name inside .query()/query-builder string literals
   * Accesses from the entity's own module are skipped — ownership implies them.
   */
  private extractTableTouches(
    project: Project,
    entities: ExtractedEntity[],
    ownerOf: (filePath: string) => string | undefined,
  ): ExtractedTableTouch[] {
    if (entities.length === 0) return [];
    const byClass = new Map(entities.map((e) => [e.className, e]));
    const byFile = new Map<string, ExtractedEntity[]>();
    for (const e of entities) {
      const list = byFile.get(e.filePath) ?? [];
      list.push(e);
      byFile.set(e.filePath, list);
    }

    const touches: ExtractedTableTouch[] = [];
    const add = (
      module: string | undefined,
      entity: string,
      via: TableTouchKind,
      file: string,
    ) => {
      if (!module || byClass.get(entity)?.ownerModule === module) return;
      touches.push({ module, entity, via, file });
    };

    // relations: entity A (module MA) declares a FK to entity B (module MB).
    // Inferred (heuristic) FKs are excluded here so the touch graph stays to
    // relations actually written in code.
    for (const ent of entities) {
      for (const rel of ent.relations) {
        if (rel.inferred) continue;
        const target = rel.resolvedTarget ?? rel.target;
        if (byClass.has(target)) {
          add(ent.ownerModule, target, 'relation', ent.filePath);
        }
      }
    }

    for (const file of project.getSourceFiles()) {
      const filePath = file.getFilePath();
      const fileModule = ownerOf(filePath);
      if (!fileModule) continue;

      // @InjectRepository(Entity)
      for (const dec of file.getDescendantsOfKind(SyntaxKind.Decorator)) {
        if (dec.getName() !== 'InjectRepository') continue;
        const target = dec.getArguments()[0]?.asKind(SyntaxKind.Identifier)?.getText();
        if (target && byClass.has(target)) add(fileModule, target, 'repository', filePath);
      }

      // entity classes imported across module boundaries
      for (const decl of file.getImportDeclarations()) {
        const target = decl.getModuleSpecifierSourceFile();
        const fileEntities = target ? byFile.get(target.getFilePath()) : undefined;
        if (!fileEntities) continue;
        const imported = new Set(decl.getNamedImports().map((s) => s.getName()));
        for (const ent of fileEntities) {
          if (imported.has(ent.className)) add(fileModule, ent.className, 'import', filePath);
        }
      }

      // raw SQL / query-builder strings mentioning a table
      for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression().getText();
        if (!SQL_CALL_RE.test(callee)) continue;
        const isRawQuery = callee.endsWith('.query');
        for (const a of call.getArguments()) {
          const text =
            a.asKind(SyntaxKind.StringLiteral)?.getLiteralValue() ??
            a.asKind(SyntaxKind.NoSubstitutionTemplateLiteral)?.getLiteralValue();
          if (!text) continue;
          for (const ent of entities) {
            const matched = isRawQuery
              ? new RegExp(
                  `\\b(from|join|into|update|table)\\s+[\`"']?${ent.tableName}\\b`,
                  'i',
                ).test(text)
              : text.toLowerCase() === ent.tableName.toLowerCase() ||
                text.toLowerCase() === ent.className.toLowerCase();
            if (matched) add(fileModule, ent.className, 'raw-sql', filePath);
          }
        }
      }
    }

    return touches;
  }

  /**
   * Module class name behind one element of @Module({ imports: [...] }):
   * `UsersModule`, `forwardRef(() => UsersModule)`, and dynamic-module calls
   * like `TypeOrmModule.forFeature([...])` or `ConfigModule.forRoot().build()`.
   */
  private importedModuleName(el: Node): string | null {
    if (Node.isIdentifier(el)) return el.getText();

    const call = el.asKind(SyntaxKind.CallExpression);
    if (!call) return null;

    if (call.getExpression().getText() === 'forwardRef') {
      const body = call.getArguments()[0]?.asKind(SyntaxKind.ArrowFunction)?.getBody();
      return body && Node.isIdentifier(body) ? body.getText() : null;
    }

    // walk to the leftmost identifier of the call chain
    let expr: Node = call.getExpression();
    while (Node.isPropertyAccessExpression(expr) || Node.isCallExpression(expr)) {
      expr = expr.getExpression();
    }
    return Node.isIdentifier(expr) ? expr.getText() : null;
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
