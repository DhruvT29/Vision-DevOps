import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { EnvironmentAuth, RunResult } from '@vision/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RunRequestDto } from './run-request.dto';

const RESPONSE_BODY_LIMIT = 256 * 1024; // chars kept in history / returned
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Executes HTTP requests against target apps server-side (no browser CORS,
 * tokens never touch the UI origin) and records every run as an Execution.
 */
@Injectable()
export class RunnerService {
  private readonly logger = new Logger(RunnerService.name);

  constructor(private readonly prisma: PrismaService) {}

  async run(dto: RunRequestDto): Promise<RunResult> {
    const env = dto.environmentId
      ? await this.prisma.environment.findUnique({ where: { id: dto.environmentId } })
      : null;
    if (dto.environmentId && !env) {
      throw new BadRequestException(`Environment ${dto.environmentId} not found`);
    }

    const variables: Record<string, string> = env ? JSON.parse(env.variablesJson) : {};
    const auth: EnvironmentAuth = env ? JSON.parse(env.authJson) : { type: 'none' };
    if (env) {
      variables.baseUrl = env.baseUrl;
      if (auth.token) variables.token = auth.token;
    }

    // Resolve URL: interpolate variables, then prefix baseUrl for bare paths.
    let url = this.interpolate(dto.url, variables);
    if (!/^https?:\/\//i.test(url)) {
      if (!env) throw new BadRequestException('Relative URL requires an environment (baseUrl)');
      url = env.baseUrl.replace(/\/+$/, '') + '/' + url.replace(/^\/+/, '');
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(dto.headers ?? {})) {
      if (k.trim()) headers[k] = this.interpolate(v, variables);
    }
    const hasAuthHeader = Object.keys(headers).some((h) => h.toLowerCase() === 'authorization');
    if (auth.type === 'bearer' && auth.token && !hasAuthHeader) {
      headers[auth.header ?? 'Authorization'] = auth.header
        ? auth.token
        : `Bearer ${auth.token}`;
    }

    const body =
      dto.body != null && dto.method !== 'GET' && dto.method !== 'HEAD'
        ? this.interpolate(dto.body, variables)
        : undefined;
    if (body !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }

    const started = Date.now();
    let status: number | undefined;
    let statusText: string | undefined;
    let responseHeaders: Record<string, string> = {};
    let responseBody = '';
    let truncated = false;
    let error: string | undefined;

    try {
      const res = await fetch(url, {
        method: dto.method === 'ALL' ? 'GET' : dto.method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = res.status;
      statusText = res.statusText;
      res.headers.forEach((v, k) => (responseHeaders[k] = v));
      const text = await res.text();
      truncated = text.length > RESPONSE_BODY_LIMIT;
      responseBody = truncated ? text.slice(0, RESPONSE_BODY_LIMIT) : text;
    } catch (e) {
      error =
        e instanceof Error
          ? e.name === 'TimeoutError'
            ? `Timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
            : (e.cause as Error | undefined)?.message ?? e.message
          : String(e);
    }
    const durationMs = Date.now() - started;

    const execution = await this.prisma.execution.create({
      data: {
        projectId: dto.projectId,
        endpointId: dto.endpointId,
        environmentId: dto.environmentId,
        method: dto.method,
        url,
        requestHeadersJson: JSON.stringify(this.redactAuth(headers)),
        requestBody: body ?? null,
        status,
        durationMs,
        responseHeadersJson: JSON.stringify(responseHeaders),
        responseBody,
        truncated,
        error,
      },
    });

    return {
      executionId: execution.id,
      url,
      status,
      statusText,
      durationMs,
      responseHeaders,
      body: responseBody,
      truncated,
      error,
    };
  }

  async history(projectId: string, endpointId?: string, limit = 50) {
    const rows = await this.prisma.execution.findMany({
      where: { projectId, ...(endpointId ? { endpointId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
    });
    return rows.map((r) => ({
      id: r.id,
      endpointId: r.endpointId ?? undefined,
      environmentId: r.environmentId ?? undefined,
      method: r.method,
      url: r.url,
      status: r.status ?? undefined,
      durationMs: r.durationMs,
      error: r.error ?? undefined,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async execution(id: string) {
    return this.prisma.execution.findUnique({ where: { id } });
  }

  private interpolate(text: string, variables: Record<string, string>): string {
    return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, name: string) =>
      name in variables ? variables[name] : match,
    );
  }

  /** Stored request headers must not leak tokens into history at full value. */
  private redactAuth(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      out[k] = k.toLowerCase() === 'authorization' ? v.slice(0, 16) + '…[redacted]' : v;
    }
    return out;
  }
}
