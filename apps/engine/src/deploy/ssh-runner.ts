import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ZipArchive } from 'archiver';
import { Client } from 'ssh2';
import type {
  DeployEvent,
  DeployStep,
  DeployUploadConfig,
  DeploymentStatus,
  DeploymentStepResult,
  ServerTestResult,
} from '@vision/shared';

/**
 * SSH deployment executor. Reproduces the deploy.ps1 pipeline as first-class
 * phases: connect → preflight → package → upload → steps → health. Pure
 * execution — persistence and event fan-out are the DeployService's job and
 * arrive here through the RunContext callbacks.
 *
 * The decrypted PEM key only ever exists in the SshAuth object in memory; it
 * is never written to disk or included in any log/error output.
 */

export interface SshAuth {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  passphrase?: string;
}

export interface RunConfig {
  auth: SshAuth;
  workingDir: string;
  preflight: string[];
  upload?: DeployUploadConfig;
  /**
   * Branch-pinned packaging: fetchTree fetches the branch fresh from the git
   * remote and returns the local dir to zip (upload.localDir is then ignored
   * as the tree source). A closure so the runner stays free of Nest services.
   */
  source?: { branch: string; fetchTree: (log: (chunk: string) => void) => Promise<string> };
  steps: DeployStep[];
  /** local commands run on THIS machine before packaging (e.g. a branch guard) */
  localPre?: DeployStep[];
  /** local commands run on THIS machine after the health check (e.g. git promotion) */
  localPost?: DeployStep[];
  /** working dir for local steps — normally the project root */
  localCwd?: string;
  healthUrl?: string;
}

export interface RunContext extends RunConfig {
  /** pre-built plan, same order the runner executes; mutated in place */
  plan: DeploymentStepResult[];
  emit: (ev: DeployEvent) => void;
  /** emit a log chunk for a step (also appended to the persisted log) */
  log: (stepIndex: number, chunk: string) => void;
  isCancelled: () => boolean;
  /** hand the live connection to the service so cancel can force-close it */
  registerClient: (client: Client) => void;
  /** pause and ask the user; resolves false if declined or cancelled */
  confirm: (stepIndex: number, message: string, defaultYes: boolean) => Promise<boolean>;
}

const CONNECT_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 10_000;

/** POSIX single-quote escaping: ' → '\'' */
export function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Step failed via a non-zero remote exit code (vs. an infrastructure error). */
class StepExitError extends Error {
  constructor(public readonly code: number) {
    super(`exited with code ${code}`);
  }
}

function connectClient(auth: SshAuth): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client
      .once('ready', () => resolve(client))
      .once('error', (err) => reject(err))
      .connect({
        host: auth.host,
        port: auth.port,
        username: auth.username,
        privateKey: auth.privateKey,
        passphrase: auth.passphrase,
        readyTimeout: CONNECT_TIMEOUT_MS,
        tryKeyboard: false,
      });
  });
}

/** Run a remote command, streaming stdout+stderr chunks; resolves exit code. */
function exec(client: Client, command: string, onChunk: (chunk: string) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err);
      stream.on('data', (d: Buffer) => onChunk(d.toString('utf8')));
      stream.stderr.on('data', (d: Buffer) => onChunk(d.toString('utf8')));
      // code is null when the connection died mid-command (e.g. cancel)
      stream.on('close', (code: number | null) => resolve(code ?? -1));
    });
  });
}

/**
 * Connect, run one command capturing stdout and stderr SEPARATELY, then close.
 * For one-shot remote reads (DB introspection): keeping the streams apart means
 * a `psql` error on stderr never corrupts the parsed stdout. The decrypted key
 * lives only in `auth` in memory; the command is not logged here.
 */
export async function execCollect(
  auth: SshAuth,
  command: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let client: Client | null = null;
  try {
    client = await connectClient(auth);
    const conn = client;
    return await new Promise((resolve, reject) => {
      conn.exec(command, (err, stream) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        stream.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
        stream.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
        stream.on('close', (code: number | null) =>
          resolve({ code: code ?? -1, stdout, stderr }),
        );
      });
    });
  } finally {
    client?.end();
  }
}

