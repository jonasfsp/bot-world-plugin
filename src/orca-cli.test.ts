import fs from 'node:fs';
import path from 'node:path';
import { assert, describe, test } from 'orca/testing';
import {
  MAX_CLI_OUTPUT_BYTES,
  MAX_CLI_TIMEOUT_MS,
  OrcaCli,
  OrcaCliError,
  assertAllowedSubcommand,
  buildMinimalSafeEnv,
  discoverOrcaBinary,
  discoverOrcaBinaryWithReport,
  formatDiscoveryReport,
  sendQuickBotMessage,
  setOrcaCliDiagnosticLogger,
  getDefaultOrcaCandidates,
  clampLimit,
  validateBotName,
  validateCursor,
  validateSince,
  verifyTrustedBinaryPath,
  verifyWindowsBinaryPath,
  type WindowsFsProbe,
} from './orca-cli.ts';
import { PollerSession } from './poller.ts';

const isOrcaCliError = (err: unknown): boolean => err instanceof OrcaCliError;

describe('OrcaCli security & argument validation', () => {
  test('blocks command injection, flag injection, and control chars in botName', () => {
    for (const bad of [
      '',
      '   ',
      '-evil-flag',
      '--json',
      '; rm -rf /',
      'bot|cat',
      'bot$(id)',
      'bot\0name',
      'bot\nname',
      'bot\rname',
      'x'.repeat(129),
    ]) {
      assert.throws(() => validateBotName(bad), isOrcaCliError);
    }
    assert.equal(validateBotName('Ops Lead'), 'Ops Lead');
    assert.equal(validateBotName('클라우드 운영'), '클라우드 운영');
    assert.equal(validateBotName('bot_world-1'), 'bot_world-1');
  });

  test('validates since and clamps limit strictly', () => {
    assert.equal(validateSince('24h'), '24h');
    assert.equal(validateSince('30m'), '30m');
    assert.throws(() => validateSince('-24h'), isOrcaCliError);
    assert.throws(() => validateSince('24h;rm'), isOrcaCliError);
    assert.throws(() => validateSince('0h'), isOrcaCliError);

    assert.equal(clampLimit(0), 1);
    assert.equal(clampLimit(-50), 1);
    assert.equal(clampLimit(30), 30);
    assert.equal(clampLimit(9999), 200);
    assert.throws(() => clampLimit(Number.NaN), isOrcaCliError);
  });

  test('enforces read-only subcommand allowlist at runtime', () => {
    assertAllowedSubcommand(['status', '--json']);
    assertAllowedSubcommand(['bot', 'list', '--json']);
    assertAllowedSubcommand(['bot', 'chats', '--bot', 'Ops Lead', '--all', '--json']);
    assertAllowedSubcommand(['bot', 'item', 'list', '--bot', 'Ops Lead', '--json']);
    assertAllowedSubcommand(['bot', 'item', 'list', '--bot', 'Ops Lead', '--all', '--json']);
    assertAllowedSubcommand(['worktree', 'ps', '--since', '24h', '--json']);
    assertAllowedSubcommand(['orchestration', 'inbox', '--limit', '30', '--full', '--json']);
    assertAllowedSubcommand(['orchestration', 'worker-list', '--limit', '100', '--full', '--json']);
    assertAllowedSubcommand(['orchestration', 'run-list', '--full', '--json']);
    assertAllowedSubcommand(['automations', 'list', '--json']);
    assertAllowedSubcommand(['automations', 'runs', '--json']);

    for (const disallowed of [
      ['terminal', 'send', '--text', 'rm -rf /'],
      ['bot', 'send', '--bot', 'Ops Lead', '--text', 'hi'],
      ['orchestration', 'send', '--body', 'x'],
      ['agent', 'launch', '--agent', 'claude'],
      ['automations', 'create', '--name', 'evil'],
      ['bot', 'chats', '--bot', '--flag-inject', '--all', '--json'],
      ['bot', 'chats', '--bot', 'Ops Lead;id', '--all', '--json'],
    ]) {
      assert.throws(() => assertAllowedSubcommand(disallowed), isOrcaCliError);
    }
  });

  test('scrubs sensitive session & credential environment variables', () => {
    const env = buildMinimalSafeEnv({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/tester',
      TMPDIR: '/tmp',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      USER: 'tester',
      ORCA_BOT_TOOLS_TOKEN: 'secret-bot-token',
      ORCA_AGENT_SESSION_ID: 'sess-123',
      ORCA_SESSION_ID: 'orca-sess',
      ORCA_TERMINAL_ID: 'term-1',
      ORCA_PANE_KEY: 'pane-1',
      ORCA_CHAT_ID: 'chat-1',
      ANTHROPIC_API_KEY: 'sk-' + 'ant-secret',
      OPENAI_API_KEY: 'sk-' + 'openai-secret',
      GEMINI_API_KEY: 'AIza' + '-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      GITHUB_TOKEN: 'ghp' + '_secret',
      GH_TOKEN: 'gho' + '_secret',
      SLACK_BOT_TOKEN: 'xoxb' + '-secret',
    });

    assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'USER']);
    assert.equal(env.ORCA_BOT_TOOLS_TOKEN, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.GH_TOKEN, undefined);
  });

  test('rejects world-writable binaries and untrusted symlinks', () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-cli-test-'));
    try {
      const goodBin = path.join(tmpDir, 'orca');
      fs.writeFileSync(goodBin, '#!/bin/sh\necho ok\n');
      fs.chmodSync(goodBin, 0o755);

      // Untrusted path not in allowlist
      assert.equal(verifyTrustedBinaryPath(goodBin), null);

      // Allowed path check with explicit allowlist & prefix
      assert.equal(verifyTrustedBinaryPath(goodBin, [goodBin], [tmpDir + '/']), goodBin);

      // World-writable binary must be rejected
      fs.chmodSync(goodBin, 0o777);
      assert.equal(verifyTrustedBinaryPath(goodBin, [goodBin], [tmpDir + '/']), null);
      fs.chmodSync(goodBin, 0o755);

      // Binary or symlink target under a world-writable ancestor directory must be rejected
      const wwAncestor = path.join(tmpDir, 'ww-ancestor');
      fs.mkdirSync(wwAncestor);
      fs.chmodSync(wwAncestor, 0o777);
      const safeChildDir = path.join(wwAncestor, 'bin');
      fs.mkdirSync(safeChildDir);
      fs.chmodSync(safeChildDir, 0o755);
      const nestedBin = path.join(safeChildDir, 'orca');
      fs.writeFileSync(nestedBin, '#!/bin/sh\necho ok\n');
      fs.chmodSync(nestedBin, 0o755);
      assert.equal(verifyTrustedBinaryPath(nestedBin, [nestedBin], [tmpDir + '/']), null);

      const nestedLink = path.join(tmpDir, 'orca-ww-ancestor-link');
      fs.symlinkSync(nestedBin, nestedLink);
      assert.equal(verifyTrustedBinaryPath(nestedLink, [nestedLink], [tmpDir + '/']), null);

      // Symlink pointing outside trusted prefix must be rejected
      const outsideDir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-cli-outside-'));
      try {
        const outsideTarget = path.join(outsideDir, 'orca');
        fs.writeFileSync(outsideTarget, '#!/bin/sh\necho evil\n');
        fs.chmodSync(outsideTarget, 0o755);
        const symlinkPath = path.join(tmpDir, 'orca-link');
        fs.symlinkSync(outsideTarget, symlinkPath);
        assert.equal(verifyTrustedBinaryPath(symlinkPath, [symlinkPath], [tmpDir + '/']), null);
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('clamps timeout <= 8000ms and rejects oversized stdout > 2 MiB', async () => {
    let seenTimeout = 0;
    let seenEnvKeys: string[] = [];
    const cli = new OrcaCli({
      timeoutMs: 99_999,
      env: buildMinimalSafeEnv({ PATH: '/usr/bin', AWS_SECRET_ACCESS_KEY: 'secret' }),
      runner: async (_bin, _args, opts) => {
        seenTimeout = opts.timeoutMs;
        seenEnvKeys = Object.keys(opts.env);
        return { stdout: JSON.stringify({ ok: true, result: { bots: [] } }), stderr: '', exitCode: 0 };
      },
    });
    await cli.botList();
    assert.equal(seenTimeout, MAX_CLI_TIMEOUT_MS);
    assert.deepEqual(seenEnvKeys, ['PATH']);

    const bigCli = new OrcaCli({
      runner: async () => ({
        stdout: 'x'.repeat(MAX_CLI_OUTPUT_BYTES + 10),
        stderr: '',
        exitCode: 0,
      }),
    });
    await assert.rejects(() => bigCli.status(), (err: unknown) => {
      return err instanceof OrcaCliError && err.code === 'output_too_large';
    });
  });

  test('rejects botName containing shell metacharacters or control sequences via runner', async () => {
    const cli = new OrcaCli({
      runner: async () => ({ stdout: '{}', stderr: '', exitCode: 0 }),
    });
    await assert.rejects(() => cli.botChats('; rm -rf /'), isOrcaCliError);
    await assert.rejects(() => cli.botChats('-flag'), isOrcaCliError);
    await assert.rejects(() => cli.botItemList('bot\x00evil', false), isOrcaCliError);
  });

  test('enforces group-writable check, PATH sanitization, strict cursor validation, and concurrency cap <= 4', async () => {
    // PATH strips empty segments and relative paths
    const env = buildMinimalSafeEnv({
      PATH: '/usr/bin::.:../bin:/bin:relative/dir',
      HOME: '/Users/tester',
    });
    assert.equal(env.PATH, '/usr/bin:/bin');

    // validateCursor trims and blocks flags/spaces/disallowed chars
    assert.equal(validateCursor('  cur_123:abc  '), 'cur_123:abc');
    for (const badCursor of ['', '   ', '-flag', ' --evil', 'cur sor', 'cur;id', 'cur\n1']) {
      assert.throws(() => validateCursor(badCursor), isOrcaCliError);
    }

    // group-writable binary is rejected
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-cli-gw-test-'));
    try {
      const bin = path.join(tmpDir, 'orca');
      fs.writeFileSync(bin, '#!/bin/sh\necho ok\n');
      fs.chmodSync(bin, 0o775);
      assert.equal(verifyTrustedBinaryPath(bin, [bin], [tmpDir + '/']), null);
      fs.chmodSync(bin, 0o755);
      assert.equal(verifyTrustedBinaryPath(bin, [bin], [tmpDir + '/']), bin);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // Slot hand-off keeps activeCount <= 4 even under 12 simultaneous requests
    let currentConcurrent = 0;
    let maxObservedConcurrent = 0;
    const cli = new OrcaCli({
      runner: async () => {
        currentConcurrent++;
        if (currentConcurrent > maxObservedConcurrent) {
          maxObservedConcurrent = currentConcurrent;
        }
        await new Promise((r) => setTimeout(r, 15));
        currentConcurrent--;
        return { stdout: JSON.stringify({ ok: true, result: { bots: [] } }), stderr: '', exitCode: 0 };
      },
    });
    await Promise.all(Array.from({ length: 12 }, () => cli.botList()));
    assert.ok(maxObservedConcurrent <= 4, `Expected max 4 concurrent, saw ${maxObservedConcurrent}`);

    // Poller type guards survive malformed CLI items/page fields
    const session = new PollerSession();
    const malformedClient = {
      isStopped: () => false,
      status: async () => ({
        ok: true,
        result: { runtime: { state: 'ready', reachable: true, runtimeId: 'rt-g' } },
      }),
      botList: async () => ({
        ok: true,
        result: { bots: [{ id: 'b1', name: 'Ops Lead', agent: 'claude', paused: false }] },
      }),
      botChats: async () => ({ ok: true, result: { bot: 'Ops Lead', chats: [] } }),
      botItemList: async () => ({
        ok: true,
        result: { botId: 'b1', botName: 'Ops Lead', items: 'not-an-array' },
      }),
      worktreePs: async () => ({ ok: true, result: { worktrees: [] } }),
      orchestrationInbox: async () => ({ ok: true, result: { messages: [] } }),
      orchestrationWorkerList: async () => ({
        ok: true,
        result: { workers: [], page: { hasMore: true, nextCursor: '-bad-flag' } },
      }),
      orchestrationRunList: async () => ({ ok: true, result: { runs: [] } }),
      automationsList: async () => ({ ok: true, result: { automations: [] } }),
      automationsRuns: async () => ({ ok: true, result: { runs: [] } }),
    };
    await session.step(malformedClient, { forceFull: true });
    assert.equal(session.snapshot.runtime.connected, true);
  });
});

// Simulated Windows filesystem: keys are lowercase paths, values are realpaths.
function fakeWindowsFs(files: Record<string, string>, dirs: Record<string, string> = {}): WindowsFsProbe {
  const fileMap = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
  const dirMap = new Map(Object.entries(dirs).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    isRegularFile: (p) => {
      if (!fileMap.has(p.toLowerCase())) {
        throw new Error('ENOENT');
      }
      return true;
    },
    realpath: (p) => {
      const key = p.toLowerCase();
      const hit = fileMap.get(key) ?? dirMap.get(key);
      if (hit === undefined) {
        throw new Error('ENOENT');
      }
      return hit;
    },
  };
}

function makeTrustedTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(process.cwd(), prefix));
  fs.chmodSync(dir, 0o755);
  return dir;
}

