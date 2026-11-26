import fs from 'node:fs';
import path from 'node:path';
import { assert, describe, mockHost, mountWorker, test } from 'orca/testing';
import { MotionDirector } from '../shared/motion.ts';
import { getThemeConfig } from '../shared/assets-catalog.ts';
import {
  PET_THROTTLE_ACTIVE_MS,
  PET_THROTTLE_IDLE_MS,
  PET_THROTTLE_RESTING_MS,
  PetTerrariumRenderer,
  resolvePetThrottleIntervalMs,
} from '../shared/pet-terrarium.ts';
import { StageRenderer } from '../shared/stage-renderer.ts';
import {
  type ToolbarSyncState,
  createToolbarChrome,
  syncToolbarChrome,
  watchDocumentVisibility,
} from '../shared/toolbar-chrome.ts';
import { type OrcaClient, OrcaCliError } from './orca-cli.ts';
import {
  FAST_INTERVAL_MS,
  INACTIVE_FAST_INTERVAL_MS,
  PollerSession,
  computeSnapshotFingerprint,
} from './poller.ts';
import { createEmptySnapshot } from './types.ts';
import { BotWorldWorkerController } from './worker.ts';

class LocalFakeNode {
  nodeName: string;
  _textContent: string | null = '';
  children: LocalFakeNode[] = [];
  parentNode: LocalFakeNode | null = null;
  constructor(name: string) {
    this.nodeName = name;
  }
  get textContent(): string | null {
    return this._textContent;
  }
  set textContent(val: string | null) {
    this._textContent = val;
    this.children = [];
  }
  get firstChild(): LocalFakeNode | null {
    return this.children[0] ?? null;
  }
  appendChild(child: LocalFakeNode): LocalFakeNode {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child: LocalFakeNode): LocalFakeNode {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }
}

class LocalFakeElement extends LocalFakeNode {
  className = '';
  id = '';
  title = '';
  disabled = false;
  type = '';
  value = '';
  attrs = new Map<string, string>();
  style: Record<string, string> = {};
  listeners = new Map<string, Array<(ev: unknown) => void>>();
  classList = {
    add: (...names: string[]) => {
      const set = new Set(this.className.split(/\s+/).filter(Boolean));
      for (const n of names) set.add(n);
      this.className = Array.from(set).join(' ');
    },
    remove: (...names: string[]) => {
      const set = new Set(this.className.split(/\s+/).filter(Boolean));
      for (const n of names) set.delete(n);
      this.className = Array.from(set).join(' ');
    },
    toggle: (name: string, force?: boolean) => {
      const set = new Set(this.className.split(/\s+/).filter(Boolean));
      const next = force !== undefined ? force : !set.has(name);
      if (next) set.add(name);
      else set.delete(name);
      this.className = Array.from(set).join(' ');
    },
    contains: (name: string) => this.className.split(/\s+/).filter(Boolean).includes(name),
  };

  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  hasAttribute(k: string): boolean {
    return this.attrs.has(k);
  }
  addEventListener(ev: string, fn: (ev: unknown) => void): void {
    const arr = this.listeners.get(ev) ?? [];
    arr.push(fn);
    this.listeners.set(ev, arr);
  }
  removeEventListener(ev: string, fn: (ev: unknown) => void): void {
    const arr = this.listeners.get(ev);
    if (!arr) return;
    this.listeners.set(
      ev,
      arr.filter((f) => f !== fn)
    );
  }
}

