import fs from 'node:fs';
import path from 'node:path';
import { assert, describe, mockHost, mountWorker, test } from 'orca/testing';
import {
  BROADCAST_CHROMA_COLORS,
  BroadcastBarController,
  getBroadcastChromaColor,
} from '../shared/broadcast-bar.ts';
import { renderBotDetail, renderBotQuickPills } from '../shared/bot-detail-view.ts';
import {
  MAX_CREATOR_AVATARS,
  MAX_CREATOR_PACK_BYTES,
  buildCreatorPackFromState,
  createEmptyCreatorAssetsState,
  parseAndValidateCreatorPack,
  resolveImportedPackAvatars,
  sanitizeCreatorAssetsState,
  sanitizePackName,
  sanitizeUploadedImage,
  validateCustomAssetDataUrl,
} from '../shared/creator-studio.ts';
import { el } from '../shared/dom.ts';
import { UI_STRINGS } from '../shared/i18n.ts';
import { OwnerAvatarController } from '../shared/owner-avatar.ts';
import {
  PetTerrariumRenderer,
  resolveNameplateBoxes,
  truncateCanvasLabel,
} from '../shared/pet-terrarium.ts';
import {
  atmosphereIconName,
  setButtonContent,
  soundIconName,
  svgIcon,
  weatherIconName,
} from '../shared/icons.ts';
import {
  mapKeyToShortcutAction,
  renderShortcutsModal,
  shouldIgnoreShortcutEvent,
} from '../shared/shortcuts.ts';
import {
  TOOLTIP_HOVER_DELAY_MS,
  TooltipController,
  computeTooltipPosition,
  readTooltipAttributes,
  setTooltip,
} from '../shared/tooltip.ts';
import type { OrcaClient } from './orca-cli.ts';
import {
  createEmptySnapshot,
  isValidBroadcastChromaKey,
  isValidViewMode,
  type WorldSnapshot,
} from './types.ts';
import { BotWorldWorkerController } from './worker.ts';

const VALID_TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const VALID_TINY_JPEG =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

class FakeNode {
  nodeName: string;
  _textContent: string | null = '';
  children: FakeNode[] = [];
  parentNode: FakeNode | null = null;
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
  get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
  }
  appendChild(child: FakeNode): FakeNode {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child: FakeNode): FakeNode {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }
  collectText(): string {
    if (this.children.length === 0) return this._textContent ?? '';
    return this.children.map((c) => c.collectText()).join(' ');
  }
}

