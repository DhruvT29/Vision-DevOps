import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { Node, Project, SyntaxKind } from 'ts-morph';
import type { FrontendHttpClient, HttpMethod } from '@vision/shared';

const AXIOS_METHODS: Record<string, HttpMethod> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
  head: 'HEAD',
  options: 'OPTIONS',
};

export interface ExtractedFrontendCall {
  client: FrontendHttpClient;
  method: HttpMethod | 'UNKNOWN';
  rawUrl: string;
  /** Path with dynamic segments as {} and the client baseURL pathname prefixed */
  resolvedPath: string | null;
  callerSymbol: string;
  filePath: string;
  line: number;
}

/**
 * Finds HTTP call sites in a React/Next frontend source tree.
 * Handles the common patterns:
 *   api.get('/addresses')            → axios instance method
 *   api.patch(`/addresses/${id}`)    → template literal, ${} → {} wildcard
 *   axios.post('http://...', body)
 *   fetch('/api/users')
 * The pathname of the axios instance's baseURL (e.g. ".../api") is prepended
 * to relative call paths so they can be matched against backend routes.
 */
@Injectable()
export class FrontendExtractorService {
  private readonly logger = new Logger(FrontendExtractorService.name);

  extract(stackDir: string): ExtractedFrontendCall[] {
    const srcDir = fs.existsSync(path.join(stackDir, 'src'))
      ? path.join(stackDir, 'src')
      : stackDir;

    const project = new Project({
      compilerOptions: { allowJs: true, checkJs: false, skipLibCheck: true, jsx: 4 /* preserve */ },
      skipAddingFilesFromTsConfig: true,
    });
    const base = srcDir.replace(/\\/g, '/');
    project.addSourceFilesAtPaths([
      `${base}/**/*.{js,jsx,ts,tsx}`,
      '!**/*.spec.*',
      '!**/*.test.*',
      '!**/*.d.ts',
    ]);

    const files = project.getSourceFiles();
    this.logger.log(`Parsing ${files.length} frontend files under ${srcDir}`);

    const basePathPrefix = this.findAxiosBasePathname(files);
    const calls: ExtractedFrontendCall[] = [];

    for (const file of files) {
      for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const expr = call.getExpression();

        // fetch('...')
        if (Node.isIdentifier(expr) && expr.getText() === 'fetch') {
          const url = this.urlOf(call.getArguments()[0]);
          if (!url) continue;
          calls.push({
            client: 'fetch',
            method: this.fetchMethod(call),
            rawUrl: url.raw,
            resolvedPath: this.resolve(url.pattern, basePathPrefix),
            callerSymbol: this.callerOf(call, file.getBaseNameWithoutExtension()),
            filePath: file.getFilePath(),
            line: call.getStartLineNumber(),
          });
          continue;
        }

        // <instance>.get/post/... ('...')
        if (!Node.isPropertyAccessExpression(expr)) continue;
        const method = AXIOS_METHODS[expr.getName()];
        if (!method) continue;

        const target = expr.getExpression().getText();
        // heuristic: axios itself, or an instance conventionally named api/client/http
        if (!/(^|\.)?(axios|api|apiClient|client|http|instance)$/i.test(target)) continue;

        const url = this.urlOf(call.getArguments()[0]);
        if (!url || (!url.pattern.startsWith('/') && !/^https?:/.test(url.pattern))) continue;

        calls.push({
          client: 'axios',
          method,
          rawUrl: url.raw,
          resolvedPath: this.resolve(url.pattern, basePathPrefix),
          callerSymbol: this.callerOf(call, file.getBaseNameWithoutExtension()),
          filePath: file.getFilePath(),
          line: call.getStartLineNumber(),
        });
      }
    }

