import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  GithubPreflightRequest,
  GithubPreflightResult,
  OpenGithubRequest,
} from '@vision/shared';

/** Thrown when no discovered credential (nor ambient SSH) can reach the repo. */
export class NoRepoAccessError extends Error {
  constructor(readonly triedAccounts: string[]) {
    super('No credential on this machine has access to the repository');
    this.name = 'NoRepoAccessError';
  }
}

interface Credential {
  token: string;
  login?: string;
  /** where it came from, for diagnostics — never a secret */
  source: string;
}

type ProbeResult =
  | {
      access: true;
      token?: string;
      account?: string;
      usedSystemCredential: boolean;
      defaultBranch?: string;
      /** set when access/branches came from `git ls-remote` (SSH / helper) */
      branches?: string[];
      /** transport URL that actually authenticated — may swap the host for an
       *  ssh-config alias (e.g. github.com → github.com-work) */
      cloneUrl?: string;
      triedAccounts: string[];
    }
  | { access: false; triedAccounts: string[] };

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const GITHUB_API = 'https://api.github.com';
const CMD_TIMEOUT = 8_000;
const GIT_TIMEOUT = 120_000;
const API_TIMEOUT = 15_000;

/** Non-interactive git/ssh env so a missing credential fails fast, never hangs. */
const NON_INTERACTIVE_ENV: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'Never',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
};

function runCmd(
  cmd: string,
  args: string[],
  opts: { cwd?: string; input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(
      () => finish(() => { child.kill(); reject(new Error(`${cmd} timed out`)); }),
      opts.timeoutMs ?? GIT_TIMEOUT,
    );
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code) => finish(() => resolve({ code, stdout, stderr })));
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

/**
 * Turns a GitHub repo URL into a local directory the analyzer can scan, reusing
 * whatever credentials the machine already has (multiple accounts supported) and
 * probing each for access before cloning. Secrets are used in memory only.
 */
@Injectable()
export class GithubSourceService {
  private readonly logger = new Logger(GithubSourceService.name);
  private readonly cacheBase =
    process.env.VISION_CACHE_DIR ?? path.join(os.homedir(), '.vision', 'repos');
  private gitChecked = false;
  private readonly locks = new Map<string, Promise<unknown>>();

  // ── Public API ────────────────────────────────────────────────────────────

  /** Credential discovery + access probe + branch list, in one call for the UI. */
  async preflight(dto: GithubPreflightRequest): Promise<GithubPreflightResult> {
    const { owner, repo, cloneUrl } = this.parseRepoUrl(dto.repoUrl);
    const probe = await this.probeAccess(owner, repo, cloneUrl, dto.token);
    if (!probe.access) return { access: false, triedAccounts: probe.triedAccounts };

    // branches from ls-remote (SSH/helper path) or the REST API (token/public path)
    const names = probe.branches ?? (await this.listBranchNames(owner, repo, probe.token));
    const defaultBranch = probe.defaultBranch ?? names[0] ?? 'main';
    const branches = [defaultBranch, ...names.filter((n) => n !== defaultBranch)];
    return {
      access: true,
      account: probe.account,
      usedSystemCredential: probe.usedSystemCredential,
      defaultBranch,
      branches,
    };
  }

  /** Clone/update the repo into a stable cache dir; returns metadata for persistence. */
  async resolve(
    dto: OpenGithubRequest,
  ): Promise<{ rootPath: string; repoUrl: string; cloneUrl: string; branch: string; account?: string }> {
    const { owner, repo, cloneUrl, webUrl } = this.parseRepoUrl(dto.repoUrl);
    const probe = await this.probeAccess(owner, repo, cloneUrl, dto.token);
    if (!probe.access) throw new NoRepoAccessError(probe.triedAccounts);

    const branch = dto.branch?.trim() || probe.defaultBranch || 'main';
    // Clone over the transport that actually authenticated (probeAccess may
    // have swapped the ssh host for the alias whose key has access).
    const effectiveCloneUrl = probe.cloneUrl ?? cloneUrl;
    const dir = this.cacheDirFor(owner, repo, branch);
    await this.withLock(dir, () => this.cloneOrUpdate(dir, effectiveCloneUrl, branch, probe.token));
    return { rootPath: dir, repoUrl: webUrl, cloneUrl: effectiveCloneUrl, branch, account: probe.account };
  }