class FakeElement extends FakeNode {
  className = '';
  id = '';
  title = '';
  disabled = false;
  type = '';
  value = '';
  placeholder = '';
  maxLength = 0;
  accept = '';
  isConnected = true;
  attrs = new Map<string, string>();
  style: Record<string, string> = {};
  rect = { left: 100, top: 100, right: 160, bottom: 124, width: 60, height: 24 };
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
  getBoundingClientRect() {
    return this.rect;
  }
  contains(other: unknown): boolean {
    if (other === this) return true;
    for (const c of this.children) {
      if (c === other || (c instanceof FakeElement && c.contains(other))) return true;
    }
    return false;
  }
  closest(selector: string): FakeElement | null {
    if (selector === '[data-bw-tip]') {
      let cur: FakeNode | null = this;
      while (cur) {
        if (cur instanceof FakeElement && cur.hasAttribute('data-bw-tip')) return cur;
        cur = cur.parentNode;
      }
      return null;
    }
    return null;
  }
  matches(_sel: string): boolean {
    return false;
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
  dispatch(evName: string, evObj: Record<string, unknown> = {}): void {
    const payload = { target: this, ...evObj };
    let cur: FakeNode | null = this;
    while (cur) {
      if (cur instanceof FakeElement) {
        for (const fn of cur.listeners.get(evName) ?? []) {
          fn(payload);
        }
      }
      cur = cur.parentNode;
    }
  }
}

class FakeHtmlInput extends FakeElement {}
class FakeHtmlImage extends FakeElement {
  src = '';
  alt = '';
}
class FakeHtmlOption extends FakeElement {
  selected = false;
}

function withFakeDom<T>(fn: (doc: { body: FakeElement; dispatch: (ev: string, obj?: Record<string, unknown>) => void }) => T): T {
  const g = globalThis as Record<string, unknown>;
  const prevDoc = g.document;
  const prevWin = g.window;
  const prevNode = g.Node;
  const prevElem = g.Element;
  const prevHtmlElem = g.HTMLElement;
  const prevInput = g.HTMLInputElement;
  const prevImg = g.HTMLImageElement;
  const prevOpt = g.HTMLOptionElement;
  const prevRaf = g.requestAnimationFrame;
  const prevCancelRaf = g.cancelAnimationFrame;

  const docListeners = new Map<string, Array<(ev: unknown) => void>>();
  const winListeners = new Map<string, Array<(ev: unknown) => void>>();
  const body = new FakeElement('body');

  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  g.Node = FakeNode;
  g.Element = FakeElement;
  g.HTMLElement = FakeElement;
  g.HTMLInputElement = FakeHtmlInput;
  g.HTMLImageElement = FakeHtmlImage;
  g.HTMLOptionElement = FakeHtmlOption;
  g.document = {
    body,
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
    addEventListener: (ev: string, fn: (ev: unknown) => void) => {
      const arr = docListeners.get(ev) ?? [];
      arr.push(fn);
      docListeners.set(ev, arr);
    },
    removeEventListener: (ev: string, fn: (ev: unknown) => void) => {
      const arr = docListeners.get(ev);
      if (arr) {
        docListeners.set(
          ev,
          arr.filter((f) => f !== fn)
        );
      }
    },
  };
  g.window = {
    innerWidth: 440,
    innerHeight: 680,
    addEventListener: (ev: string, fn: (ev: unknown) => void) => {
      const arr = winListeners.get(ev) ?? [];
      arr.push(fn);
      winListeners.set(ev, arr);
    },
    removeEventListener: (ev: string, fn: (ev: unknown) => void) => {
      const arr = winListeners.get(ev);
      if (arr) {
        winListeners.set(
          ev,
          arr.filter((f) => f !== fn)
        );
      }
    },
  };

  const cleanup = () => {
    g.document = prevDoc;
    g.window = prevWin;
    g.Node = prevNode;
    g.Element = prevElem;
    g.HTMLElement = prevHtmlElem;
    g.HTMLInputElement = prevInput;
    g.HTMLImageElement = prevImg;
    g.HTMLOptionElement = prevOpt;
    g.requestAnimationFrame = prevRaf;
    g.cancelAnimationFrame = prevCancelRaf;
  };

  try {
    const res = fn({
      body,
      dispatch: (ev: string, obj: Record<string, unknown> = {}) => {
        for (const f of docListeners.get(ev) ?? []) f(obj);
      },
    });
    if (res && typeof (res as unknown as Promise<unknown>).then === 'function') {
      return (res as unknown as Promise<unknown>).finally(cleanup) as T;
    }
    cleanup();
    return res;
  } catch (err) {
    cleanup();
    throw err;
  }
}

function makeSnapshot(): WorldSnapshot {
  const snap = createEmptySnapshot();
  snap.capturedAt = 1_700_090_000_000;
  snap.initialSyncComplete = true;
  snap.runtime.connected = true;
  snap.runtime.reachable = true;
  snap.bots['bot-alpha'] = {
    id: 'bot-alpha',
    name: 'SecretAlphaBot',
    agent: 'claude',
    paused: false,
    specialty: 'Security',
    status: { kind: 'Working', tool: 'read_file' },
    currentTaskTitle: 'Check IAM',
    currentTool: 'read_file',
    lastActivityAt: 1_700_089_990_000,
    homeChatId: 'c1',
    needsYouCount: 0,
    activeWorkerCount: 0,
  };
  snap.bots['bot-beta'] = {
    id: 'bot-beta',
    name: 'SecretBetaBot',
    agent: 'gemini',
    paused: false,
    specialty: 'Cloud',
    status: { kind: 'NeedsOwner', count: 1, prompt: 'Approve?', optionsCount: 2 },
    currentTaskTitle: 'Needs approval',
    currentTool: null,
    lastActivityAt: 1_700_089_980_000,
    homeChatId: 'c2',
    needsYouCount: 1,
    activeWorkerCount: 0,
  };
  snap.botOrder = ['bot-alpha', 'bot-beta'];
  return snap;
}

function makeMinimalClient(): OrcaClient {
  return {
    isStopped: () => false,
    status: async () => ({
      ok: true,
      result: { runtime: { state: 'ready', reachable: true, runtimeId: 'rt-v090' } },
    }),
    botList: async () => ({ ok: true, result: { bots: [] } }),
    botChats: async () => ({ ok: true, result: { chats: [] } }),
    botItemList: async () => ({ ok: true, result: { items: [] } }),
    worktreePs: async () => ({ ok: true, result: { worktrees: [] } }),
    orchestrationInbox: async () => ({ ok: true, result: { messages: [] } }),
    orchestrationWorkerList: async () => ({ ok: true, result: { workers: [] } }),
    orchestrationRunList: async () => ({ ok: true, result: { runs: [] } }),
    automationsList: async () => ({ ok: true, result: { automations: [] } }),
    automationsRuns: async () => ({ ok: true, result: { runs: [] } }),
  };
}

describe('Bot World v0.9.0 — Creator Studio, Broadcast Bar, Hover Tooltips & Audit Fixes', () => {
  test('manifest v0.9.0, viewMode broadcast enum, symmetric i18n keys, and safe raster img src', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve('orca-plugin.json'), 'utf8')) as {
      version: string;
      capabilities: Array<{ kind: string }>;
      screenshots: unknown[];
      contributes: { settings: Array<{ key: string; enum?: string[]; default: unknown }> };
    };
    assert.match(manifest.version, /^1\.0\.0(-autoseller\.\d+)?$/);
    assert.equal(manifest.capabilities.length, 5);
    assert.equal(manifest.screenshots.length, 6);
    const vmSetting = manifest.contributes.settings.find((s) => s.key === 'viewMode');
    assert.deepEqual(vmSetting?.enum, ['office', 'pet', 'broadcast']);
    assert.equal(vmSetting?.default, 'office');

    assert.equal(isValidViewMode('broadcast'), true);
    assert.equal(isValidBroadcastChromaKey('green'), true);
    assert.equal(isValidBroadcastChromaKey('charcoal'), true);
    assert.equal(isValidBroadcastChromaKey('neon'), false);

    // Symmetric EN / KO i18n keys
    const enKeys = Object.keys(UI_STRINGS.en).sort();
    const koKeys = Object.keys(UI_STRINGS.ko).sort();
    assert.deepEqual(enKeys, koKeys);

    // shared/dom.ts allows local assets and validated raster data URLs, blocks SVG & external URLs
    withFakeDom(() => {
      const okLocal = el('img', { src: '../assets/characters/ddochi/idle.png' }) as unknown as FakeHtmlImage;
      assert.equal(okLocal.src, '../assets/characters/ddochi/idle.png');

      const okData = el('img', { src: VALID_TINY_PNG }) as unknown as FakeHtmlImage;
      assert.equal(okData.src, VALID_TINY_PNG);

      const badSvg = el('img', {
        src: 'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIj48L3N2Zz4=',
      }) as unknown as FakeHtmlImage;
      assert.equal(badSvg.src, '');

      const badExt = el('img', { src: 'https://evil.example/a.png' }) as unknown as FakeHtmlImage;
      assert.equal(badExt.src, '');
    });
  });

  test('shared/creator-studio.ts enforces raster MIME, byte caps, prototype-pollution stripping, and pack round-trip', async () => {
    assert.equal(validateCustomAssetDataUrl(VALID_TINY_PNG, 'avatar'), VALID_TINY_PNG);
    assert.equal(validateCustomAssetDataUrl(VALID_TINY_JPEG, 'background'), VALID_TINY_JPEG);
    assert.equal(
      validateCustomAssetDataUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'avatar'),
      null
    );
    assert.equal(
      validateCustomAssetDataUrl('data:text/html;base64,PHNjcmlwdD48L3NjcmlwdD4=', 'background'),
      null
    );
    assert.equal(
      validateCustomAssetDataUrl('data:image/png;base64,' + 'A'.repeat(125 * 1024), 'avatar'),
      null
    );
    assert.equal(
      validateCustomAssetDataUrl('data:image/jpeg;base64,' + 'A'.repeat(460 * 1024), 'background'),
      null
    );

    // Reject SVG/HTML/JS & oversized raw files before canvas decode
    const svgBlob = new Blob(['<svg></svg>'], { type: 'image/svg+xml' });
    const svgRes = await sanitizeUploadedImage(svgBlob, 'avatar');
    assert.deepEqual(svgRes, { ok: false, reason: 'unsupported_type' });

    const htmlBlob = new Blob(['<script>alert(1)</script>'], { type: 'text/html' });
    assert.deepEqual(await sanitizeUploadedImage(htmlBlob, 'background'), {
      ok: false,
      reason: 'unsupported_type',
    });

    const hugeFakeFile = {
      type: 'image/png',
      size: 5 * 1024 * 1024,
      slice: () => new Blob([]),
    } as unknown as File;
    assert.deepEqual(await sanitizeUploadedImage(hugeFakeFile, 'avatar'), {
      ok: false,
      reason: 'too_large',
    });

    // Pack parser strips __proto__ / constructor and rejects invalid assets or >24 avatars
    const maliciousPack = JSON.stringify({
      version: 1,
      packName: '  Creator   /Users/alice/Pack  ',
      customBackground: VALID_TINY_JPEG,
      customAvatars: {
        'slot-1': VALID_TINY_PNG,
      },
    }).replace('"slot-1"', '"__proto__":{"polluted":true},"slot-1"');
    const parsedOk = parseAndValidateCreatorPack(maliciousPack);
    assert.equal(parsedOk.ok, true);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    if (parsedOk.ok) {
      assert.equal(Object.hasOwn(parsedOk.pack.customAvatars, '__proto__'), false);
      assert.ok(!parsedOk.pack.packName.includes('/Users/alice'));
      const resolved = resolveImportedPackAvatars(parsedOk.pack, ['bot-alpha', 'bot-beta']);
      assert.equal(resolved['bot-alpha'], VALID_TINY_PNG);
    }

    const svgPack = JSON.stringify({
      version: 1,
      packName: 'Evil',
      customBackground: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      customAvatars: {},
    });
    assert.deepEqual(parseAndValidateCreatorPack(svgPack), { ok: false, error: 'invalid_asset' });

    const tooManyAvatars: Record<string, string> = {};
    for (let i = 0; i < MAX_CREATOR_AVATARS + 1; i++) {
      tooManyAvatars[`b-${i}`] = VALID_TINY_PNG;
    }
    assert.deepEqual(
      parseAndValidateCreatorPack(
        JSON.stringify({ version: 1, packName: 'Many', customAvatars: tooManyAvatars })
      ),
      { ok: false, error: 'too_many_avatars' }
    );

    const oversizedRaw = JSON.stringify({
      version: 1,
      packName: 'Huge',
      pad: 'x'.repeat(MAX_CREATOR_PACK_BYTES + 10),
    });
    assert.deepEqual(parseAndValidateCreatorPack(oversizedRaw), { ok: false, error: 'too_large' });

    // Build pack & sanitize stored creator state
    const state = createEmptyCreatorAssetsState(1234);
    state.customBackground = VALID_TINY_JPEG;
    state.customAvatars['bot-alpha'] = VALID_TINY_PNG;
    const built = buildCreatorPackFromState(state, { botOrder: ['bot-alpha'] });
    assert.equal(built.customAvatars['slot-1'], VALID_TINY_PNG);
    assert.equal(sanitizePackName('a'.repeat(60)).length <= 40, true);
    const sanitizedState = sanitizeCreatorAssetsState({
      packName: 'My Pack',
      customBackground: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      customAvatars: { 'bot-1': VALID_TINY_PNG, __proto__: VALID_TINY_PNG },
    });
    assert.equal(sanitizedState.customBackground, null);
    assert.deepEqual(sanitizedState.customAvatars, { 'bot-1': VALID_TINY_PNG });
  });

  test('worker creator RPCs validate raster data URLs, persist to storage:own, emit creatorUpdatedAtMs, and support broadcast viewMode', async () => {
    const host = mockHost({
      settings: { defaultTheme: 'startup_office', redactMode: false, pollIntervalSec: 5 },
    });
    const client = makeMinimalClient();
    let controller!: BotWorldWorkerController;
    const worker = await mountWorker(
      {
        default: async (orca) => {
          controller = new BotWorldWorkerController(orca, client, { nowMs: () => 50_000 });
          await controller.init({ disableAutoLoop: true });
        },
        deactivate: async () => {
          controller.dispose();
        },
      },
      { host }
    );

    try {
      const vmRes = await worker.request('botWorld.setViewMode', { viewMode: 'broadcast' });
      assert.equal(vmRes.viewMode, 'broadcast');

      const avRes = await worker.request('botWorld.setCustomAvatar', {
        botId: 'bot-alpha',
        dataUrl: VALID_TINY_PNG,
      });
      assert.equal(avRes.customAvatars['bot-alpha'], VALID_TINY_PNG);

      const bgRes = await worker.request('botWorld.setCustomBackground', {
        dataUrl: VALID_TINY_JPEG,
      });
      assert.equal(bgRes.customBackground, VALID_TINY_JPEG);

      const fetched = await worker.request('botWorld.getCreatorAssets');
      assert.equal(fetched.customBackground, VALID_TINY_JPEG);
      assert.equal(fetched.customAvatars['bot-alpha'], VALID_TINY_PNG);

      const payload = await worker.request('botWorld.getState');
      assert.equal(payload.creatorUpdatedAtMs, fetched.updatedAtMs);

      // Reject SVG & __proto__
      await assert.rejects(
        () =>
          worker.request('botWorld.setCustomAvatar', {
            botId: 'bot-alpha',
            dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
          }),
        (err: unknown) => (err as { code?: string })?.code === 'invalid_params'
      );
      await assert.rejects(
        () =>
          worker.request('botWorld.setCustomAvatar', {
            botId: '__proto__',
            dataUrl: VALID_TINY_PNG,
          }),
        (err: unknown) => (err as { code?: string })?.code === 'invalid_params'
      );
      await assert.rejects(
        () =>
          worker.request('botWorld.setCustomBackground', {
            dataUrl: 'data:text/html;base64,PGgxPkhlbGxvPC9oMT4=',
          }),
        (err: unknown) => (err as { code?: string })?.code === 'invalid_params'
      );

      // Import pack & reset
      const imported = await worker.request('botWorld.importCreatorPack', {
        pack: {
          version: 1,
          packName: 'Neon Pack',
          customBackground: null,
          customAvatars: { 'bot-beta': VALID_TINY_PNG },
        },
      });
      assert.equal(imported.packName, 'Neon Pack');
      assert.equal(imported.customBackground, null);
      assert.deepEqual(imported.customAvatars, { 'bot-beta': VALID_TINY_PNG });

      const reset = await worker.request('botWorld.resetCustomAssets', { target: 'all' });
      assert.equal(reset.customBackground, null);
      assert.deepEqual(reset.customAvatars, {});
      assert.ok(host.data().storage['botWorld.creator.v1'] !== undefined);
    } finally {
      await worker.deactivate();
    }
  });

  test('BroadcastBarController & PetTerrariumRenderer support chroma keys, redact masking, and custom avatars', () => {
    assert.equal(getBroadcastChromaColor('green'), BROADCAST_CHROMA_COLORS.green);
    assert.equal(getBroadcastChromaColor('blue'), '#0047bb');
    assert.equal(getBroadcastChromaColor('black'), '#000000');
    assert.equal(getBroadcastChromaColor('charcoal'), '#11141b');

    const drawnTexts: string[] = [];
    const filledColors: string[] = [];
    const mockCtx = {
      save: () => {},
      restore: () => {},
      setTransform: () => {},
      clearRect: () => {},
      fillRect: () => {
        filledColors.push(String(mockCtx.fillStyle));
      },
      strokeRect: () => {},
      beginPath: () => {},
      closePath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      quadraticCurveTo: () => {},
      arc: () => {},
      ellipse: () => {},
      fill: () => {},
      stroke: () => {},
      clip: () => {},
      translate: () => {},
      scale: () => {},
      drawImage: () => {},
      measureText: (t: string) => ({ width: t.length * 6 }),
      fillText: (t: string) => {
        drawnTexts.push(t);
      },
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      globalAlpha: 1,
      font: '',
      textAlign: 'left',
      textBaseline: 'alphabetic',
      filter: '',
      shadowColor: '',
      shadowBlur: 0,
    };

    const g = globalThis as Record<string, unknown>;
    const prevImage = g.Image;
    g.Image = class {
      onload: (() => void) | null = null;
      complete = false;
      naturalWidth = 0;
      set src(_v: string) {}
    };

    withFakeDom(() => {
      try {
        const canvas = {
          width: 640,
          height: 280,
          style: {} as Record<string, string>,
          getContext: () => mockCtx,
          getBoundingClientRect: () => ({ width: 640, height: 280, left: 0, top: 0 }),
          addEventListener: () => {},
          removeEventListener: () => {},
        } as unknown as HTMLCanvasElement;

        const renderer = new PetTerrariumRenderer(canvas, { onSelectAndPet: () => {} });
        const snap = makeSnapshot();
        renderer.setActive(true);
        renderer.update({
          snapshot: snap,
          themeId: 'startup_office',
          selectedBotId: 'bot-alpha',
          redactMode: true,
          botAppearances: {},
          locale: 'en',
          customAvatars: { 'bot-alpha': VALID_TINY_PNG },
          rpgProfiles: {
            'bot-alpha': {
              botId: 'bot-alpha',
              xp: 120,
              level: 3,
              completions: 2,
              delegations: 1,
              headpats: 0,
              highFives: 0,
              coffees: 0,
              equippedProp: 'none',
              unlockedProps: ['rubber_duck', 'mini_plant', 'mech_keyboard'],
            },
          },
          broadcastMode: true,
          broadcastChromaKey: 'green',
        });

        assert.ok(filledColors.includes('#00b140'));
        assert.ok(drawnTexts.some((t) => t.includes('Bot #1 · Lv.3')));
        assert.equal(drawnTexts.some((t) => t.includes('SecretAlphaBot')), false);
        assert.equal(drawnTexts.some((t) => t.includes('SecretBetaBot')), false);
        renderer.dispose();

        let selectedChroma = '';
        let exited = false;
        const bar = new BroadcastBarController({
          onSelectChroma: (k) => {
            selectedChroma = k;
          },
          onToggleRedact: () => {},
          onDropToy: () => {},
          onExit: () => {
            exited = true;
          },
        });
        bar.update({ active: true, chromaKey: 'blue', redactMode: true, locale: 'ko' });
        assert.equal(bar.root.classList.contains('bw-hidden'), false);
        const barText = (bar.root as unknown as FakeElement).collectText();
        assert.ok(barText.includes('나가기'));
        assert.ok(barText.includes('가림'));
        bar.revealTemporarily();
        const pill = (bar.root as unknown as FakeElement).children[0] as FakeElement;
        assert.equal(pill.classList.contains('bw-broadcast-pill-visible'), true);
        // Click charcoal swatch (index 3) and exit button (last child)
        (pill.children[3] as FakeElement).dispatch('click');
        assert.equal(selectedChroma, 'charcoal');
        (pill.children[pill.children.length - 1] as FakeElement).dispatch('click');
        assert.equal(exited, true);
        bar.dispose();
      } finally {
        g.Image = prevImage;
      }
    });
  });

  test('shared/tooltip.ts computes clamped positions on 440px viewport, supports warm hover, removes title, and hides on Escape/click', async () => {
    // Near right edge of 440px sidebar -> clamps within 8px padding
    const rightPos = computeTooltipPosition(
      { left: 400, top: 20, right: 432, bottom: 44, width: 32, height: 24 },
      { width: 180, height: 28 },
      { width: 440, height: 680 }
    );
    assert.equal(rightPos.placement, 'bottom');
    assert.equal(rightPos.left, 440 - 180 - 8);
    assert.equal(rightPos.top, 44 + 8);

    // Near bottom edge -> flips above
    const bottomPos = computeTooltipPosition(
      { left: 100, top: 640, right: 140, bottom: 668, width: 40, height: 28 },
      { width: 120, height: 28 },
      { width: 440, height: 680 }
    );
    assert.equal(bottomPos.placement, 'top');
    assert.equal(bottomPos.top, 640 - 8 - 28);

    await withFakeDom(async ({ body, dispatch }) => {
      const root = new FakeElement('div');
      const btnA = new FakeElement('button');
      btnA.title = 'Old native title';
      setTooltip(btnA as unknown as HTMLElement, 'Toggle Stream', 'B');
      assert.equal(btnA.hasAttribute('title'), false);
      assert.deepEqual(readTooltipAttributes(btnA as unknown as Element), {
        text: 'Toggle Stream',
        kbd: 'B',
      });

      const btnB = new FakeElement('button');
      setTooltip(btnB as unknown as HTMLElement, 'Open Studio', 'U');
      root.appendChild(btnA);
      root.appendChild(btnB);
      body.appendChild(root);

      let now = 10_000;
      const ctrl = new TooltipController(root as unknown as HTMLElement, { nowMs: () => now });
      const tipEl = body.children.find((c) => c instanceof FakeElement && c.className.includes('bw-tooltip')) as FakeElement;
      assert.ok(tipEl !== undefined);
      assert.equal(tipEl.classList.contains('bw-hidden'), true);

      // Hover A -> waits 260ms delay
      btnA.dispatch('mouseover', { target: btnA });
      assert.equal(tipEl.classList.contains('bw-hidden'), true);
      await new Promise((r) => setTimeout(r, TOOLTIP_HOVER_DELAY_MS + 30));
      assert.equal(tipEl.classList.contains('bw-hidden'), false);
      assert.ok(tipEl.collectText().includes('Toggle Stream'));
      assert.ok(tipEl.collectText().includes('B'));

      // Leave A -> move to B within 350ms warm window -> shows immediately
      now += 100;
      btnA.dispatch('mouseout', { target: btnA, relatedTarget: btnB });
      assert.equal(tipEl.classList.contains('bw-hidden'), false);
      assert.ok(tipEl.collectText().includes('Open Studio'));
      assert.ok(tipEl.collectText().includes('U'));

      // Escape hides immediately
      dispatch('keydown', { key: 'Escape' });
      assert.equal(tipEl.classList.contains('bw-hidden'), true);

      ctrl.dispose();
      assert.equal(body.children.includes(tipEl), false);
    });
  });

  test('v0.8.0 audit fixes: renderBotQuickPills Redact masking, ownerAvatar.clearKeys(), and B/U shortcuts', () => {
    withFakeDom(() => {
      const snap = makeSnapshot();
      const strip = new FakeElement('div');
      const idxMap = new Map<string, number>([
        ['bot-alpha', 1],
        ['bot-beta', 2],
      ]);

      renderBotQuickPills(strip as unknown as HTMLElement, {
        snapshot: snap,
        selectedBotId: 'bot-alpha',
        redactMode: true,
        botIndexMap: idxMap,
        locale: 'en',
        onSelectBot: () => {},
      });
      const textEn = strip.collectText();
      assert.ok(textEn.includes('Bot #1'));
      assert.ok(textEn.includes('★ Bot #2'));
      assert.equal(textEn.includes('SecretAlphaBot'), false);
      assert.equal(textEn.includes('SecretBetaBot'), false);

      renderBotQuickPills(strip as unknown as HTMLElement, {
        snapshot: snap,
        selectedBotId: 'bot-beta',
        redactMode: true,
        botIndexMap: idxMap,
        locale: 'ko',
        onSelectBot: () => {},
      });
      const textKo = strip.collectText();
      assert.ok(textKo.includes('봇 #1'));
      assert.ok(textKo.includes('★ 봇 #2'));
      assert.equal(textKo.includes('SecretAlphaBot'), false);

      // Detail view drops robotic '(Read-Only)' suffix
      const detail = new FakeElement('div');
      renderBotDetail(detail as unknown as HTMLElement, {
        snapshot: snap,
        bot: snap.bots['bot-alpha'],
        redactMode: false,
        botAppearances: {},
        locale: 'en',
        onSelectCharacter: () => {},
      });
      const detailText = detail.collectText();
      assert.ok(detailText.includes('Active Task'));
      assert.equal(detailText.includes('(Read-Only)'), false);
    });

    // ownerAvatar.clearKeys stops held movement immediately
    const owner = new OwnerAvatarController();
    owner.setRoaming(true, [0.5, 0.5]);
    owner.setMoveKey('d', true);
    assert.equal(owner.step(0.1), true);
    const xBefore = owner.x;
    owner.clearKeys();
    owner.step(0.1);
    assert.equal(owner.x, xBefore);

    // Verify panel/main.ts and editor/main.ts wire clearKeys() & redacted quick pills
    const panelSrc = fs.readFileSync(path.resolve('panel/main.ts'), 'utf8');
    const editorSrc = fs.readFileSync(path.resolve('editor/main.ts'), 'utf8');
    assert.ok(panelSrc.includes('renderBotQuickPills(botStrip, {\n    snapshot: snap,\n    selectedBotId: state.selectedBotId,\n    redactMode,\n    botIndexMap,'));
    assert.ok(panelSrc.includes('ownerAvatar.clearKeys()'));
    assert.ok(editorSrc.includes('ownerAvatar.clearKeys()'));

    // Shortcuts B & U + modal/input suppression
    assert.equal(mapKeyToShortcutAction('b', { modalOpen: false }), 'toggleBroadcast');
    assert.equal(mapKeyToShortcutAction('U', { modalOpen: false }), 'toggleCreatorStudio');
    assert.equal(mapKeyToShortcutAction('b', { modalOpen: true }), null);
    assert.equal(mapKeyToShortcutAction('u', { modalOpen: true }), 'toggleCreatorStudio');
    assert.equal(shouldIgnoreShortcutEvent({ key: 'b', target: { tagName: 'INPUT' } as unknown as EventTarget }), true);
    assert.equal(shouldIgnoreShortcutEvent({ key: 'u', target: { tagName: 'TEXTAREA' } as unknown as EventTarget }), true);

    withFakeDom(() => {
      const modal = new FakeElement('div');
      renderShortcutsModal(modal as unknown as HTMLElement, {
        open: true,
        locale: 'en',
        isEditor: true,
        onClose: () => {},
      });
      const txt = modal.collectText();
      assert.ok(txt.includes('B'));
      assert.ok(txt.includes('U'));
    });
  });

  test('Broadcast nameplate layout avoids horizontal overlaps on 1600x1000 with 8+ crowded bots and keeps top tool badges non-overlapping', () => {
    const fontsUsed: string[] = [];
    const drawnNameplates: Array<{ text: string; x: number; y: number }> = [];
    const mockCtx = {
      save: () => {},
      restore: () => {},
      setTransform: () => {},
      clearRect: () => {},
      fillRect: () => {},
      strokeRect: () => {},
      beginPath: () => {},
      closePath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      quadraticCurveTo: () => {},
      arc: () => {},
      ellipse: () => {},
      fill: () => {},
      stroke: () => {},
      clip: () => {},
      translate: () => {},
      scale: () => {},
      drawImage: () => {},
      measureText: (t: string) => ({ width: t.length * 7.2 }),
      fillText: (text: string, x: number, y: number) => {
        fontsUsed.push(mockCtx.font);
        drawnNameplates.push({ text, x, y });
      },
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      globalAlpha: 1,
      font: '',
      textAlign: 'left',
      textBaseline: 'alphabetic',
      filter: '',
      shadowColor: '',
      shadowBlur: 0,
    };

    // 1. Direct layout solver test: 8 clustered bots + 12 crowded bots on 1600px and 640px
    const eightClustered = Array.from({ length: 8 }, (_, idx) => ({
      botId: `bot-${idx}`,
      label: `Agent Ops ${idx + 1} · Lv.${idx + 2}`,
      anchorCx: 320 + idx * 45, // intentionally tighter than pillW (~135px)!
      pillW: 135,
      baseY: 890,
      statusDotColor: '#38bdf8',
      selected: idx === 0,
      dimmed: false,
    }));
    const resolvedWide = resolveNameplateBoxes(eightClustered, {
      canvasWidth: 1600,
      canvasHeight: 1000,
      railBaseY: 900,
      pillH: 24,
      tierStepY: 29,
    });
    assert.equal(resolvedWide.length, 8);
    for (let i = 0; i < resolvedWide.length; i++) {
      const a = resolvedWide[i]!;
      assert.ok(a.left >= 6 && a.right <= 1594);
      assert.ok(a.top >= 4 && a.bottom <= 996);
      for (let j = i + 1; j < resolvedWide.length; j++) {
        const b = resolvedWide[j]!;
        const sepX = a.right <= b.left || b.right <= a.left;
        const sepY = a.bottom <= b.top || b.bottom <= a.top;
        assert.ok(sepX || sepY, `Pills ${a.botId} and ${b.botId} overlapped`);
      }
    }

    const narrowCrowded = Array.from({ length: 8 }, (_, idx) => ({
      botId: `n-${idx}`,
      label: `Bot #${idx + 1} · Lv.2`,
      anchorCx: 80 + idx * 55,
      pillW: 96,
      baseY: 250,
      statusDotColor: '#4ade80',
      selected: false,
      dimmed: false,
    }));
    const resolvedNarrow = resolveNameplateBoxes(narrowCrowded, {
      canvasWidth: 640,
      canvasHeight: 280,
      railBaseY: 242,
      pillH: 19,
      tierStepY: 24,
    });
    assert.equal(resolvedNarrow.length, 8);
    for (let i = 0; i < resolvedNarrow.length; i++) {
      const a = resolvedNarrow[i]!;
      assert.ok(a.left >= 6 && a.right <= 634);
      assert.ok(a.top >= 4 && a.bottom <= 276);
      for (let j = i + 1; j < resolvedNarrow.length; j++) {
        const b = resolvedNarrow[j]!;
        const sepX = a.right <= b.left || b.right <= a.left;
        const sepY = a.bottom <= b.top || b.bottom <= a.top;
        assert.ok(sepX || sepY, `Narrow pills ${a.botId} and ${b.botId} overlapped`);
      }
    }

    // 2. Smart label truncation preserves RPG level suffix
    const trunc = truncateCanvasLabel(
      mockCtx as unknown as CanvasRenderingContext2D,
      'VeryLongCoordinatorServiceName · Lv.12',
      142
    );
    assert.ok(trunc.endsWith('… · Lv.12'));
    assert.ok(mockCtx.measureText(trunc).width <= 142);

    // 3. Full PetTerrariumRenderer 1600x1000 render with 8 bots & top tool badges
    const g = globalThis as Record<string, unknown>;
    const prevImage = g.Image;
    g.Image = class {
      onload: (() => void) | null = null;
      complete = false;
      naturalWidth = 0;
      set src(_v: string) {}
    };
    withFakeDom(() => {
      try {
        const canvas = {
          width: 1600,
          height: 1000,
          style: {} as Record<string, string>,
          getContext: () => mockCtx,
          getBoundingClientRect: () => ({ width: 1600, height: 1000, left: 0, top: 0 }),
          addEventListener: () => {},
          removeEventListener: () => {},
        } as unknown as HTMLCanvasElement;

        const renderer = new PetTerrariumRenderer(canvas, { onSelectAndPet: () => {} });
        const snap = createEmptySnapshot();
        const roleNames = [
          'Ops Lead',
          'Infra Ops',
          'Cloud Ops',
          'Sec Audit',
          'Build QA',
          'Doc Writer',
          'Cost Guard',
          'MCP Host',
        ];
        const rpgProfiles: Record<string, import('./types.ts').BotRpgProfile> = {};
        roleNames.forEach((name, idx) => {
          const id = `bot-${idx}`;
          snap.bots[id] = {
            id,
            name,
            agent: 'claude',
            paused: false,
            specialty: name,
            status: { kind: 'Working', tool: idx % 2 === 0 ? 'run_command' : 'read_file' },
            currentTaskTitle: 'Task',
            currentTool: 'run_command',
            lastActivityAt: 1000,
            homeChatId: null,
            needsYouCount: 0,
            activeWorkerCount: 0,
          };
          snap.botOrder.push(id);
          rpgProfiles[id] = {
            botId: id,
            xp: (idx + 1) * 50,
            level: idx + 1,
            completions: 1,
            delegations: 0,
            headpats: 0,
            highFives: 0,
            coffees: 0,
            equippedProp: 'none',
            unlockedProps: [],
          };
        });

        renderer.setActive(true);
        renderer.update({
          snapshot: snap,
          themeId: 'startup_office',
          selectedBotId: 'bot-0',
          redactMode: false,
          botAppearances: {},
          locale: 'en',
          rpgProfiles,
          broadcastMode: true,
          broadcastChromaKey: 'green',
        });

        // Force close horizontal proximity to verify both top tool badges and bottom nameplates stay separated
        renderer.engine.pets.forEach((pet, idx) => {
          pet.x = 120 + idx * 24;
        });
        fontsUsed.length = 0;
        drawnNameplates.length = 0;
        renderer.renderNow();

        assert.ok(fontsUsed.some((f) => f.includes('13.5px')));
        const plates = drawnNameplates.filter((d) => d.text.includes('· Lv.'));
        assert.equal(plates.length, 8);
        for (let i = 0; i < plates.length; i++) {
          for (let j = i + 1; j < plates.length; j++) {
            const a = plates[i]!;
            const b = plates[j]!;
            const distY = Math.abs(a.y - b.y);
            const distX = Math.abs(a.x - b.x);
            assert.ok(distY >= 24 || distX >= 100, `Rendered plates ${a.text} & ${b.text} overlapped`);
          }
        }
        const toolBadges = drawnNameplates.filter((d) => d.text.startsWith('▶ '));
        assert.equal(toolBadges.length, 8);
        for (let i = 0; i < toolBadges.length; i++) {
          for (let j = i + 1; j < toolBadges.length; j++) {
            const a = toolBadges[i]!;
            const b = toolBadges[j]!;
            const distY = Math.abs(a.y - b.y);
            const distX = Math.abs(a.x - b.x);
            assert.ok(distY >= 20 || distX >= 80, `Top badges ${a.text} & ${b.text} overlapped`);
          }
        }
        renderer.dispose();
      } finally {
        g.Image = prevImage;
      }
    });
  });

  test('shared/icons.ts renders monochrome SVG toolbar icons via createElementNS and shared/styles.css enforces uniform 26px toolbar heights', () => {
    const css = fs.readFileSync(path.resolve('shared/styles.css'), 'utf8');
    assert.ok(css.includes('height: 26px;'));
    assert.ok(css.includes('.bw-icon-btn'));
    assert.ok(css.includes('.bw-toolbar-sep'));
    assert.ok(css.includes('height: 14px;'));

    const editorSrc = fs.readFileSync(path.resolve('editor/main.ts'), 'utf8');
    const panelSrc = fs.readFileSync(path.resolve('panel/main.ts'), 'utf8');
    const broadcastSrc = fs.readFileSync(path.resolve('shared/broadcast-bar.ts'), 'utf8');
    for (const emoji of ['🐾', '🚶', '📺', '🎯', '🕸', '🗺', '🎨', '📸', '⏱', '☕', '🎾', '🍪', '🏢']) {
      assert.equal(editorSrc.includes(emoji), false, `editor/main.ts still contains ${emoji}`);
      assert.equal(panelSrc.includes(emoji), false, `panel/main.ts still contains ${emoji}`);
      assert.equal(broadcastSrc.includes(emoji), false, `shared/broadcast-bar.ts still contains ${emoji}`);
    }

    assert.equal(atmosphereIconName('auto'), 'contrast');
    assert.equal(atmosphereIconName('sunset'), 'sunset');
    assert.equal(weatherIconName('rain'), 'rain');
    assert.equal(soundIconName('off'), 'volume-off');

    withFakeDom(() => {
      const icon = svgIcon('paw');
      assert.equal(icon.getAttribute('width'), '14');
      assert.equal(icon.getAttribute('height'), '14');
      assert.equal(icon.getAttribute('stroke'), 'currentColor');
      assert.equal(icon.getAttribute('fill'), 'none');
      assert.equal(icon.getAttribute('stroke-width'), '1.75');

      const btn = new FakeElement('button');
      setButtonContent(btn as unknown as HTMLButtonElement, 'camera', 'Photo');
      assert.equal(btn.children.length, 2);
      assert.ok(btn.collectText().includes('Photo'));
    });
  });

  test('shared/styles.css never maps --bw-accent to --orca-accent and defines full html.light high-contrast tokens', () => {
    const css = fs.readFileSync(path.resolve('shared/styles.css'), 'utf8');

    // --orca-accent is a surface hover/selection fill in Orca, never an interactive text accent
    assert.equal(
      /--bw-accent\s*:[^;]*var\(--orca-accent/.test(css),
      false,
      'shared/styles.css must never map --bw-accent to var(--orca-accent)'
    );
    assert.equal(
      css.includes('--orca-surface'),
      false,
      'shared/styles.css should not rely on uninjected --orca-surface token'
    );
    assert.ok(css.includes('--bw-hover-fill: var(--orca-accent'));

    // Extract html.light { ... } block and assert required high-contrast semantic overrides
    const lightBlockMatch = css.match(/html\.light\s*\{([\s\S]*?)\}/);
    assert.ok(lightBlockMatch !== null, 'html.light block must exist in shared/styles.css');
    const lightBlock = lightBlockMatch[1] ?? '';

    for (const token of [
      '--bw-accent',
      '--bw-warn',
      '--bw-danger',
      '--bw-success',
      '--bw-fg',
      '--bw-bg',
      '--bw-card',
      '--bw-popover',
      '--bw-border',
    ]) {
      assert.ok(
        new RegExp(`${token}\\s*:`).test(lightBlock),
        `html.light must define override for ${token}`
      );
    }

    // Verify both editor/main.ts and panel/main.ts sync light/dark classes on Orca theme events
    const editorSrc = fs.readFileSync(path.resolve('editor/main.ts'), 'utf8');
    const panelSrc = fs.readFileSync(path.resolve('panel/main.ts'), 'utf8');
    for (const src of [editorSrc, panelSrc]) {
      assert.ok(src.includes("orca.on('theme'"));
      assert.ok(src.includes("classList.toggle('light'"));
      assert.ok(src.includes("classList.toggle('dark'"));
    }
  });
});
