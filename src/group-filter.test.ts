import { assert, describe, mockHost, mountWorker, test } from 'orca/testing';
import { listBotGroups, scopeSnapshotToGroup } from '../shared/filter.ts';
import { groupOptionLabels } from '../shared/group-select.ts';
import { applyBotChats, applyBotList, parseBotServer } from './normalize.ts';
import { type OrcaClient, assertAllowedSubcommand } from './orca-cli.ts';
import { createEmptySnapshot } from './types.ts';
import { BotWorldWorkerController, sanitizeGroupFilter } from './worker.ts';

const BOTS = [
  { id: 'h', name: 'Head', agent: 'claude', paused: false, specialty: '' },
  { id: 'q', name: 'QA', agent: 'codex', paused: false, specialty: '' },
  {
    id: 'n',
    name: 'Nexus',
    agent: 'claude',
    paused: false,
    specialty: '',
    server: { name: 'Inspirion', on: 'Inspirion' },
  },
];

const CHATS: Record<string, Array<Record<string, unknown>>> = {
  Head: [
    { id: 'home-h', title: 'Home', home: true, lastActivityAt: 10 },
    { id: 'bot-group-member-aaa', title: 'Stacx', lastActivityAt: 20 },
  ],
  QA: [{ id: 'bot-group-member-bbb', title: 'Stacx', lastActivityAt: 5 }],
  Nexus: [
    { id: 'home-n', title: 'Home', home: true, lastActivityAt: 10 },
    { id: 'bot-group-member-ccc', title: 'AutoSeller', lastActivityAt: 30 },
  ],
};

function makeClient(calls: string[]): OrcaClient {
  return {
    isStopped: () => false,
    status: async () => ({
      ok: true,
      result: { runtime: { state: 'ready', reachable: true, runtimeId: 'rt-groups' } },
    }),
    botList: async () => ({ ok: true, result: { bots: BOTS } }),
    botChats: async (name, environment) => {
      calls.push(`chats:${name}:${environment ?? 'local'}`);
      return { ok: true, result: { bot: name, chats: CHATS[name] ?? [] } };
    },
    botItemList: async (name, _all, environment) => {
      calls.push(`items:${name}:${environment ?? 'local'}`);
      return { ok: true, result: { items: [] } };
    },
    worktreePs: async () => ({ ok: true, result: { worktrees: [] } }),
    orchestrationInbox: async () => ({ ok: true, result: { messages: [] } }),
    orchestrationWorkerList: async () => ({ ok: true, result: { workers: [] } }),
    orchestrationRunList: async () => ({ ok: true, result: { runs: [] } }),
    automationsList: async () => ({ ok: true, result: { automations: [] } }),
    automationsRuns: async () => ({ ok: true, result: { runs: [] } }),
  };
}

function loadedSnapshot() {
  const snap = createEmptySnapshot();
  applyBotList(snap, { ok: true, result: { bots: BOTS } });
  for (const bot of BOTS) {
    applyBotChats(snap, { ok: true, result: { bot: bot.name, chats: CHATS[bot.name] } });
  }
  return snap;
}

function workerFor(botId: string) {
  return {
    dispatchId: `d-${botId}`,
    taskId: null,
    runId: null,
    parentBotId: botId,
    parentBotName: null,
    provider: 'claude',
    model: null,
    workerState: 'ready',
    dispatchStatus: 'dispatched',
    terminalState: null,
    terminalHandle: null,
    worktreeId: null,
    liveness: 'Live' as const,
    activity: 'working',
    toolName: null,
    taskTitle: null,
    updatedAt: null,
  };
}