/** "Test connection" for a server entry: connect + echo probe. */
export async function testConnection(auth: SshAuth): Promise<ServerTestResult> {
  const started = Date.now();
  let client: Client | null = null;
  try {
    client = await connectClient(auth);
    let out = '';
    const code = await exec(client, 'echo vision-ok', (c) => (out += c));
    if (code === 0 && out.includes('vision-ok')) {
      return { ok: true, latencyMs: Date.now() - started };
    }
    return { ok: false, error: `probe command exited with code ${code}` };
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  } finally {
    client?.end();
  }
}

/** Build the flattened step plan for a run — the service persists this. */
export function buildPlan(cfg: RunConfig): DeploymentStepResult[] {
  const plan: DeploymentStepResult[] = [
    { phase: 'connect', name: 'Connect & verify SSH', status: 'pending' },
  ];
  (cfg.localPre ?? []).forEach((step, i) => {
    plan.push({
      phase: 'local-pre',
      name: step.name?.trim() || `Local pre-step ${i + 1}`,
      command: step.command,
      status: 'pending',
    });
  });
  cfg.preflight.forEach((command, i) => {
    plan.push({ phase: 'preflight', name: `Preflight ${i + 1}`, command, status: 'pending' });
  });
  if (cfg.upload) {
    plan.push({
      phase: 'package',
      name: cfg.source ? `Package branch ${cfg.source.branch}` : 'Package project',
      status: 'pending',
    });
    plan.push({ phase: 'upload', name: 'Upload bundle', status: 'pending' });
  }
  cfg.steps.forEach((step, i) => {
    plan.push({
      phase: 'step',
      name: step.name?.trim() || `Step ${i + 1}`,
      command: step.command,
      status: 'pending',
    });
  });
  if (cfg.healthUrl) {
    plan.push({ phase: 'health', name: 'Health check', command: `GET ${cfg.healthUrl}`, status: 'pending' });
  }
  (cfg.localPost ?? []).forEach((step, i) => {
    plan.push({
      phase: 'local-post',
      name: step.name?.trim() || `Local post-step ${i + 1}`,
      command: step.command,
      status: 'pending',
    });
  });
  return plan;
}

/**
 * Run a command on the machine hosting the engine. The command is written to a
 * temp script file rather than passed inline — the generated local steps are
 * multi-line PowerShell with nested quotes, which argv-level quoting mangles.
 */
