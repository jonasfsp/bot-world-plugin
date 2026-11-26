import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeJsonParse } from './types.ts';

// macOS install locations (unchanged from upstream v1.0.0).
export const TRUSTED_ORCA_PATHS: readonly string[] = [
  '/Applications/Orca.app/Contents/Resources/bin/orca',
  '/opt/homebrew/bin/orca',
  '/usr/local/bin/orca',
] as const;

const TRUSTED_REALPATH_PREFIXES: readonly string[] = [
  '/Applications/Orca.app/Contents/Resources/bin/',
  '/opt/homebrew/',
  '/usr/local/',
] as const;

// Linux: Orca desktop writes a per-user launcher to <userData>/cli/bin/orca
// (userData = ${XDG_CONFIG_HOME:-~/.config}/orca). The root-owned app bundle
// launcher (/opt/Orca/resources/bin/orca-ide) is a fallback.
const LINUX_SYSTEM_ORCA_PATHS: readonly string[] = ['/opt/Orca/resources/bin/orca-ide'] as const;
const LINUX_SYSTEM_REALPATH_PREFIXES: readonly string[] = ['/opt/Orca/resources/bin/'] as const;

const SAFE_ENV_KEYS: readonly string[] = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'USER',
] as const;

// Read by the Orca CLI to locate the runtime metadata (userData) directory.
// Values must be absolute paths.
const SAFE_PATH_ENV_KEYS: readonly string[] = ['XDG_CONFIG_HOME', 'ORCA_USER_DATA_PATH'] as const;

// Windows-only: SystemRoot is required by Node/Electron (Winsock, crypto);
// APPDATA locates %APPDATA%\orca (runtime metadata); USERPROFILE backs
// os.homedir(); TEMP/TMP back os.tmpdir(); LOCALAPPDATA is the per-user install root.
const WINDOWS_SAFE_PATH_ENV_KEYS: readonly string[] = [
  'SystemRoot',
  'LOCALAPPDATA',
  'APPDATA',
  'USERPROFILE',
  'TEMP',
  'TMP',
] as const;

export const MAX_CLI_TIMEOUT_MS = 8_000;
export const DEFAULT_CLI_TIMEOUT_MS = 4_000;
export const MAX_CLI_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_CONCURRENT_CLI = 4;

export type CliEnvelope<T> = {
  id?: string;
  ok: boolean;
  result?: T;
  error?: {
    code?: string;
    message?: string;
  };
  _meta?: {
    runtimeId?: string;
  };
};

export type CliRunnerResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** Set when the process could not be started (ENOENT, EACCES, EINVAL, ...). */
  spawnError?: { code?: string; errno?: number };
};

export type CliRunner = (
  binaryPath: string,
  args: readonly string[],
  options: {
    timeoutMs: number;
    maxBufferBytes: number;
    env: Record<string, string>;
    signal?: AbortSignal;
  }
) => Promise<CliRunnerResult>;

export class OrcaCliError extends Error {
  readonly code:
    | 'binary_not_found'
    | 'invalid_argument'
    | 'disallowed_command'
    | 'runtime_unavailable'
    | 'timeout'
    | 'output_too_large'
    | 'non_zero_exit'
    | 'json_error'
    | 'stopped';

  constructor(
    code:
      | 'binary_not_found'
      | 'invalid_argument'
      | 'disallowed_command'
      | 'runtime_unavailable'
      | 'timeout'
      | 'output_too_large'
      | 'non_zero_exit'
      | 'json_error'
      | 'stopped',
    message: string
  ) {
    super(message);
    this.name = 'OrcaCliError';
    this.code = code;
  }
}

function isWindowsDriveAbsolute(value: string): boolean {
  // Rejects UNC (\\server\share), device (\\?\) and drive-relative (C:foo) paths.
  return /^[A-Za-z]:[\\/]/.test(value);
}

function isAbsoluteForPlatform(value: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? isWindowsDriveAbsolute(value) : value.startsWith('/');
}

/** Windows env names are case-insensitive; a plain object (tests, forked env) may not be. */
function readEnv(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): string | undefined {
  const direct = env[key];
  if (typeof direct === 'string' || platform !== 'win32') {
    return direct;
  }
  const upper = key.toUpperCase();
  for (const [k, v] of Object.entries(env)) {
    if (k.toUpperCase() === upper && typeof v === 'string') {
      return v;
    }
  }
  return undefined;
}

function safeHomeDir(): string | null {
  try {
    return os.homedir();
  } catch {
    return null;
  }
}

/** Windows user profile: USERPROFILE, else os.homedir(); drive-absolute only. */
function windowsHome(env: NodeJS.ProcessEnv, homeDir: string | null): string | null {
  const profile = readEnv(env, 'USERPROFILE', 'win32');
  if (typeof profile === 'string' && !profile.includes('\0') && isWindowsDriveAbsolute(profile)) {
    return profile;
  }
  if (homeDir && !homeDir.includes('\0') && isWindowsDriveAbsolute(homeDir)) {
    return homeDir;
  }
  return null;
}

export function buildMinimalSafeEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir: string | null = platform === process.platform ? safeHomeDir() : null
): Record<string, string> {
  const safe: Record<string, string> = {};
  const delimiter = platform === 'win32' ? ';' : ':';
  const pathKeys = platform === 'win32'
    ? [...SAFE_PATH_ENV_KEYS, ...WINDOWS_SAFE_PATH_ENV_KEYS]
    : SAFE_PATH_ENV_KEYS;
  for (const key of [...SAFE_ENV_KEYS, ...pathKeys]) {
    const val = readEnv(sourceEnv, key, platform);
    if (typeof val !== 'string' || val.length === 0 || val.includes('\0')) {
      continue;
    }
    if (key === 'PATH') {
      const filtered = val
        .split(delimiter)
        .filter((seg) => seg.length > 0 && isAbsoluteForPlatform(seg, platform));
      if (filtered.length > 0) {
        safe[key] = filtered.join(delimiter);
      }
      continue;
    }
    if (pathKeys.includes(key) && !isAbsoluteForPlatform(val, platform)) {
      continue;
    }
    safe[key] = val;
  }
  if (platform === 'win32') {
    // Orca forks plugin workers with a reduced env (no APPDATA/LOCALAPPDATA). The CLI
    // needs APPDATA to find %APPDATA%\orca (runtime metadata), so derive the standard
    // per-user folders from the profile, only when they are missing.
    const home = windowsHome(sourceEnv, homeDir);
    if (home) {
      safe.USERPROFILE ??= home;
      safe.APPDATA ??= path.win32.join(home, 'AppData', 'Roaming');
      safe.LOCALAPPDATA ??= path.win32.join(home, 'AppData', 'Local');
    }
    if (!safe.SystemRoot) {
      const windir = readEnv(sourceEnv, 'WINDIR', 'win32');
      if (typeof windir === 'string' && !windir.includes('\0') && isWindowsDriveAbsolute(windir)) {
        safe.SystemRoot = windir;
      }
    }
  }
  return safe;
}