function writeExec(file: string, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  fs.writeFileSync(file, '#!/bin/sh\necho ok\n');
  fs.chmodSync(file, mode);
}

describe('OrcaCli cross-platform CLI discovery', () => {
  const WIN_ENV = {
    LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files',
  };
  const WIN_LOCAL_EXE = 'C:\\Users\\tester\\AppData\\Local\\Programs\\Orca\\resources\\bin\\orca.exe';
  const WIN_PF_EXE = 'C:\\Program Files\\Orca\\resources\\bin\\orca.exe';
  const WIN_DIRS = {
    [WIN_ENV.LOCALAPPDATA]: WIN_ENV.LOCALAPPDATA,
    [WIN_ENV.ProgramFiles]: WIN_ENV.ProgramFiles,
  };

  test('lists platform default candidates in order', () => {
    assert.deepEqual(getDefaultOrcaCandidates({ platform: 'win32', env: WIN_ENV, homeDir: null }), [
      WIN_LOCAL_EXE,
      WIN_PF_EXE,
    ]);
    assert.deepEqual(
      getDefaultOrcaCandidates({ platform: 'win32', env: { LOCALAPPDATA: 'relative\\dir' }, homeDir: null }),
      []
    );
    assert.deepEqual(getDefaultOrcaCandidates({ platform: 'linux', env: {}, homeDir: '/home/jonas' }), [
      '/home/jonas/.config/orca/cli/bin/orca',
      '/opt/Orca/resources/bin/orca-ide',
    ]);
    assert.deepEqual(
      getDefaultOrcaCandidates({ platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' }, homeDir: '/home/jonas' }),
      ['/xdg/orca/cli/bin/orca', '/home/jonas/.config/orca/cli/bin/orca', '/opt/Orca/resources/bin/orca-ide']
    );
    assert.deepEqual(getDefaultOrcaCandidates({ platform: 'darwin', env: {}, homeDir: '/Users/x' }), [
      '/Applications/Orca.app/Contents/Resources/bin/orca',
      '/opt/homebrew/bin/orca',
      '/usr/local/bin/orca',
    ]);
  });

  test('Windows: finds orca.exe under %LOCALAPPDATA% or %ProgramFiles% (simulated)', () => {
    const local = fakeWindowsFs({ [WIN_LOCAL_EXE]: WIN_LOCAL_EXE }, WIN_DIRS);
    assert.equal(discoverOrcaBinary({ platform: 'win32', env: WIN_ENV, homeDir: null, windowsFs: local }), WIN_LOCAL_EXE);

    const pf = fakeWindowsFs({ [WIN_PF_EXE]: WIN_PF_EXE }, WIN_DIRS);
    assert.equal(discoverOrcaBinary({ platform: 'win32', env: WIN_ENV, homeDir: null, windowsFs: pf }), WIN_PF_EXE);

    // Nothing installed -> null
    assert.equal(
      discoverOrcaBinary({ platform: 'win32', env: WIN_ENV, homeDir: null, windowsFs: fakeWindowsFs({}, WIN_DIRS) }),
      null
    );
  });

  test('Windows: rejects paths outside trusted roots, non-.exe, UNC, relative, and escaping links', () => {
    const ctx = (files: Record<string, string>) => ({ env: WIN_ENV, windowsFs: fakeWindowsFs(files, WIN_DIRS) });
    const outside = 'C:\\Temp\\orca.exe';
    assert.equal(verifyWindowsBinaryPath(outside, ctx({ [outside]: outside })), null);
    assert.equal(verifyWindowsBinaryPath('C:\\Users\\tester\\AppData\\Local\\orca.bat', ctx({})), null);
    assert.equal(verifyWindowsBinaryPath('\\\\evil\\share\\orca.exe', ctx({})), null);
    assert.equal(verifyWindowsBinaryPath('orca.exe', ctx({})), null);
    assert.equal(verifyWindowsBinaryPath('C:orca.exe', ctx({})), null);
    // Junction/symlink inside LOCALAPPDATA resolving outside it is refused
    assert.equal(verifyWindowsBinaryPath(WIN_LOCAL_EXE, ctx({ [WIN_LOCAL_EXE]: outside })), null);
    // Prefix trick: C:\Program FilesEvil is not inside C:\Program Files
    const evil = 'C:\\Program FilesEvil\\Orca\\resources\\bin\\orca.exe';
    assert.equal(verifyWindowsBinaryPath(evil, ctx({ [evil]: evil })), null);
    // Case-insensitive containment
    const upper = WIN_LOCAL_EXE.toUpperCase();
    assert.equal(verifyWindowsBinaryPath(upper, ctx({ [upper]: upper })), upper);
    // .cmd is never executed; it maps to the sibling .exe
    const cmd = WIN_LOCAL_EXE.replace(/\.exe$/, '.cmd');
    assert.equal(verifyWindowsBinaryPath(cmd, ctx({ [WIN_LOCAL_EXE]: WIN_LOCAL_EXE })), WIN_LOCAL_EXE);
    assert.equal(verifyWindowsBinaryPath(cmd, ctx({ [cmd]: cmd })), null);
  });

  test('Windows: ORCA_CLI_COMMAND wins when valid and falls back when invalid', () => {
    const custom = 'D:\\Orca\\resources\\bin\\orca.exe';
    const files = { [custom]: custom, [WIN_LOCAL_EXE]: WIN_LOCAL_EXE };
    const run = (cmd: string) =>
      discoverOrcaBinary({
        platform: 'win32',
        env: { ...WIN_ENV, ORCA_CLI_COMMAND: cmd },
        homeDir: null,
        windowsFs: fakeWindowsFs(files, WIN_DIRS),
      });
    assert.equal(run(custom), custom);
    assert.equal(run('D:\\missing\\orca.exe'), WIN_LOCAL_EXE);
    assert.equal(run('orca.exe'), WIN_LOCAL_EXE);
    assert.equal(run('D:\\Orca\\resources\\bin\\orca.ps1'), WIN_LOCAL_EXE);
  });

  test('Windows env: keeps drive-absolute PATH segments and required runtime vars only', () => {
    const env = buildMinimalSafeEnv(
      {
        PATH: 'C:\\Windows\\System32;relative;\\\\server\\share;C:foo;;D:\\Tools',
        SystemRoot: 'C:\\Windows',
        LOCALAPPDATA: WIN_ENV.LOCALAPPDATA,
        APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
        USERPROFILE: 'C:\\Users\\tester',
        TEMP: 'relative-temp',
        TMP: 'C:\\Users\\tester\\AppData\\Local\\Temp',
        ORCA_USER_DATA_PATH: 'C:\\Users\\tester\\AppData\\Roaming\\orca',
        ORCA_BOT_TOOLS_TOKEN: 'secret',
        ORCA_CLI_COMMAND: WIN_LOCAL_EXE,
        GITHUB_TOKEN: 'ghp' + '_secret',
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      },
      'win32'
    );
    assert.equal(env.PATH, 'C:\\Windows\\System32;D:\\Tools');
    assert.deepEqual(Object.keys(env).sort(), [
      'APPDATA',
      'LOCALAPPDATA',
      'ORCA_USER_DATA_PATH',
      'PATH',
      'SystemRoot',
      'TMP',
      'USERPROFILE',
    ]);
  });

  test('POSIX env: Windows-only vars excluded, path vars must be absolute', () => {
    const env = buildMinimalSafeEnv(
      {
        PATH: '/usr/bin',
        SystemRoot: 'C:\\Windows',
        APPDATA: '/x',
        XDG_CONFIG_HOME: 'relative',
        ORCA_USER_DATA_PATH: '/home/jonas/.config/orca',
      },
      'linux'
    );
    assert.deepEqual(Object.keys(env).sort(), ['ORCA_USER_DATA_PATH', 'PATH']);
  });

  test('Linux: finds ~/.config/orca/cli/bin/orca (mode 700) and still refuses writable files/dirs', () => {
    const home = makeTrustedTmp('.tmp-cli-home-');
    try {
      const bin = path.join(home, '.config', 'orca', 'cli', 'bin', 'orca');
      writeExec(bin, 0o700);
      const ctx = { platform: 'linux' as const, env: {}, homeDir: home };
      assert.equal(discoverOrcaBinary(ctx), bin);

      // other-writable / group-writable / non-executable binaries are refused
      for (const mode of [0o702, 0o722, 0o720, 0o600]) {
        fs.chmodSync(bin, mode);
        assert.notEqual(discoverOrcaBinary(ctx), bin, `mode ${mode.toString(8)} must be refused`);
      }
      fs.chmodSync(bin, 0o700);

      // world-writable ancestor directory is refused
      const orcaDir = path.join(home, '.config', 'orca');
      fs.chmodSync(orcaDir, 0o777);
      assert.notEqual(discoverOrcaBinary(ctx), bin);
      fs.chmodSync(orcaDir, 0o755);

      // group-writable parent directory is refused
      const binDir = path.dirname(bin);
      fs.chmodSync(binDir, 0o775);
      assert.notEqual(discoverOrcaBinary(ctx), bin);
      fs.chmodSync(binDir, 0o755);

      // symlink escaping the trusted cli/bin dir is refused
      const outside = path.join(home, 'elsewhere', 'orca');
      writeExec(outside, 0o755);
      fs.rmSync(bin);
      fs.symlinkSync(outside, bin);
      assert.notEqual(discoverOrcaBinary(ctx), bin);
      assert.notEqual(discoverOrcaBinary(ctx), outside);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('POSIX: ORCA_CLI_COMMAND valid/invalid', () => {
    const dir = makeTrustedTmp('.tmp-cli-env-');
    try {
      const bin = path.join(dir, 'custom', 'orca');
      writeExec(bin, 0o755);
      const run = (cmd: string | undefined) =>
        discoverOrcaBinary({ platform: 'linux', env: cmd === undefined ? {} : { ORCA_CLI_COMMAND: cmd }, homeDir: dir });

      assert.equal(run(bin), bin);
      // relative and missing paths are ignored (fallback never returns them)
      assert.notEqual(run(path.relative(process.cwd(), bin)), path.relative(process.cwd(), bin));
      assert.notEqual(run(path.join(dir, 'missing', 'orca')), path.join(dir, 'missing', 'orca'));
      // directories are refused
      assert.notEqual(run(path.dirname(bin)), path.dirname(bin));
      // world-writable binary is refused even when explicitly configured
      fs.chmodSync(bin, 0o757);
      assert.notEqual(run(bin), bin);
      fs.chmodSync(bin, 0o755);
      // macOS honors ORCA_CLI_COMMAND too
      assert.equal(
        discoverOrcaBinary({ platform: 'darwin', env: { ORCA_CLI_COMMAND: bin }, homeDir: dir }),
        bin
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('OrcaCli Windows reduced worker env & diagnostics', () => {
  // Exactly the keys Orca's main process passes to a forked plugin worker on Windows.
  const WORKER_ENV = {
    PATH: 'C:\\Windows\\System32;C:\\Windows',
    USERPROFILE: 'C:\\Users\\tester',
    SystemRoot: 'C:\\Windows',
    SYSTEMDRIVE: 'C:',
    WINDIR: 'C:\\Windows',
    TEMP: 'C:\\Users\\tester\\AppData\\Local\\Temp',
    TMP: 'C:\\Users\\tester\\AppData\\Local\\Temp',
    COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    ELECTRON_RUN_AS_NODE: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  const USER_INSTALL = 'C:\\Users\\tester\\AppData\\Local\\Programs\\Orca';
  const USER_EXE = `${USER_INSTALL}\\resources\\bin\\orca.exe`;
  const MACHINE_INSTALL = 'C:\\Program Files\\Orca';
  const MACHINE_EXE = `${MACHINE_INSTALL}\\resources\\bin\\orca.exe`;

  test('finds orca.exe from process.execPath without LOCALAPPDATA/ORCA_CLI_COMMAND', () => {
    const user = discoverOrcaBinaryWithReport({
      platform: 'win32',
      env: WORKER_ENV,
      homeDir: null,
      execPath: `${USER_INSTALL}\\Orca.exe`,
      windowsFs: fakeWindowsFs({ [USER_EXE]: USER_EXE }),
    });
    assert.equal(user.path, USER_EXE);
    assert.equal(user.attempts[0].candidate, USER_EXE);

    // Machine-wide install: ProgramFiles is not in the worker env either.
    const machine = discoverOrcaBinary({
      platform: 'win32',
      env: WORKER_ENV,
      homeDir: null,
      execPath: `${MACHINE_INSTALL}\\Orca.exe`,
      windowsFs: fakeWindowsFs({ [MACHINE_EXE]: MACHINE_EXE }),
    });
    assert.equal(machine, MACHINE_EXE);
  });

  test('finds orca.exe from USERPROFILE or os.homedir() when execPath does not help', () => {
    const viaProfile = discoverOrcaBinary({
      platform: 'win32',
      env: WORKER_ENV,
      homeDir: null,
      execPath: 'D:\\tools\\node\\node.exe',
      windowsFs: fakeWindowsFs({ [USER_EXE]: USER_EXE }),
    });
    assert.equal(viaProfile, USER_EXE);

    const { USERPROFILE: _omit, ...noProfile } = WORKER_ENV;
    const viaHomedir = discoverOrcaBinary({
      platform: 'win32',
      env: noProfile,
      homeDir: 'C:\\Users\\tester',
      execPath: null,
      windowsFs: fakeWindowsFs({ [USER_EXE]: USER_EXE }),
    });
    assert.equal(viaHomedir, USER_EXE);
  });

  test('still rejects candidates whose realpath leaves the derived roots', () => {
    const report = discoverOrcaBinaryWithReport({
      platform: 'win32',
      env: WORKER_ENV,
      homeDir: null,
      execPath: 'C:\\Orca\\Orca.exe',
      windowsFs: fakeWindowsFs({
        'C:\\Orca\\resources\\bin\\orca.exe': 'D:\\evil\\orca.exe',
        [USER_EXE]: 'D:\\evil\\orca.exe',
      }),
    });
    assert.equal(report.path, null);
    assert.deepEqual(
      report.attempts.map((a) => a.result),
      ['outside_trusted_roots', 'outside_trusted_roots']
    );

    // UNC execPath is ignored entirely; nothing else installed -> not found
    const unc = discoverOrcaBinaryWithReport({
      platform: 'win32',
      env: {},
      homeDir: null,
      execPath: '\\\\server\\share\\Orca.exe',
      windowsFs: fakeWindowsFs({ '\\\\server\\share\\resources\\bin\\orca.exe': '\\\\server\\share\\resources\\bin\\orca.exe' }),
    });
    assert.equal(unc.path, null);
    assert.equal(unc.attempts.length, 0);
  });

  test('derives APPDATA/LOCALAPPDATA for the CLI only when missing', () => {
    const env = buildMinimalSafeEnv(WORKER_ENV, 'win32', null);
    assert.equal(env.APPDATA, 'C:\\Users\\tester\\AppData\\Roaming');
    assert.equal(env.LOCALAPPDATA, 'C:\\Users\\tester\\AppData\\Local');
    assert.equal(env.USERPROFILE, 'C:\\Users\\tester');
    assert.equal(env.SystemRoot, 'C:\\Windows');
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(env.COMSPEC, undefined);

    const explicit = buildMinimalSafeEnv({ ...WORKER_ENV, APPDATA: 'E:\\Roaming' }, 'win32', null);
    assert.equal(explicit.APPDATA, 'E:\\Roaming');

    const { USERPROFILE: _omit, SystemRoot: _sr, ...bare } = WORKER_ENV;
    const fromHome = buildMinimalSafeEnv(bare, 'win32', 'C:\\Users\\other');
    assert.equal(fromHome.USERPROFILE, 'C:\\Users\\other');
    assert.equal(fromHome.APPDATA, 'C:\\Users\\other\\AppData\\Roaming');
    assert.equal(fromHome.SystemRoot, 'C:\\Windows');

    // Never derived from a non-absolute home
    const relHome = buildMinimalSafeEnv({ PATH: 'C:\\Windows' }, 'win32', 'relative\\home');
    assert.equal(relHome.APPDATA, undefined);

    // Case-insensitive lookup of upper-cased keys from the forked env
    const upper = buildMinimalSafeEnv({ SYSTEMROOT: 'C:\\Windows', USERPROFILE: 'C:\\Users\\u' }, 'win32', null);
    assert.equal(upper.SystemRoot, 'C:\\Windows');
  });

  test('diagnostic line reports env presence only, never env values or secrets', () => {
    const report = discoverOrcaBinaryWithReport({
      platform: 'win32',
      env: {
        ...WORKER_ENV,
        APPDATA: 'C:\\Users\\tester\\AppData\\Roaming\\SECRET-APPDATA',
        ORCA_BOT_TOOLS_TOKEN: 'tok-SECRET',
      },
      homeDir: null,
      execPath: 'C:\\Orca\\Orca.exe',
      windowsFs: fakeWindowsFs({}),
    });
    const line = formatDiscoveryReport(report);
    assert.ok(line.includes('platform=win32'), line);
    assert.ok(line.includes('LOCALAPPDATA=unset'), line);
    assert.ok(line.includes('ProgramFiles=unset'), line);
    assert.ok(line.includes('ORCA_CLI_COMMAND=unset'), line);
    assert.ok(line.includes('USERPROFILE=set'), line);
    assert.ok(line.includes('APPDATA=set'), line);
    assert.ok(line.includes('C:\\Orca\\resources\\bin\\orca.exe -> not_found'), line);
    assert.ok(!line.includes('SECRET'), line);
  });

  test('logs spawn failures once per minute per code, truncated, without write-command content', async () => {
    const lines: string[] = [];
    let now = 1_000_000;
    setOrcaCliDiagnosticLogger((l) => lines.push(l), { now: () => now });
    try {
      const failing = async () => ({
        stdout: '',
        stderr: 'spawn EINVAL ' + 'x'.repeat(1000),
        exitCode: null,
        spawnError: { code: 'EINVAL', errno: -4071 },
      });
      const cli = new OrcaCli({ runner: failing });
      await assert.rejects(() => cli.status(), isOrcaCliError);
      await assert.rejects(() => cli.botList(), isOrcaCliError);
      assert.equal(lines.length, 1);
      assert.ok(lines[0].includes('code=EINVAL'), lines[0]);
      assert.ok(lines[0].includes('errno=-4071'), lines[0]);
      assert.ok(lines[0].length < 450, `line too long: ${lines[0].length}`);

      now += 61_000;
      await assert.rejects(() => cli.status(), isOrcaCliError);
      assert.equal(lines.length, 2);

      // Write path (Quick Send): message text and stderr never reach the log
      await assert.rejects(
        () =>
          sendQuickBotMessage('Ops Lead', 'TOP-SECRET-MESSAGE', {
            runner: async () => ({
              stdout: '',
              stderr: 'echo TOP-SECRET-MESSAGE',
              exitCode: 1,
            }),
          }),
        isOrcaCliError
      );
      assert.equal(lines.length, 3);
      assert.ok(lines[2].includes('code=exit_1'), lines[2]);
      assert.ok(!lines.some((l) => l.includes('TOP-SECRET-MESSAGE')));
    } finally {
      setOrcaCliDiagnosticLogger(null);
    }
  });
});
