import fs from 'node:fs';
import path from 'node:path';
import { assert, describe, mockHost, mountWorker, test } from 'orca/testing';
import { getThemeConfig } from '../shared/assets-catalog.ts';
import { renderBotDetail } from '../shared/bot-detail-view.ts';
import {
  applyRpgActionToStore,
  applyWorldEventsToRpgStore,
  computeBotRpgProfile,
  createEmptyBotRpgStore,
  equipDeskPropInStore,
  levelForXp,
  nextLevelXpThreshold,
  sanitizeBotRpgStore,
  unlockedPropsForLevel,
  xpFloorForLevel,
} from '../shared/bot-rpg.ts';
import { createDemoOfficeSession } from '../shared/demo-office.ts';
import { MotionDirector, ReplayController } from '../shared/motion.ts';
import { buildOfficeReport, formatReportMarkdown } from '../shared/office-report.ts';
import {
  OWNER_MAX_X,
  OWNER_MAX_Y,
  OWNER_MIN_X,
  OWNER_MIN_Y,
  OwnerAvatarController,
} from '../shared/owner-avatar.ts';
import { QuickSendBar } from '../shared/quick-send.ts';
import {
  mapKeyToShortcutAction,
  renderShortcutsModal,
  shouldIgnoreShortcutEvent,
} from '../shared/shortcuts.ts';
import { DesktopNotificationManager } from './desktop-notify.ts';
import type { OrcaClient } from './orca-cli.ts';
import { type BotRpgStore, MAX_RPG_PROFILES, type WorldSnapshot, createEmptySnapshot } from './types.ts';
import { BotWorldWorkerController } from './worker.ts';

function makeSnapshot(nowMs = 1_700_080_000_000): WorldSnapshot {
  const snap = createEmptySnapshot();
  snap.capturedAt = nowMs;
  snap.initialSyncComplete = true;
  snap.runtime.connected = true;
  snap.runtime.reachable = true;
  snap.bots['bot-1'] = {
    id: 'bot-1',
    name: 'Ops Lead',
    agent: 'claude',
    paused: false,
    specialty: 'Triage',
    status: { kind: 'Working', tool: 'read_file' },
    currentTaskTitle: 'Triage PRs',
    currentTool: 'read_file',
    lastActivityAt: nowMs - 2_000,
    homeChatId: 'chat-1',
    needsYouCount: 0,
    activeWorkerCount: 0,
  };
  snap.bots['bot-2'] = {
    id: 'bot-2',
    name: 'Security',
    agent: 'claude',
    paused: false,
    specialty: 'Auth',
    status: { kind: 'Idle' },
    currentTaskTitle: null,
    currentTool: null,
    lastActivityAt: nowMs - 20_000,
    homeChatId: 'chat-2',
    needsYouCount: 0,
    activeWorkerCount: 0,
  };
  snap.bots['bot-3'] = {
    id: 'bot-3',
    name: 'Cost Guard',
    agent: 'gemini',
    paused: false,
    specialty: 'FinOps',
    status: { kind: 'Idle' },
    currentTaskTitle: null,
    currentTool: null,
    lastActivityAt: nowMs - 30_000,
    homeChatId: 'chat-3',
    needsYouCount: 0,
    activeWorkerCount: 0,
  };
  snap.botOrder = ['bot-1', 'bot-2', 'bot-3'];
  return snap;
}