describe('Bot group filter', () => {
  test('group chats become bot groups, never task titles; server comes from bot list', () => {
    const snap = loadedSnapshot();
    assert.deepEqual(snap.bots['h'].groups, ['Stacx']);
    assert.deepEqual(snap.bots['n'].groups, ['AutoSeller']);
    assert.equal(snap.bots['n'].server, 'Inspirion');
    assert.equal(snap.bots['h'].server, null);
    assert.equal(snap.bots['q'].currentTaskTitle, null);
    assert.deepEqual(listBotGroups(snap), ['AutoSeller', 'Stacx']);
    assert.equal(parseBotServer({ on: '--evil' }), null);
    assert.equal(parseBotServer('Inspirion'), null);
  });

  test('scopeSnapshotToGroup keeps only that group, its workers and items', () => {
    const snap = loadedSnapshot();
    snap.workers['w1'] = workerFor('h');
    snap.workers['w2'] = workerFor('n');
    const stacx = scopeSnapshotToGroup(snap, 'Stacx');
    assert.deepEqual(Object.keys(stacx.bots).sort(), ['h', 'q']);
    assert.deepEqual(stacx.botOrder, ['h', 'q']);
    assert.deepEqual(Object.keys(stacx.workers), ['w1']);
    assert.equal(scopeSnapshotToGroup(snap, ''), snap);
    assert.deepEqual(Object.keys(scopeSnapshotToGroup(snap, 'Nope').bots), []);
    assert.equal(Object.keys(snap.bots).length, 3, 'original snapshot untouched');
  });

  test('select options: all first, saved choice kept, Redact Mode aliases names', () => {
    const opts = groupOptionLabels(['AutoSeller', 'Stacx'], 'Old', false, 'en');
    assert.deepEqual(
      opts.map((o) => o.value),
      ['', 'AutoSeller', 'Stacx', 'Old']
    );
    const redacted = groupOptionLabels(['AutoSeller'], '', true, 'en');
    assert.equal(redacted[1].label, 'Group #1');
    assert.equal(redacted[1].value, 'AutoSeller');
  });

  test('CLI allowlist accepts --environment only on bot chats / item list, validated', () => {
    assertAllowedSubcommand([
      'bot', 'chats', '--bot', 'Nexus', '--all', '--environment', 'Inspirion', '--json',
    ]);
    assertAllowedSubcommand([
      'bot', 'item', 'list', '--bot', 'Nexus', '--environment', 'Inspirion', '--json',
    ]);
    assertAllowedSubcommand([
      'bot', 'item', 'list', '--bot', 'Nexus', '--all', '--environment', 'Inspirion', '--json',
    ]);
    assert.throws(() =>
      assertAllowedSubcommand([
        'bot', 'chats', '--bot', 'Nexus', '--all', '--environment', '-x', '--json',
      ])
    );
    assert.throws(() =>
      assertAllowedSubcommand([
        'bot', 'chats', '--bot', 'Nexus', '--all', '--environment', 'a;b', '--json',
      ])
    );
    assert.throws(() => assertAllowedSubcommand(['status', '--environment', 'Inspirion', '--json']));
    assert.equal(sanitizeGroupFilter('  Stacx '), 'Stacx');
    assert.equal(sanitizeGroupFilter('a\nb'), null);
    assert.equal(sanitizeGroupFilter(42), null);
  });

  test('worker: remote bots polled with --environment; setGroupFilter scopes and persists', async () => {
    const calls: string[] = [];
    const host = mockHost({ settings: { redactMode: false, pollIntervalSec: 5 } });
    let controller!: BotWorldWorkerController;
    const worker = await mountWorker(
      {
        default: async (orca) => {
          controller = new BotWorldWorkerController(orca, makeClient(calls));
          await controller.init({ disableAutoLoop: true });
          await controller.runPollTick(true);
        },
        deactivate: async () => controller.dispose(),
      },
      { host }
    );
    try {
      assert.ok(calls.includes('chats:Nexus:Inspirion'), calls.join(','));
      assert.ok(calls.includes('chats:Head:local'), calls.join(','));
      const all = await worker.request('botWorld.getState');
      assert.equal(all.groupFilter, '');
      assert.deepEqual(all.availableGroups, ['AutoSeller', 'Stacx']);
      assert.equal(Object.keys(all.snapshot.bots).length, 3);

      const res = await worker.request('botWorld.setGroupFilter', { group: 'AutoSeller' });
      assert.equal(res.groupFilter, 'AutoSeller');
      const scoped = await worker.request('botWorld.getState');
      assert.deepEqual(Object.keys(scoped.snapshot.bots), ['n']);
      assert.deepEqual(scoped.availableGroups, ['AutoSeller', 'Stacx']);

      await assert.rejects(
        () => worker.request('botWorld.setGroupFilter', { group: 'x\u0000' }),
        (err: unknown) => (err as { code?: string })?.code === 'invalid_params'
      );
      await worker.request('botWorld.setGroupFilter', { group: '' });
      const back = await worker.request('botWorld.getState');
      assert.equal(Object.keys(back.snapshot.bots).length, 3);
    } finally {
      await worker.deactivate();
    }
  });
});