    this.logger.log(`Found ${calls.length} frontend HTTP call sites`);
    return calls;
  }

  /** Pathname of axios.create({ baseURL }) — e.g. "https://x.com/api" → "/api". */
  private findAxiosBasePathname(files: import('ts-morph').SourceFile[]): string {
    for (const file of files) {
      for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (!call.getExpression().getText().endsWith('axios.create')) continue;
        const arg = call.getArguments()[0]?.asKind(SyntaxKind.ObjectLiteralExpression);
        const prop = arg?.getProperty('baseURL')?.asKind(SyntaxKind.PropertyAssignment);
        let init: Node | undefined = prop?.getInitializer();
        if (!init) continue;

        // baseURL: SOME_CONST → follow to the const's initializer in this file
        const ident = init.asKind(SyntaxKind.Identifier);
        if (ident) {
          const decl = file.getVariableDeclaration(ident.getText());
          init = decl?.getInitializer() ?? init;
        }

        // take any string literal inside (covers `process.env.X || 'https://.../api'`)
        const literal =
          init.asKind(SyntaxKind.StringLiteral) ??
          init.getDescendantsOfKind(SyntaxKind.StringLiteral)[0];
        if (!literal) continue;
        const value = literal.getLiteralValue();
        try {
          return new URL(value).pathname.replace(/\/+$/, '');
        } catch {
          return value.startsWith('/') ? value.replace(/\/+$/, '') : '';
        }
      }
    }
    return '';
  }

  private urlOf(arg: Node | undefined): { raw: string; pattern: string } | null {
    if (!arg) return null;
    const lit = arg.asKind(SyntaxKind.StringLiteral);
    if (lit) return { raw: lit.getText(), pattern: lit.getLiteralValue() };

    const tpl = arg.asKind(SyntaxKind.TemplateExpression);
    if (tpl) {
      let pattern = tpl.getHead().getLiteralText();
      for (const span of tpl.getTemplateSpans()) {
        pattern += '{}' + span.getLiteral().getLiteralText();
      }
      return { raw: arg.getText(), pattern };
    }
    const noSub = arg.asKind(SyntaxKind.NoSubstitutionTemplateLiteral);
    if (noSub) return { raw: arg.getText(), pattern: noSub.getLiteralText() };
    return null;
  }

  private resolve(pattern: string, basePathname: string): string | null {
    if (/^https?:/.test(pattern)) {
      try {
        const u = new URL(pattern.replace(/\{\}/g, '_'));
        return u.pathname;
      } catch {
        return null;
      }
    }
    if (!pattern.startsWith('/')) return null;
    // strip query
    const clean = pattern.split('?')[0];
    return (basePathname + clean).replace(/\/{2,}/g, '/');
  }

  /**
   * e.g. "addressService.setPrimary". Only names that own a function body
   * containing the call qualify — `const res = await api.get(...)` must not
   * yield "res".
   */
  private callerOf(node: Node, fileStem: string): string {
    const isFunctionLike = (n: Node | undefined) =>
      !!n && (Node.isArrowFunction(n) || Node.isFunctionExpression(n));

    let current: Node | undefined = node;
    while (current) {
      if (Node.isMethodDeclaration(current)) return `${fileStem}.${current.getName()}`;
      if (Node.isFunctionDeclaration(current) && current.getName())
        return `${fileStem}.${current.getName()}`;
      if (Node.isPropertyAssignment(current) && isFunctionLike(current.getInitializer()))
        return `${fileStem}.${current.getName()}`;
      if (Node.isVariableDeclaration(current) && isFunctionLike(current.getInitializer()))
        return `${fileStem}.${current.getName()}`;
      current = current.getParent();
    }
    return fileStem;
  }

  private fetchMethod(call: import('ts-morph').CallExpression): HttpMethod | 'UNKNOWN' {
    const opts = call.getArguments()[1]?.asKind(SyntaxKind.ObjectLiteralExpression);
    const prop = opts?.getProperty('method')?.asKind(SyntaxKind.PropertyAssignment);
    const lit = prop?.getInitializer()?.asKind(SyntaxKind.StringLiteral);
    if (lit) return lit.getLiteralValue().toUpperCase() as HttpMethod;
    return opts ? 'UNKNOWN' : 'GET';
  }
}