function makeFakeCanvasContext(metrics?: { maxShadowBlur: number; fillRectCount: number }) {
  const m = metrics ?? { maxShadowBlur: 0, fillRectCount: 0 };
  let shadowBlur = 0;
  return {
    get shadowBlur() {
      return shadowBlur;
    },
    set shadowBlur(v: number) {
      shadowBlur = v;
      if (v > m.maxShadowBlur) m.maxShadowBlur = v;
    },
    shadowColor: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    filter: 'none',
    save: () => {},
    restore: () => {},
    scale: () => {},
    translate: () => {},
    rotate: () => {},
    setTransform: () => {},
    resetTransform: () => {},
    setLineDash: () => {},
    clearRect: () => {},
    fillRect: () => {
      m.fillRectCount++;
    },
    strokeRect: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    quadraticCurveTo: () => {},
    bezierCurveTo: () => {},
    arc: () => {},
    ellipse: () => {},
    rect: () => {},
    roundRect: () => {},
    clip: () => {},
    fill: () => {},
    stroke: () => {},
    drawImage: () => {},
    fillText: () => {},
    strokeText: () => {},
    measureText: (txt: string) => ({ width: txt.length * 6 }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
  };
}

function createStaticCli(overrides: Partial<OrcaClient> = {}): OrcaClient {
  return {
    isStopped: () => false,
    status: async () => ({
      ok: true,
      result: {
        runtime: {
          state: 'ready',
          reachable: true,
          runtimeId: 'rt-test',
          appVersion: '1.4.267',
        },
      },
    }),
    botList: async () => ({
      ok: true,
      result: {
        bots: [
          {
            id: 'bot-a',
            name: 'AlphaBot',
            agent: 'claude',
            paused: false,
            specialty: 'ops',
          },
        ],
      },
    }),
    botChats: async () => ({
      ok: true,
      result: {
        bot: 'AlphaBot',
        chats: [{ id: 'chat-1', title: 'Home', home: true, lastActivityAt: 1000 }],
      },
    }),
    botItemList: async () => ({ ok: true, result: { botId: 'bot-a', botName: 'AlphaBot', items: [] } }),
    orchestrationRunList: async () => ({ ok: true, result: { runs: [] } }),
    orchestrationWorkerList: async () => ({ ok: true, result: { workers: [] } }),
    orchestrationInbox: async () => ({ ok: true, result: { messages: [] } }),
    worktreePs: async () => ({ ok: true, result: { worktrees: [] } }),
    automationsList: async () => ({ ok: true, result: { automations: [] } }),
    automationsRuns: async () => ({ ok: true, result: { runs: [] } }),
    ...overrides,
  };
}

describe('Bot World Stage-1 Optimization & 0px Layout-Shift Toolbar', () => {
  test('CSS & DOM enforce 0px layout-shift fixed toolbar geometry, focus rings, and cameraHud resetSeatsBtn', () => {
    const css = fs.readFileSync(path.resolve('shared/styles.css'), 'utf8');
    const editorSrc = fs.readFileSync(path.resolve('editor/main.ts'), 'utf8');
    const chromeSrc = fs.readFileSync(path.resolve('shared/toolbar-chrome.ts'), 'utf8');

    // Static XSS hygiene in new shared/toolbar-chrome.ts
    assert.ok(!/\.innerHTML\b/.test(chromeSrc), 'shared/toolbar-chrome.ts must not use innerHTML');
    assert.ok(!/\beval\s*\(/.test(chromeSrc), 'shared/toolbar-chrome.ts must not use eval');
    assert.ok(!/new\s+Function\b/.test(chromeSrc), 'shared/toolbar-chrome.ts must not use new Function');

    // Fixed geometry CSS rules
    assert.ok(css.includes('.bw-toolbar-editor'), 'styles.css defines .bw-toolbar-editor');
    assert.ok(css.includes('height: 40px;'), 'editor toolbar locks height: 40px');
    assert.ok(css.includes('flex-wrap: nowrap;'), 'toolbars disable flex-wrap');
    assert.ok(css.includes('overflow-x: auto;'), 'toolbars handle narrow width with horizontal scroll');
    assert.ok(css.includes('.bw-toolbar-panel'), 'styles.css defines .bw-toolbar-panel');
    assert.ok(css.includes('.bw-toolbar-row-1'), 'styles.css defines panel row 1');
    assert.ok(css.includes('height: 34px;'), 'panel row 1 locks 34px');
    assert.ok(css.includes('.bw-toolbar-row-2'), 'styles.css defines panel row 2');
    assert.ok(css.includes('height: 32px;'), 'panel row 2 locks 32px');
    assert.ok(css.includes('.bw-tb-fixed'), 'styles.css defines .bw-tb-fixed');
    assert.ok(css.includes(':focus-visible'), 'styles.css defines :focus-visible rings');
    assert.ok(css.includes('.bw-hud-reset-seats'), 'resetSeatsBtn moves into HUD fixed slot');

    // Cascade order: fixed width utilities must come after base pill/btn/select rules
    const btnPos = css.indexOf('.bw-btn,');
    const fixedPos = css.indexOf('.bw-tb-fixed {');
    assert.ok(btnPos >= 0 && fixedPos > btnPos, '.bw-tb-fixed must follow base button styles in CSS cascade');

    // resetSeatsBtn is inside cameraHud (not toolbar) in editor/main.ts
    assert.ok(editorSrc.includes('bw-hud-reset-seats'), 'editor/main.ts styles resetSeatsBtn as HUD button');
    assert.ok(/cameraHud\s*=\s*el\([\s\S]*resetSeatsBtn/.test(editorSrc), 'resetSeatsBtn is inside cameraHud');

    // Runtime DOM toolbar contract across both panel and editor modes & EN/KO toggles
    const g = globalThis as unknown as Record<string, unknown>;
    const prevDoc = g.document;
    const prevNode = g.Node;
    const docListeners = new Map<string, Array<(ev: unknown) => void>>();
    const fakeDoc = {
      hidden: false,
      title: '',
      documentElement: new LocalFakeElement('HTML') as LocalFakeElement & { lang?: string },
      createElement: (tag: string) => new LocalFakeElement(tag.toUpperCase()),
      createElementNS: (_ns: string, tag: string) => new LocalFakeElement(tag.toUpperCase()),
      createTextNode: (txt: string) => {
        const n = new LocalFakeNode('#text');
        n._textContent = txt;
        return n;
      },
      addEventListener: (ev: string, fn: (ev: unknown) => void) => {
        const arr = docListeners.get(ev) ?? [];
        arr.push(fn);
        docListeners.set(ev, arr);
      },
      removeEventListener: (ev: string, fn: (ev: unknown) => void) => {
        const arr = docListeners.get(ev);
        if (!arr) return;
        docListeners.set(
          ev,
          arr.filter((f) => f !== fn)
        );
      },
    };
    g.document = fakeDoc;
    g.Node = LocalFakeNode;

    try {
      const noopHandlers = {
        onSelectTheme: () => {},
        onToggleViewMode: () => {},
        onToggleRoam: () => {},
        onToggleBroadcast: () => {},
        onCycleAtmosphere: () => {},
        onCycleWeather: () => {},
        onCycleSound: () => {},
        onFocusSpotlight: () => {},
        onToggleCollab: () => {},
        onToggleZones: () => {},
        onToggleCreatorStudio: () => {},
        onTakePhoto: () => {},
        onToggleReport: () => {},
        onToggleRedact: () => {},
        onToggleLanguage: () => {},
        onToggleDemo: () => {},
        onToggleHelp: () => {},
        onRefresh: () => {},
      };

      const panelChrome = createToolbarChrome('panel', 'en', noopHandlers);
      const editorChrome = createToolbarChrome('editor', 'en', noopHandlers);

      const getFixedClasses = (node: unknown): string[] =>
        ((node as LocalFakeElement).className ?? '')
          .split(/\s+/)
          .filter((c) => c === 'bw-tb-fixed' || c.startsWith('bw-tb-w-') || c === 'bw-icon-btn')
          .sort();

      // Snapshot initial fixed-size classes
      const panelControls = [
        panelChrome.titleEl,
        panelChrome.connPill,
        panelChrome.themeSelect,
        panelChrome.viewModeBtn,
        panelChrome.demoBtn,
        panelChrome.roamBtn,
        panelChrome.broadcastBtn,
        panelChrome.atmoBtn,
        panelChrome.weatherBtn,
        panelChrome.soundBtn,
        panelChrome.focusBtn,
        panelChrome.collabBtn,
        panelChrome.zonesBtn,
        panelChrome.studioBtn,
        panelChrome.photoBtn,
        panelChrome.reportBtn,
        panelChrome.redactBtn,
        panelChrome.langBtn,
        panelChrome.helpBtn,
        panelChrome.refreshBtn,
      ];
      const editorControls = [
        editorChrome.titleEl,
        editorChrome.connPill,
        editorChrome.docSyncPill,
        editorChrome.themeSelect,
        editorChrome.viewModeBtn,
        editorChrome.roamBtn,
        editorChrome.broadcastBtn,
        editorChrome.atmoBtn,
        editorChrome.weatherBtn,
        editorChrome.soundBtn,
        editorChrome.focusBtn,
        editorChrome.collabBtn,
        editorChrome.zonesBtn,
        editorChrome.studioBtn,
        editorChrome.photoBtn,
        editorChrome.reportBtn,
        editorChrome.redactBtn,
        editorChrome.langBtn,
        editorChrome.demoBtn,
        editorChrome.helpBtn,
        editorChrome.refreshBtn,
      ].filter(Boolean);

      const initialPanelClasses = panelControls.map(getFixedClasses);
      const initialEditorClasses = editorControls.map(getFixedClasses);

      // Every fixed/icon control must carry sizing locks up front
      for (const list of initialPanelClasses) {
        assert.ok(list.length >= 1, 'panel toolbar controls must declare fixed size or .bw-icon-btn');
      }
      for (const list of initialEditorClasses) {
        assert.ok(list.length >= 1, 'editor toolbar controls must declare fixed size or .bw-icon-btn');
      }

      const states: Array<Partial<ToolbarSyncState>> = [
        { locale: 'en', connected: false, atmosphereMode: 'auto', weatherMode: 'auto', soundMode: 'off', viewMode: 'office', redactMode: false, demoMode: false },
        { locale: 'ko', connected: true, atmosphereMode: 'night', weatherMode: 'snow', soundMode: 'rain', viewMode: 'pet', redactMode: true, demoMode: true, roaming: true, showCollabNetwork: true, zonesActive: true, creatorOpen: true, reportOpen: true, shortcutsOpen: true, docReadOnly: true },
        { locale: 'en', connected: true, retryAfterSecs: 12, atmosphereMode: 'sunset', weatherMode: 'sunbeams', soundMode: 'auto', viewMode: 'broadcast', redactMode: true, demoMode: false, docReadOnly: false },
      ];

      for (const patch of states) {
        const base: ToolbarSyncState = {
          mode: 'panel',
          locale: 'en',
          themeId: 'startup_office',
          atmosphereMode: 'auto',
          weatherMode: 'auto',
          soundMode: 'off',
          viewMode: 'office',
          redactMode: false,
          demoMode: false,
          roaming: false,
          showCollabNetwork: false,
          zonesActive: false,
          creatorOpen: false,
          reportOpen: false,
          shortcutsOpen: false,
          connected: true,
          retryAfterSecs: null,
          botCount: 4,
          ...patch,
        };
        syncToolbarChrome(panelChrome, base);
        syncToolbarChrome(editorChrome, { ...base, mode: 'editor' });

        panelControls.forEach((ctrl, idx) => {
          assert.deepEqual(
            getFixedClasses(ctrl),
            initialPanelClasses[idx],
            'panel toolbar button fixed classes must never change across toggles'
          );
          assert.ok(
            !(ctrl as unknown as LocalFakeElement).classList.contains('bw-hidden'),
            'toolbar controls must not toggle bw-hidden'
          );
        });
        editorControls.forEach((ctrl, idx) => {
          assert.deepEqual(
            getFixedClasses(ctrl),
            initialEditorClasses[idx],
            'editor toolbar button fixed classes must never change across toggles'
          );
          assert.ok(
            !(ctrl as unknown as LocalFakeElement).classList.contains('bw-hidden'),
            'editor toolbar controls must not toggle bw-hidden'
          );
        });
      }

      // Panel Row 2 buttons are strictly uniform 26x26px icon buttons
      const row2Buttons = [
        panelChrome.roamBtn,
        panelChrome.broadcastBtn,
        panelChrome.atmoBtn,
        panelChrome.weatherBtn,
        panelChrome.soundBtn,
        panelChrome.focusBtn,
        panelChrome.collabBtn,
        panelChrome.zonesBtn,
        panelChrome.studioBtn,
        panelChrome.photoBtn,
        panelChrome.reportBtn,
        panelChrome.redactBtn,
        panelChrome.langBtn,
        panelChrome.helpBtn,
        panelChrome.refreshBtn,
      ];
      for (const btn of row2Buttons) {
        assert.ok((btn as unknown as LocalFakeElement).classList.contains('bw-icon-btn'));
      }

      // Editor toolbar converts 10 secondary action/modal buttons to uniform 26x26 icon buttons
      const editorIconButtons = [
        editorChrome.roamBtn,
        editorChrome.broadcastBtn,
        editorChrome.focusBtn,
        editorChrome.collabBtn,
        editorChrome.zonesBtn,
        editorChrome.studioBtn,
        editorChrome.photoBtn,
        editorChrome.reportBtn,
        editorChrome.helpBtn,
        editorChrome.refreshBtn,
      ];
      for (const btn of editorIconButtons) {
        assert.ok((btn as unknown as LocalFakeElement).classList.contains('bw-icon-btn'));
      }

      // Verify total toolbar width budgets for 440px sidebar panel and 1280px wide editor
      const extractWidth = (className: string): number => {
        const re = new RegExp(`\\.${className}\\s*\\{[^}]*\\bwidth:\\s*(\\d+)px`);
        const m = re.exec(css);
        assert.ok(m, `Missing pixel width in styles.css for .${className}`);
        return Number(m[1]);
      };

      // Panel Row 1: 6px*2 padding + 4px outer gap + left (title + conn + 4px gap) + right (theme + view + demo + 8px gaps)
      const panelRow1Total =
        12 +
        4 +
        (extractWidth('bw-tb-w-title-panel') + extractWidth('bw-tb-w-conn-panel') + 4) +
        (extractWidth('bw-tb-w-theme-panel') +
          extractWidth('bw-tb-w-view-panel') +
          extractWidth('bw-tb-w-demo-panel') +
          8);
      assert.ok(
        panelRow1Total <= 440,
        `Panel Row 1 width ${panelRow1Total}px must fit within 440px`
      );

      // Panel Row 2: 6px*2 padding + 15 * 25px icons + 17 * 2px gaps + 3 * 1px seps
      const row2BtnMatch = /\.bw-toolbar-row-2\s+\.bw-icon-btn\s*\{[^}]*\bwidth:\s*(\d+)px/.exec(css);
      const row2IconWidth = row2BtnMatch ? Number(row2BtnMatch[1]) : 26;
      const panelRow2Total = 12 + 15 * row2IconWidth + 17 * 2 + 3 * 1;
      assert.ok(
        panelRow2Total <= 440,
        `Panel Row 2 width ${panelRow2Total}px must fit within 440px`
      );

      // Wide Editor Toolbar: 6px*2 padding + 4px outer gap + left (title + conn + docSync + 2*2px gaps) + right (8 text controls + 10*26px icons + 20*2px gaps + 3*1px seps)
      const editorLeftTotal =
        extractWidth('bw-tb-w-title-editor') +
        extractWidth('bw-tb-w-conn-editor') +
        extractWidth('bw-tb-w-docsync') +
        4;
      const editorRightTextTotal =
        extractWidth('bw-tb-w-theme-editor') +
        extractWidth('bw-tb-w-view') +
        extractWidth('bw-tb-w-atmo') +
        extractWidth('bw-tb-w-weather') +
        extractWidth('bw-tb-w-sound') +
        extractWidth('bw-tb-w-redact') +
        extractWidth('bw-tb-w-lang') +
        extractWidth('bw-tb-w-demo');
      const editorToolbarTotal =
        12 + 4 + editorLeftTotal + editorRightTextTotal + 10 * 26 + 20 * 2 + 3 * 1;
      assert.ok(
        editorToolbarTotal <= 1260,
        `Editor toolbar width ${editorToolbarTotal}px must fit cleanly within 1280px (<= 1260px budget)`
      );

      // watchDocumentVisibility fires on visibilitychange and cleans up on dispose
      const visEvents: boolean[] = [];
      const watcher = watchDocumentVisibility((visible) => visEvents.push(visible));
      assert.equal(watcher.isVisible(), true);
      fakeDoc.hidden = true;
      for (const fn of docListeners.get('visibilitychange') ?? []) fn({});
      fakeDoc.hidden = false;
      for (const fn of docListeners.get('visibilitychange') ?? []) fn({});
      assert.deepEqual(visEvents, [false, true]);
      watcher.dispose();
      assert.equal((docListeners.get('visibilitychange') ?? []).length, 0);
    } finally {
      g.document = prevDoc;
      g.Node = prevNode;
    }
  });

  test('Poller parallelizes CLI <= MAX_CONCURRENT_CLI(4), suppresses 10 unchanged polls, and handles botWorld.setUiActive backoff', async () => {
    // 1. Verify concurrency <= 4 and actual parallel overlap >= 2
    let inFlight = 0;
    let maxInFlight = 0;
    const track = async <T>(fn: () => Promise<T>): Promise<T> => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      await new Promise((r) => setTimeout(r, 15));
      try {
        return await fn();
      } finally {
        inFlight--;
      }
    };
    const concurrentCli = createStaticCli({
      status: () =>
        track(async () => ({
          ok: true,
          result: {
            runtime: {
              state: 'ready',
              reachable: true,
              runtimeId: 'rt-test',
              appVersion: '1.4.267',
            },
          },
        })),
      botList: () => track(async () => ({ ok: true, result: { bots: [] } })),
      botChats: () => track(async () => ({ ok: true, result: { bot: 'AlphaBot', chats: [] } })),
      botItemList: () => track(async () => ({ ok: true, result: { botId: 'bot-a', botName: 'AlphaBot', items: [] } })),
      orchestrationRunList: () => track(async () => ({ ok: true, result: { runs: [] } })),
      orchestrationWorkerList: () => track(async () => ({ ok: true, result: { workers: [] } })),
      orchestrationInbox: () => track(async () => ({ ok: true, result: { messages: [] } })),
      worktreePs: () => track(async () => ({ ok: true, result: { worktrees: [] } })),
      automationsList: () => track(async () => ({ ok: true, result: { automations: [] } })),
      automationsRuns: () => track(async () => ({ ok: true, result: { runs: [] } })),
    });
    const session = new PollerSession();
    await session.step(concurrentCli, { forceFull: true });
    assert.ok(maxInFlight >= 2, `Expected parallel CLI execution, got maxInFlight=${maxInFlight}`);
    assert.ok(maxInFlight <= 4, `Exceeded MAX_CONCURRENT_CLI=4: maxInFlight=${maxInFlight}`);

    // 2. Verify computeSnapshotFingerprint ignores capturedAt
    const snapA = createEmptySnapshot();
    const snapB = createEmptySnapshot();
    snapA.capturedAt = 1000;
    snapB.capturedAt = 999999;
    assert.equal(computeSnapshotFingerprint(snapA), computeSnapshotFingerprint(snapB));

    // 3. Worker 10 unchanged polls suppression + immediate triggers + setUiActive
    const host = mockHost({
      settings: { defaultTheme: 'startup_office', redactMode: false, pollIntervalSec: 5 },
    });
    let stateUpdatedCount = 0;
    let statusBarUpdateCount = 0;
    let botState: 'idle' | 'working' = 'working';
    let failInbox = false;
    let inboxCallCount = 0;
    const dynamicCli = createStaticCli({
      botList: async () => ({
        ok: true,
        result: {
          bots: [
            {
              id: 'bot-a',
              name: 'AlphaBot',
              agent: 'claude',
              paused: botState === 'idle',
              specialty: 'ops',
            },
          ],
        },
      }),
      worktreePs: async () => ({
        ok: true,
        result: {
          worktrees: [
            {
              worktreeId: 'wt-1',
              bot: 'AlphaBot',
              botHome: true,
              agents: [
                {
                  address: 'orca_session_id:chat-1',
                  paneKey: 'structured-agent-session-chat-1',
                  state: botState,
                  toolName: botState === 'working' ? 'read_file' : undefined,
                  taskTitle: 'task',
                },
              ],
            },
          ],
        },
      }),
      orchestrationInbox: async () => {
        inboxCallCount++;
        // Runtime-level failure (an isolated non-runtime error is tolerated since autoseller.3)
        if (failInbox) throw new OrcaCliError('runtime_unavailable', 'runtime offline');
        return { ok: true, result: { messages: [] } };
      },
    });

    let controller!: BotWorldWorkerController;
    const worker = await mountWorker(
      {
        default: async (orca) => {
          const trackedOrca = {
            ...orca,
            panels: {
              ...orca.panels,
              post: (...args: Parameters<typeof orca.panels.post>) => {
                if (args[0] === 'botWorld.stateUpdated') {
                  stateUpdatedCount++;
                }
                return orca.panels.post(...args);
              },
            },
            host: {
              ...orca.host,
              call: (...args: Parameters<typeof orca.host.call>) => {
                if (args[0] === 'statusBar.update') {
                  statusBarUpdateCount++;
                }
                return orca.host.call(...args);
              },
            },
          } as typeof orca;
          controller = new BotWorldWorkerController(trackedOrca, dynamicCli);
          await controller.init({ disableAutoLoop: true });
        },
        deactivate: async () => {
          controller.dispose();
        },
      },
      { host }
    );

    try {
      // Reset init counters, then initial poll emits once
      stateUpdatedCount = 0;
      statusBarUpdateCount = 0;
      await controller.runPollTick(true);
      assert.equal(stateUpdatedCount, 1);
      assert.equal(statusBarUpdateCount, 1);

      // 10 consecutive unchanged polls -> 0 IPC stateUpdated & 0 statusBar updates
      stateUpdatedCount = 0;
      statusBarUpdateCount = 0;
      for (let i = 0; i < 10; i++) {
        await controller.runPollTick(false);
      }
      assert.equal(stateUpdatedCount, 0, '10 unchanged polls must emit 0 stateUpdated IPC events');
      assert.equal(statusBarUpdateCount, 0, '10 unchanged polls must perform 0 statusBar updates');

      // Force refresh emits immediately
      await worker.request('botWorld.refresh', {});
      assert.equal(stateUpdatedCount, 1, 'forced refresh emits immediately');

      // Actual state change emits immediately on next poll
      stateUpdatedCount = 0;
      statusBarUpdateCount = 0;
      botState = 'idle';
      await controller.runPollTick(false);
      assert.equal(stateUpdatedCount, 1, 'bot state change emits immediately');
      assert.equal(statusBarUpdateCount, 1, 'bot state change updates status bar');

      // Connection state drop emits immediately
      stateUpdatedCount = 0;
      failInbox = true;
      await controller.runPollTick(false);
      assert.equal(stateUpdatedCount, 1, 'connection drop emits immediately');
      failInbox = false;
      await controller.runPollTick(false);

      // Preference change emits immediately
      stateUpdatedCount = 0;
      await worker.request('botWorld.setRedactMode', { redactMode: true });
      assert.equal(stateUpdatedCount, 1, 'redact preference change emits immediately');

      // botWorld.setUiActive backoff (12s when inactive, 2s when active or multi-client)
      const hidePanel = await worker.request('botWorld.setUiActive', {
        active: false,
        clientId: 'panel',
      });
      assert.deepEqual(hidePanel, {
        uiActive: false,
        fastIntervalMs: INACTIVE_FAST_INTERVAL_MS,
      });
      assert.equal(INACTIVE_FAST_INTERVAL_MS, 12_000);

      // Panel hidden while editor active keeps 2000ms
      await worker.request('botWorld.setUiActive', { active: true, clientId: 'panel' });
      await worker.request('botWorld.setUiActive', { active: true, clientId: 'editor' });
      const panelOffEditorOn = await worker.request('botWorld.setUiActive', {
        active: false,
        clientId: 'panel',
      });
      assert.deepEqual(panelOffEditorOn, {
        uiActive: true,
        fastIntervalMs: FAST_INTERVAL_MS,
      });
      assert.equal(FAST_INTERVAL_MS, 2_000);

      const allOff = await worker.request('botWorld.setUiActive', {
        active: false,
        clientId: 'editor',
      });
      assert.deepEqual(allOff, { uiActive: false, fastIntervalMs: 12_000 });

      // Invalid inputs rejected cleanly
      await assert.rejects(
        async () => worker.request('botWorld.setUiActive', { active: 'true' }),
        /active must be a boolean/
      );
      await assert.rejects(
        async () => worker.request('botWorld.setUiActive', { active: true, clientId: 123 as unknown as string }),
        /clientId/i
      );

      // agent.status.changed runs an immediate 1-shot fast poll WITHOUT clearing 12s UI-inactive backoff
      const inboxBeforeEvent = inboxCallCount;
      await worker.emit('agent.status.changed', {
        workspaceId: 'ws-1',
        paneKey: 'structured-agent-session-chat-1',
        state: 'working',
        receivedAt: Date.now(),
      });
      await new Promise((r) => setTimeout(r, 320));
      const internalSess = (controller as unknown as { session: PollerSession }).session;
      assert.ok(
        inboxCallCount > inboxBeforeEvent,
        'agent.status.changed triggers an immediate 1-shot fast poll'
      );
      assert.equal(
        internalSess.isUiActive(),
        false,
        'agent.status.changed must NOT flip uiActive to true while all UIs remain hidden'
      );
      assert.equal(
        internalSess.getFastIntervalMs(),
        INACTIVE_FAST_INTERVAL_MS,
        '12s UI-inactive backoff must stay active after background agent.status.changed'
      );
    } finally {
      await worker.deactivate();
    }
  });

  test('StageRenderer & PetTerrariumRenderer: no render-time layout read, ResizeObserver, DPR<=2, offscreen cache, zero shadowBlur, visibilitychange, and 3-tier pet throttle', () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const prevWin = g.window;
    const prevDoc = g.document;
    const prevImg = g.Image;
    const prevRaf = g.requestAnimationFrame;
    const prevCaf = g.cancelAnimationFrame;
    const prevRO = g.ResizeObserver;

    const roCallbacks: Array<(entries: Array<{ contentRect: { width: number; height: number } }>) => void> = [];
    const docListeners = new Map<string, Array<() => void>>();
    const rafCallbacks = new Map<number, (nowMs: number) => void>();
    const cancelledRafIds: number[] = [];
    let nextRafId = 1;

    const mainMetrics = { maxShadowBlur: 0, fillRectCount: 0 };
    const offscreenMetrics = { maxShadowBlur: 0, fillRectCount: 0 };
    let offscreenCreatedCount = 0;

    const makeCanvasMock = (w: number, h: number, onGetRect: () => void) => {
      const ctx = makeFakeCanvasContext(mainMetrics);
      return {
        width: w,
        height: h,
        style: { cursor: 'default' },
        getContext: () => ctx,
        getBoundingClientRect: () => {
          onGetRect();
          return { left: 0, top: 0, width: w, height: h, right: w, bottom: h };
        },
        addEventListener: () => {},
        removeEventListener: () => {},
      } as unknown as HTMLCanvasElement;
    };

    const fakeDoc = {
      hidden: false,
      createElement: (tag: string) => {
        if (tag === 'canvas') {
          offscreenCreatedCount++;
          const offCtx = makeFakeCanvasContext(offscreenMetrics);
          return {
            width: 0,
            height: 0,
            getContext: () => offCtx,
          };
        }
        return {};
      },
      addEventListener: (ev: string, fn: () => void) => {
        const arr = docListeners.get(ev) ?? [];
        arr.push(fn);
        docListeners.set(ev, arr);
      },
      removeEventListener: (ev: string, fn: () => void) => {
        const arr = docListeners.get(ev);
        if (!arr) return;
        docListeners.set(
          ev,
          arr.filter((f) => f !== fn)
        );
      },
    };

    g.window = {
      devicePixelRatio: 3, // Should be capped to DPR = 2
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    g.document = fakeDoc;
    g.ResizeObserver = class FakeResizeObserver {
      cb: (entries: Array<{ contentRect: { width: number; height: number } }>) => void;
      constructor(cb: (entries: Array<{ contentRect: { width: number; height: number } }>) => void) {
        this.cb = cb;
        roCallbacks.push(cb);
      }
      observe() {}
      disconnect() {}
    };
    g.requestAnimationFrame = (cb: (nowMs: number) => void) => {
      const id = nextRafId++;
      rafCallbacks.set(id, cb);
      return id;
    };
    g.cancelAnimationFrame = (id: number) => {
      cancelledRafIds.push(id);
      rafCallbacks.delete(id);
    };
    g.Image = class FakeImage {
      complete = false;
      naturalWidth = 0;
      src = '';
      onload: (() => void) | null = null;
    };

    try {
      let stageRectCalls = 0;
      let petRectCalls = 0;
      const stageCanvas = makeCanvasMock(500, 300, () => {
        stageRectCalls++;
      });
      const petCanvas = makeCanvasMock(500, 300, () => {
        petRectCalls++;
      });

      const stageRenderer = new StageRenderer(stageCanvas, { onSelectBot: () => {} });
      const petRenderer = new PetTerrariumRenderer(petCanvas, { onSelectAndPet: () => {} });

      // DPR capped at 2 despite devicePixelRatio = 3
      assert.equal(stageCanvas.width, 1000);
      assert.equal(stageCanvas.height, 600);
      assert.equal(petCanvas.width, 1000);
      assert.equal(petCanvas.height, 600);

      const snap = createEmptySnapshot();
      snap.capturedAt = Date.now();
      snap.runtime.connected = true;
      snap.botOrder = ['b1'];
      snap.bots.b1 = {
        id: 'b1',
        name: 'WorkerBot',
        handle: 'w1',
        state: 'working',
        status: { kind: 'Working', tool: 'read_file' },
        provider: 'claude',
        model: 'sonnet',
        updatedAt: '2026-11-24T00:00:00Z',
        worktreePath: '/tmp/w1',
        assignedSeatIndex: 0,
        characterId: 'cat',
        redacted: false,
      };
      const motion = new MotionDirector();
      motion.launchQuickMessageCourier(
        'b1',
        snap,
        getThemeConfig('startup_office', 'en'),
        'ping',
        false,
        {},
        'en'
      );
      motion.triggerMilestone(5);

      // Reset rect counters before rendering 5 frames on StageRenderer
      stageRectCalls = 0;
      petRectCalls = 0;

      for (let i = 0; i < 5; i++) {
        stageRenderer.update({
          snapshot: snap,
          themeId: 'startup_office',
          atmosphereMode: 'night',
          weatherMode: 'clear',
          selectedBotId: 'b1',
          hoveredBotId: null,
          redactMode: false,
          customDeskPositions: {},
          motion,
          botAppearances: {},
          locale: 'en',
          showCollabNetwork: true,
          collabEdges: [
            {
              id: 'edge-1',
              from: { kind: 'bot', botId: 'b1' },
              to: { kind: 'automation_hub' },
              kind: 'automation_bot',
              weight: 2,
              active: true,
            },
          ],
        });
        stageRenderer.renderNow();
      }

      // Change theme once -> offscreen cache redraws only when theme changes
      const offscreenDrawsAfter5 = offscreenMetrics.fillRectCount;
      stageRenderer.update({
        snapshot: snap,
        themeId: 'cyber_ops',
        atmosphereMode: 'night',
        weatherMode: 'clear',
        selectedBotId: 'b1',
        hoveredBotId: null,
        redactMode: false,
        customDeskPositions: {},
        motion,
        botAppearances: {},
        locale: 'en',
      });
      stageRenderer.renderNow();
      assert.ok(offscreenCreatedCount >= 1, 'offscreen cache canvas is allocated');
      assert.ok(offscreenDrawsAfter5 > 0, 'offscreen cache paints static background on miss');
      assert.ok(
        offscreenMetrics.fillRectCount > offscreenDrawsAfter5,
        'offscreen cache repaints when theme changes'
      );

      // Verify cache hit on repeated identical frames (no new offscreen draws)
      const drawsAfterThemeSwitch = offscreenMetrics.fillRectCount;
      stageRenderer.renderNow();
      stageRenderer.renderNow();
      assert.equal(
        offscreenMetrics.fillRectCount,
        drawsAfterThemeSwitch,
        'unchanged background frames reuse offscreen canvas cache cleanly'
      );

      // ResizeObserver contentRect resizes canvas without calling getBoundingClientRect()
      roCallbacks[0]?.([{ contentRect: { width: 800, height: 400 } }]);
      assert.equal(stageCanvas.width, 1600);
      assert.equal(stageCanvas.height, 800);
      assert.equal(stageRectCalls, 0, 'StageRenderer.renderNow & ResizeObserver perform 0 getBoundingClientRect calls');

      // PetTerrariumRenderer 0 getBoundingClientRect during renderNow + ResizeObserver + 0 shadowBlur
      petRenderer.setActive(true);
      petRectCalls = 0; // Reset after setActive initial measure
      petRenderer.update({
        snapshot: snap,
        themeId: 'startup_office',
        atmosphereMode: 'day',
        weatherMode: 'auto',
        displayTimestampMs: snap.capturedAt,
        selectedBotId: 'b1',
        redactMode: false,
        botAppearances: {},
        locale: 'en',
        broadcastMode: true,
        broadcastChromaKey: 'green',
      });
      for (let i = 0; i < 4; i++) {
        petRenderer.renderNow();
      }
      roCallbacks[1]?.([{ contentRect: { width: 640, height: 320 } }]);
      assert.equal(petCanvas.width, 1280);
      assert.equal(petCanvas.height, 640);
      assert.equal(petRectCalls, 0, 'PetTerrariumRenderer.renderNow & ResizeObserver perform 0 getBoundingClientRect calls');
      assert.equal(mainMetrics.maxShadowBlur, 0, 'Renderers eliminate unnecessary per-frame shadowBlur');

      // visibilitychange pauses active rAF loops and resumes on visible
      assert.equal(stageRenderer.isPageVisible(), true);
      assert.equal(petRenderer.isPageVisible(), true);
      assert.ok(rafCallbacks.size >= 2, 'active renderers schedule requestAnimationFrame');
      cancelledRafIds.length = 0;
      fakeDoc.hidden = true;
      for (const fn of docListeners.get('visibilitychange') ?? []) fn();
      assert.equal(stageRenderer.isPageVisible(), false);
      assert.equal(petRenderer.isPageVisible(), false);
      assert.ok(cancelledRafIds.length >= 2, 'document hidden cancels active rAF loops');

      const rafCountWhileHidden = nextRafId;
      fakeDoc.hidden = false;
      for (const fn of docListeners.get('visibilitychange') ?? []) fn();
      assert.equal(stageRenderer.isPageVisible(), true);
      assert.equal(petRenderer.isPageVisible(), true);
      assert.ok(nextRafId > rafCountWhileHidden, 'document visible resumes rAF loops');

      // PetTerrariumRenderer 3-tier adaptive throttle verification (0ms / 33ms / 80ms)
      assert.equal(PET_THROTTLE_ACTIVE_MS, 0);
      assert.equal(PET_THROTTLE_IDLE_MS, 33);
      assert.equal(PET_THROTTLE_RESTING_MS, 80);

      // Tier 2: working/idle with clear weather -> 33ms
      assert.equal(resolvePetThrottleIntervalMs(petRenderer.engine, 'clear'), 33);
      assert.equal(petRenderer.getTargetFrameIntervalMs(), 33);

      // Tier 1: NeedsOwner -> 0ms (60fps)
      snap.bots.b1.status = { kind: 'NeedsOwner', reason: 'approval' };
      petRenderer.update({
        snapshot: snap,
        themeId: 'startup_office',
        atmosphereMode: 'day',
        weatherMode: 'clear',
        displayTimestampMs: snap.capturedAt,
        selectedBotId: 'b1',
        redactMode: false,
        botAppearances: {},
        locale: 'en',
      });
      assert.equal(resolvePetThrottleIntervalMs(petRenderer.engine, 'clear'), 0);

      // Tier 3: all pets paused/resting + clear weather -> 80ms (~12fps)
      snap.bots.b1.status = { kind: 'Paused' };
      petRenderer.update({
        snapshot: snap,
        themeId: 'startup_office',
        atmosphereMode: 'day',
        weatherMode: 'clear',
        displayTimestampMs: snap.capturedAt,
        selectedBotId: 'b1',
        redactMode: false,
        botAppearances: {},
        locale: 'en',
      });
      petRenderer.engine.pets[0].pose = 'sleeping';
      assert.equal(resolvePetThrottleIntervalMs(petRenderer.engine, 'clear'), 80);
      assert.equal(petRenderer.getTargetFrameIntervalMs(), 80);

      // Verify Tier 3 skips intermediate rAF ticks (< 80ms) cleanly
      const frameLoop = (petRenderer as unknown as { frameLoop: (nowMs: number) => void }).frameLoop;
      mainMetrics.fillRectCount = 0;
      frameLoop(1000);
      const countAt1000 = mainMetrics.fillRectCount;
      assert.ok(countAt1000 > 0);
      frameLoop(1020); // +20ms < 80ms -> throttled (no draw)
      assert.equal(mainMetrics.fillRectCount, countAt1000, 'Tier 3 80ms throttle skips frame at +20ms');
      frameLoop(1085); // +85ms >= 80ms -> renders
      assert.ok(mainMetrics.fillRectCount > countAt1000, 'Tier 3 80ms throttle renders at +85ms');

      // StageRenderer.setActive(false) cancels rAF loop (e.g. Pet/Broadcast mode) and setActive(true) resumes
      assert.equal(stageRenderer.isActive(), true);
      cancelledRafIds.length = 0;
      const stageRafBeforeHide = nextRafId;
      stageRenderer.setActive(false);
      assert.equal(stageRenderer.isActive(), false);
      assert.ok(cancelledRafIds.length >= 1, 'StageRenderer.setActive(false) cancels active rAF loop');
      stageRenderer.update({
        snapshot: snap,
        themeId: 'startup_office',
        atmosphereMode: 'night',
        weatherMode: 'clear',
        selectedBotId: 'b1',
        hoveredBotId: null,
        redactMode: false,
        customDeskPositions: {},
        motion,
        botAppearances: {},
        locale: 'en',
      });
      assert.equal(nextRafId, stageRafBeforeHide, 'inactive StageRenderer does not schedule rAF on update');
      stageRenderer.setActive(true);
      assert.equal(stageRenderer.isActive(), true);
      assert.ok(nextRafId > stageRafBeforeHide, 'StageRenderer.setActive(true) resumes rAF loop');

      stageRenderer.dispose();
      petRenderer.dispose();
    } finally {
      g.window = prevWin;
      g.document = prevDoc;
      g.Image = prevImg;
      g.requestAnimationFrame = prevRaf;
      g.cancelAnimationFrame = prevCaf;
      g.ResizeObserver = prevRO;
    }
  });
});