  /** `remote.origin.url` of a local working copy, or undefined when absent. */
  async originUrl(localDir: string): Promise<string | undefined> {
    try {
      const { stdout, code } = await runCmd(
        'git',
        ['-C', localDir, 'config', '--get', 'remote.origin.url'],
        { env: NON_INTERACTIVE_ENV, timeoutMs: CMD_TIMEOUT },
      );
      if (code !== 0) return undefined;
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  // ── URL parsing ───────────────────────────────────────────────────────────

  parseRepoUrl(input: string): { owner: string; repo: string; cloneUrl: string; webUrl: string } {
    const url = input.trim();
    const mk = (owner: string, repo: string) => ({
      owner,
      repo,
      cloneUrl: url,
      webUrl: `https://github.com/${owner}/${repo}`,
    });

    // https://github.com/owner/repo(.git)
    let m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
    if (m) return mk(m[1], m[2]);

    // scp form git@<host>:owner/repo(.git) — <host> may be an ssh-config alias
    m = url.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
    if (m && this.sshHostName(m[1]) === 'github.com') return mk(m[2], m[3]);

    // ssh://git@<host>/owner/repo(.git)
    m = url.match(/^ssh:\/\/git@([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
    if (m && this.sshHostName(m[1]) === 'github.com') return mk(m[2], m[3]);

    throw new BadRequestException(`Not a github.com repository URL: ${url}`);
  }

  /** Resolve an ssh-config Host alias (e.g. "github.com-work") to its real HostName. */
  private sshHostName(alias: string): string {
    try {
      const cfg = path.join(os.homedir(), '.ssh', 'config');
      if (!fs.existsSync(cfg)) return alias.toLowerCase();
      let inBlock = false;
      for (const raw of fs.readFileSync(cfg, 'utf-8').split(/\r?\n/)) {
        const line = raw.trim();
        if (/^host\s+/i.test(line)) {
          const hosts = line.replace(/^host\s+/i, '').split(/\s+/);
          inBlock = hosts.some((h) => h.toLowerCase() === alias.toLowerCase());
        } else if (inBlock && /^hostname\s+/i.test(line)) {
          return line.replace(/^hostname\s+/i, '').trim().toLowerCase();
        }
      }
    } catch {
      /* fall through */
    }
    return alias.toLowerCase();
  }

  // ── Access probing ────────────────────────────────────────────────────────

  private async probeAccess(
    owner: string,
    repo: string,
    cloneUrl: string,
    override?: string,
  ): Promise<ProbeResult> {
    await this.assertGit();

    // A public repo is reachable with no credential at all.
    const anon = await this.getRepo(owner, repo);
    if (anon.ok) {
      return { access: true, usedSystemCredential: false, defaultBranch: anon.defaultBranch, triedAccounts: [] };
    }

    // Token-based probe (env / gh accounts / credential helper), or a pasted PAT.
    const creds: Credential[] = override?.trim()
      ? [{ token: override.trim(), source: 'pasted' }]
      : await this.discoverCredentials();

    const tried: string[] = [];
    for (const cred of creds) {
      const res = await this.getRepo(owner, repo, cred.token);
      const login = cred.login ?? (await this.whoami(cred.token));
      if (res.ok) {
        return {
          access: true,
          token: cred.token,
          account: login,
          usedSystemCredential: cred.source !== 'pasted',
          defaultBranch: res.defaultBranch,
          triedAccounts: tried,
        };
      }
      tried.push(login ? `@${login}` : cred.source);
    }

    // Ambient git — a credential helper the REST probe couldn't enumerate as a
    // token, and every github.com SSH identity in ~/.ssh/config (multi-account
    // setups map extra aliases like github.com-work to different keys, so the
    // pasted host may not be the one that has access). `git ls-remote` does
    // exactly what a clone will do, and hands back the branch list.
    const isSshUrl = cloneUrl.startsWith('git@') || cloneUrl.startsWith('ssh://');
    const ambient: Array<{ url: string; host?: string }> = [];
    if (!isSshUrl) ambient.push({ url: cloneUrl });
    ambient.push(...this.sshCandidates(cloneUrl, owner, repo));

    for (const cand of ambient) {
      const ls = await this.gitLsRemote(cand.url);
      const login = cand.host ? await this.sshWhoami(cand.host) : undefined;
      if (ls.ok) {
        return {
          access: true,
          usedSystemCredential: true,
          account: login,
          defaultBranch: ls.defaultBranch,
          branches: ls.branches,
          cloneUrl: cand.url,
          triedAccounts: tried,
        };
      }
      if (login && !tried.includes(`@${login}`)) tried.push(`@${login}`);
    }
    return { access: false, triedAccounts: tried };
  }

  /**
   * SSH clone-URL variants to probe: the URL as pasted first, then the repo
   * rewritten onto every ~/.ssh/config alias that points at github.com.
   */
  private sshCandidates(
    cloneUrl: string,
    owner: string,
    repo: string,
  ): Array<{ url: string; host: string }> {
    const originalHost = (cloneUrl.match(/^git@([^:]+):/i) ??
      cloneUrl.match(/^ssh:\/\/git@([^/]+)\//i))?.[1];

    const out: Array<{ url: string; host: string }> = [];
    const seen = new Set<string>();
    const push = (url: string, host: string) => {
      if (seen.has(host.toLowerCase())) return;
      seen.add(host.toLowerCase());
      out.push({ url, host });
    };
    if (originalHost) push(cloneUrl, originalHost);
    for (const host of this.sshGithubHosts()) push(`git@${host}:${owner}/${repo}.git`, host);
    return out;
  }

  /** All ssh-config Host aliases whose HostName is github.com, plus github.com itself. */
  private sshGithubHosts(): string[] {
    const hosts: string[] = [];
    try {
      const cfg = path.join(os.homedir(), '.ssh', 'config');
      if (fs.existsSync(cfg)) {
        let aliases: string[] = [];
        for (const raw of fs.readFileSync(cfg, 'utf-8').split(/\r?\n/)) {
          const line = raw.trim();
          if (/^host\s+/i.test(line)) {
            aliases = line
              .replace(/^host\s+/i, '')
              .split(/\s+/)
              .filter((h) => !/[*?]/.test(h)); // skip wildcard patterns
          } else if (/^hostname\s+github\.com\s*$/i.test(line)) {
            for (const a of aliases) if (!hosts.includes(a)) hosts.push(a);
          }
        }
      }
    } catch {
      /* unreadable config — fall through to the bare host */
    }
    if (!hosts.some((h) => h.toLowerCase() === 'github.com')) hosts.unshift('github.com');
    return hosts;
  }

  /** GitHub reports the authenticated login on `ssh -T` ("Hi <login>! ..."). */
  private async sshWhoami(host: string): Promise<string | undefined> {
    try {
      const { stdout, stderr } = await runCmd(
        'ssh',
        ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-T', `git@${host}`],
        { timeoutMs: 15_000 },
      );
      return `${stdout}\n${stderr}`.match(/\bHi ([^\s!]+)!/)?.[1];
    } catch {
      return undefined;
    }
  }

  /** Tests repo access over whatever transport the URL implies, returning branches. */
  private async gitLsRemote(
    cloneUrl: string,
  ): Promise<{ ok: boolean; branches: string[]; defaultBranch?: string }> {
    try {
      const { stdout, code } = await runCmd(
        'git',
        ['ls-remote', '--symref', cloneUrl, 'HEAD', 'refs/heads/*'],
        { env: NON_INTERACTIVE_ENV, timeoutMs: 30_000 },
      );
      if (code !== 0) return { ok: false, branches: [] };
      let defaultBranch: string | undefined;
      const branches: string[] = [];
      for (const line of stdout.split(/\r?\n/)) {
        const sym = line.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/);
        if (sym) {
          defaultBranch = sym[1];
          continue;
        }
        const head = line.match(/refs\/heads\/(\S+)$/);
        if (head) branches.push(head[1]);
      }
      return { ok: true, branches, defaultBranch };
    } catch {
      return { ok: false, branches: [] };
    }
  }

  // ── Credential discovery (multi-account) ──────────────────────────────────

  private async discoverCredentials(): Promise<Credential[]> {
    const creds: Credential[] = [];
    const seen = new Set<string>();
    const add = (token: string | undefined, login: string | undefined, source: string) => {
      const t = token?.trim();
      if (!t || seen.has(t)) return;
      seen.add(t);
      creds.push({ token: t, login, source });
    };

    add(process.env.GITHUB_TOKEN, undefined, 'env:GITHUB_TOKEN');
    add(process.env.GH_TOKEN, undefined, 'env:GH_TOKEN');

    // All GitHub CLI accounts (the usual work + personal split lives here).
    const logins = await this.ghLogins();
    let gotPerUser = false;
    for (const login of logins) {
      const token = await this.ghToken(login);
      if (token) {
        add(token, login, 'gh');
        gotPerUser = true;
      }
    }
    if (!gotPerUser) add(await this.ghToken(), logins[0], 'gh');

    // Credential helper (GCM / keychain / ~/.git-credentials): default + per-login.
    const def = await this.gitCredential();
    add(def?.password, def?.username, 'git-credential');
    for (const login of logins) {
      const c = await this.gitCredential(login);
      add(c?.password, login, 'git-credential');
    }

    return creds;
  }

  private async ghLogins(): Promise<string[]> {
    try {
      const { stdout, stderr } = await runCmd('gh', ['auth', 'status'], { timeoutMs: CMD_TIMEOUT });
      const logins = new Set<string>();
      for (const m of `${stdout}\n${stderr}`.matchAll(/account\s+(\S+)/gi)) logins.add(m[1]);
      return [...logins];
    } catch {
      return [];
    }
  }

  private async ghToken(login?: string): Promise<string | undefined> {
    try {
      const args = login ? ['auth', 'token', '--user', login] : ['auth', 'token'];
      const { stdout, code } = await runCmd('gh', args, { timeoutMs: CMD_TIMEOUT });
      if (code === 0) return stdout.trim() || undefined;
    } catch {
      /* gh missing or too old for --user */
    }
    return undefined;
  }

  private async gitCredential(
    login?: string,
  ): Promise<{ username?: string; password?: string } | undefined> {
    try {
      let input = 'protocol=https\nhost=github.com\n';
      if (login) input += `username=${login}\n`;
      input += '\n';
      const { stdout, code } = await runCmd('git', ['credential', 'fill'], {
        input,
        timeoutMs: CMD_TIMEOUT,
        env: NON_INTERACTIVE_ENV,
      });
      if (code !== 0) return undefined;
      const out: Record<string, string> = {};
      for (const line of stdout.split(/\r?\n/)) {
        const i = line.indexOf('=');
        if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
      }
      return { username: out.username, password: out.password };
    } catch {
      return undefined;
    }
  }

  // ── GitHub REST helpers ───────────────────────────────────────────────────

  private ghHeaders(token?: string): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'vision-engine',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  private async getRepo(
    owner: string,
    repo: string,
    token?: string,
  ): Promise<{ ok: boolean; status: number; defaultBranch?: string }> {
    try {
      const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
        headers: this.ghHeaders(token),
        signal: AbortSignal.timeout(API_TIMEOUT),
      });
      if (res.status === 200) {
        const json = (await res.json()) as { default_branch?: string };
        return { ok: true, status: 200, defaultBranch: json.default_branch };
      }
      return { ok: false, status: res.status };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  private async whoami(token: string): Promise<string | undefined> {
    try {
      const res = await fetch(`${GITHUB_API}/user`, {
        headers: this.ghHeaders(token),
        signal: AbortSignal.timeout(API_TIMEOUT),
      });
      if (res.status === 200) return ((await res.json()) as { login?: string }).login;
    } catch {
      /* ignore */
    }
    return undefined;
  }

  private async listBranchNames(owner: string, repo: string, token?: string): Promise<string[]> {
    try {
      const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/branches?per_page=100`, {
        headers: this.ghHeaders(token),
        signal: AbortSignal.timeout(API_TIMEOUT),
      });
      if (res.status !== 200) return [];
      const json = (await res.json()) as Array<{ name: string }>;
      return json.map((b) => b.name);
    } catch {
      return [];
    }
  }

  // ── Clone / update ────────────────────────────────────────────────────────

  private async cloneOrUpdate(dir: string, cloneUrl: string, branch: string, token?: string): Promise<void> {
    const isSsh = cloneUrl.startsWith('git@') || cloneUrl.startsWith('ssh://');
    // For HTTPS with a resolved token, pass it as a one-shot header so it never
    // lands in .git/config (unlike embedding it in the origin URL).
    const authArgs = !isSsh && token ? ['-c', `http.extraHeader=AUTHORIZATION: Bearer ${token}`] : [];
    const secrets = token ? [token] : [];
    const gitDir = path.join(dir, '.git');

    try {
      if (fs.existsSync(gitDir)) {
        // re-point origin at the transport that authenticated this time (the
        // cached clone may have been created via a different host alias)
        await this.git(['-C', dir, 'remote', 'set-url', 'origin', cloneUrl], secrets);
        await this.git([...authArgs, '-C', dir, 'fetch', '--depth', '1', 'origin', branch], secrets);
        await this.git(['-C', dir, 'reset', '--hard', 'FETCH_HEAD'], secrets);
      } else {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        await this.git(
          [...authArgs, 'clone', '--depth', '1', '--single-branch', '--branch', branch, cloneUrl, dir],
          secrets,
        );
      }
    } catch (e) {
      const msg = this.redact(e instanceof Error ? e.message : String(e), secrets);
      throw new BadRequestException(`Could not clone ${cloneUrl}: ${msg}`);
    }
  }

  private async git(args: string[], secrets: string[]): Promise<string> {
    const { stdout, stderr, code } = await runCmd('git', args, {
      env: NON_INTERACTIVE_ENV,
      timeoutMs: GIT_TIMEOUT,
    });
    if (code !== 0) {
      const detail = this.redact((stderr || stdout || `exited ${code}`).trim(), secrets);
      throw new Error(detail);
    }
    return stdout;
  }

  private async assertGit(): Promise<void> {
    if (this.gitChecked) return;
    try {
      const { code } = await runCmd('git', ['--version'], { timeoutMs: CMD_TIMEOUT });
      if (code !== 0) throw new Error('non-zero');
      this.gitChecked = true;
    } catch {
      throw new BadRequestException(
        'git was not found on PATH — install Git to open GitHub repositories.',
      );
    }
  }

  // ── Misc helpers ──────────────────────────────────────────────────────────

  private cacheDirFor(owner: string, repo: string, branch: string): string {
    const s = (v: string) => v.replace(/[^\w.-]+/g, '-');
    return path.join(this.cacheBase, `${s(owner)}__${s(repo)}__${s(branch)}`);
  }

  private redact(str: string, secrets: string[]): string {
    let out = str;
    for (const secret of secrets) if (secret) out = out.split(secret).join('***');
    return out;
  }

  /** Serialize clone/update of the same dir to avoid a git race. */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }
}