async function runLocal(
  command: string,
  cwd: string | undefined,
  onChunk: (chunk: string) => void,
): Promise<number> {
  const isWin = process.platform === 'win32';
  const file = path.join(os.tmpdir(), `vision-local-${Date.now()}.${isWin ? 'ps1' : 'sh'}`);
  fs.writeFileSync(file, command, 'utf8');
  try {
    return await new Promise<number>((resolve, reject) => {
      const child = isWin
        ? spawn(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
            { cwd, windowsHide: true },
          )
        : spawn('bash', [file], { cwd });
      child.stdout.on('data', (d: Buffer) => onChunk(d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => onChunk(d.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => resolve(code ?? -1));
    });
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/**
 * Execute the plan sequentially. Mutates plan entries in place (the service
 * flushes them to the DB). Returns the terminal status; 'cancelled' is decided
 * by the service from its own flag.
 */
export async function runPipeline(ctx: RunContext): Promise<{ status: DeploymentStatus; error?: string }> {
  let client: Client | null = null;
  let zipPath: string | null = null;
  let failed = false;
  let error: string | undefined;

  // per-phase cursors so a plan entry can be traced back to its DeployStep
  // (for confirm/enabled metadata); advanced even when a step is skipped
  let preIdx = 0;
  let stepIdx = 0;
  let postIdx = 0;

  for (let i = 0; i < ctx.plan.length; i++) {
    const step = ctx.plan[i];
    let source: DeployStep | undefined;
    if (step.phase === 'local-pre') source = ctx.localPre?.[preIdx++];
    else if (step.phase === 'step') source = ctx.steps[stepIdx++];
    else if (step.phase === 'local-post') source = ctx.localPost?.[postIdx++];

    if (failed || ctx.isCancelled()) {
      step.status = 'skipped';
      ctx.emit({ type: 'step', stepIndex: i, status: 'skipped' });
      continue;
    }

    if (source?.enabled === false) {
      step.status = 'skipped';
      ctx.log(i, `\n==> ${step.name}\nstep is switched off — skipped\n`);
      ctx.emit({ type: 'step', stepIndex: i, status: 'skipped' });
      continue;
    }

    if (source?.confirmBefore) {
      const ok = await ctx.confirm(i, source.confirmBefore, true);
      if (!ok) {
        step.status = 'skipped';
        ctx.log(i, `\n==> ${step.name}\ndeclined — skipped\n`);
        ctx.emit({ type: 'step', stepIndex: i, status: 'skipped' });
        continue;
      }
    }

    step.status = 'running';
    ctx.emit({ type: 'step', stepIndex: i, status: 'running' });
    ctx.log(i, `\n==> ${step.name}\n`);
    const started = Date.now();

    try {
      let exitCode = 0;
      switch (step.phase) {
        case 'connect': {
          client = await connectClient(ctx.auth);
          ctx.registerClient(client);
          let out = '';
          const code = await exec(client, 'echo vision-ok', (c) => (out += c));
          if (code !== 0 || !out.includes('vision-ok')) throw new StepExitError(code);
          ctx.log(i, `connected to ${ctx.auth.username}@${ctx.auth.host}:${ctx.auth.port}\n`);
          break;
        }
        case 'preflight': {
          // preflight runs from the login dir (the working dir may not exist
          // yet on a first deploy) — commands use absolute paths
          const code = await exec(client!, `bash -lc ${shq(step.command!)}`, (c) => ctx.log(i, c));
          if (code !== 0) throw new StepExitError(code);
          break;
        }
        case 'package': {
          let upload = ctx.upload!;
          if (ctx.source) {
            const tree = await ctx.source.fetchTree((c) => ctx.log(i, c));
            // the fetched tree is a real clone — never ship its .git, no
            // matter what the target's exclusion list says
            upload = {
              ...upload,
              localDir: tree,
              excludeDirs: [...new Set([...upload.excludeDirs, '.git'])],
            };
          }
          zipPath = await packageDir(upload, i, ctx);
          break;
        }
        case 'upload': {
          await uploadZip(client!, zipPath!, ctx.upload!.remoteZipPath, i, ctx);
          break;
        }
        case 'step': {
          const wrapped = `bash -lc ${shq(`cd ${shq(ctx.workingDir)} && ${step.command!}`)}`;
          const code = await exec(client!, wrapped, (c) => ctx.log(i, c));
          if (code !== 0) throw new StepExitError(code);
          break;
        }
        case 'health': {
          await healthCheck(ctx.healthUrl!, i, ctx);
          break;
        }
        case 'local-pre':
        case 'local-post': {
          ctx.log(i, `running locally in ${ctx.localCwd ?? process.cwd()}\n`);
          const code = await runLocal(step.command!, ctx.localCwd, (c) => ctx.log(i, c));
          if (code !== 0) throw new StepExitError(code);
          break;
        }
      }
      step.status = 'succeeded';
      step.exitCode = exitCode;
      step.durationMs = Date.now() - started;
      ctx.emit({
        type: 'step',
        stepIndex: i,
        status: 'succeeded',
        exitCode: step.exitCode,
        durationMs: step.durationMs,
      });
    } catch (err) {
      // an opt-in gate: the step failed, ask whether to carry on anyway
      if (source?.confirmOnFailure && !ctx.isCancelled()) {
        ctx.log(i, `\n[!] ${step.name}: ${errMessage(err)}\n`);
        if (await ctx.confirm(i, source.confirmOnFailure, false)) {
          step.status = 'succeeded';
          if (err instanceof StepExitError) step.exitCode = err.code;
          step.durationMs = Date.now() - started;
          ctx.log(i, 'continuing despite the failure (confirmed)\n');
          ctx.emit({
            type: 'step',
            stepIndex: i,
            status: 'succeeded',
            exitCode: step.exitCode,
            durationMs: step.durationMs,
          });
          continue;
        }
      }
      step.status = 'failed';
      step.durationMs = Date.now() - started;
      if (err instanceof StepExitError) step.exitCode = err.code;
      failed = true;
      error = ctx.isCancelled() ? 'cancelled' : `${step.name}: ${errMessage(err)}`;
      if (!ctx.isCancelled()) ctx.log(i, `\n[FAIL] ${step.name}: ${errMessage(err)}\n`);
      ctx.emit({
        type: 'step',
        stepIndex: i,
        status: 'failed',
        exitCode: step.exitCode,
        durationMs: step.durationMs,
      });
    }
  }

  client?.end();
  if (zipPath) fs.rmSync(zipPath, { force: true });
  return failed ? { status: 'failed', error } : { status: 'succeeded' };
}

/**
 * Zip the local dir applying the exclusion lists (dir/file basenames matched
 * anywhere in the tree — same semantics as the deploy scripts' robocopy /XD
 * /XF). Manual walk so excluded trees are pruned, not traversed; entry names
 * use forward slashes, so no Windows-backslash zip entries (the unzip-exit-1
 * bug the scripts had to work around).
 */
async function packageDir(cfg: DeployUploadConfig, stepIndex: number, ctx: RunContext): Promise<string> {
  const src = cfg.localDir;
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    throw new Error(`local directory not found: ${src}`);
  }
  const excludeDirs = new Set(cfg.excludeDirs);
  const excludeFiles = new Set(cfg.excludeFiles);
  const files: { abs: string; rel: string }[] = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!excludeDirs.has(entry.name)) walk(abs, childRel);
      } else if (entry.isFile()) {
        if (!excludeFiles.has(entry.name)) files.push({ abs, rel: childRel });
      }
    }
  };
  walk(src, '');
  if (files.length === 0) throw new Error('nothing to package — every file was excluded');
  ctx.log(stepIndex, `packaging ${files.length} files from ${src}\n`);

  const zipPath = path.join(os.tmpdir(), `vision-deploy-${Date.now()}.zip`);
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 6 } });
    out.on('close', () => resolve());
    archive.on('error', reject);
    archive.pipe(out);
    for (const f of files) archive.file(f.abs, { name: f.rel });
    void archive.finalize();
  });
  const mb = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(1);
  ctx.log(stepIndex, `zip ready (${mb} MB)\n`);
  return zipPath;
}