function makeMockClient(getSnap: () => WorldSnapshot): OrcaClient {
  return {
    isStopped: () => false,
    status: async () => ({
      ok: true,
      result: { runtime: { state: 'ready', reachable: true, runtimeId: 'rt-rpg' } },
    }),
    botList: async () => {
      const snap = getSnap();
      return {
        ok: true,
        result: {
          bots: Object.values(snap.bots).map((b) => ({
            id: b.id,
            name: b.name,
            agent: b.agent,
            paused: b.paused,
            specialty: b.specialty,
          })),
        },
      };
    },
    botChats: async () => ({ ok: true, result: { chats: [] } }),
    botItemList: async ({ bot }) => {
      const snap = getSnap();
      const items = Object.values(snap.items)
        .filter((it) => it.ownerBotId === bot || it.ownerBotName === bot)
        .map((it) => ({
          uid: it.uid,
          number: it.number,
          title: it.title,
          status: it.status,
          version: it.version,
          questionPrompt: it.questionPrompt ?? undefined,
          optionsCount: it.optionsCount,
        }));
      return { ok: true, result: { items } };
    },
    worktreePs: async () => {
      const snap = getSnap();
      const worktrees = Object.values(snap.bots).map((b, idx) => ({
        worktreeId: `wt-${idx}`,
        bot: b.name,
        botHome: true,
        agents: [
          {
            address: b.homeChatId ? `orca_session_id:${b.homeChatId}` : `bot:${b.id}`,
            paneKey: `pane-${b.id}`,
            state: b.status.kind === 'Working' ? 'working' : b.status.kind === 'Error' ? 'error' : 'idle',
            toolName: b.currentTool ?? undefined,
            taskTitle: b.currentTaskTitle ?? undefined,
            error: b.status.kind === 'Error' ? (b.status.message ?? undefined) : undefined,
          },
        ],
      }));
      return { ok: true, result: { worktrees } };
    },
    orchestrationInbox: async () => ({ ok: true, result: { messages: [] } }),
    orchestrationWorkerList: async () => ({ ok: true, result: { workers: [] } }),
    orchestrationRunList: async () => ({ ok: true, result: { runs: [] } }),
    automationsList: async () => ({ ok: true, result: { automations: [] } }),
    automationsRuns: async () => ({ ok: true, result: { runs: [] } }),
  };
}

function withFakeDom<T>(fn: (g: Record<string, unknown>) => T): T {
  const g = globalThis as unknown as Record<string, unknown>;
  const prevDoc = g.document;
  const prevNode = g.Node;
  const prevInput = g.HTMLInputElement;
  const prevImg = g.HTMLImageElement;
  const prevOpt = g.HTMLOptionElement;
  class FakeNode {
    tag: string;
    textContent = '';
    children: FakeNode[] = [];
    firstChild: FakeNode | null = null;
    constructor(tag = '') {
      this.tag = tag;
    }
    appendChild(c: FakeNode): FakeNode {
      this.children.push(c);
      this.firstChild = this.children[0] ?? null;
      return c;
    }
    removeChild(c: FakeNode): FakeNode {
      this.children = this.children.filter((x) => x !== c);
      this.firstChild = this.children[0] ?? null;
      return c;
    }
  }
  class FakeElement extends FakeNode {
    className = '';
    title = '';
    disabled = false;
    type = '';
    value = '';
    placeholder = '';
    maxLength = 500;
    attrs: Record<string, string> = {};
    listeners: Record<string, Array<(ev?: unknown) => void>> = {};
    classList = {
      toggle: () => {},
      add: () => {},
      remove: () => {},
    };
    setAttribute(k: string, v: string): void {
      this.attrs[k] = v;
    }
    addEventListener(ev: string, fn: (ev?: unknown) => void): void {
      this.listeners[ev] = this.listeners[ev] ?? [];
      this.listeners[ev].push(fn);
    }
    blur(): void {}
    focus(): void {}
  }
  class FakeHtmlInput extends FakeElement {}
  class FakeHtmlImage extends FakeElement {
    src = '';
    alt = '';
  }
  class FakeHtmlOption extends FakeElement {
    selected = false;
  }

  g.Node = FakeNode;
  g.HTMLInputElement = FakeHtmlInput;
  g.HTMLImageElement = FakeHtmlImage;
  g.HTMLOptionElement = FakeHtmlOption;
  g.document = {
    createElement: (tag: string) =>
      tag === 'img'
        ? new FakeHtmlImage(tag)
        : tag === 'input'
          ? new FakeHtmlInput(tag)
          : tag === 'option'
            ? new FakeHtmlOption(tag)
            : new FakeElement(tag),
    createTextNode: (text: string) => {
      const n = new FakeNode('#text');
      n.textContent = text;
      return n;
    },
  };
  try {
    return fn(g);
  } finally {
    g.document = prevDoc;
    g.Node = prevNode;
    g.HTMLInputElement = prevInput;
    g.HTMLImageElement = prevImg;
    g.HTMLOptionElement = prevOpt;
  }
}