function isWorldWritable(mode: number): boolean {
  return (mode & 0o002) !== 0;
}

function isGroupWritable(mode: number): boolean {
  return (mode & 0o020) !== 0;
}

function isExecutable(mode: number): boolean {
  return (mode & 0o111) !== 0;
}

function isTrustedOwnerUid(uid: number): boolean {
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  return uid === 0 || (currentUid !== null && uid === currentUid);
}

function isTrustedDirectoryMode(dirPath: string, stat: fs.Stats): boolean {
  if (!stat.isDirectory() || isWorldWritable(stat.mode)) {
    return false;
  }
  if (!isTrustedOwnerUid(stat.uid)) {
    return false;
  }
  if (!isGroupWritable(stat.mode)) {
    return true;
  }
  // Allow macOS system admin (/Applications) or Homebrew (/opt/homebrew) admin-group dirs
  const isSystemAdminGid = stat.gid === 0 || stat.gid === 80;
  if (!isSystemAdminGid) {
    return false;
  }
  if (stat.uid === 0 && (dirPath === '/Applications' || dirPath.startsWith('/Applications/'))) {
    return true;
  }
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    currentUid !== null &&
    stat.uid === currentUid &&
    (dirPath === '/opt/homebrew' || dirPath.startsWith('/opt/homebrew/'))
  ) {
    return true;
  }
  return false;
}