async function uploadZip(
  client: Client,
  zipPath: string,
  remoteZipPath: string,
  stepIndex: number,
  ctx: RunContext,
): Promise<void> {
  // SFTP has no shell, so "~" must be resolved to the real home dir first
  let remote = remoteZipPath;
  if (remote === '~' || remote.startsWith('~/')) {
    let home = '';
    await exec(client, 'echo $HOME', (c) => (home += c));
    home = home.trim();
    if (!home.startsWith('/')) throw new Error('could not resolve remote $HOME for the upload path');
    remote = home + remote.slice(1);
  }

  const totalBytes = fs.statSync(zipPath).size;
  await new Promise<void>((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err);
      let lastEmit = 0;
      sftp.fastPut(
        zipPath,
        remote,
        {
          step: (transferred: number) => {
            const now = Date.now();
            if (now - lastEmit > 250) {
              lastEmit = now;
              ctx.emit({ type: 'progress', stepIndex, sentBytes: transferred, totalBytes });
            }
          },
        },
        (e) => (e ? reject(e) : resolve()),
      );
    });
  });
  ctx.emit({ type: 'progress', stepIndex, sentBytes: totalBytes, totalBytes });
  ctx.log(stepIndex, `uploaded ${(totalBytes / (1024 * 1024)).toFixed(1)} MB → ${remote}\n`);
}

async function healthCheck(url: string, stepIndex: number, ctx: RunContext): Promise<void> {
  ctx.log(stepIndex, `GET ${url}\n`);
  const res = await fetch(url, {
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    redirect: 'follow',
  });
  // reachability semantics, same as the deploy scripts' smoke tests: an auth
  // gate (401/403) still proves the box is up and serving
  const authGated = res.status === 401 || res.status === 403;
  const ok = res.status < 400 || authGated;
  ctx.log(stepIndex, `HTTP ${res.status}${authGated ? ' (auth-gated, treated as up)' : ''}\n`);
  if (!ok) throw new Error(`health check returned HTTP ${res.status}`);
}