describe('Bot World v0.8.0 — Bot RPG, Desk Props, Owner Roaming, Banter & Desktop Alerts', () => {
  test('manifest declares v0.8.0, notifications:show capability, opt-in defaults, and <=6 screenshots', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve('orca-plugin.json'), 'utf8')) as {
      version: string;
      capabilities: Array<{ kind: string }>;
      screenshots: unknown[];
      contributes: { settings: Array<{ key: string; default: unknown }> };
    };
    assert.match(manifest.version, /^1\.0\.0(-autoseller\.\d+)?$/);
    assert.ok(manifest.capabilities.some((c) => c.kind === 'notifications:show'));
    assert.ok(manifest.screenshots.length <= 6);
    const quickSendSetting = manifest.contributes.settings.find((s) => s.key === 'allowQuickSend');
    const notifySetting = manifest.contributes.settings.find((s) => s.key === 'desktopNotifications');
    assert.equal(quickSendSetting?.default, false);
    assert.equal(notifySetting?.default, false);
  });

  test('shared/bot-rpg.ts computes levels, unlocks props, validates equip, strips PII, and caps at 256 profiles', () => {
    assert.equal(levelForXp(0), 1);
    assert.equal(levelForXp(39), 1);
    assert.equal(levelForXp(40), 2);
    assert.equal(levelForXp(100), 3);
    assert.equal(levelForXp(190), 4);
    assert.equal(levelForXp(320), 5);
    assert.equal(levelForXp(500), 6);
    assert.equal(levelForXp(750), 7);
    assert.equal(xpFloorForLevel(1), 0);
    assert.equal(xpFloorForLevel(6), 500);
    assert.equal(nextLevelXpThreshold(1), 40);
    assert.equal(nextLevelXpThreshold(6), 750);

    assert.deepEqual(unlockedPropsForLevel(1), ['rubber_duck']);
    assert.deepEqual(unlockedPropsForLevel(6), [
      'rubber_duck',
      'mini_plant',
      'mech_keyboard',
      'dual_monitor',
      'cat_plush',
      'gold_trophy',
    ]);

    // Auto-showcase highest unlocked prop at xp >= 40 if unset, while explicit 'none' pins hidden
    assert.equal(computeBotRpgProfile('b1', { xp: 10 }).equippedProp, 'none');
    assert.equal(computeBotRpgProfile('b1', { xp: 40 }).equippedProp, 'mini_plant');
    assert.equal(computeBotRpgProfile('b1', { xp: 40, equippedProp: 'none' }).equippedProp, 'none');

    // Equip validation
    const store = createEmptyBotRpgStore(1000);
    const lockedRes = equipDeskPropInStore(store, 'b1', 'gold_trophy', 1001);
    assert.equal(lockedRes.ok, false);
    assert.equal(lockedRes.reason, 'prop_locked');

    const duckRes = equipDeskPropInStore(store, 'b1', 'rubber_duck', 1002);
    assert.equal(duckRes.ok, true);
    assert.equal(duckRes.profile.equippedProp, 'rubber_duck');

    // Event XP awards + dedupe
    const seen = new Set<string>();
    const evRes = applyWorldEventsToRpgStore(
      store,
      [
        { kind: 'ItemDone', itemUid: 'i1', number: 1, botId: 'b1', botName: 'Secret Name', title: 'Secret' },
        { kind: 'ItemDone', itemUid: 'i1', number: 1, botId: 'b1', botName: 'Secret Name', title: 'Secret' }, // dup
        { kind: 'WorkerStart', dispatchId: 'd1', parentBotId: 'b1', parentBotName: 'Secret', provider: 'codex', taskTitle: null },
        { kind: 'BotWorking', botId: 'b1', botName: 'Secret', tool: 'read_file' },
      ],
      seen,
      2000
    );
    assert.equal(evRes.changed, true);
    assert.equal(store.profiles['b1'].xp, 40); // 25 + 10 + 5 (duplicate ItemDone ignored)
    assert.equal(store.profiles['b1'].completions, 1);
    assert.equal(store.profiles['b1'].delegations, 1);

    // Storage sanitizer strips PII / dangerous keys & caps at 256
    const dirty: Record<string, unknown> = {
      version: 1,
      updatedAtMs: 5000,
      profiles: {
        __proto__: { xp: 999 },
        'bad\nkey': { xp: 100 },
        b1: {
          xp: 120,
          completions: 2,
          delegations: 1,
          headpats: 0,
          highFives: 0,
          coffees: 0,
          equippedProp: 'mech_keyboard',
          botName: 'LEAKED_NAME',
          taskTitle: 'LEAKED_TASK',
        },
      },
    };
    for (let i = 0; i < 300; i++) {
      (dirty.profiles as Record<string, unknown>)[`bot-${i}`] = { xp: i };
    }
    const cleanStore: BotRpgStore = sanitizeBotRpgStore(dirty, 5000);
    assert.equal(Object.keys(cleanStore.profiles).length, MAX_RPG_PROFILES);
    assert.equal(Object.hasOwn(cleanStore.profiles, '__proto__'), false);
    assert.equal(Object.hasOwn(cleanStore.profiles, 'bad\nkey'), false);
    assert.equal(
      Object.hasOwn(cleanStore.profiles['b1'] as unknown as Record<string, unknown>, 'botName'),
      false
    );
    assert.equal(
      Object.hasOwn(cleanStore.profiles['b1'] as unknown as Record<string, unknown>, 'taskTitle'),
      false
    );
  });

  test('OwnerAvatarController clamps bounds, moves via WASD/Arrows & floor target, detects proximity, enforces cooldowns, and suppresses shortcuts in inputs/modals', () => {
    const owner = new OwnerAvatarController();
    owner.setRoaming(true, [0.5, 0.5]);
    assert.equal(owner.roaming, true);

    // Clamp top-left & bottom-right
    owner.walkToNormalized(-1, -1);
    for (let i = 0; i < 40; i++) owner.step(0.25);
    assert.equal(owner.x, OWNER_MIN_X);
    assert.equal(owner.y, OWNER_MIN_Y);

    owner.walkToNormalized(2, 2);
    for (let i = 0; i < 40; i++) owner.step(0.25);
    assert.equal(owner.x, OWNER_MAX_X);
    assert.equal(owner.y, OWNER_MAX_Y);

    // WASD movement
    owner.x = 0.5;
    owner.y = 0.5;
    assert.equal(owner.setMoveKey('a', true), true);
    owner.step(0.2);
    assert.ok(owner.x < 0.5);
    assert.equal(owner.facing, 'Left');
    owner.setMoveKey('a', false);

    // Proximity detection
    const snap = makeSnapshot();
    const botPositions = new Map<string, [number, number]>([
      ['bot-1', [0.46, 0.5]],
      ['bot-2', [0.85, 0.85]],
    ]);
    const near = owner.findNearbyBot(snap, botPositions);
    assert.ok(near !== null && near.botId === 'bot-1');

    // Cooldown per-bot per-action (3000ms)
    assert.equal(owner.canInteract('bot-1', 'high_five', 10_000), true);
    owner.recordInteraction('bot-1', 'high_five', 10_000);
    assert.equal(owner.canInteract('bot-1', 'high_five', 11_000), false);
    assert.equal(owner.canInteract('bot-1', 'coffee', 11_000), true);
    assert.equal(owner.canInteract('bot-1', 'high_five', 13_000), true);

    // Shortcut mapping & input/modal suppression
    assert.equal(mapKeyToShortcutAction('v'), 'toggleRoam');
    assert.equal(mapKeyToShortcutAction('h'), 'highFiveNearby');
    assert.equal(mapKeyToShortcutAction('k'), 'handCoffeeNearby');
    assert.equal(mapKeyToShortcutAction('v', { modalOpen: true }), null);
    assert.equal(mapKeyToShortcutAction('h', { modalOpen: true }), null);
    assert.equal(mapKeyToShortcutAction('k', { modalOpen: true }), null);
    assert.equal(
      shouldIgnoreShortcutEvent({ key: 'w', target: { tagName: 'INPUT' } as unknown as EventTarget }),
      true
    );
    assert.equal(
      shouldIgnoreShortcutEvent({ key: 'h', target: { tagName: 'TEXTAREA' } as unknown as EventTarget }),
      true
    );
    assert.equal(
      shouldIgnoreShortcutEvent({ key: 'v' }, { modalOpen: true }),
      true
    );

    withFakeDom(() => {
      const modalEl = document.createElement('div');
      renderShortcutsModal(modalEl, { open: true, locale: 'en', isEditor: true, onClose: () => {} });
      const collect = (n: unknown): string => {
        const node = n as { children?: unknown[]; textContent?: string };
        if (!node.children || node.children.length === 0) return node.textContent ?? '';
        return node.children.map(collect).join(' ');
      };
      const text = collect(modalEl);
      assert.ok(text.includes('Toggle Owner Roaming mode'));
      assert.ok(text.includes('High-Five nearby bot'));
      assert.ok(text.includes('Hand coffee to nearby bot'));
    });
  });

  test('Watercooler banter requires 2+ idle bots, respects MAX_BUBBLES, clears on clearTransients, suppresses in Replay, and stays Redact-safe', () => {
    const theme = getThemeConfig('startup_office', 'en');
    const motion = new MotionDirector();

    // Only 1 idle bot -> never triggers banter
    const oneIdle = makeSnapshot();
    oneIdle.bots['bot-3'].status = { kind: 'Working', tool: 'read_file' };
    motion.syncLayout(oneIdle, theme);
    for (let i = 0; i < 120; i++) {
      motion.step(0.25, oneIdle, theme);
    }
    assert.equal(motion.bubbles.length, 0);

    // 2+ idle bots -> triggers Line A after ~14s, then Line B 1.6s later
    const twoIdle = makeSnapshot();
    motion.clearTransients();
    for (let i = 0; i < 58; i++) {
      motion.step(0.25, twoIdle, theme);
    }
    assert.equal(motion.bubbles.length, 1);
    assert.ok(motion.bubbles[0].normalText.startsWith('💬 '));
    assert.equal(motion.bubbles[0].normalText, motion.bubbles[0].redactedText);

    // Advance 1.8s -> Line B arrives
    for (let i = 0; i < 9; i++) {
      motion.step(0.2, twoIdle, theme);
    }
    assert.equal(motion.bubbles.length, 2);
    assert.ok(motion.bubbles[1].normalText.startsWith('💬 '));

    // Locale switch re-localizes active banter bubbles
    motion.setLocale('ko');
    assert.ok(motion.bubbles[0].normalText.startsWith('💬 '));

    // clearTransients removes active banter & pending reply
    motion.clearTransients();
    assert.equal(motion.bubbles.length, 0);

    // ReplayController suppresses banter
    const replay = new ReplayController();
    assert.equal(replay.motion.banterEnabled, false);
  });

  test('DesktopNotificationManager enforces opt-in, initial-sync suppression, state transitions, 60s cooldown, strictObject payload, and Redact compliance', async () => {
    const prev = makeSnapshot(1000);
    const next = makeSnapshot(2000);
    next.bots['bot-1'].status = {
      kind: 'NeedsOwner',
      count: 1,
      prompt: 'Approve AKIAIOSFODNN7EXAMPLE secret rotation?',
      optionsCount: 2,
    };
    next.bots['bot-2'].status = {
      kind: 'Error',
      message: 'Failed for alice@example.com',
    };

    const calls: Array<{ method: string; params: unknown }> = [];
    const fakeOrca = {
      host: {
        has: (m: string) => m === 'notifications.show',
        call: async (m: string, params: unknown) => {
          calls.push({ method: m, params });
          return { delivered: true };
        },
      },
      log: () => {},
    } as unknown as Parameters<DesktopNotificationManager['evaluateAndNotify']>[0]['orca'];

    const mgr = new DesktopNotificationManager({ cooldownMs: 60_000 });

    // 1. Disabled by default -> no calls
    const resDisabled = await mgr.evaluateAndNotify({
      prevSnapshot: prev,
      nextSnapshot: next,
      enabled: false,
      redactMode: false,
      locale: 'en',
      nowMs: 10_000,
      orca: fakeOrca,
    });
    assert.equal(resDisabled.sent.length, 0);
    assert.equal(calls.length, 0);

    // 2. Initial sync suppressed
    const emptyPrev = createEmptySnapshot();
    const resInit = await mgr.evaluateAndNotify({
      prevSnapshot: emptyPrev,
      nextSnapshot: next,
      enabled: true,
      redactMode: false,
      locale: 'en',
      nowMs: 10_000,
      orca: fakeOrca,
    });
    assert.equal(resInit.sent.length, 0);
    assert.equal(calls.length, 0);

    // 3. Redact Mode ON -> completely hides real bot names, prompts, and emails
    const resRedact = await mgr.evaluateAndNotify({
      prevSnapshot: prev,
      nextSnapshot: next,
      enabled: true,
      redactMode: true,
      locale: 'en',
      nowMs: 10_000,
      orca: fakeOrca,
    });
    assert.equal(resRedact.sent.length, 2);
    assert.equal(calls.length, 2);
    for (const c of calls) {
      assert.equal(c.method, 'notifications.show');
      const p = c.params as Record<string, unknown>;
      assert.deepEqual(Object.keys(p).sort(), ['body', 'title']);
      assert.ok(String(p.title).length >= 1 && String(p.title).length <= 120);
      assert.ok(!String(p.title).includes('Ops Lead'));
      assert.ok(!String(p.title).includes('Security'));
      assert.ok(!String(p.body).includes('AKIA'));
      assert.ok(!String(p.body).includes('alice@example.com'));
    }

    // 4. Cooldown blocks immediate repeat within 60s
    const resCooldown = await mgr.evaluateAndNotify({
      prevSnapshot: prev,
      nextSnapshot: next,
      enabled: true,
      redactMode: false,
      locale: 'en',
      nowMs: 30_000,
      orca: fakeOrca,
    });
    assert.equal(resCooldown.sent.length, 0);

    // 5. After 60s with redactMode: false -> scrubs secrets while keeping <= 120 title
    const resNormal = await mgr.evaluateAndNotify({
      prevSnapshot: prev,
      nextSnapshot: next,
      enabled: true,
      redactMode: false,
      locale: 'ko',
      nowMs: 75_000,
      orca: fakeOrca,
    });
    assert.equal(resNormal.sent.length, 2);
    assert.ok(!resNormal.sent[0].body.includes('AKIAIOSFODNN7EXAMPLE'));
    assert.ok(!resNormal.sent[1].body.includes('alice@example.com'));

    // 6. Missing capability & host refusal never throw
    const noCapOrca = {
      host: { has: () => false, call: async () => ({}) },
      log: () => {},
    } as unknown as typeof fakeOrca;
    const resNoCap = await mgr.evaluateAndNotify({
      prevSnapshot: prev,
      nextSnapshot: next,
      enabled: true,
      redactMode: true,
      locale: 'en',
      nowMs: 200_000,
      orca: noCapOrca,
    });
    assert.equal(resNoCap.sent.length, 0);

    const errOrca = {
      host: {
        has: () => true,
        call: async () => {
          throw new Error('denied');
        },
      },
      log: () => {},
    } as unknown as typeof fakeOrca;
    const resErr = await mgr.evaluateAndNotify({
      prevSnapshot: prev,
      nextSnapshot: next,
      enabled: true,
      redactMode: true,
      locale: 'en',
      nowMs: 200_000,
      orca: errOrca,
    });
    assert.equal(resErr.sent.length, 0);
  });

  test('Worker RPG RPCs, QuickSend race guard, and v0.7.0 audit polish checks work end-to-end', async () => {
    let snap = makeSnapshot(1000);
    snap.bots['bot-1'].name = 'Ops Lead alice@example.com';
    const client = makeMockClient(() => snap);
    let clockMs = 10_000;
    const host = mockHost({
      settings: {
        defaultTheme: 'startup_office',
        redactMode: false,
        pollIntervalSec: 5,
        allowQuickSend: false,
        desktopNotifications: false,
      },
      results: {
        'notifications.show': { delivered: true },
      },
    });

    let controller!: BotWorldWorkerController;
    let workerOrca!: Parameters<NonNullable<typeof import('./worker.ts').default>>[0];
    const worker = await mountWorker(
      {
        default: async (orca) => {
          workerOrca = orca;
          controller = new BotWorldWorkerController(orca, client, {
            nowMs: () => clockMs,
            quickSend: async () => ({ ok: true, result: { sent: true } }),
          });
          await controller.init({ disableAutoLoop: true });
          await controller.runPollTick(true);
        },
        deactivate: async () => controller.dispose(),
      },
      { host }
    );

    try {
      // Unknown bot rejected for awardRpgXp
      const unkRes = await worker.request('botWorld.awardRpgXp', {
        botId: 'no-such-bot',
        action: 'headpat',
      });
      assert.equal(unkRes.ok, false);
      assert.equal(unkRes.reason, 'unknown_bot');

      // Invalid action rejected
      await assert.rejects(
        () => worker.request('botWorld.awardRpgXp', { botId: 'bot-1', action: 'cheat' as 'headpat' }),
        (err: unknown) => (err as { code?: string })?.code === 'invalid_params'
      );

      // Valid XP award + persistence + 3s cooldown
      const hp1 = await worker.request('botWorld.awardRpgXp', { botId: 'bot-1', action: 'headpat' });
      assert.equal(hp1.ok, true);
      assert.equal(hp1.xpAwarded, 5);
      assert.equal(hp1.profile?.xp, 5);

      const hpCooldown = await worker.request('botWorld.awardRpgXp', { botId: 'bot-1', action: 'headpat' });
      assert.equal(hpCooldown.ok, false);
      assert.equal(hpCooldown.reason, 'cooldown');

      clockMs += 3_100;
      const coffee1 = await worker.request('botWorld.awardRpgXp', { botId: 'bot-1', action: 'coffee' });
      assert.equal(coffee1.ok, true);
      assert.equal(coffee1.profile?.xp, 15);

      // Locked prop rejected, unlocked prop equipped
      const lockedEquip = await worker.request('botWorld.equipDeskProp', {
        botId: 'bot-1',
        propId: 'gold_trophy',
      });
      assert.equal(lockedEquip.ok, false);
      assert.equal(lockedEquip.reason, 'prop_locked');

      const duckEquip = await worker.request('botWorld.equipDeskProp', {
        botId: 'bot-1',
        propId: 'rubber_duck',
      });
      assert.equal(duckEquip.ok, true);
      assert.equal(duckEquip.profile?.equippedProp, 'rubber_duck');

      // Storage contains ZERO PII
      const storedRpg = await workerOrca.storage.get('botWorld.rpg.v1');
      assert.ok(storedRpg !== undefined);
      const rawJson = JSON.stringify(storedRpg);
      assert.ok(!rawJson.includes('alice@example.com'));
      assert.ok(!rawJson.includes('Ops Lead'));

      // QuickSend awaits settingsUpdateQueue & scrubs returned botName
      await workerOrca.settings.set('allowQuickSend', true);
      const qsRes = await worker.request('botWorld.sendQuickMessage', {
        botId: 'bot-1',
        message: 'Check status',
      });
      assert.equal(qsRes.ok, true);
      if (qsRes.ok) {
        assert.ok(!qsRes.botName.includes('alice@example.com'));
      }
    } finally {
      await worker.deactivate();
    }

    // v0.7.0 Audit Polish: QuickSendBar IME guard & MotionDirector localized redacted bubble + scrubAll
    withFakeDom(() => {
      const sent: Array<{ botId: string; msg: string }> = [];
      const bar = new QuickSendBar({
        onSend: (botId, msg) => sent.push({ botId, msg }),
      });
      bar.update({
        snapshot: makeSnapshot(),
        selectedBotId: 'bot-1',
        redactMode: false,
        allowQuickSend: true,
        demoMode: false,
        locale: 'ko',
        sending: false,
      });
      bar.input.value = '한글';
      const fakeInput = bar.input as unknown as { listeners: Record<string, Array<(ev: unknown) => void>> };
      fakeInput.listeners['keydown']?.[0]?.({
        key: 'Enter',
        shiftKey: false,
        isComposing: true,
        keyCode: 229,
        preventDefault: () => {},
      });
      assert.equal(sent.length, 0);

      fakeInput.listeners['keydown']?.[0]?.({
        key: 'Enter',
        shiftKey: false,
        isComposing: false,
        keyCode: 13,
        preventDefault: () => {},
      });
      assert.equal(sent.length, 1);
    });

    const motion = new MotionDirector();
    const theme = getThemeConfig('startup_office', 'ko');
    const koSnap = makeSnapshot();
    motion.launchQuickMessageCourier(
      'bot-1',
      koSnap,
      theme,
      'Check alice@example.com',
      false,
      undefined,
      'ko'
    );
    assert.ok(!motion.bubbles[0].normalText.includes('alice@example.com'));
    assert.equal(motion.bubbles[0].redactedText, '✉ 빠른 메시지');

    // Demo RPG + Detail + Office Report Redact check
    const demo = createDemoOfficeSession(1_700_090_000_000);
    const demoPayload = demo.getPayload({
      themeId: 'startup_office',
      redactMode: true,
      locale: 'en',
      languageSetting: 'en',
      botAppearances: {},
    });
    assert.ok(demoPayload.rpgProfiles?.['demo-ops-lead']?.equippedProp === 'gold_trophy');
    assert.ok(demoPayload.rpgProfiles?.['demo-security']?.equippedProp === 'cat_plush');

    const report = buildOfficeReport(demoPayload.events, demoPayload.snapshot, {
      redactMode: true,
      locale: 'en',
      rpgProfiles: demoPayload.rpgProfiles,
    });
    assert.ok((report.topRpgBots?.length ?? 0) > 0);
    const md = formatReportMarkdown(report, { redactMode: true, locale: 'en' });
    assert.ok(md.includes('Bot Growth & Levels'));
    assert.ok(!md.includes('Ops Lead'));

    withFakeDom(() => {
      const detailRoot = document.createElement('div');
      renderBotDetail(detailRoot, {
        snapshot: demoPayload.snapshot,
        bot: demoPayload.snapshot.bots['demo-ops-lead'],
        redactMode: true,
        botAppearances: {},
        locale: 'en',
        rpgProfile: demoPayload.rpgProfiles?.['demo-ops-lead'] ?? null,
        onSelectCharacter: () => {},
      });
      const collect = (n: unknown): string => {
        const node = n as { children?: unknown[]; textContent?: string };
        if (!node.children || node.children.length === 0) return node.textContent ?? '';
        return node.children.map(collect).join(' ');
      };
      const detailText = collect(detailRoot);
      assert.ok(detailText.includes('Bot Level & Desk Prop'));
      assert.ok(detailText.includes('Lv.6 · Archmage'));
      assert.ok(!detailText.includes('Triage incoming PR reviews'));
    });

    // Verify applyRpgActionToStore standalone cooldown
    const standalone = createEmptyBotRpgStore(100);
    const cds = new Map<string, number>();
    assert.equal(applyRpgActionToStore(standalone, 'b1', 'high_five', 1000, cds).xpAwarded, 8);
    assert.equal(applyRpgActionToStore(standalone, 'b1', 'high_five', 2000, cds).ok, false);
    assert.equal(applyRpgActionToStore(standalone, 'b1', 'high_five', 4500, cds).xpAwarded, 8);
  });
});
