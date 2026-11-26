import fs from 'node:fs';
import path from 'node:path';
import { assert, describe, test } from 'orca/testing';
import { decodeBotWorldContent, encodeBotWorldContent, mergeBotWorldDocuments } from '../editor/doc-sync.ts';
import {
  THEME_CATALOG,
  deskPosition,
  getThemeConfig,
  resolveThemeAssetPath,
  resolveThemeName,
} from '../shared/assets-catalog.ts';
import { MotionDirector, ReplayController, StageLayout } from '../shared/motion.ts';
import {
  buildOfficeReport,
  formatReportMarkdown,
  renderOfficeReportModal,
} from '../shared/office-report.ts';
import { mapKeyToShortcutAction, nextThemeId } from '../shared/shortcuts.ts';
import { resolveAtmospherePhase } from '../shared/stage-renderer.ts';
import {
  type AtmosphereMode,
  DEFAULT_BOTWORLD_DOCUMENT,
  DESK_COORD_MAX_X,
  DESK_COORD_MAX_Y,
  DESK_COORD_MIN_X,
  DESK_COORD_MIN_Y,
  MAX_CUSTOM_DESK_POSITIONS,
  THEME_IDS,
  type WorldEventRecord,
  createEmptySnapshot,
  isThemeId,
  sanitizeCustomDeskPositions,
  validateBotWorldDocument,
} from './types.ts';

function makeSampleSnapshot() {
  const snap = createEmptySnapshot();
  snap.capturedAt = 1_700_050_000_000;
  snap.bots['b1'] = {
    id: 'b1',
    name: 'Ops Lead',
    agent: 'claude',
    paused: false,
    specialty: 'Triage',
    status: { kind: 'Working', tool: 'read_file' },
    currentTaskTitle: 'Secret PR #42 review',
    currentTool: 'read_file',
    lastActivityAt: 1_700_050_000_000,
    homeChatId: 'c1',
    needsYouCount: 0,
    activeWorkerCount: 1,
  };
  snap.bots['b2'] = {
    id: 'b2',
    name: 'Security',
    agent: 'claude',
    paused: false,
    specialty: 'Auth',
    status: { kind: 'NeedsOwner', count: 1, prompt: 'Approve production role?', optionsCount: 2 },
    currentTaskTitle: 'IAM secret rotation',
    currentTool: null,
    lastActivityAt: 1_700_050_000_000,
    homeChatId: 'c2',
    needsYouCount: 1,
    activeWorkerCount: 0,
  };
  snap.bots['b3'] = {
    id: 'b3',
    name: 'Cost Guard',
    agent: 'gemini',
    paused: false,
    specialty: 'FinOps',
    status: { kind: 'Idle' },
    currentTaskTitle: null,
    currentTool: null,
    lastActivityAt: 1_700_040_000_000,
    homeChatId: 'c3',
    needsYouCount: 0,
    activeWorkerCount: 0,
  };
  snap.bots['b4'] = {
    id: 'b4',
    name: 'Doc Review',
    agent: 'claude',
    paused: false,
    specialty: 'Docs',
    status: { kind: 'Idle' },
    currentTaskTitle: null,
    currentTool: null,
    lastActivityAt: 1_700_030_000_000,
    homeChatId: 'c4',
    needsYouCount: 0,
    activeWorkerCount: 0,
  };
  snap.botOrder = ['b1', 'b2', 'b3', 'b4'];
  snap.workers['w1'] = {
    dispatchId: 'w1',
    taskId: 't1',
    runId: 'r1',
    parentBotId: 'b1',
    parentBotName: 'Ops Lead',
    provider: 'claude',
    model: 'sonnet',
    workerState: 'ready',
    dispatchStatus: 'dispatched',
    terminalState: 'attached',
    terminalHandle: 'term_1',
    worktreeId: 'wt_1',
    liveness: 'Live',
    activity: 'working',
    toolName: 'read_file',
    taskTitle: 'Inspect code',
    updatedAt: 1_700_050_000_000,
  };
  return snap;
}

