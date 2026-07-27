import type {
  DeployStep,
  DeployUploadConfig,
  ParsedDeployScript,
} from '@vision/shared';

/**
 * Static parser for the annpriya family of PowerShell deploy scripts:
 * a CONFIG block of `$Var = "literal"`, a robocopy/Compress-Archive package
 * phase, an embedded bash here-string (`@' ... '@`) sectioned by
 * `echo "--- Name ---"` markers with `__TOKEN__` placeholders resolved by a
 * trailing `-replace` chain, scp/ssh transport, and local/interactive phases.
 *
 * The script is NEVER executed — everything here is text analysis. Any PEM path
 * the script references is deliberately ignored and never read.
 */

interface Vars {
  [name: string]: string;
}

// ── expression evaluation ────────────────────────────────────────────────────

/** Expand $Var / ${Var} / $env:NAME inside a double-quoted string body. */
function expand(body: string, vars: Vars): string {
  return body
    .replace(/\$env:([A-Za-z_]\w*)/g, (_m, n: string) => process.env[n] ?? `$env:${n}`)
    .replace(/\$\{(\w+)\}/g, (m, n: string) => vars[n] ?? m)
    .replace(/\$(\w+)/g, (m, n: string) => vars[n] ?? m);
}

/** Evaluate the right-hand side of an assignment. Returns undefined if unsupported. */
function evalExpr(raw: string, vars: Vars): string | undefined {
  let s = raw.trim();
  // strip a trailing inline comment outside quotes
  s = s.replace(/\s+#(?:(?!["']).)*$/, '').trim();

  // (Split-Path $X -Leaf)
  const leaf = /^\(?\s*Split-Path\s+(.+?)\s+-Leaf\s*\)?$/i.exec(s);
  if (leaf) {
    const inner = evalExpr(leaf[1], vars);
    if (inner === undefined) return undefined;
    return inner.split(/[\\/]/).filter(Boolean).pop() ?? inner;
  }

  // Join-Path a b
  const join = /^\(?\s*Join-Path\s+(.+?)\s+(.+?)\s*\)?$/i.exec(s);
  if (join) {
    const a = evalExpr(join[1], vars);
    const b = evalExpr(join[2], vars);
    if (a === undefined || b === undefined) return undefined;
    return `${a.replace(/[\\/]+$/, '')}\\${b.replace(/^[\\/]+/, '')}`;
  }

  if (/^"(.*)"$/s.test(s)) return expand(s.slice(1, -1), vars);
  if (/^'(.*)'$/s.test(s)) return s.slice(1, -1);
  if (/^-?\d+$/.test(s)) return s;
  if (/^\$\w+$/.test(s)) return vars[s.slice(1)];
  return undefined;
}

/** Join backtick-continued PowerShell lines into single logical lines. */
function logicalLines(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  for (const line of text.split(/\r?\n/)) {
    const trimmedEnd = line.replace(/\s+$/, '');
    if (trimmedEnd.endsWith('`')) {
      buf += trimmedEnd.slice(0, -1) + ' ';
    } else {
      out.push(buf + line);
      buf = '';
    }
  }
  if (buf) out.push(buf);
  return out;
}

// ── here-strings ─────────────────────────────────────────────────────────────

interface HereString {
  varName: string;
  body: string;
  interpolating: boolean;
}

/** Pull out `$X = @' ... '@` (and `@" ... "@`) blocks, plus the masked script. */
function extractHereStrings(text: string): { blocks: HereString[]; masked: string } {
  const lines = text.split(/\r?\n/);
  const blocks: HereString[] = [];
  const maskedLines: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = /^\s*\$(\w+)\s*=\s*@(['"])\s*$/.exec(lines[i]);
    if (m) {
      const [, varName, quote] = m;
      const terminator = quote === "'" ? "'@" : '"@';
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== terminator) {
        body.push(lines[j]);
        j++;
      }
      blocks.push({ varName, body: body.join('\n'), interpolating: quote === '"' });
      maskedLines.push(`# <here-string ${varName}>`);
      i = j + 1;
      continue;
    }
    maskedLines.push(lines[i]);
    i++;
  }
  return { blocks, masked: maskedLines.join('\n') };
}

// ── main ─────────────────────────────────────────────────────────────────────

export function parsePowershellDeployScript(text: string): ParsedDeployScript {
  const warnings: string[] = [];
  const { blocks, masked } = extractHereStrings(text);
  const lines = logicalLines(masked);

  // 1. variable table (in order, so later assignments can use earlier ones)
  const vars: Vars = {};
  for (const line of lines) {
    const m = /^\s*\$(\w+)\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    const [, name, rhs] = m;
    const val = evalExpr(rhs, vars);
    if (val !== undefined) vars[name] = val;
  }

  // 2. the remote bash block + its __TOKEN__ replacements
  const bash = blocks.find((b) => /^\s*#!\/bin\/bash|set -e/m.test(b.body));
  for (const b of blocks) {
    if (b.interpolating) {
      warnings.push(
        `here-string $${b.varName} uses @"..."@ (interpolating) — values may differ from the script`,
      );
    }
  }
  let bashBody = bash?.body ?? '';
  if (bash) {
    for (const line of lines) {
      // lookahead, not a consuming group — otherwise every other -replace in a
      // chained line gets swallowed and its placeholder is left unresolved
      const rep = /-replace\s+'(__\w+__)'\s*,\s*(.+?)(?=\s+-replace|\s*$)/g;
      let m: RegExpExecArray | null;
      while ((m = rep.exec(line))) {
        const value = evalExpr(m[2], vars);
        if (value === undefined) {
          warnings.push(`could not resolve the value for placeholder ${m[1]}`);
          continue;
        }
        bashBody = bashBody.split(m[1]).join(value);
      }
    }
  } else {
    warnings.push('no embedded bash script (@\'...\'@) found — no remote steps were imported');
  }

  // 3. package config from robocopy
  let upload: DeployUploadConfig | undefined;
  const robo = lines.find((l) => /^\s*robocopy\s/i.test(l));
  let projectRoot: string | undefined;
  if (robo) {
    const toks = robo
      .replace(/\|.*$/, '')
      .trim()
      .split(/\s+/)
      .slice(1);
    projectRoot = toks[0] ? evalExpr(toks[0], vars) ?? vars[toks[0].replace(/^\$/, '')] : undefined;
    const collect = (flag: string): string[] => {
      const at = toks.findIndex((t) => t.toUpperCase() === flag);
      if (at === -1) return [];
      const out: string[] = [];
      for (let k = at + 1; k < toks.length && !toks[k].startsWith('/'); k++) out.push(toks[k]);
      return out;
    };
    upload = {
      localDir: projectRoot ?? '',
      excludeDirs: collect('/XD'),
      excludeFiles: collect('/XF'),
      remoteZipPath: '',
    };
  } else {
    warnings.push('no robocopy call found — upload excludes were not imported');
  }

  // 4. transport: scp destination (zip) + ssh user@host
  const scpZip = lines.find((l) => /^\s*scp\s/i.test(l) && /Zip|\.zip/i.test(l));
  if (scpZip && upload) {
    const quoted = [...scpZip.matchAll(/"([^"]*)"/g)].map((m) => expand(m[1], vars));
    const dest = quoted.find((q) => /@[^:]+:/.test(q));
    const path = dest?.slice(dest.indexOf(':', dest.indexOf('@')) + 1);
    if (path) upload.remoteZipPath = path;
  }
  if (upload && !upload.remoteZipPath) {
    upload.remoteZipPath = '~/deploy.zip';
    warnings.push('could not read the scp destination — remote zip path defaulted to ~/deploy.zip');
  }

  let host: string | undefined;
  let username: string | undefined;
  for (const line of lines) {
    if (!/^\s*\$?\w*\s*=?\s*ssh\s|^\s*ssh\s/i.test(line)) continue;
    for (const q of [...line.matchAll(/"([^"]*)"/g)].map((m) => expand(m[1], vars))) {
      const m = /^([\w.-]+)@([\w.-]+)$/.exec(q.trim());
      if (m) {
        username ??= m[1];
        host ??= m[2];
      }
    }
  }

  // 5. remote steps from the bash sections
  const { steps, workingDir } = splitBashSections(bashBody, vars, warnings);

  // 6. ssh-based preflight checks (before the deploy.sh execution) + trailing smoke tests
  const preflight: string[] = [];
  const execAt = lines.findIndex((l) => /^\s*ssh\s/i.test(l) && /bash\s+\S*deploy\.sh/i.test(l));
  lines.forEach((line, idx) => {
    // must BE an ssh invocation (optionally captured into a var) — a Warn/echo
    // string that merely mentions `ssh -i` is not a command
    if (!/^\s*(?:\$\w+\s*=\s*)?ssh\s+-i\s/i.test(line)) return;
    if (/bash\s+\S*deploy\.sh/i.test(line)) return;
    const quoted = [...line.matchAll(/"([^"]*)"/g)].map((m) => expand(m[1], vars));
    const cmd = quoted.find((q) => !/^[\w.-]+@[\w.-]+$/.test(q.trim()) && q.trim().length > 0);
    if (!cmd) return;
    if (/^echo\s+OK$/i.test(cmd.trim())) {
      warnings.push('dropped the `echo OK` reachability probe — Vision\'s connect phase covers it');
      return;
    }
    if (execAt !== -1 && idx > execAt) {
      steps.push({ name: 'Smoke test (remote)', command: cmd });
      warnings.push(
        'imported the post-deploy ssh smoke test as a step; its PowerShell status-code assertion was not translated',
      );
    } else {
      preflight.push(cmd);
    }
  });

  // 7. health URL
  let healthUrl: string | undefined;
  const iwr = lines.find((l) => /Invoke-WebRequest/i.test(l));
  if (iwr) {
    const m = /-Uri\s+("[^"]*"|\$\w+|\S+)/i.exec(iwr);
    if (m) healthUrl = evalExpr(m[1], vars);
  }

  // 8. local phases
  const { localPre, localPost } = extractLocalPhases(lines, vars, warnings);

  if (/Remove-Item/i.test(masked)) {
    warnings.push('local temp-file cleanup was not imported — Vision removes its own zip automatically');
  }

  return {
    workingDir,
    preflight,
    upload,
    steps,
    localPre,
    localPost,
    healthUrl,
    detected: {
      host,
      username,
      projectRoot,
      expectedBranch: vars.ExpectedBranch,
    },
    warnings,
  };
}

// ── bash block → self-contained steps ────────────────────────────────────────

const MARKER = /^\s*echo\s+"---\s*(.+?)\s*---"\s*$/;

function splitBashSections(
  bash: string,
  vars: Vars,
  warnings: string[],
): { steps: DeployStep[]; workingDir?: string } {
  const steps: DeployStep[] = [];
  if (!bash.trim()) return { steps };

  const lines = bash.split(/\r?\n/);
  const firstMarker = lines.findIndex((l) => MARKER.test(l));
  const preambleLines = firstMarker === -1 ? lines : lines.slice(0, firstMarker);

  // keep `set -e` and plain VAR= assignments so every step stands alone
  const preamble = preambleLines.filter(
    (l) => /^\s*set\s+-e\s*$/.test(l) || /^\s*[A-Za-z_]\w*=/.test(l),
  );
  // section markers reference bash vars (e.g. "Restarting backend (PM2: $PM2_APP)")
  // — expand them so step NAMES read properly in the console
  const bashVars: Vars = {};
  for (const l of preamble) {
    const m = /^\s*([A-Za-z_]\w*)=(.*)$/.exec(l);
    if (m) bashVars[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  const expandName = (n: string) =>
    n
      .replace(/\$\{(\w+)\}/g, (m, k: string) => bashVars[k] ?? m)
      .replace(/\$(\w+)/g, (m, k: string) => bashVars[k] ?? m);
  const workingDir = /(?:^|\n)\s*PROJECT_DIR=(.+)/.exec(bash)?.[1]?.trim().replace(/^["']|["']$/g, '');

  if (firstMarker === -1) {
    warnings.push('the bash block has no `echo "--- ... ---"` markers — imported as a single step');
    return {
      steps: [{ name: 'Remote deploy script', command: bash.trim() }],
      workingDir,
    };
  }

  // carry the most recent `cd` forward: a later section may rely on it
  let carriedCd: string | null = null;
  let i = firstMarker;
  while (i < lines.length) {
    const name = expandName(MARKER.exec(lines[i])![1]);
    let j = i + 1;
    const body: string[] = [];
    while (j < lines.length && !MARKER.test(lines[j])) {
      body.push(lines[j]);
      j++;
    }
    const cdIn = [...body.join('\n').matchAll(/^\s*cd\s+(.+)\s*$/gm)].pop()?.[1]?.trim();
    // a section that only prints banners carries no work — Vision already shows
    // the step name, so importing it would just add empty steps
    const meaningful = body.some((l) => {
      const t = l.trim();
      return t.length > 0 && !t.startsWith('#') && !/^echo\b/.test(t);
    });
    if (meaningful) {
      const parts = [...preamble];
      if (carriedCd) parts.push(`cd ${carriedCd}`);
      parts.push(...body);
      const command = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      if (command) steps.push({ name, command });
    }
    if (cdIn) carriedCd = cdIn;
    i = j;
  }
  return { steps, workingDir };
}

// ── local / interactive phases ───────────────────────────────────────────────

function psQuote(s: string): string {
  return `"${s.replace(/"/g, '`"')}"`;
}

function extractLocalPhases(
  lines: string[],
  vars: Vars,
  warnings: string[],
): { localPre: DeployStep[]; localPost: DeployStep[] } {
  const localPre: DeployStep[] = [];
  const localPost: DeployStep[] = [];
  const root = vars.ProjectRoot;
  const expected = vars.ExpectedBranch;
  const joined = lines.join('\n');

  // branch guard → fail on mismatch, ask whether to continue
  if (root && expected && /branch\s+--show-current/.test(joined)) {
    localPre.push({
      name: 'Branch guard',
      command: [
        `$b = (git -C ${psQuote(root)} branch --show-current).Trim()`,
        `Write-Host "current branch: $b"`,
        `if ($b -ne ${psQuote(expected)}) { Write-Host "expected ${expected}"; exit 1 }`,
      ].join('\n'),
      confirmOnFailure: `Checked-out branch is not '${expected}'. Deploy from the current branch anyway?`,
    });
  }

  // pending migration listing (+ prod's extra "proceed?" gate)
  const pendingDir = vars.MigPendingDir;
  if (root && pendingDir && /Get-ChildItem\s+\$MigPendingPath|MigPendingPath/.test(joined)) {
    localPre.push({
      name: 'List pending migrations',
      command: [
        `$p = Join-Path ${psQuote(root)} ${psQuote(pendingDir)}`,
        `if (Test-Path $p) { Get-ChildItem $p -Filter *.sql | Sort-Object Name | ForEach-Object { Write-Host $_.Name } } else { Write-Host "no pending migrations dir" }`,
      ].join('\n'),
    });
    if (/Read-Host[^\n]*[Pp]roceed with these migrations/.test(joined)) {
      localPre.push({
        name: 'Confirm migrations',
        command: 'Write-Host "migrations confirmed"',
        confirmBefore: 'Proceed with these DB migrations?',
      });
    }
  }

  // post-deploy promotion: git mv + commit + push (always confirm-first)
  const promotedDir = vars.MigPromotedDir;
  if (root && pendingDir && promotedDir && /git\s+-C\s+\$ProjectRoot\s+mv/.test(joined)) {
    localPost.push({
      name: `Promote applied migrations to ${promotedDir}`,
      command: [
        `$root = ${psQuote(root)}`,
        `$files = @(Get-ChildItem (Join-Path $root ${psQuote(pendingDir)}) -Filter *.sql -ErrorAction SilentlyContinue | Sort-Object Name)`,
        `if ($files.Count -eq 0) { Write-Host "nothing to promote"; exit 0 }`,
        `foreach ($m in $files) {`,
        `  git -C $root mv (Join-Path ${psQuote(pendingDir)} $m.Name) (Join-Path ${psQuote(promotedDir)} $m.Name)`,
        `  if ($LASTEXITCODE -ne 0) { Write-Host "git mv failed for $($m.Name)"; exit 1 }`,
        `}`,
        `git -C $root commit -m "deploy: promote applied migrations to ${promotedDir} ($(Get-Date -Format 'yyyy-MM-dd'))" -- backend/migrations`,
        `if ($LASTEXITCODE -ne 0) { Write-Host "git commit failed"; exit 1 }`,
        `$cb = (git -C $root branch --show-current).Trim()`,
        `git -C $root push origin $cb`,
        `if ($LASTEXITCODE -ne 0) { Write-Host "git push failed"; exit 1 }`,
        `Write-Host "promoted $($files.Count) migration(s) on $cb"`,
      ].join('\n'),
      confirmBefore: `Promote applied migration(s) to ${promotedDir}, then commit and PUSH the branch?`,
    });
  }

  const prompts = (joined.match(/Read-Host/g) ?? []).length;
  const mapped =
    localPre.filter((s) => s.confirmBefore || s.confirmOnFailure).length +
    localPost.filter((s) => s.confirmBefore).length;
  if (prompts > mapped) {
    warnings.push(
      `${prompts - mapped} interactive prompt(s) in the script were not imported — review the local steps`,
    );
  }
  return { localPre, localPost };
}