function hasSafeRealpathAncestors(resolvedTargetPath: string): boolean {
  let dir = path.dirname(resolvedTargetPath);
  for (;;) {
    const dirStat = fs.lstatSync(dir);
    if (isWorldWritable(dirStat.mode)) {
      return false;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return true;
}

/** Result of one candidate check: the path to execute, or a short rejection reason. */
export type CandidateCheck = { ok: true; path: string } | { ok: false; reason: string };

const reject = (reason: string): CandidateCheck => ({ ok: false, reason });

function errnoReason(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code.toLowerCase() : 'stat_error';
}

function checkTrustedBinaryPath(
  candidate: string,
  allowedPaths: readonly string[],
  trustedPrefixes: readonly string[]
): CandidateCheck {
  if (!allowedPaths.includes(candidate)) {
    return reject('not_allowlisted');
  }
  try {
    const lstat = fs.lstatSync(candidate);
    if (isWorldWritable(lstat.mode)) {
      return reject('world_writable');
    }
    if (!isTrustedOwnerUid(lstat.uid)) {
      return reject('untrusted_owner');
    }
    const parentDir = path.dirname(candidate);
    const parentStat = fs.statSync(parentDir);
    if (!isTrustedDirectoryMode(parentDir, parentStat)) {
      return reject('unsafe_parent_dir');
    }

    if (lstat.isSymbolicLink()) {
      if (isGroupWritable(lstat.mode)) {
        return reject('group_writable');
      }
      const resolved = fs.realpathSync(candidate);
      const inTrustedPrefix = trustedPrefixes.some((prefix) => resolved.startsWith(prefix));
      if (!inTrustedPrefix) {
        return reject('symlink_outside_trusted_prefix');
      }
      const targetStat = fs.statSync(resolved);
      if (!targetStat.isFile()) {
        return reject('not_regular_file');
      }
      if (!isExecutable(targetStat.mode)) {
        return reject('not_executable');
      }
      if (isWorldWritable(targetStat.mode) || isGroupWritable(targetStat.mode)) {
        return reject('target_writable_by_others');
      }
      if (!isTrustedOwnerUid(targetStat.uid)) {
        return reject('untrusted_owner');
      }
      const targetParent = path.dirname(resolved);
      const targetParentStat = fs.statSync(targetParent);
      if (!isTrustedDirectoryMode(targetParent, targetParentStat)) {
        return reject('unsafe_parent_dir');
      }
      if (!hasSafeRealpathAncestors(resolved)) {
        return reject('world_writable_ancestor');
      }
      return { ok: true, path: resolved };
    }

    if (!lstat.isFile()) {
      return reject('not_regular_file');
    }
    if (!isExecutable(lstat.mode)) {
      return reject('not_executable');
    }
    if (isGroupWritable(lstat.mode)) {
      return reject('group_writable');
    }
    const resolved = fs.realpathSync(candidate);
    if (!hasSafeRealpathAncestors(resolved)) {
      return reject('world_writable_ancestor');
    }
    return { ok: true, path: candidate };
  } catch (err) {
    return reject(errnoReason(err));
  }
}

export function verifyTrustedBinaryPath(
  candidate: string,
  allowedPaths: readonly string[] = TRUSTED_ORCA_PATHS,
  trustedPrefixes: readonly string[] = TRUSTED_REALPATH_PREFIXES
): string | null {
  const res = checkTrustedBinaryPath(candidate, allowedPaths, trustedPrefixes);
  return res.ok ? res.path : null;
}

export type OrcaDiscoveryContext = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homeDir: string | null;
  /** The worker's own executable (Orca.exe under ELECTRON_RUN_AS_NODE on Windows). */
  execPath?: string | null;
  /** Injectable for tests that simulate Windows paths on a POSIX host. */
  windowsFs?: WindowsFsProbe;
};

export type WindowsFsProbe = {
  isRegularFile(p: string): boolean;
  realpath(p: string): string;
};

const nodeWindowsFsProbe: WindowsFsProbe = {
  isRegularFile: (p) => fs.statSync(p).isFile(),
  realpath: (p) => fs.realpathSync.native(p),
};

function defaultDiscoveryContext(): OrcaDiscoveryContext {
  return {
    platform: process.platform,
    env: process.env,
    homeDir: safeHomeDir(),
    execPath: typeof process.execPath === 'string' ? process.execPath : null,
  };
}

function envPath(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): string | null {
  const val = readEnv(env, key, platform);
  if (typeof val !== 'string' || val.length === 0 || val.includes('\0')) {
    return null;
  }
  return isAbsoluteForPlatform(val, platform) ? val : null;
}

/** Install dir of the running Orca (dirname of Orca.exe), when execPath is usable. */
function windowsExecInstallDir(ctx: Pick<OrcaDiscoveryContext, 'execPath'>): string | null {
  const exec = ctx.execPath;
  if (typeof exec !== 'string' || exec.includes('\0') || !isWindowsDriveAbsolute(exec)) {
    return null;
  }
  return path.win32.dirname(path.win32.normalize(exec));
}

function windowsCliUnder(installDir: string): string {
  return path.win32.join(installDir, 'resources', 'bin', 'orca.exe');
}

/** Windows default candidates, in order, de-duplicated case-insensitively. */
function windowsDefaultCandidates(ctx: OrcaDiscoveryContext): string[] {
  const out: string[] = [];
  const execDir = windowsExecInstallDir(ctx);
  if (execDir) {
    out.push(windowsCliUnder(execDir));
  }
  const local = envPath(ctx.env, 'LOCALAPPDATA', 'win32');
  if (local) {
    out.push(windowsCliUnder(path.win32.join(local, 'Programs', 'Orca')));
  }
  const programFiles = envPath(ctx.env, 'ProgramFiles', 'win32');
  if (programFiles) {
    out.push(windowsCliUnder(path.win32.join(programFiles, 'Orca')));
  }
  const home = windowsHome(ctx.env, ctx.homeDir);
  if (home) {
    out.push(windowsCliUnder(path.win32.join(home, 'AppData', 'Local', 'Programs', 'Orca')));
  }
  const seen = new Set<string>();
  return out.filter((p) => {
    const key = path.win32.normalize(p).toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** Directories a Windows CLI realpath may live under. */
function windowsTrustedRoots(ctx: Pick<OrcaDiscoveryContext, 'env' | 'homeDir' | 'execPath'>): string[] {
  const roots: string[] = [];
  const local = envPath(ctx.env, 'LOCALAPPDATA', 'win32');
  if (local) {
    roots.push(local);
  }
  const programFiles = envPath(ctx.env, 'ProgramFiles', 'win32');
  if (programFiles) {
    roots.push(programFiles);
  }
  const home = windowsHome(ctx.env, ctx.homeDir ?? null);
  if (home) {
    roots.push(path.win32.join(home, 'AppData', 'Local'));
  }
  const execDir = windowsExecInstallDir(ctx);
  if (execDir) {
    roots.push(execDir);
  }
  return roots;
}

function linuxUserCliPaths(ctx: OrcaDiscoveryContext): string[] {
  const configDirs: string[] = [];
  const xdg = envPath(ctx.env, 'XDG_CONFIG_HOME', 'linux');
  if (xdg) {
    configDirs.push(xdg);
  }
  if (ctx.homeDir && ctx.homeDir.startsWith('/')) {
    configDirs.push(path.posix.join(ctx.homeDir, '.config'));
  }
  const unique = [...new Set(configDirs.map((d) => path.posix.join(d, 'orca', 'cli', 'bin', 'orca')))];
  return unique;
}

/** Platform default CLI locations, in discovery order (ORCA_CLI_COMMAND is checked first, separately). */
export function getDefaultOrcaCandidates(ctx: OrcaDiscoveryContext = defaultDiscoveryContext()): string[] {
  if (ctx.platform === 'win32') {
    // orca.exe is preferred: Node refuses to spawn .cmd without a shell (CVE-2024-27980).
    return windowsDefaultCandidates(ctx);
  }
  if (ctx.platform === 'linux') {
    return [...linuxUserCliPaths(ctx), ...LINUX_SYSTEM_ORCA_PATHS];
  }
  if (ctx.platform === 'darwin') {
    return [...TRUSTED_ORCA_PATHS];
  }
  return [];
}

function posixTrustedPrefixes(ctx: OrcaDiscoveryContext): string[] {
  if (ctx.platform === 'linux') {
    return [
      ...linuxUserCliPaths(ctx).map((p) => path.posix.dirname(p) + '/'),
      ...LINUX_SYSTEM_REALPATH_PREFIXES,
    ];
  }
  return [...TRUSTED_REALPATH_PREFIXES];
}

function isWithinWindowsDir(child: string, dir: string): boolean {
  const normChild = path.win32.normalize(child).toLowerCase();
  let normDir = path.win32.normalize(dir).toLowerCase();
  if (!normDir.endsWith('\\')) {
    normDir += '\\';
  }
  return normChild.startsWith(normDir);
}

function checkWindowsBinaryPath(
  candidate: string,
  ctx: Pick<OrcaDiscoveryContext, 'env' | 'windowsFs' | 'homeDir' | 'execPath'>,
  explicitlyConfigured: boolean
): CandidateCheck {
  if (typeof candidate !== 'string' || candidate.includes('\0') || !isWindowsDriveAbsolute(candidate)) {
    return reject('not_drive_absolute');
  }
  const probe = ctx.windowsFs ?? nodeWindowsFsProbe;
  let target = path.win32.normalize(candidate);
  const ext = path.win32.extname(target).toLowerCase();
  if (ext === '.cmd') {
    target = target.slice(0, -ext.length) + '.exe';
  } else if (ext !== '.exe') {
    return reject('not_exe');
  }
  let resolved: string;
  try {
    if (!probe.isRegularFile(target)) {
      return reject('not_regular_file');
    }
    resolved = probe.realpath(target);
  } catch (err) {
    return reject(errnoReason(err) === 'stat_error' ? 'not_found' : errnoReason(err));
  }
  if (!isWindowsDriveAbsolute(resolved) || path.win32.extname(resolved).toLowerCase() !== '.exe') {
    return reject('realpath_not_exe');
  }
  if (explicitlyConfigured) {
    return { ok: true, path: resolved };
  }
  const roots = windowsTrustedRoots(ctx).map((dir) => {
    try {
      return probe.realpath(dir);
    } catch {
      return dir;
    }
  });
  return roots.some((root) => isWithinWindowsDir(resolved, root))
    ? { ok: true, path: resolved }
    : reject('outside_trusted_roots');
}

/**
 * Windows replacement for the POSIX mode/owner checks (Node reports 0o666/0o444
 * and has no getuid there). Requires: drive-absolute path, .exe (a .cmd is mapped
 * to its sibling .exe, never executed), an existing regular file, and a realpath
 * inside %LOCALAPPDATA%, %ProgramFiles%, <profile>\AppData\Local, or the install
 * dir of the running Orca (dirname of process.execPath), or equal to
 * ORCA_CLI_COMMAND's realpath.
 */
export function verifyWindowsBinaryPath(
  candidate: string,
  ctx: Pick<OrcaDiscoveryContext, 'env' | 'windowsFs'> &
    Partial<Pick<OrcaDiscoveryContext, 'homeDir' | 'execPath'>>,
  options: { explicitlyConfigured?: boolean } = {}
): string | null {
  const res = checkWindowsBinaryPath(
    candidate,
    { homeDir: null, execPath: null, ...ctx },
    Boolean(options.explicitlyConfigured)
  );
  return res.ok ? res.path : null;
}

function checkCandidate(
  candidate: string,
  ctx: OrcaDiscoveryContext,
  explicitlyConfigured: boolean
): CandidateCheck {
  if (ctx.platform === 'win32') {
    return checkWindowsBinaryPath(candidate, ctx, explicitlyConfigured);
  }
  if (!candidate.startsWith('/')) {
    return reject('not_absolute');
  }
  const prefixes = posixTrustedPrefixes(ctx);
  if (explicitlyConfigured) {
    prefixes.push(path.posix.dirname(candidate) + '/');
  }
  return checkTrustedBinaryPath(candidate, [candidate], prefixes);
}

export type OrcaDiscoveryAttempt = {
  source: 'ORCA_CLI_COMMAND' | 'default';
  candidate: string;
  result: string;
};

export type OrcaDiscoveryReport = {
  path: string | null;
  platform: NodeJS.Platform;
  execPath: string | null;
  /** Presence only (never values) of the env keys discovery depends on. */
  envPresent: Record<string, boolean>;
  attempts: OrcaDiscoveryAttempt[];
};

const DIAGNOSTIC_ENV_KEYS = ['LOCALAPPDATA', 'ProgramFiles', 'ORCA_CLI_COMMAND', 'USERPROFILE', 'APPDATA'] as const;

/**
 * Discovery order: (a) ORCA_CLI_COMMAND when it is an absolute path to an existing
 * file that passes the platform checks; (b) the platform default install locations.
 */
export function discoverOrcaBinaryWithReport(
  ctx: OrcaDiscoveryContext = defaultDiscoveryContext()
): OrcaDiscoveryReport {
  const envPresent: Record<string, boolean> = {};
  for (const key of DIAGNOSTIC_ENV_KEYS) {
    const val = readEnv(ctx.env, key, ctx.platform);
    envPresent[key] = typeof val === 'string' && val.length > 0;
  }
  const report: OrcaDiscoveryReport = {
    path: null,
    platform: ctx.platform,
    execPath: typeof ctx.execPath === 'string' ? ctx.execPath : null,
    envPresent,
    attempts: [],
  };
  const configuredRaw = readEnv(ctx.env, 'ORCA_CLI_COMMAND', ctx.platform);
  if (typeof configuredRaw === 'string' && configuredRaw.length > 0) {
    const configured = envPath(ctx.env, 'ORCA_CLI_COMMAND', ctx.platform);
    if (!configured) {
      report.attempts.push({ source: 'ORCA_CLI_COMMAND', candidate: '(not absolute)', result: 'ignored' });
    } else {
      const res = checkCandidate(configured, ctx, true);
      report.attempts.push({ source: 'ORCA_CLI_COMMAND', candidate: configured, result: res.ok ? 'ok' : res.reason });
      if (res.ok) {
        report.path = res.path;
        return report;
      }
    }
  }
  for (const candidate of getDefaultOrcaCandidates(ctx)) {
    const res = checkCandidate(candidate, ctx, false);
    report.attempts.push({ source: 'default', candidate, result: res.ok ? 'ok' : res.reason });
    if (res.ok) {
      report.path = res.path;
      return report;
    }
  }
  return report;
}

export function discoverOrcaBinary(ctx: OrcaDiscoveryContext = defaultDiscoveryContext()): string | null {
  return discoverOrcaBinaryWithReport(ctx).path;
}

export function formatDiscoveryReport(report: OrcaDiscoveryReport): string {
  const env = Object.entries(report.envPresent)
    .map(([k, v]) => `${k}=${v ? 'set' : 'unset'}`)
    .join(',');
  const attempts = report.attempts.length === 0
    ? '(none)'
    : report.attempts.map((a) => `${a.source === 'ORCA_CLI_COMMAND' ? 'env:' : ''}${a.candidate} -> ${a.result}`).join('; ');
  return `platform=${report.platform} execPath=${report.execPath ?? '(none)'} env[${env}] candidates[${attempts}]`;
}

// --- Diagnostics -----------------------------------------------------------
// One short line per error code per minute to the worker log. Never logs env
// values, CLI arguments or stdout (which may carry bot messages).

export type OrcaCliDiagnosticLogger = (line: string) => void;

export const DIAGNOSTIC_RATE_LIMIT_MS = 60_000;
const MAX_DIAGNOSTIC_STDERR_CHARS = 300;

let diagnosticLogger: OrcaCliDiagnosticLogger | null = null;
let diagnosticNow: () => number = () => Date.now();
const diagnosticLastLogged = new Map<string, number>();
let loggedFirstSuccess = false;

/** Route CLI diagnostics to the plugin worker log (orca.log). Pass null to disable. */
export function setOrcaCliDiagnosticLogger(
  logger: OrcaCliDiagnosticLogger | null,
  options: { now?: () => number } = {}
): void {
  diagnosticLogger = logger;
  diagnosticNow = options.now ?? (() => Date.now());
  diagnosticLastLogged.clear();
  loggedFirstSuccess = false;
}

function emitDiagnostic(key: string, line: string): void {
  if (!diagnosticLogger) {
    return;
  }
  const now = diagnosticNow();
  const last = diagnosticLastLogged.get(key);
  if (last !== undefined && now - last < DIAGNOSTIC_RATE_LIMIT_MS) {
    return;
  }
  diagnosticLastLogged.set(key, now);
  try {
    diagnosticLogger(`[bot-world] orca-cli ${line}`.replace(/[\r\n]+/g, ' '));
  } catch {
    // logging must never break polling
  }
}

function truncateForLog(text: string): string {
  const clean = text.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
  return clean.length > MAX_DIAGNOSTIC_STDERR_CHARS
    ? `${clean.slice(0, MAX_DIAGNOSTIC_STDERR_CHARS)}…`
    : clean;
}

/** Discover the CLI and log the outcome (failure, or the first success). */
function discoverAndLog(): string | null {
  const report = discoverOrcaBinaryWithReport();
  if (!report.path) {
    emitDiagnostic('binary_not_found', `binary_not_found ${formatDiscoveryReport(report)}`);
  } else if (!loggedFirstSuccess && diagnosticLogger) {
    loggedFirstSuccess = true;
    emitDiagnostic('discovered', `using ${report.path} ${formatDiscoveryReport(report)}`);
  }
  return report.path;
}

function logRunFailure(res: CliRunnerResult, includeStderr: boolean): void {
  const spawn = res.spawnError;
  const code = spawn?.code ?? `exit_${String(res.exitCode)}`;
  const parts = [`run_failed code=${code}`];
  if (spawn?.errno !== undefined) {
    parts.push(`errno=${spawn.errno}`);
  }
  if (includeStderr && res.stderr) {
    parts.push(`stderr="${truncateForLog(res.stderr)}"`);
  }
  emitDiagnostic(`run:${code}`, parts.join(' '));
}

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const QUICK_MESSAGE_CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const SHELL_META_RE = /[;|&$`<>\\/]/;
export const MAX_QUICK_MESSAGE_CHARS = 500;
export const MAX_ITEM_NUMBER = 999_999_999;

export function validateItemNumber(itemNumber: number): number {
  if (
    typeof itemNumber !== 'number' ||
    !Number.isSafeInteger(itemNumber) ||
    itemNumber < 1 ||
    itemNumber > MAX_ITEM_NUMBER
  ) {
    throw new OrcaCliError(
      'invalid_argument',
      `itemNumber must be an integer between 1 and ${MAX_ITEM_NUMBER}`
    );
  }
  return itemNumber;
}

export function validateBotName(botName: string): string {
  if (typeof botName !== 'string') {
    throw new OrcaCliError('invalid_argument', 'botName must be a string');
  }
  const trimmed = botName.trim();
  if (trimmed.length === 0 || trimmed.length > 128) {
    throw new OrcaCliError('invalid_argument', 'botName length out of bounds');
  }
  if (CONTROL_CHAR_RE.test(trimmed)) {
    throw new OrcaCliError('invalid_argument', 'botName contains control characters');
  }
  if (SHELL_META_RE.test(trimmed)) {
    throw new OrcaCliError('invalid_argument', 'botName contains disallowed characters');
  }
  if (trimmed.startsWith('-')) {
    throw new OrcaCliError('invalid_argument', 'botName cannot start with "-"');
  }
  return trimmed;
}

export function validateSince(since: string): string {
  if (typeof since !== 'string' || !/^[1-9][0-9]{0,3}[smhd]$/.test(since)) {
    throw new OrcaCliError('invalid_argument', 'since must match ^[1-9][0-9]{0,3}[smhd]$');
  }
  return since;
}

export function clampLimit(limit: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new OrcaCliError('invalid_argument', 'limit must be a finite number');
  }
  const intVal = Math.trunc(limit);
  return Math.max(1, Math.min(200, intVal));
}

const CURSOR_SAFE_RE = /^[A-Za-z0-9_.:=+/-]+$/;

export function validateCursor(cursor: string): string {
  if (typeof cursor !== 'string') {
    throw new OrcaCliError('invalid_argument', 'cursor must be a string');
  }
  const trimmed = cursor.trim();
  if (trimmed.length === 0 || trimmed.length > 256) {
    throw new OrcaCliError('invalid_argument', 'cursor length out of bounds');
  }
  if (
    CONTROL_CHAR_RE.test(trimmed) ||
    trimmed.startsWith('-') ||
    /\s/.test(trimmed) ||
    !CURSOR_SAFE_RE.test(trimmed)
  ) {
    throw new OrcaCliError('invalid_argument', 'cursor contains invalid characters');
  }
  return trimmed;
}

/**
 * Runtime enforcement of the read-only subcommand allowlist.
 * Rejects any non-read-only command or unexpected argument shape before spawning.
 */
export function assertAllowedSubcommand(args: readonly string[]): void {
  if (!Array.isArray(args) || args.length < 2) {
    throw new OrcaCliError('disallowed_command', 'Command arguments missing');
  }
  for (const arg of args) {
    if (typeof arg !== 'string' || CONTROL_CHAR_RE.test(arg)) {
      throw new OrcaCliError('invalid_argument', 'Argument contains control characters');
    }
  }

  // Exact structural match against read-only commands
  const a0 = args[0];
  const a1 = args[1];

  if (a0 === 'status' && args.length === 2 && a1 === '--json') return;

  if (a0 === 'bot' && a1 === 'list' && args.length === 3 && args[2] === '--json') return;

  if (
    a0 === 'bot' &&
    a1 === 'chats' &&
    args.length === 6 &&
    args[2] === '--bot' &&
    args[4] === '--all' &&
    args[5] === '--json'
  ) {
    validateBotName(args[3]);
    return;
  }

  if (a0 === 'bot' && a1 === 'item' && args[2] === 'list' && args[3] === '--bot') {
    if (args.length === 6 && args[5] === '--json') {
      validateBotName(args[4]);
      return;
    }
    if (args.length === 7 && args[5] === '--all' && args[6] === '--json') {
      validateBotName(args[4]);
      return;
    }
  }

  if (
    a0 === 'worktree' &&
    a1 === 'ps' &&
    args.length === 5 &&
    args[2] === '--since' &&
    args[4] === '--json'
  ) {
    validateSince(args[3]);
    return;
  }

  if (
    a0 === 'orchestration' &&
    a1 === 'inbox' &&
    args.length === 6 &&
    args[2] === '--limit' &&
    args[4] === '--full' &&
    args[5] === '--json' &&
    /^[1-9][0-9]*$/.test(args[3])
  ) {
    const n = Number(args[3]);
    if (n >= 1 && n <= 200) return;
  }

  if (a0 === 'orchestration' && a1 === 'worker-list' && args[2] === '--limit') {
    if (
      args.length === 6 &&
      /^[1-9][0-9]*$/.test(args[3]) &&
      Number(args[3]) <= 200 &&
      args[4] === '--full' &&
      args[5] === '--json'
    ) {
      return;
    }
    if (
      args.length === 8 &&
      /^[1-9][0-9]*$/.test(args[3]) &&
      Number(args[3]) <= 200 &&
      args[4] === '--cursor' &&
      args[6] === '--full' &&
      args[7] === '--json'
    ) {
      validateCursor(args[5]);
      return;
    }
  }

  if (
    a0 === 'orchestration' &&
    a1 === 'run-list' &&
    args.length === 4 &&
    args[2] === '--full' &&
    args[3] === '--json'
  ) {
    return;
  }

  if (a0 === 'automations' && a1 === 'list' && args.length === 3 && args[2] === '--json') {
    return;
  }

  if (a0 === 'automations' && a1 === 'runs' && args.length === 3 && args[2] === '--json') {
    return;
  }

  throw new OrcaCliError('disallowed_command', `Command is not in the read-only allowlist: ${a0}`);
}

const defaultExecFileRunner: CliRunner = (binaryPath, args, options) => {
  return new Promise((resolve, reject) => {
    execFile(
      binaryPath,
      [...args],
      {
        shell: false,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBufferBytes,
        env: options.env,
        windowsHide: true,
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        if (error) {
          const errObj = error as NodeJS.ErrnoException & {
            killed?: boolean;
            signal?: string;
            code?: string | number;
          };
          if (errObj.name === 'AbortError') {
            reject(new OrcaCliError('stopped', 'CLI command aborted'));
            return;
          }
          if (errObj.killed && errObj.signal === 'SIGTERM') {
            reject(new OrcaCliError('timeout', `CLI command timed out after ${options.timeoutMs}ms`));
            return;
          }
          if (errObj.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            reject(new OrcaCliError('output_too_large', 'CLI output exceeded 2 MiB limit'));
            return;
          }
          // Non-zero exit code can still carry JSON stdout envelope
          const exitCode = typeof errObj.code === 'number' ? errObj.code : null;
          const spawnError =
            typeof errObj.code === 'string'
              ? {
                  code: errObj.code,
                  ...(typeof errObj.errno === 'number' ? { errno: errObj.errno } : {}),
                }
              : undefined;
          resolve({
            stdout: typeof stdout === 'string' ? stdout : '',
            stderr: typeof stderr === 'string' && stderr.length > 0 ? stderr : errObj.message,
            exitCode,
            ...(spawnError ? { spawnError } : {}),
          });
          return;
        }
        resolve({
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
          exitCode: 0,
        });
      }
    );
  });
};

export interface OrcaClient {
  isStopped(): boolean;
  status(): Promise<CliEnvelope<unknown>>;
  botList(): Promise<CliEnvelope<unknown>>;
  botChats(botName: string): Promise<CliEnvelope<unknown>>;
  botItemList(botName: string, all: boolean): Promise<CliEnvelope<unknown>>;
  worktreePs(since?: string): Promise<CliEnvelope<unknown>>;
  orchestrationInbox(limit: number): Promise<CliEnvelope<unknown>>;
  orchestrationWorkerList(limit: number, cursor?: string | null): Promise<CliEnvelope<unknown>>;
  orchestrationRunList(): Promise<CliEnvelope<unknown>>;
  automationsList(): Promise<CliEnvelope<unknown>>;
  automationsRuns(): Promise<CliEnvelope<unknown>>;
}

export class OrcaCli implements OrcaClient {
  private readonly binaryPath: string | null;
  private readonly hasCustomRunner: boolean;
  private readonly timeoutMs: number;
  private readonly runner: CliRunner;
  private readonly env: Record<string, string>;
  private stopped = false;
  private activeCount = 0;
  private readonly waiters: Array<(granted: boolean) => void> = [];
  private abortController = new AbortController();

  constructor(options?: {
    binaryPath?: string | null;
    timeoutMs?: number;
    runner?: CliRunner;
    env?: Record<string, string>;
  }) {
    // Only allow custom binaryPath when explicit runner is injected (tests);
    // otherwise strictly use discoverOrcaBinary() allowlist.
    if (options?.runner) {
      this.hasCustomRunner = true;
      this.runner = options.runner;
      this.binaryPath =
        options.binaryPath === undefined ? '/Applications/Orca.app/Contents/Resources/bin/orca' : options.binaryPath;
    } else {
      this.hasCustomRunner = false;
      this.runner = defaultExecFileRunner;
      this.binaryPath = discoverOrcaBinary();
    }
    const rawTimeout = options?.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
    this.timeoutMs = Math.max(100, Math.min(MAX_CLI_TIMEOUT_MS, Math.trunc(rawTimeout)));
    this.env = options?.env ?? buildMinimalSafeEnv();
  }

  isStopped(): boolean {
    return this.stopped;
  }

  stop(): void {
    this.stopped = true;
    this.abortController.abort();
    while (this.waiters.length > 0) {
      const next = this.waiters.shift();
      next?.(false);
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.stopped) {
      throw new OrcaCliError('stopped', 'Orca CLI stopped');
    }
    if (this.activeCount < MAX_CONCURRENT_CLI) {
      this.activeCount++;
      return;
    }
    const granted = await new Promise<boolean>((resolve) => {
      this.waiters.push(resolve);
    });
    if (this.stopped || !granted) {
      if (granted) {
        this.releaseSlot();
      }
      throw new OrcaCliError('stopped', 'Orca CLI stopped');
    }
  }

  private releaseSlot(): void {
    const next = this.waiters.shift();
    if (next && !this.stopped) {
      next(true);
      return;
    }
    if (next) {
      next(false);
    }
    this.activeCount = Math.max(0, this.activeCount - 1);
  }

  async runEnvelope<T = unknown>(args: readonly string[]): Promise<CliEnvelope<T>> {
    assertAllowedSubcommand(args);
    if (this.stopped) {
      throw new OrcaCliError('stopped', 'Orca CLI stopped');
    }
    const execPath = this.hasCustomRunner ? this.binaryPath : discoverAndLog();
    if (!execPath) {
      throw new OrcaCliError('binary_not_found', 'Trusted Orca CLI binary not found');
    }

    await this.acquireSlot();
    try {
      const res = await this.runner(execPath, args, {
        timeoutMs: this.timeoutMs,
        maxBufferBytes: MAX_CLI_OUTPUT_BYTES,
        env: this.env,
        signal: this.abortController.signal,
      });

      if (Buffer.byteLength(res.stdout, 'utf8') > MAX_CLI_OUTPUT_BYTES) {
        throw new OrcaCliError('output_too_large', 'CLI stdout exceeded 2 MiB');
      }

      if (res.exitCode !== 0 && res.stdout.trim().length === 0) {
        // Read-only commands: stderr carries no bot message content.
        logRunFailure(res, true);
        const stderr = res.stderr.trim();
        if (stderr.includes('not reachable') || stderr.includes('runtime_unavailable')) {
          throw new OrcaCliError('runtime_unavailable', stderr || 'Orca runtime unavailable');
        }
        throw new OrcaCliError(
          'non_zero_exit',
          `orca command exited with ${String(res.exitCode)}: ${stderr}`
        );
      }

      let parsed: CliEnvelope<T>;
      try {
        parsed = safeJsonParse<CliEnvelope<T>>(res.stdout, MAX_CLI_OUTPUT_BYTES);
      } catch (err) {
        throw new OrcaCliError(
          'json_error',
          `Failed to parse CLI JSON: ${err instanceof Error ? err.message : 'invalid json'}`
        );
      }

      if (!parsed || typeof parsed !== 'object') {
        throw new OrcaCliError('json_error', 'CLI returned non-object envelope');
      }

      if (!parsed.ok && parsed.error) {
        const code = String(parsed.error.code ?? '');
        const msg = String(parsed.error.message ?? '');
        emitDiagnostic(
          `envelope:${code.slice(0, 64)}`,
          `envelope_error code=${truncateForLog(code).slice(0, 64)} message="${truncateForLog(msg)}"`
        );
        if (code === 'runtime_unavailable' || msg.includes('not reachable')) {
          throw new OrcaCliError('runtime_unavailable', msg || 'Orca runtime unavailable');
        }
        throw new OrcaCliError('non_zero_exit', `${code}: ${msg}`);
      }

      return parsed;
    } finally {
      this.releaseSlot();
    }
  }

  async status(): Promise<CliEnvelope<unknown>> {
    return this.runEnvelope(['status', '--json']);
  }

  async botList(): Promise<CliEnvelope<unknown>> {
    return this.runEnvelope(['bot', 'list', '--json']);
  }

  async botChats(botName: string): Promise<CliEnvelope<unknown>> {
    const clean = validateBotName(botName);
    return this.runEnvelope(['bot', 'chats', '--bot', clean, '--all', '--json']);
  }

  async botItemList(botName: string, all: boolean): Promise<CliEnvelope<unknown>> {
    const clean = validateBotName(botName);
    return this.runEnvelope(
      all
        ? ['bot', 'item', 'list', '--bot', clean, '--all', '--json']
        : ['bot', 'item', 'list', '--bot', clean, '--json']
    );
  }

  async worktreePs(since = '24h'): Promise<CliEnvelope<unknown>> {
    const cleanSince = validateSince(since);
    return this.runEnvelope(['worktree', 'ps', '--since', cleanSince, '--json']);
  }

  async orchestrationInbox(limit: number): Promise<CliEnvelope<unknown>> {
    const clamped = clampLimit(limit);
    return this.runEnvelope(['orchestration', 'inbox', '--limit', String(clamped), '--full', '--json']);
  }

  async orchestrationWorkerList(limit: number, cursor?: string | null): Promise<CliEnvelope<unknown>> {
    const clamped = clampLimit(limit);
    if (cursor !== undefined && cursor !== null && cursor.length > 0) {
      const cleanCursor = validateCursor(cursor);
      return this.runEnvelope([
        'orchestration',
        'worker-list',
        '--limit',
        String(clamped),
        '--cursor',
        cleanCursor,
        '--full',
        '--json',
      ]);
    }
    return this.runEnvelope([
      'orchestration',
      'worker-list',
      '--limit',
      String(clamped),
      '--full',
      '--json',
    ]);
  }

  async orchestrationRunList(): Promise<CliEnvelope<unknown>> {
    return this.runEnvelope(['orchestration', 'run-list', '--full', '--json']);
  }

  async automationsList(): Promise<CliEnvelope<unknown>> {
    return this.runEnvelope(['automations', 'list', '--json']);
  }

  async automationsRuns(): Promise<CliEnvelope<unknown>> {
    return this.runEnvelope(['automations', 'runs', '--json']);
  }
}

/**
 * Validates an opt-in Quick Send message body.
 * Rejects NUL and ASCII control characters (normalizing tabs/newlines cleanly) and enforces 1..500 chars.
 */
export function validateQuickMessageBody(rawMessage: string): string {
  if (typeof rawMessage !== 'string') {
    throw new OrcaCliError('invalid_argument', 'message must be a string');
  }
  if (rawMessage.includes('\0') || QUICK_MESSAGE_CONTROL_CHAR_RE.test(rawMessage)) {
    throw new OrcaCliError('invalid_argument', 'message contains disallowed control characters');
  }
  const normalized = rawMessage
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .trim();
  const charCount = Array.from(normalized).length;
  if (charCount === 0 || charCount > MAX_QUICK_MESSAGE_CHARS) {
    throw new OrcaCliError(
      'invalid_argument',
      `message must be 1..${MAX_QUICK_MESSAGE_CHARS} characters`
    );
  }
  return normalized;
}

/**
 * Builds an execFile argument vector for opt-in Quick Send.
 * Kept strictly separate from the read-only `assertAllowedSubcommand()` allowlist.
 */
export function buildQuickSendArgs(botName: string, message: string): string[] {
  const cleanBot = validateBotName(botName);
  const cleanBody = validateQuickMessageBody(message);
  return [
    'orchestration',
    'send',
    '--to',
    `bot:${cleanBot}`,
    '--subject',
    'Bot World Quick Message',
    '--body',
    cleanBody,
    '--json',
  ];
}

/**
 * Builds an execFile argument vector for opt-in Needs You item replies.
 * Kept strictly separate from the read-only `assertAllowedSubcommand()` allowlist.
 */
export function buildItemReplyArgs(
  botName: string,
  itemNumber: number,
  answerText: string
): string[] {
  const cleanBot = validateBotName(botName);
  const cleanNum = validateItemNumber(itemNumber);
  const cleanBody = validateQuickMessageBody(answerText);
  return [
    'orchestration',
    'send',
    '--to',
    `bot:${cleanBot}`,
    '--item',
    String(cleanNum),
    '--subject',
    'Bot World Decision Reply',
    '--body',
    cleanBody,
    '--json',
  ];
}

export type CliWriteOptions = {
  binaryPath?: string | null;
  timeoutMs?: number;
  runner?: CliRunner;
  env?: Record<string, string>;
  signal?: AbortSignal;
};

async function runWriteEnvelope(
  args: readonly string[],
  options?: CliWriteOptions
): Promise<CliEnvelope<unknown>> {
  const hasCustomRunner = Boolean(options?.runner);
  const execPath = hasCustomRunner
    ? options?.binaryPath === undefined
      ? TRUSTED_ORCA_PATHS[0]
      : options.binaryPath
    : discoverAndLog();
  if (!execPath) {
    throw new OrcaCliError('binary_not_found', 'Trusted Orca CLI binary not found');
  }

  const runner = options?.runner ?? defaultExecFileRunner;
  const rawTimeout = options?.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  const timeoutMs = Math.max(100, Math.min(MAX_CLI_TIMEOUT_MS, Math.trunc(rawTimeout)));
  const env = options?.env ?? buildMinimalSafeEnv();

  const res = await runner(execPath, args, {
    timeoutMs,
    maxBufferBytes: MAX_CLI_OUTPUT_BYTES,
    env,
    signal: options?.signal,
  });

  if (Buffer.byteLength(res.stdout, 'utf8') > MAX_CLI_OUTPUT_BYTES) {
    throw new OrcaCliError('output_too_large', 'CLI stdout exceeded 2 MiB');
  }

  if (res.exitCode !== 0 && res.stdout.trim().length === 0) {
    // Write commands carry the user's message in argv; never log their stderr.
    logRunFailure(res, false);
    const stderr = res.stderr.trim();
    if (stderr.includes('not reachable') || stderr.includes('runtime_unavailable')) {
      throw new OrcaCliError('runtime_unavailable', stderr || 'Orca runtime unavailable');
    }
    throw new OrcaCliError(
      'non_zero_exit',
      `orca command exited with ${String(res.exitCode)}: ${stderr}`
    );
  }

  let parsed: CliEnvelope<unknown>;
  try {
    parsed = safeJsonParse<CliEnvelope<unknown>>(res.stdout, MAX_CLI_OUTPUT_BYTES);
  } catch (err) {
    throw new OrcaCliError(
      'json_error',
      `Failed to parse CLI JSON: ${err instanceof Error ? err.message : 'invalid json'}`
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new OrcaCliError('json_error', 'CLI returned non-object envelope');
  }

  if (!parsed.ok && parsed.error) {
    const code = String(parsed.error.code ?? '');
    const msg = String(parsed.error.message ?? '');
    if (code === 'runtime_unavailable' || msg.includes('not reachable')) {
      throw new OrcaCliError('runtime_unavailable', msg || 'Orca runtime unavailable');
    }
    throw new OrcaCliError('non_zero_exit', `${code}: ${msg}`);
  }

  return parsed;
}

export async function sendQuickBotMessage(
  botName: string,
  message: string,
  options?: CliWriteOptions
): Promise<CliEnvelope<unknown>> {
  const args = buildQuickSendArgs(botName, message);
  return runWriteEnvelope(args, options);
}

export async function replyNeedsOwnerItem(
  botName: string,
  itemNumber: number,
  answerText: string,
  options?: CliWriteOptions
): Promise<CliEnvelope<unknown>> {
  const args = buildItemReplyArgs(botName, itemNumber, answerText);
  return runWriteEnvelope(args, options);
}