describe('Bot World v0.3.0 — Power User Edition features', () => {
  test('new themes (cozy_cafe, cyber_ops) pass asset allowlist, manifest, desk bounds, and overflow separation', () => {
    assert.deepEqual(THEME_IDS, ['startup_office', 'corporate_office', 'cozy_cafe', 'cyber_ops']);
    assert.equal(isThemeId('cozy_cafe'), true);
    assert.equal(isThemeId('cyber_ops'), true);
    assert.equal(isThemeId('haunted_castle'), false);

    assert.equal(resolveThemeAssetPath('cozy_cafe'), '../assets/themes/cozy_cafe/bg.jpg');
    assert.equal(resolveThemeAssetPath('cyber_ops'), '../assets/themes/cyber_ops/bg.jpg');
    assert.equal(resolveThemeAssetPath('../cozy_cafe'), '../assets/themes/startup_office/bg.jpg');

    assert.equal(resolveThemeName('cozy_cafe', 'en'), 'Cozy Cafe');
    assert.equal(resolveThemeName('cozy_cafe', 'ko'), '코지 카페');
    assert.equal(resolveThemeName('cyber_ops', 'en'), 'Cyber Ops');
    assert.equal(resolveThemeName('cyber_ops', 'ko'), '사이버 관제실');

    assert.ok(THEME_CATALOG.cozy_cafe);
    assert.ok(THEME_CATALOG.cyber_ops);

    const manifest = JSON.parse(fs.readFileSync(path.resolve('orca-plugin.json'), 'utf8')) as {
      version: string;
      contributes: { settings: Array<{ key: string; enum?: string[]; enumLabels?: string[] }> };
    };
    assert.match(manifest.version, /^1\.0\.0(-autoseller\.\d+)?$/);
    const themeSetting = manifest.contributes.settings.find((s) => s.key === 'defaultTheme');
    assert.deepEqual(themeSetting?.enum, ['startup_office', 'corporate_office', 'cozy_cafe', 'cyber_ops']);
    assert.deepEqual(themeSetting?.enumLabels, [
      'Startup Office',
      'Corporate Office',
      'Cozy Cafe',
      'Cyber Ops',
    ]);

    for (const themeId of ['cozy_cafe', 'cyber_ops'] as const) {
      assert.ok(fs.existsSync(path.resolve(`assets/themes/${themeId}/bg.jpg`)));
      const rawThemeJson = JSON.parse(
        fs.readFileSync(path.resolve(`assets/themes/${themeId}/theme.json`), 'utf8')
      ) as { id: string; background_path: string; bot_desks: unknown[] };
      assert.equal(rawThemeJson.id, themeId);
      assert.equal(rawThemeJson.background_path, `themes/${themeId}/bg.jpg`);
      assert.equal(rawThemeJson.bot_desks.length, 14);

      const theme = getThemeConfig(themeId, 'en');
      const [designW, designH] = theme.designSize;
      assert.equal(theme.botDesks.length, 14);

      const overflowPositions: Array<[number, number]> = [];
      for (let idx = 14; idx <= 35; idx++) {
        const [x, y] = deskPosition(theme, idx);
        assert.ok(
          x >= 95 && x <= designW - 95,
          `${themeId} overflow[${idx}] x=${x} out of [${95}, ${designW - 95}]`
        );
        assert.ok(
          y >= 120 && y <= designH - 72,
          `${themeId} overflow[${idx}] y=${y} out of [${120}, ${designH - 72}]`
        );
        assert.equal(
          x < 260 && y > designH - 110,
          false,
          `${themeId} overflow[${idx}] (${x}, ${y}) overlapped bottom-left HUD`
        );
        for (const desk of theme.botDesks) {
          const d = Math.hypot(x - desk.x, y - desk.y);
          assert.ok(d >= 72, `${themeId} overflow[${idx}] too close to desk[${desk.slot}]: ${d}`);
        }
        for (const lm of [theme.officeDoor, theme.bossDesk, theme.automationBoard]) {
          const d = Math.hypot(x - lm.x, y - lm.y);
          assert.ok(d >= 72, `${themeId} overflow[${idx}] too close to landmark: ${d}`);
        }
        for (const [ox, oy] of overflowPositions) {
          const d = Math.hypot(x - ox, y - oy);
          assert.ok(d >= 72, `${themeId} overflow[${idx}] too close to peer overflow: ${d}`);
        }
        overflowPositions.push([x, y]);
      }
    }
  });

  test('customDeskPositions validates keys, clamps bounds, caps at 128, preserves v1 docs, and syncs StageLayout & MotionDirector', () => {
    // 1. Prototype pollution, NaN/Infinity, clamping, and max 128 cap
    const rawMalicious: Record<string, unknown> = {
      b1: { x: 10, y: 999 },
      b2: { x: 450.25, y: 310.74 },
      b_nan: { x: Number.NaN, y: 200 },
      b_inf: { x: 200, y: Number.POSITIVE_INFINITY },
      'bad\nkey': { x: 200, y: 200 },
      b_arr: [100, 200],
    };
    Object.defineProperty(rawMalicious, '__proto__', {
      value: { x: 300, y: 300 },
      enumerable: true,
    });
    const sanitized = sanitizeCustomDeskPositions(rawMalicious);
    assert.equal(Object.hasOwn(sanitized, '__proto__'), false);
    assert.equal(Object.hasOwn(sanitized, 'b_nan'), false);
    assert.equal(Object.hasOwn(sanitized, 'b_inf'), false);
    assert.equal(Object.hasOwn(sanitized, 'bad\nkey'), false);
    assert.equal(Object.hasOwn(sanitized, 'b_arr'), false);
    assert.deepEqual(sanitized['b1'], { x: DESK_COORD_MIN_X, y: DESK_COORD_MAX_Y });
    assert.deepEqual(sanitized['b2'], { x: 450.3, y: 310.7 });

    const tooMany: Record<string, { x: number; y: number }> = {};
    for (let i = 0; i < 160; i++) {
      tooMany[`bot_${i}`] = { x: 300 + i, y: 300 };
    }
    const capped = sanitizeCustomDeskPositions(tooMany);
    assert.equal(Object.keys(capped).length, MAX_CUSTOM_DESK_POSITIONS);

    // 2. .botworld v1 backward compatibility & round-trip encode/decode/merge
    const v1Doc = JSON.stringify({
      version: 1,
      themeId: 'cozy_cafe',
      redactMode: false,
      selectedBotId: null,
      botAppearances: {},
    });
    const v1Parsed = validateBotWorldDocument(v1Doc);
    assert.equal(v1Parsed.valid, true);
    assert.equal(v1Parsed.data.themeId, 'cozy_cafe');
    assert.deepEqual(v1Parsed.data.customDeskPositions, {});

    const docWithInvalidPos = JSON.stringify({
      version: 1,
      themeId: 'cyber_ops',
      redactMode: true,
      selectedBotId: 'b1',
      botAppearances: { b1: 'security' },
      customDeskPositions: {
        b1: { x: 2000, y: 50 },
        b_bad: { x: null, y: 200 },
      },
    });
    const parsedWithPos = validateBotWorldDocument(docWithInvalidPos);
    assert.equal(parsedWithPos.valid, true);
    assert.deepEqual(parsedWithPos.data.customDeskPositions, {
      b1: { x: DESK_COORD_MAX_X, y: DESK_COORD_MIN_Y },
    });

    const merged = mergeBotWorldDocuments(
      { ...DEFAULT_BOTWORLD_DOCUMENT, customDeskPositions: { b1: { x: 200, y: 200 } } },
      { ...DEFAULT_BOTWORLD_DOCUMENT, customDeskPositions: { b1: { x: 200, y: 200 }, b2: { x: 500, y: 400 } } },
      { ...DEFAULT_BOTWORLD_DOCUMENT, customDeskPositions: { b1: { x: 333, y: 444 } } }
    );
    assert.deepEqual(merged.customDeskPositions, {
      b1: { x: 333, y: 444 },
      b2: { x: 500, y: 400 },
    });

    // Reset in mine removes b1 even if outside kept it
    const mergedReset = mergeBotWorldDocuments(
      { ...DEFAULT_BOTWORLD_DOCUMENT, customDeskPositions: { b1: { x: 200, y: 200 } } },
      { ...DEFAULT_BOTWORLD_DOCUMENT, customDeskPositions: { b1: { x: 200, y: 200 } } },
      { ...DEFAULT_BOTWORLD_DOCUMENT, customDeskPositions: {} }
    );
    assert.deepEqual(mergedReset.customDeskPositions, {});

    const encoded = encodeBotWorldContent(merged);
    const decoded = decodeBotWorldContent(encoded);
    assert.deepEqual(decoded.customDeskPositions, merged.customDeskPositions);

    // 3. StageLayout, MotionDirector, couriers, workers, and ReplayController sync with customDeskPositions
    const snap = makeSampleSnapshot();
    const theme = getThemeConfig('cozy_cafe', 'en');
    const customSeats = { b1: { x: 640, y: 420 } };
    const layout = StageLayout.fromSnapshot(snap, theme, customSeats);
    const b1Desk = layout.botDesks.get('b1');
    assert.ok(b1Desk);
    assert.equal(b1Desk.x, 640);
    assert.equal(b1Desk.y, 420);

    const w1Seat = layout.workerSeats.get('w1');
    assert.ok(w1Seat);
    assert.equal(w1Seat.x, 640 + b1Desk.workerOffset[0]);
    assert.equal(w1Seat.y, 420 + b1Desk.workerOffset[1]);

    const motion = new MotionDirector();
    motion.enqueueEvents(
      [
        {
          kind: 'Handoff',
          messageId: 'm1',
          from: { kind: 'Bot', botId: 'b1', botName: 'Ops Lead' },
          to: { kind: 'BossDesk' },
          subject: 'Handing off',
        },
      ],
      snap,
      theme,
      'en',
      customSeats
    );
    assert.equal(motion.couriers.length, 1);
    assert.deepEqual(motion.couriers[0].from, [640, 420]);

    // Resetting custom seats immediately updates MotionDirector layout
    motion.syncLayout(snap, theme, {});
    assert.equal(motion.layout.botDesks.get('b1')?.x, theme.botDesks[0].x);
    assert.equal(motion.layout.botDesks.get('b1')?.y, theme.botDesks[0].y);

    // ReplayController passes customDeskPositions through seekTo
    const replay = new ReplayController();
    replay.seekTo(
      snap.capturedAt,
      [{ timestampMs: snap.capturedAt, snapshot: snap }],
      [],
      snap,
      theme,
      'en',
      customSeats
    );
    assert.equal(replay.motion.layout.botDesks.get('b1')?.x, 640);
    assert.equal(replay.motion.layout.botDesks.get('b1')?.y, 420);
  });

  test('buildOfficeReport, formatReportMarkdown, and renderOfficeReportModal aggregate 24h KPIs and enforce redactMode', () => {
    const snap = makeSampleSnapshot();
    const nowMs = 1_700_050_000_000;
    const events: WorldEventRecord[] = [
      // Outside 24h window -> excluded
      {
        timestampMs: nowMs - 25 * 3600_000,
        summary: 'Old event',
        redactedSummary: 'Old',
        event: { kind: 'BotWorking', botId: 'b4', botName: 'Doc Review', tool: 'read_file' },
      },
      // Within 24h
      {
        timestampMs: nowMs - 5 * 3600_000,
        summary: 'Worker started',
        redactedSummary: 'Worker #1',
        event: {
          kind: 'WorkerStart',
          dispatchId: 'w1',
          parentBotId: 'b1',
          parentBotName: 'Ops Lead',
          provider: 'claude',
          taskTitle: 'TOP_SECRET_TASK_ALPHA',
        },
      },
      {
        timestampMs: nowMs - 3 * 3600_000,
        summary: 'Handoff',
        redactedSummary: 'Handoff',
        event: {
          kind: 'Handoff',
          messageId: 'm1',
          from: { kind: 'Bot', botId: 'b1', botName: 'Ops Lead' },
          to: { kind: 'Bot', botId: 'b2', botName: 'Security' },
          subject: 'TOP_SECRET_HANDOFF_SUBJECT',
        },
      },
      {
        timestampMs: nowMs - 2 * 3600_000,
        summary: 'Question',
        redactedSummary: 'Question',
        event: {
          kind: 'Question',
          messageId: 'm2',
          from: { kind: 'Bot', botId: 'b2', botName: 'Security' },
          to: { kind: 'BossDesk' },
          subject: 'TOP_SECRET_QUESTION',
        },
      },
      {
        timestampMs: nowMs - 2 * 3600_000 + 10_000,
        summary: 'Reply',
        redactedSummary: 'Reply',
        event: {
          kind: 'Reply',
          messageId: 'm3',
          from: { kind: 'BossDesk' },
          to: { kind: 'Bot', botId: 'b2', botName: 'Security' },
          subject: 'Approved secret',
        },
      },
      {
        timestampMs: nowMs - 1 * 3600_000,
        summary: 'Needs you',
        redactedSummary: 'Needs you',
        event: {
          kind: 'ItemNeedsYou',
          itemUid: 'it1',
          number: 99,
          botId: 'b2',
          botName: 'Security',
          title: 'TOP_SECRET_APPROVAL_ITEM',
          optionsCount: 2,
        },
      },
      {
        timestampMs: nowMs - 45 * 60_000,
        summary: 'Auto 1',
        redactedSummary: 'Auto done',
        event: {
          kind: 'AutomationRun',
          automationId: 'a1',
          automationName: 'Secret Cron',
          botId: 'b1',
          botName: 'Ops Lead',
          success: true,
          noReply: false,
          error: null,
        },
      },
      {
        timestampMs: nowMs - 30 * 60_000,
        summary: 'Auto 2',
        redactedSummary: 'Auto failed',
        event: {
          kind: 'AutomationRun',
          automationId: 'a2',
          automationName: 'Failing Cron',
          botId: 'b3',
          botName: 'Cost Guard',
          success: false,
          noReply: false,
          error: 'TOP_SECRET_STACK_TRACE',
        },
      },
      {
        timestampMs: nowMs - 10 * 60_000,
        summary: 'Status report',
        redactedSummary: 'Report',
        event: {
          kind: 'StatusReport',
          messageId: 'm4',
          from: { kind: 'Bot', botId: 'b1', botName: 'Ops Lead' },
          to: { kind: 'BossDesk' },
          subject: 'All done',
        },
      },
    ];

    const reportEn = buildOfficeReport(events, snap, { nowMs, redactMode: false, locale: 'en' });
    assert.equal(reportEn.windowHours, 24);
    assert.equal(reportEn.totalEvents, 8);
    assert.equal(reportEn.workerRuns, 1);
    assert.equal(reportEn.collaborations, 4); // Handoff + Question + Reply + StatusReport
    assert.equal(reportEn.automationsTotal, 2);
    assert.equal(reportEn.automationsSucceeded, 1);
    assert.equal(reportEn.automationSuccessRate, 50);
    assert.equal(reportEn.needsOwnerCount, 1);
    assert.equal(reportEn.totalBotsCount, 4);
    assert.equal(reportEn.activeBotsCount, 3); // b1, b2, b3 (b4 event was 25h ago and idle)

    // Top 3: b1 (4 events), b2 (3 events), b3 (1 event)
    assert.equal(reportEn.topBots.length, 3);
    assert.deepEqual(
      reportEn.topBots.map((b) => [b.botId, b.eventCount]),
      [
        ['b1', 4],
        ['b2', 3],
        ['b3', 1],
      ]
    );
    assert.equal(reportEn.hourlyBuckets.length, 12);
    for (let i = 1; i < reportEn.hourlyBuckets.length; i++) {
      assert.ok(reportEn.hourlyBuckets[i].hourStartMs > reportEn.hourlyBuckets[i - 1].hourStartMs);
    }
    const bucketSum = reportEn.hourlyBuckets.reduce((acc, b) => acc + b.count, 0);
    assert.equal(bucketSum, 8);

    const mdPlainEn = formatReportMarkdown(reportEn, { redactMode: false, locale: 'en' });
    assert.ok(mdPlainEn.includes('Ops Lead'));

    const reportRedactedEn = buildOfficeReport(events, snap, { nowMs, redactMode: true, locale: 'en' });
    assert.deepEqual(
      reportRedactedEn.topBots.map((b) => [b.botId, b.botName, b.eventCount]),
      [
        ['b1', 'Bot #1', 4],
        ['b2', 'Bot #2', 3],
        ['b3', 'Bot #3', 1],
      ]
    );

    const mdRedactedEn = formatReportMarkdown(reportRedactedEn, { redactMode: true, locale: 'en' });
    assert.ok(mdRedactedEn.includes('[Redacted]'));
    assert.ok(mdRedactedEn.includes('Bot #1'));
    assert.ok(mdRedactedEn.includes('Bot #2'));
    assert.ok(mdRedactedEn.includes('Bot #3'));
    assert.ok(mdRedactedEn.includes('50%'));
    assert.equal(mdRedactedEn.includes('Ops Lead'), false);
    assert.equal(mdRedactedEn.includes('Security'), false);
    assert.equal(mdRedactedEn.includes('Cost Guard'), false);
    assert.equal(mdRedactedEn.includes('Doc Review'), false);
    assert.equal(mdRedactedEn.includes('TOP_SECRET'), false);
    assert.equal(mdRedactedEn.includes('read_file'), false);

    // Defense-in-depth: passing a non-redacted report with redactMode: true never leaks real bot names
    const mdDefenseEn = formatReportMarkdown(reportEn, { redactMode: true, locale: 'en' });
    assert.equal(mdDefenseEn.includes('Ops Lead'), false);
    assert.equal(mdDefenseEn.includes('Security'), false);
    assert.equal(mdDefenseEn.includes('Cost Guard'), false);

    const reportRedactedKo = buildOfficeReport(events, snap, { nowMs, redactMode: true, locale: 'ko' });
    assert.deepEqual(
      reportRedactedKo.topBots.map((b) => [b.botId, b.botName, b.eventCount]),
      [
        ['b1', '봇 #1', 4],
        ['b2', '봇 #2', 3],
        ['b3', '봇 #3', 1],
      ]
    );

    const mdRedactedKo = formatReportMarkdown(reportRedactedKo, { redactMode: true, locale: 'ko' });
    assert.ok(mdRedactedKo.includes('[가림 모드]'));
    assert.ok(mdRedactedKo.includes('24시간 사무실 리포트'));
    assert.ok(mdRedactedKo.includes('봇 #1'));
    assert.equal(mdRedactedKo.includes('Ops Lead'), false);
    assert.equal(mdRedactedKo.includes('Security'), false);
    assert.equal(mdRedactedKo.includes('Cost Guard'), false);
    assert.equal(mdRedactedKo.includes('TOP_SECRET'), false);

    // Empty report -> automationSuccessRate is null
    const emptyReport = buildOfficeReport([], snap, { nowMs, redactMode: true, locale: 'ko' });
    assert.equal(emptyReport.totalEvents, 0);
    assert.equal(emptyReport.automationSuccessRate, null);
    assert.equal(emptyReport.topBots.length, 0);

    // renderOfficeReportModal uses safe DOM nodes without innerHTML
    const g = globalThis as Record<string, unknown>;
    const prevDoc = g.document;
    const prevNode = g.Node;
    const prevHtmlInput = g.HTMLInputElement;
    const prevHtmlImg = g.HTMLImageElement;
    class FakeNode {
      childNodes: FakeNode[] = [];
      textContent = '';
      get firstChild(): FakeNode | null {
        return this.childNodes[0] ?? null;
      }
      appendChild(child: FakeNode): FakeNode {
        this.childNodes.push(child);
        return child;
      }
      removeChild(child: FakeNode): FakeNode {
        const idx = this.childNodes.indexOf(child);
        if (idx >= 0) this.childNodes.splice(idx, 1);
        return child;
      }
      collectText(): string {
        if (this.childNodes.length === 0) return this.textContent;
        return this.childNodes.map((c) => c.collectText()).join('');
      }
    }
    class FakeElement extends FakeNode {
      className = '';
      title = '';
      classList = {
        tokens: new Set<string>(),
        toggle: (cls: string, force?: boolean) => {
          if (force === undefined) {
            if (this.classList.tokens.has(cls)) this.classList.tokens.delete(cls);
            else this.classList.tokens.add(cls);
          } else if (force) {
            this.classList.tokens.add(cls);
          } else {
            this.classList.tokens.delete(cls);
          }
        },
        contains: (cls: string) => this.classList.tokens.has(cls),
      };
      listeners = new Map<string, Array<() => void>>();
      constructor(public tagName: string) {
        super();
      }
      setAttribute(): void {}
      addEventListener(ev: string, cb: () => void): void {
        const list = this.listeners.get(ev) ?? [];
        list.push(cb);
        this.listeners.set(ev, list);
      }
      findByText(text: string): FakeElement | null {
        if (this.collectText() === text) return this;
        for (const c of this.childNodes) {
          if (c instanceof FakeElement) {
            const hit = c.findByText(text);
            if (hit) return hit;
          }
        }
        return null;
      }
    }
    g.Node = FakeNode;
    g.HTMLInputElement = FakeElement;
    g.HTMLImageElement = FakeElement;
    g.document = {
      createElement: (tag: string) => new FakeElement(tag),
      createTextNode: (text: string) => {
        const n = new FakeNode();
        n.textContent = text;
        return n;
      },
    };
    try {
      const backdrop = new FakeElement('div');
      let copiedCount = 0;
      let closedCount = 0;
      renderOfficeReportModal(backdrop as unknown as HTMLElement, {
        open: true,
        report: reportRedactedEn,
        redactMode: true,
        locale: 'en',
        copied: false,
        onCopyMarkdown: () => {
          copiedCount += 1;
        },
        onClose: () => {
          closedCount += 1;
        },
      });
      assert.equal(backdrop.classList.contains('bw-hidden'), false);
      const modalText = backdrop.collectText();
      assert.ok(modalText.includes('24h Office Digest'));
      assert.ok(modalText.includes('Redacted'));
      assert.ok(modalText.includes('Bot #1'));
      assert.ok(modalText.includes('Bot #2'));
      assert.ok(modalText.includes('Bot #3'));
      assert.equal(modalText.includes('Ops Lead'), false);
      assert.equal(modalText.includes('Security'), false);
      assert.equal(modalText.includes('Cost Guard'), false);
      assert.equal(modalText.includes('Doc Review'), false);
      assert.equal(modalText.includes('TOP_SECRET'), false);

      const copyBtn = backdrop.findByText('Copy Markdown');
      assert.ok(copyBtn);
      copyBtn.listeners.get('click')?.[0]?.();
      assert.equal(copiedCount, 1);

      const closeBtn = backdrop.findByText('✕');
      assert.ok(closeBtn);
      closeBtn.listeners.get('click')?.[0]?.();
      assert.equal(closedCount, 1);

      renderOfficeReportModal(backdrop as unknown as HTMLElement, {
        open: false,
        report: reportEn,
        redactMode: false,
        locale: 'ko',
        copied: false,
        onCopyMarkdown: () => {},
        onClose: () => {},
      });
      assert.equal(backdrop.classList.contains('bw-hidden'), true);
      assert.equal(backdrop.childNodes.length, 0);
    } finally {
      g.document = prevDoc;
      g.Node = prevNode;
      g.HTMLInputElement = prevHtmlInput;
      g.HTMLImageElement = prevHtmlImg;
    }
  });

  test('resolveAtmospherePhase falls back on invalid runtime strings, and shortcuts I & T cycle properly', () => {
    const dayTs = new Date(2026, 10, 22, 12, 0, 0).getTime();
    const nightTs = new Date(2026, 10, 22, 23, 0, 0).getTime();
    assert.equal(resolveAtmospherePhase('invalid_mode' as unknown as AtmosphereMode, dayTs), 'day');
    assert.equal(resolveAtmospherePhase('invalid_mode' as unknown as AtmosphereMode, nightTs), 'night');

    assert.equal(mapKeyToShortcutAction('i'), 'toggleReport');
    assert.equal(mapKeyToShortcutAction('I'), 'toggleReport');
    assert.equal(mapKeyToShortcutAction('t'), 'toggleTheme');

    assert.equal(nextThemeId('startup_office'), 'corporate_office');
    assert.equal(nextThemeId('corporate_office'), 'cozy_cafe');
    assert.equal(nextThemeId('cozy_cafe'), 'cyber_ops');
    assert.equal(nextThemeId('cyber_ops'), 'startup_office');
  });
});
