import { scrubAll } from '../src/redact.ts';
import {
  type AtmosphereMode,
  type AtmospherePhase,
  type BotActivityStatus,
  type BotRpgProfile,
  type BotState,
  type CharacterId,
  type DeskCoordinate,
  type DeskPropId,
  type StuckAlert,
  type TeamZone,
  type ThemeId,
  type UiLocale,
  type WeatherKind,
  type WeatherMode,
  type WorldSnapshot,
  botStatusLabel,
  clampDeskCoordinate,
  isSafeKey,
  isWorkerUnverifiableWarning,
  isWorkerVisibleOnStage,
} from '../src/types.ts';
import {
  CHARACTER_SPECS,
  type ThemeConfig,
  getThemeConfig,
  resolveCharacterIdWithPrefs,
  resolveCharacterSpritePath,
  resolveThemeAssetPath,
} from './assets-catalog.ts';
import {
  CAMERA_ZOOM_STEP,
  CameraController,
  FOCUS_SPOTLIGHT_ZOOM,
  type StageViewport,
  type ViewportTransform,
  composeViewportTransform,
  createStageViewport,
} from './camera.ts';
import type { CollabEdge } from './collab-network.ts';
import { validateCustomAssetDataUrl } from './creator-studio.ts';
import {
  type BrandInfo,
  type ProjectBoard,
  boardProjectLabels,
  boardTotals,
  sanitizeBrand,
} from '../src/project-board.ts';
import { tStrings } from './i18n.ts';
import {
  type BubbleKind,
  type CarryProp,
  type Facing,
  type FlyingCourier,
  type FlyingProp,
  type HuddleSparkle,
  MAX_BUBBLES,
  MAX_COURIERS,
  MAX_PARTICLES,
  type MilestoneBanner,
  type MotionDirector,
  type Particle,
  type Rect,
  type ReplayController,
  hasErrorDeskBeacon,
} from './motion.ts';
import type { OwnerRipple } from './owner-avatar.ts';
import { stuckAlertByBotMap } from './watchdog.ts';
import { WeatherSystem, resolveWeatherKind } from './weather.ts';
import { formatZoneDisplayLabel, zoneColorPalette } from './zones.ts';

const BOT_SPRITE_DESIGN_PX = 90;
const WORKER_SPRITE_DESIGN_PX = 74;
export const CANVAS_FONT_FAMILY =
  '"Pretendard", "Apple SD Gothic Neo", "Inter", system-ui, sans-serif';

function designToScreen(vt: ViewportTransform, dx: number, dy: number): [number, number] {
  return [vt.originX + dx * vt.scale, vt.originY + dy * vt.scale];
}

function spriteBounds(
  vt: ViewportTransform,
  footX: number,
  footY: number,
  baseDesignPx: number,
  scale: number,
  anchor: [number, number],
  yBobPx: number
): Rect {
  const w = baseDesignPx * scale * vt.scale;
  const h = baseDesignPx * scale * vt.scale;
  const [sx, sy] = designToScreen(vt, footX, footY);
  return [sx - w * anchor[0], sy - h * anchor[1] + yBobPx, w, h];
}

function rectOverlapArea(a: Rect, b: Rect): number {
  const ox = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const oy = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return ox > 0 && oy > 0 ? ox * oy : 0;
}

function estimateBubbleWidth(text: string): number {
  let w = 22;
  for (const ch of text) {
    w += ch.charCodeAt(0) <= 127 ? 6.5 : 10.5;
  }
  return Math.max(72, Math.min(220, w));
}

function placeSpeechBubble(
  anchorX: number,
  anchorY: number,
  scale: number,
  estW: number,
  estH: number,
  stageBounds: Rect,
  obstacles: readonly Rect[]
): [number, number] {
  const [bgLeft, bgTop, bgRight, bgBottom] = stageBounds;
  const margin = 10;
  const minX = bgLeft + margin;
  const maxX = Math.max(minX, bgRight - estW - margin);
  const minY = bgTop + margin;
  const maxY = Math.max(minY, bgBottom - estH - margin);

  const baseX = Math.max(minX, Math.min(maxX, anchorX - estW * 0.5));
  const baseY = Math.max(minY, Math.min(maxY, anchorY - 116 * scale));

  const stepY = estH + 8;
  const stepX = Math.max(52, estW * 0.52);
  const dirs: ReadonlyArray<[number, number]> = [
    [0, -1],
    [0.8, -0.8],
    [-0.8, -0.8],
    [1, 0],
    [-1, 0],
    [0.8, 0.8],
    [-0.8, 0.8],
    [0, 1],
  ];
  const rings = [0.85, 1.5, 2.25, 3.2, 4.4];

  const candidates: Array<[number, number]> = [[baseX, baseY]];
  for (const ring of rings) {
    for (const [dx, dy] of dirs) {
      candidates.push([
        Math.max(minX, Math.min(maxX, baseX + dx * stepX * ring)),
        Math.max(minY, Math.min(maxY, baseY + dy * stepY * ring)),
      ]);
    }
  }

  let best = candidates[0];
  let bestHasOverlap = true;
  let bestOverlap = Infinity;
  let bestPaddedOverlap = Infinity;
  let bestDist = Infinity;

  for (const [cx, cy] of candidates) {
    const rect: Rect = [cx, cy, estW, estH];
    const padded: Rect = [cx - 4, cy - 4, estW + 8, estH + 8];
    let overlap = 0;
    let paddedOverlap = 0;
    for (const ob of obstacles) {
      overlap += rectOverlapArea(rect, ob);
      paddedOverlap += rectOverlapArea(padded, ob);
    }
    const dist = Math.hypot(cx - baseX, cy - baseY);
    const hasOverlap = overlap > 0;
    let isBetter = false;
    if (!hasOverlap && bestHasOverlap) isBetter = true;
    else if (hasOverlap && !bestHasOverlap) isBetter = false;
    else if (!hasOverlap && !bestHasOverlap) {
      isBetter = dist + paddedOverlap * 0.05 < bestDist + bestPaddedOverlap * 0.05;
    } else {
      isBetter = overlap * 100 + dist < bestOverlap * 100 + bestDist;
    }
    if (isBetter) {
      best = [cx, cy];
      bestHasOverlap = hasOverlap;
      bestOverlap = overlap;
      bestPaddedOverlap = paddedOverlap;
      bestDist = dist;
    }
  }
  return best;
}

function shortToolName(tool: string): string {
  switch (tool) {
    case 'run_command':
      return 'Cmd';
    case 'edit_file':
      return 'Edit';
    case 'write_file':
      return 'Write';
    case 'read_file':
      return 'Read';
    case 'search_web':
      return 'Web';
    case 'call_mcp_tool':
      return 'MCP';
    case 'execute':
      return 'Exec';
    default:
      return tool;
  }
}

function classifyToolGlyph(tool: string | null): string {
  if (!tool) return '⚙';
  const lower = tool.toLowerCase();
  if (['bash', 'run_command', 'execute', 'cmd', 'exec'].includes(lower)) return '>_';
  if (['edit', 'write', 'edit_file', 'write_file'].includes(lower)) return '✎';
  if (['read', 'grep', 'glob', 'read_file', 'search_web', 'web'].includes(lower)) return '🔍';
  return '⚙';
}

function shortProvider(provider: string): string {
  if (provider === 'antigravity') return 'agy';
  return provider;
}

export function statusBadgeStyle(
  status: BotActivityStatus,
  redactMode: boolean,
  locale: UiLocale = 'en'
): { text: string; bg: string; fg: string } {
  const s = tStrings(locale);
  switch (status.kind) {
    case 'Working': {
      const text =
        redactMode || !status.tool || status.tool.length === 0
          ? s.badgeWorking
          : `▶ ${scrubAll(shortToolName(status.tool))}`;
      return { text, bg: '#1d4ed8', fg: '#ffffff' };
    }
    case 'Idle':
      return { text: s.badgeIdle, bg: 'rgba(22, 101, 52, 0.9)', fg: '#dcfce7' };
    case 'WaitingAnswer':
      return { text: s.badgeWaiting, bg: '#b45309', fg: '#fef3c7' };
    case 'Blocked':
      return { text: s.badgeBlocked, bg: '#ea580c', fg: '#ffffff' };
    case 'NeedsOwner': {
      return { text: s.badgeNeedsYou(status.optionsCount), bg: '#eab308', fg: '#422006' };
    }
    case 'Error':
      return { text: s.badgeError, bg: '#dc2626', fg: '#ffffff' };
    case 'Paused':
      return { text: s.badgePaused, bg: '#475569', fg: '#e2e8f0' };
  }
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rad = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

function truncateTextToWidth(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const chars = Array.from(text);
  let out = '';
  for (const ch of chars) {
    if (ctx.measureText(`${out}${ch}…`).width > maxWidth) {
      return `${out}…`;
    }
    out += ch;
  }
  return out;
}

function bubbleColors(kind: BubbleKind): { bg: string; border: string; fg: string } {
  switch (kind) {
    case 'Normal':
      return { bg: 'rgba(250, 250, 250, 0.95)', border: 'rgba(63, 63, 70, 0.8)', fg: '#18181b' };
    case 'Question':
      return { bg: 'rgba(239, 246, 255, 0.95)', border: 'rgba(59, 130, 246, 0.92)', fg: '#1e3a8a' };
    case 'Alert':
      return { bg: 'rgba(254, 242, 242, 0.96)', border: 'rgba(239, 68, 68, 0.92)', fg: '#7f1d1d' };
    case 'Success':
      return { bg: 'rgba(240, 253, 244, 0.96)', border: 'rgba(34, 197, 94, 0.92)', fg: '#14532d' };
    case 'Boss':
      return { bg: 'rgba(254, 252, 232, 0.96)', border: 'rgba(234, 179, 8, 0.92)', fg: '#713f12' };
  }
}

export function resolveAtmospherePhase(
  mode: AtmosphereMode,
  timestampMs: number
): AtmospherePhase {
  if (mode === 'day' || mode === 'sunset' || mode === 'night') return mode;
  const ts = Number.isFinite(timestampMs) ? timestampMs : Date.now();
  const hour = new Date(ts).getHours();
  if (hour >= 7 && hour <= 16) return 'day';
  if (hour >= 17 && hour <= 19) return 'sunset';
  return 'night';
}

const IDLE_Z_THRESHOLD_MS = 5 * 60_000;

function isBotLongIdle(bot: BotState, phase: AtmospherePhase, displayTimestampMs: number): boolean {
  if (bot.status.kind !== 'Idle') return false;
  if (phase === 'night') return true;
  if (bot.lastActivityAt === null || !Number.isFinite(bot.lastActivityAt)) return false;
  return displayTimestampMs - bot.lastActivityAt >= IDLE_Z_THRESHOLD_MS;
}

export type StageOwnerAvatarInput = {
  roaming: boolean;
  x: number;
  y: number;
  facing: Facing;
  walkPhase: number;
  isMoving: boolean;
  ripple: OwnerRipple | null;
  nearbyBotId: string | null;
  ownerTag: string;
};

export type StageRenderInput = {
  snapshot: WorldSnapshot;
  themeId: ThemeId;
  atmosphereMode?: AtmosphereMode;
  weatherMode?: WeatherMode;
  displayTimestampMs?: number;
  selectedBotId: string | null;
  redactMode: boolean;
  botAppearances: Record<string, CharacterId>;
  customDeskPositions?: Readonly<Record<string, DeskCoordinate>>;
  rpgProfiles?: Readonly<Record<string, BotRpgProfile>>;
  ownerAvatar?: StageOwnerAvatarInput | null;
  motion: MotionDirector;
  replay?: ReplayController | null;
  locale?: UiLocale;
  filterMatchedBotIds?: ReadonlySet<string> | null;
  showCollabNetwork?: boolean;
  collabEdges?: readonly CollabEdge[];
  mvpBotId?: string | null;
  zones?: readonly TeamZone[];
  showZones?: boolean;
  timelapseActive?: boolean;
  customBackground?: string | null;
  customAvatars?: Readonly<Record<string, string>>;
  stuckAlerts?: readonly StuckAlert[];
  /** Company logo/name shown at the boss desk (from the .botworld document). */
  brand?: BrandInfo | null;
  /** Projects and backlog shown under the Automation Board (from the .botworld document). */
  projectBoard?: ProjectBoard | null;
};

/** A board snapshot older than this is labelled stale instead of looking current. */
export const PROJECT_BOARD_STALE_MS = 26 * 60 * 60 * 1000;
const MAX_BOARD_ROWS = 6;

type HitBox = {
  botId: string;
  rect: Rect;
};

type DragCandidate = {
  botId: string;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startDesignX: number;
  startDesignY: number;
  isDragging: boolean;
  currentPos: DeskCoordinate;
};

type PanDragState = {
  pointerId: number;
  lastClientX: number;
  lastClientY: number;
  moved: boolean;
};

export class StageRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly imageCache = new Map<string, HTMLImageElement>();
  private readonly onSelectBot: (botId: string) => void;
  private readonly onHoverBot?: (botId: string | null) => void;
  private readonly onMoveBot?: (botId: string, pos: DeskCoordinate) => void;
  private readonly onCameraChange?: () => void;
  private readonly onDoubleClickFloor?: (normX: number, normY: number) => void;
  readonly camera: CameraController;
  readonly weather = new WeatherSystem();
  private lastInput: StageRenderInput | null = null;
  private lastViewport: ViewportTransform | null = null;
  private lastStageViewport: StageViewport | null = null;
  private hitBoxes: HitBox[] = [];
  private dragCandidate: DragCandidate | null = null;
  private panDrag: PanDragState | null = null;
  private suppressNextClick = false;
  private rafId: number | null = null;
  private lastFrameMs = 0;
  private lastIdleAnimRenderMs = 0;
  private animTick = 0;
  private tickAccumulatorMs = 0;
  private resizeObserver: ResizeObserver | null = null;
  private active = true;
  private pageVisible = typeof document !== 'undefined' ? !document.hidden : true;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private bgCacheCanvas: HTMLCanvasElement | null = null;
  private bgCacheCtx: CanvasRenderingContext2D | null = null;
  private bgCacheKey = '';
  private destroyed = false;

  constructor(
    canvas: HTMLCanvasElement,
    options: {
      onSelectBot: (botId: string) => void;
      onHoverBot?: (botId: string | null) => void;
      onMoveBot?: (botId: string, pos: DeskCoordinate) => void;
      onCameraChange?: () => void;
      onDoubleClickFloor?: (normX: number, normY: number) => void;
      camera?: CameraController;
    }
  ) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('2D canvas context unavailable');
    }
    this.ctx = ctx;
    this.onSelectBot = options.onSelectBot;
    this.onHoverBot = options.onHoverBot;
    this.onMoveBot = options.onMoveBot;
    this.onCameraChange = options.onCameraChange;
    this.onDoubleClickFloor = options.onDoubleClickFloor;
    this.camera = options.camera ?? new CameraController();

    this.canvas.addEventListener('click', this.handleClick);
    this.canvas.addEventListener('dblclick', this.handleDoubleClick);
    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerup', this.handlePointerUp);
    this.canvas.addEventListener('pointercancel', this.handlePointerCancel);
    this.canvas.addEventListener('pointerleave', this.handlePointerLeave);
    this.canvas.addEventListener('wheel', this.handleWheel, { passive: false });

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver((entries) => {
        const cr = entries[0]?.contentRect;
        this.resizeCanvas(cr ? { width: cr.width, height: cr.height } : undefined);
        if (this.active && this.pageVisible) this.renderNow();
      });
      this.resizeObserver.observe(this.canvas);
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('resize', this.handleWindowResize);
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }
    this.resizeCanvas();
  }

  private readonly handleWindowResize = (): void => {
    this.resizeCanvas();
    if (this.active && this.pageVisible) this.renderNow();
  };

  private readonly handleVisibilityChange = (): void => {
    if (typeof document !== 'undefined') {
      this.setPageVisible(!document.hidden);
    }
  };

  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (!active) {
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      return;
    }
    this.resizeCanvas();
    if (!this.destroyed && this.pageVisible && this.lastInput) {
      this.renderNow();
      this.ensureAnimationLoopIfNeeded();
    }
  }

  isActive(): boolean {
    return this.active;
  }

  setPageVisible(visible: boolean): void {
    if (this.pageVisible === visible) return;
    this.pageVisible = visible;
    if (!visible) {
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      return;
    }
    if (!this.destroyed && this.active && this.lastInput) {
      this.renderNow();
      this.ensureAnimationLoopIfNeeded();
    }
  }

  isPageVisible(): boolean {
    return this.pageVisible;
  }

  private loadImage(safePath: string): HTMLImageElement | null {
    if (!safePath.startsWith('../assets/')) {
      const validCustom =
        validateCustomAssetDataUrl(safePath, 'background') ??
        validateCustomAssetDataUrl(safePath, 'avatar');
      if (!validCustom) return null;
    }
    const cached = this.imageCache.get(safePath);
    if (cached) {
      return cached.complete && cached.naturalWidth > 0 ? cached : null;
    }
    if (this.imageCache.size >= 64) {
      for (const key of this.imageCache.keys()) {
        if (key.startsWith('data:')) {
          this.imageCache.delete(key);
          if (this.imageCache.size < 48) break;
        }
      }
    }
    const img = new Image();
    img.onload = () => {
      if (!this.destroyed) {
        this.renderNow();
      }
    };
    img.src = safePath;
    this.imageCache.set(safePath, img);
    return img.complete && img.naturalWidth > 0 ? img : null;
  }

  private resizeCanvas(contentRect?: { width: number; height: number }): void {
    const rect =
      contentRect && contentRect.width > 0 && contentRect.height > 0
        ? contentRect
        : this.canvas.getBoundingClientRect();
    const rawDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const dpr = Math.max(1, Math.min(2, rawDpr));
    this.dpr = dpr;
    if (rect.width > 0 && rect.height > 0) {
      this.cssW = rect.width;
      this.cssH = rect.height;
      const targetW = Math.max(1, Math.round(rect.width * dpr));
      const targetH = Math.max(1, Math.round(rect.height * dpr));
      if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
        this.canvas.width = targetW;
        this.canvas.height = targetH;
        this.bgCacheKey = '';
      }
    } else if (this.canvas.width > 0 && this.canvas.height > 0) {
      this.cssW = this.canvas.width / dpr;
      this.cssH = this.canvas.height / dpr;
    }
  }

  update(input: StageRenderInput): void {
    this.lastInput = input;
    const locale = input.locale ?? 'en';
    const theme = getThemeConfig(input.themeId, locale);
    const displayTs = this.resolveDisplayTimestampMs(input);
    const phase = resolveAtmospherePhase(input.atmosphereMode ?? 'auto', displayTs);
    const weatherKind = resolveWeatherKind(input.weatherMode ?? 'auto', phase, input.themeId);
    this.weather.syncKind(weatherKind, theme.designSize);
    input.motion.setLocale(locale);
    input.motion.syncLayout(input.snapshot, theme, input.customDeskPositions);
    if (this.camera.followBotId) {
      this.syncFollowTarget(input, theme.designSize, false);
    }
    if (this.active && this.pageVisible) {
      this.renderNow();
    }
    this.ensureAnimationLoopIfNeeded();
  }

  refreshCameraLoop(): void {
    if (!this.lastInput) return;
    this.renderNow();
    this.ensureAnimationLoopIfNeeded();
  }

  private syncFollowTarget(
    input: StageRenderInput,
    designSize: readonly [number, number],
    immediate: boolean
  ): void {
    const fid = this.camera.followBotId;
    if (!fid) return;
    const desk = input.motion.layout.botDesks.get(fid);
    if (!desk) return;
    const pose = input.motion.actorPose(`bot:${fid}`, [desk.x, desk.y]);
    this.camera.updateFollowTarget(pose.footX, pose.footY - 22, designSize, immediate);
  }

  focusBot(botId: string): boolean {
    if (!this.lastInput) return false;
    const desk = this.lastInput.motion.layout.botDesks.get(botId);
    if (!desk) return false;
    const theme = getThemeConfig(this.lastInput.themeId, this.lastInput.locale ?? 'en');
    const pose = this.lastInput.motion.actorPose(`bot:${botId}`, [desk.x, desk.y]);
    this.camera.focusWorldPoint(pose.footX, pose.footY - 22, FOCUS_SPOTLIGHT_ZOOM, theme.designSize, {
      botId,
    });
    if (this.camera.followBotId && this.camera.followBotId !== botId) {
      this.camera.setFollowBot(botId);
    }
    this.onCameraChange?.();
    this.renderNow();
    this.ensureAnimationLoopIfNeeded();
    return true;
  }

  toggleFollow(botId: string | null): boolean {
    if (this.camera.followBotId !== null && (botId === null || this.camera.followBotId === botId)) {
      this.camera.releaseFollow();
    } else if (botId) {
      this.camera.setFollowBot(botId);
      if (this.lastInput) {
        const theme = getThemeConfig(this.lastInput.themeId, this.lastInput.locale ?? 'en');
        this.syncFollowTarget(this.lastInput, theme.designSize, false);
      }
    }
    this.onCameraChange?.();
    this.renderNow();
    this.ensureAnimationLoopIfNeeded();
    return this.camera.followBotId !== null;
  }

  zoomBy(delta: number): void {
    if (!this.lastInput) return;
    const theme = getThemeConfig(this.lastInput.themeId, this.lastInput.locale ?? 'en');
    this.camera.setZoom(this.camera.targetZoom + delta, theme.designSize, false);
    this.onCameraChange?.();
    this.renderNow();
    this.ensureAnimationLoopIfNeeded();
  }

  resetCamera(): void {
    this.camera.reset(false);
    this.onCameraChange?.();
    this.renderNow();
    this.ensureAnimationLoopIfNeeded();
  }

  private resolveDisplayTimestampMs(input: StageRenderInput): number {
    if (typeof input.displayTimestampMs === 'number' && Number.isFinite(input.displayTimestampMs)) {
      return input.displayTimestampMs;
    }
    if (input.replay?.isReplay) {
      return input.replay.cursorMs;
    }
    return input.snapshot.capturedAt > 0 ? input.snapshot.capturedAt : Date.now();
  }

  private resolveWeatherForInput(input: StageRenderInput): {
    phase: AtmospherePhase;
    weatherKind: WeatherKind;
  } {
    const displayTs = this.resolveDisplayTimestampMs(input);
    const phase = resolveAtmospherePhase(input.atmosphereMode ?? 'auto', displayTs);
    const weatherKind = resolveWeatherKind(input.weatherMode ?? 'auto', phase, input.themeId);
    return { phase, weatherKind };
  }

  private hasActiveOrWorkingAnimation(input: StageRenderInput): boolean {
    if (input.motion.hasActiveAnimations()) return true;
    for (const bot of Object.values(input.snapshot.bots)) {
      if (
        bot.status.kind === 'Working' ||
        bot.status.kind === 'NeedsOwner' ||
        bot.status.kind === 'Blocked' ||
        hasErrorDeskBeacon(bot)
      ) {
        return true;
      }
    }
    return false;
  }

  private hasAmbientIdleAnimation(input: StageRenderInput): boolean {
    const mode = input.atmosphereMode ?? 'auto';
    const displayTs = this.resolveDisplayTimestampMs(input);
    const phase = resolveAtmospherePhase(mode, displayTs);
    let idleCount = 0;
    for (const bot of Object.values(input.snapshot.bots)) {
      if (bot.status.kind === 'Idle') {
        idleCount += 1;
      }
      if (isBotLongIdle(bot, phase, displayTs)) {
        return true;
      }
    }
    return idleCount >= 2 && !input.replay?.isReplay;
  }

  private shouldAnimate(input: StageRenderInput): boolean {
    if (!this.active || !this.pageVisible) return false;
    if (this.camera.isAnimating()) return true;
    if (input.ownerAvatar?.roaming && (input.ownerAvatar.isMoving || input.ownerAvatar.ripple !== null)) {
      return true;
    }
    if (input.showCollabNetwork && input.collabEdges && input.collabEdges.length > 0) return true;
    if (input.motion.hasActiveAnimations()) return true;
    if (input.timelapseActive) return false;
    if (input.replay?.isReplay) {
      return input.replay.isPlaying;
    }
    if (this.resolveWeatherForInput(input).weatherKind !== 'clear') {
      return true;
    }
    if (this.hasActiveOrWorkingAnimation(input)) {
      return true;
    }
    return this.hasAmbientIdleAnimation(input);
  }

  private ensureAnimationLoopIfNeeded(): void {
    if (this.destroyed || !this.lastInput) return;
    if (this.shouldAnimate(this.lastInput)) {
      if (this.rafId === null) {
        this.lastFrameMs = performance.now();
        this.rafId = requestAnimationFrame(this.frameLoop);
      }
    } else if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private readonly frameLoop = (nowMs: number): void => {
    this.rafId = null;
    if (this.destroyed || !this.lastInput) return;

    const dtMs = Math.max(0, Math.min(250, nowMs - this.lastFrameMs));
    this.lastFrameMs = nowMs;
    const dtSecs = dtMs / 1000;

    this.tickAccumulatorMs += dtMs;
    if (this.tickAccumulatorMs >= 420) {
      this.animTick += 1;
      this.tickAccumulatorMs %= 420;
    }

    const input = this.lastInput;
    const theme = getThemeConfig(input.themeId, input.locale ?? 'en');
    const { weatherKind } = this.resolveWeatherForInput(input);
    const isPlayingReplay = Boolean(input.replay?.isReplay && input.replay.isPlaying);
    if (!isPlayingReplay && !input.timelapseActive) {
      input.motion.step(dtSecs, input.snapshot, theme, input.customDeskPositions);
      this.weather.step(dtSecs, weatherKind, theme.designSize);
    }
    if (this.camera.followBotId) {
      this.syncFollowTarget(input, theme.designSize, false);
    }
    const camStillAnimating = this.camera.step(dtSecs, theme.designSize);

    const isIdleOnlyAmbient =
      !camStillAnimating &&
      weatherKind === 'clear' &&
      !(input.showCollabNetwork && input.collabEdges && input.collabEdges.length > 0) &&
      !isPlayingReplay &&
      !this.hasActiveOrWorkingAnimation(input) &&
      this.hasAmbientIdleAnimation(input);
    if (!isIdleOnlyAmbient || nowMs - this.lastIdleAnimRenderMs >= 80) {
      this.lastIdleAnimRenderMs = nowMs;
      this.renderNow();
    }
    this.ensureAnimationLoopIfNeeded();
  };

  private findHitBotId(clientX: number, clientY: number): string | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    for (let i = this.hitBoxes.length - 1; i >= 0; i--) {
      const hb = this.hitBoxes[i];
      const [rx, ry, rw, rh] = hb.rect;
      if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) {
        return hb.botId;
      }
    }
    return null;
  }

  private screenClientToNormalized(clientX: number, clientY: number): [number, number] | null {
    if (!this.lastViewport) return null;
    const rect = this.canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const designX = (sx - this.lastViewport.originX) / Math.max(0.0001, this.lastViewport.scale);
    const designY = (sy - this.lastViewport.originY) / Math.max(0.0001, this.lastViewport.scale);
    return [
      designX / Math.max(1, this.lastViewport.designW),
      designY / Math.max(1, this.lastViewport.designH),
    ];
  }

  private readonly handleDoubleClick = (ev: MouseEvent): void => {
    if (!this.onDoubleClickFloor || !this.lastInput?.ownerAvatar?.roaming) return;
    const norm = this.screenClientToNormalized(ev.clientX, ev.clientY);
    if (norm) {
      this.onDoubleClickFloor(norm[0], norm[1]);
    }
  };

  private readonly handleClick = (ev: MouseEvent): void => {
    if (this.suppressNextClick) {
      this.suppressNextClick = false;
      return;
    }
    if (ev.altKey && this.onDoubleClickFloor && this.lastInput?.ownerAvatar?.roaming) {
      const norm = this.screenClientToNormalized(ev.clientX, ev.clientY);
      if (norm) {
        this.onDoubleClickFloor(norm[0], norm[1]);
        return;
      }
    }
    const botId = this.findHitBotId(ev.clientX, ev.clientY);
    if (botId) {
      this.onSelectBot(botId);
    }
  };

  private readonly handlePointerDown = (ev: PointerEvent): void => {
    if (ev.button !== 0 || !this.lastInput) return;
    const botId = this.findHitBotId(ev.clientX, ev.clientY);
    if (botId && this.onMoveBot) {
      const desk = this.lastInput.motion.layout.botDesks.get(botId);
      if (!desk) return;
      this.dragCandidate = {
        botId,
        pointerId: ev.pointerId,
        startClientX: ev.clientX,
        startClientY: ev.clientY,
        startDesignX: desk.x,
        startDesignY: desk.y,
        isDragging: false,
        currentPos: { x: desk.x, y: desk.y },
      };
      try {
        this.canvas.setPointerCapture?.(ev.pointerId);
      } catch {
        // Ignore capture errors in non-DOM/synthetic environments
      }
      return;
    }

    // Background drag-to-pan when zoomed > 1.0 and NOT starting on a bot
    if (!botId && this.camera.isZoomed()) {
      this.panDrag = {
        pointerId: ev.pointerId,
        lastClientX: ev.clientX,
        lastClientY: ev.clientY,
        moved: false,
      };
      this.canvas.style.cursor = 'grabbing';
      try {
        this.canvas.setPointerCapture?.(ev.pointerId);
      } catch {
        // Ignore capture errors
      }
    }
  };

  private readonly handlePointerMove = (ev: PointerEvent): void => {
    if (this.dragCandidate && ev.pointerId === this.dragCandidate.pointerId) {
      const dist = Math.hypot(
        ev.clientX - this.dragCandidate.startClientX,
        ev.clientY - this.dragCandidate.startClientY
      );
      if (!this.dragCandidate.isDragging && dist >= 6) {
        this.dragCandidate.isDragging = true;
        this.canvas.style.cursor = 'grabbing';
      }
      if (this.dragCandidate.isDragging && this.lastViewport) {
        const dxDesign = (ev.clientX - this.dragCandidate.startClientX) / this.lastViewport.scale;
        const dyDesign = (ev.clientY - this.dragCandidate.startClientY) / this.lastViewport.scale;
        this.dragCandidate.currentPos = clampDeskCoordinate({
          x: Math.round(this.dragCandidate.startDesignX + dxDesign),
          y: Math.round(this.dragCandidate.startDesignY + dyDesign),
        });
        this.renderNow();
      }
      return;
    }

    if (this.panDrag && ev.pointerId === this.panDrag.pointerId) {
      const dx = ev.clientX - this.panDrag.lastClientX;
      const dy = ev.clientY - this.panDrag.lastClientY;
      this.panDrag.lastClientX = ev.clientX;
      this.panDrag.lastClientY = ev.clientY;
      if (Math.hypot(dx, dy) >= 1) {
        this.panDrag.moved = true;
      }
      if (this.lastStageViewport) {
        this.camera.panByScreenDelta(dx, dy, this.lastStageViewport, true);
        this.onCameraChange?.();
        this.renderNow();
        this.ensureAnimationLoopIfNeeded();
      }
      return;
    }

    const hovered = this.findHitBotId(ev.clientX, ev.clientY);
    this.canvas.style.cursor = hovered
      ? this.onMoveBot
        ? 'grab'
        : 'pointer'
      : this.camera.isZoomed()
        ? 'grab'
        : 'default';
    this.onHoverBot?.(hovered);
  };

  private readonly handlePointerUp = (ev: PointerEvent): void => {
    if (this.panDrag && ev.pointerId === this.panDrag.pointerId) {
      try {
        this.canvas.releasePointerCapture?.(ev.pointerId);
      } catch {
        // Ignore release errors
      }
      const moved = this.panDrag.moved;
      this.panDrag = null;
      if (moved) {
        this.suppressNextClick = true;
        setTimeout(() => {
          this.suppressNextClick = false;
        }, 0);
      }
      this.canvas.style.cursor = this.camera.isZoomed() ? 'grab' : 'default';
      return;
    }

    if (!this.dragCandidate || ev.pointerId !== this.dragCandidate.pointerId) return;
    try {
      this.canvas.releasePointerCapture?.(ev.pointerId);
    } catch {
      // Ignore release errors
    }
    const cand = this.dragCandidate;
    this.dragCandidate = null;
    if (cand.isDragging) {
      this.suppressNextClick = true;
      setTimeout(() => {
        this.suppressNextClick = false;
      }, 0);
      this.canvas.style.cursor = this.onMoveBot ? 'grab' : 'pointer';
      this.onMoveBot?.(cand.botId, cand.currentPos);
      this.renderNow();
    } else {
      this.canvas.style.cursor = this.onMoveBot ? 'grab' : 'pointer';
    }
  };

  private readonly handlePointerCancel = (ev: PointerEvent): void => {
    if (this.panDrag && ev.pointerId === this.panDrag.pointerId) {
      try {
        this.canvas.releasePointerCapture?.(ev.pointerId);
      } catch {
        // Ignore release errors
      }
      this.panDrag = null;
      this.canvas.style.cursor = 'default';
      return;
    }
    if (!this.dragCandidate || ev.pointerId !== this.dragCandidate.pointerId) return;
    try {
      this.canvas.releasePointerCapture?.(ev.pointerId);
    } catch {
      // Ignore release errors
    }
    this.dragCandidate = null;
    this.canvas.style.cursor = 'default';
    this.renderNow();
  };

  private readonly handlePointerLeave = (ev: PointerEvent): void => {
    if (this.panDrag) {
      const hasCap = this.canvas.hasPointerCapture?.(ev.pointerId) ?? false;
      if (hasCap) return;
      this.panDrag = null;
    }
    if (this.dragCandidate) {
      const hasCap = this.canvas.hasPointerCapture?.(ev.pointerId) ?? false;
      if (hasCap) return;
      this.dragCandidate = null;
      this.renderNow();
    }
    this.canvas.style.cursor = 'default';
    this.onHoverBot?.(null);
  };

  private readonly handleWheel = (ev: WheelEvent): void => {
    if (!this.lastInput || !this.lastStageViewport) return;
    if (Math.abs(ev.deltaY) < 0.01) return;
    ev.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    const step = ev.deltaY < 0 ? CAMERA_ZOOM_STEP * 0.6 : -CAMERA_ZOOM_STEP * 0.6;
    const nextZoom = this.camera.targetZoom + step;
    this.camera.zoomAtScreenPoint(nextZoom, sx, sy, this.lastStageViewport, false);
    this.onCameraChange?.();
    this.renderNow();
    this.ensureAnimationLoopIfNeeded();
  };

  private getBgCache(targetW: number, targetH: number): CanvasRenderingContext2D | null {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      return null;
    }
    if (!this.bgCacheCanvas) {
      const c = document.createElement('canvas') as HTMLCanvasElement;
      if (!c || typeof c.getContext !== 'function') return null;
      const cctx = c.getContext('2d');
      if (!cctx) return null;
      this.bgCacheCanvas = c;
      this.bgCacheCtx = cctx;
      this.bgCacheKey = '';
    }
    if (this.bgCacheCanvas.width !== targetW || this.bgCacheCanvas.height !== targetH) {
      this.bgCacheCanvas.width = targetW;
      this.bgCacheCanvas.height = targetH;
      this.bgCacheKey = '';
    }
    return this.bgCacheCtx;
  }

  private paintBackgroundDirect(
    ctx: CanvasRenderingContext2D,
    cssW: number,
    cssH: number,
    vt: ViewportTransform,
    bgW: number,
    bgH: number,
    bgImg: HTMLImageElement | null,
    isCustomBg: boolean
  ): void {
    ctx.fillStyle = '#1c1917';
    ctx.fillRect(0, 0, cssW, cssH);
    if (bgImg) {
      if (isCustomBg) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(vt.originX, vt.originY, bgW, bgH);
        ctx.clip();
        const iw = bgImg.naturalWidth || bgW;
        const ih = bgImg.naturalHeight || bgH;
        const coverScale = Math.max(bgW / Math.max(1, iw), bgH / Math.max(1, ih));
        const dw = iw * coverScale;
        const dh = ih * coverScale;
        const dx = vt.originX + (bgW - dw) * 0.5;
        const dy = vt.originY + (bgH - dh) * 0.5;
        ctx.drawImage(bgImg, dx, dy, dw, dh);
        ctx.restore();
      } else {
        ctx.drawImage(bgImg, vt.originX, vt.originY, bgW, bgH);
      }
    } else {
      ctx.fillStyle = '#292524';
      ctx.fillRect(vt.originX, vt.originY, bgW, bgH);
    }
  }

  renderNow(): void {
    const input = this.lastInput;
    if (!input) return;

    const dpr = this.dpr;
    const cssW = this.cssW > 0 ? this.cssW : this.canvas.width / dpr;
    const cssH = this.cssH > 0 ? this.cssH : this.canvas.height / dpr;
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const locale = input.locale ?? 'en';
    const s = tStrings(locale);
    const theme: ThemeConfig = getThemeConfig(input.themeId, locale);
    const stageVp = createStageViewport(cssW, cssH, theme.designSize);
    this.lastStageViewport = stageVp;
    const vt = composeViewportTransform(stageVp, {
      zoom: this.camera.zoom,
      panX: this.camera.panX,
      panY: this.camera.panY,
    });
    this.lastViewport = vt;
    const bgW = vt.designW * vt.scale;
    const bgH = vt.designH * vt.scale;
    const customBgUrl = input.customBackground
      ? validateCustomAssetDataUrl(input.customBackground, 'background')
      : null;
    const customBgImg = customBgUrl ? this.loadImage(customBgUrl) : null;
    const bgImg = customBgImg ?? this.loadImage(resolveThemeAssetPath(input.themeId));
    const bgImgDim = bgImg ? `${bgImg.naturalWidth}x${bgImg.naturalHeight}` : 'none';
    const bgKey = `${this.canvas.width}x${this.canvas.height}:${dpr}:${input.themeId}:${customBgUrl ?? ''}:${bgImgDim}:${vt.originX.toFixed(2)},${vt.originY.toFixed(2)},${vt.scale.toFixed(4)}`;
    const bgCtx = this.getBgCache(this.canvas.width, this.canvas.height);
    if (bgCtx && this.bgCacheCanvas) {
      if (this.bgCacheKey !== bgKey) {
        bgCtx.save();
        bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        bgCtx.clearRect(0, 0, cssW, cssH);
        this.paintBackgroundDirect(
          bgCtx,
          cssW,
          cssH,
          vt,
          bgW,
          bgH,
          bgImg,
          Boolean(customBgImg)
        );
        bgCtx.restore();
        this.bgCacheKey = bgKey;
      }
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.bgCacheCanvas, 0, 0);
      ctx.restore();
    } else {
      this.paintBackgroundDirect(ctx, cssW, cssH, vt, bgW, bgH, bgImg, Boolean(customBgImg));
    }

    const { snapshot, motion, redactMode, selectedBotId, botAppearances } = input;
    const layout = motion.layout;
    const elapsedSecs = motion.elapsedSecs;
    const displayTimestampMs = this.resolveDisplayTimestampMs(input);
    const atmosphereMode = input.atmosphereMode ?? 'auto';
    const atmospherePhase = resolveAtmospherePhase(atmosphereMode, displayTimestampMs);
    const weatherKind = resolveWeatherKind(input.weatherMode ?? 'auto', atmospherePhase, input.themeId);
    this.weather.syncKind(weatherKind, theme.designSize);
    const pulseHigh = this.animTick % 2 === 0;
    const runtimeDimmed = !snapshot.runtime.connected && Object.keys(snapshot.bots).length > 0;
    const uiScale = Math.max(0.76, Math.min(1.18, vt.scale));
    const filterSet = input.filterMatchedBotIds ?? null;
    const filterActive = filterSet !== null;
    const mvpBotId = input.mvpBotId ?? null;

    const orderedBots: BotState[] =
      snapshot.botOrder.length > 0
        ? snapshot.botOrder
            .filter((id) => isSafeKey(id) && Object.hasOwn(snapshot.bots, id))
            .map((id) => snapshot.bots[id])
        : Object.values(snapshot.bots);

    type ActorRenderItem = {
      botId: string | null;
      footX: number;
      footY: number;
      zBias: number;
      spritePath: string;
      isCustomAvatar?: boolean;
      scale: number;
      anchor: [number, number];
      basePx: number;
      yBobPx: number;
      facing: Facing;
      carryProp: CarryProp | null;
      grayscale: boolean;
      dimmed: boolean;
      filterHighlighted: boolean;
      spotlighted: boolean;
      selected: boolean;
      needsOwner: boolean;
      isWorker: boolean;
      isOwner?: boolean;
      ownerTag?: string;
      nearbyHighlight?: boolean;
      isDragging?: boolean;
    };

    type BotOverlay = {
      botId: string;
      name: string;
      status: BotActivityStatus;
      taskTitle: string | null;
      screenX: number;
      screenY: number;
      spriteTopY: number;
      spriteRect: Rect;
      selected: boolean;
      activeWorkerCount: number;
      dimmed: boolean;
      isMvp: boolean;
      rpgLevel: number | null;
      stuckMinutes: number | null;
    };

    type WorkerOverlay = {
      provider: string;
      activity: string;
      unverifiableWarning: boolean;
      screenX: number;
      screenY: number;
      spriteRect: Rect;
      dimmed: boolean;
    };

    type DeskMiniProp = {
      glyph: string;
      bg: string;
      border: string;
      fg: string;
      screenX: number;
      screenY: number;
    };

    const stuckByBot = stuckAlertByBotMap(input.stuckAlerts ?? []);

    const actors: ActorRenderItem[] = [];
    const botOverlays: BotOverlay[] = [];
    const workerOverlays: WorkerOverlay[] = [];
    const deskProps: DeskMiniProp[] = [];

    orderedBots.forEach((bot, idx) => {
      const desk = layout.botDesks.get(bot.id);
      if (!desk) return;

      const isDraggingBot = Boolean(
        this.dragCandidate?.isDragging && this.dragCandidate.botId === bot.id
      );
      const rawPose = motion.actorPose(`bot:${bot.id}`, [desk.x, desk.y]);
      const pose = isDraggingBot
        ? {
            ...rawPose,
            footX: this.dragCandidate!.currentPos.x,
            footY: this.dragCandidate!.currentPos.y,
            isWalking: false,
          }
        : rawPose;
      const charId = resolveCharacterIdWithPrefs(botAppearances, bot.id, bot.name);
      const spec = CHARACTER_SPECS[charId];

      let yBobPx = 0;
      let xShakePx = 0;
      if (isDraggingBot) {
        yBobPx = -8 * vt.scale;
      } else if (pose.isWalking) {
        yBobPx = pose.yBobPx;
      } else if (bot.status.kind === 'Working') {
        yBobPx = (this.animTick + idx) % 2 === 0 ? -1.5 : 1.5;
      } else if (bot.status.kind === 'NeedsOwner') {
        yBobPx = -Math.abs(Math.sin(elapsedSecs * 6 + idx)) * 3.5;
      } else if (bot.status.kind === 'Blocked') {
        yBobPx = -Math.abs(Math.sin(elapsedSecs * 7.5 + idx * 0.9)) * 3.8;
        xShakePx = Math.sin(elapsedSecs * 14 + idx) * 1.8;
      }

      const selected = selectedBotId === bot.id;
      const needsOwner = bot.status.kind === 'NeedsOwner';
      const grayscale = bot.status.kind === 'Paused';
      const isMatched = !filterActive || filterSet.has(bot.id);
      const dimmed = filterActive && !isMatched;
      const filterHighlighted = filterActive && isMatched;
      const spotlighted =
        this.camera.spotlightBotId === bot.id && this.camera.spotlightRemainingSecs > 0;

      const rpgProf =
        input.rpgProfiles && isSafeKey(bot.id) && Object.hasOwn(input.rpgProfiles, bot.id)
          ? input.rpgProfiles[bot.id]
          : undefined;
      const nearbyHighlight = Boolean(
        input.ownerAvatar?.roaming && input.ownerAvatar.nearbyBotId === bot.id
      );

      const customAvatarUrl =
        input.customAvatars && isSafeKey(bot.id) && Object.hasOwn(input.customAvatars, bot.id)
          ? validateCustomAssetDataUrl(input.customAvatars[bot.id], 'avatar')
          : null;

      actors.push({
        botId: bot.id,
        footX: pose.footX + xShakePx,
        footY: pose.footY,
        zBias: isDraggingBot ? 10 : 0,
        spritePath: customAvatarUrl ?? resolveCharacterSpritePath(charId),
        isCustomAvatar: Boolean(customAvatarUrl),
        scale: customAvatarUrl ? 0.92 : spec.scale,
        anchor: spec.anchor,
        basePx: BOT_SPRITE_DESIGN_PX,
        yBobPx,
        facing: pose.facing,
        carryProp: pose.carryProp,
        grayscale,
        dimmed,
        filterHighlighted,
        spotlighted,
        selected,
        needsOwner,
        isWorker: false,
        nearbyHighlight,
        isDragging: isDraggingBot,
      });

      const [sx, sy] = designToScreen(vt, pose.footX, pose.footY);
      const sb = spriteBounds(
        vt,
        pose.footX + xShakePx,
        pose.footY,
        BOT_SPRITE_DESIGN_PX,
        spec.scale,
        spec.anchor,
        yBobPx
      );
      const cleanName = scrubAll(bot.name);
      const taskTitle = redactMode
        ? `${cleanName} · ${botStatusLabel(bot.status, locale)}`
        : bot.currentTaskTitle !== null
          ? scrubAll(bot.currentTaskTitle)
          : null;

      const stuckAlert = stuckByBot.get(bot.id);
      botOverlays.push({
        botId: bot.id,
        name: cleanName,
        status: bot.status,
        taskTitle,
        screenX: sx,
        screenY: sy,
        spriteTopY: sb[1],
        spriteRect: sb,
        selected,
        activeWorkerCount: bot.activeWorkerCount,
        dimmed,
        isMvp: mvpBotId === bot.id,
        rpgLevel: rpgProf ? rpgProf.level : null,
        stuckMinutes: stuckAlert ? stuckAlert.elapsedMinutes : null,
      });

      const hasVisibleWorker =
        Array.from(layout.workerSeats.values()).some((s) => s.parentBotId === bot.id) ||
        motion.activeWorkerMotions().some((m) => m.meta.parentBotId === bot.id);

      const deskPt = designToScreen(vt, desk.x, desk.y);
      const prop = this.buildDeskMiniProp(
        bot.status,
        desk.x,
        desk.y,
        layout.bossDesk,
        elapsedSecs + idx * 0.4,
        vt,
        deskPt,
        hasVisibleWorker,
        desk.workerOffset[0],
        redactMode
      );
      if (prop) deskProps.push(prop);
    });

    const workerSpec = CHARACTER_SPECS.worker_helper;
    const renderedWorkerIds = new Set<string>();
    let redactedWorkerBadgeIdx = 1;
    for (const worker of Object.values(snapshot.workers)) {
      if (!isWorkerVisibleOnStage(worker)) continue;
      const seat = layout.workerSeats.get(worker.dispatchId);
      if (!seat) continue;
      renderedWorkerIds.add(worker.dispatchId);

      const pose = motion.actorPose(`worker:${worker.dispatchId}`, [seat.x, seat.y]);
      const yBobPx = pose.isWalking
        ? pose.yBobPx
        : worker.activity === 'working' && this.animTick % 2 === 0
          ? -1.2
          : 0;

      const workerDimmed = filterActive && !filterSet.has(seat.parentBotId);
      actors.push({
        botId: null,
        footX: pose.footX,
        footY: pose.footY,
        zBias: 1,
        spritePath: resolveCharacterSpritePath('worker_helper'),
        scale: workerSpec.scale,
        anchor: workerSpec.anchor,
        basePx: WORKER_SPRITE_DESIGN_PX,
        yBobPx,
        facing: pose.facing,
        carryProp: pose.carryProp,
        grayscale: worker.liveness === 'Exited',
        dimmed: workerDimmed,
        filterHighlighted: false,
        spotlighted: false,
        selected: false,
        needsOwner: false,
        isWorker: true,
      });

      const [wx, wy] = designToScreen(vt, pose.footX, pose.footY);
      const wb = spriteBounds(
        vt,
        pose.footX,
        pose.footY,
        WORKER_SPRITE_DESIGN_PX,
        workerSpec.scale,
        workerSpec.anchor,
        yBobPx
      );
      const badgeProvider = redactMode
        ? s.workerNumbered(redactedWorkerBadgeIdx++)
        : shortProvider(scrubAll(worker.provider));
      workerOverlays.push({
        provider: badgeProvider,
        activity: scrubAll(worker.activity),
        unverifiableWarning: isWorkerUnverifiableWarning(worker),
        screenX: wx,
        screenY: wy,
        spriteRect: wb,
        dimmed: workerDimmed,
      });
    }

    for (const { meta, pose } of motion.activeWorkerMotions()) {
      if (renderedWorkerIds.has(meta.dispatchId)) continue;
      const motionDimmed =
        filterActive && (!meta.parentBotId || !filterSet.has(meta.parentBotId));
      actors.push({
        botId: null,
        footX: pose.footX,
        footY: pose.footY,
        zBias: 1,
        spritePath: resolveCharacterSpritePath('worker_helper'),
        scale: workerSpec.scale,
        anchor: workerSpec.anchor,
        basePx: WORKER_SPRITE_DESIGN_PX,
        yBobPx: pose.yBobPx,
        facing: pose.facing,
        carryProp: pose.carryProp,
        grayscale: meta.kind === 'Leaving' && meta.liveness === 'Exited',
        dimmed: motionDimmed,
        filterHighlighted: false,
        spotlighted: false,
        selected: false,
        needsOwner: false,
        isWorker: true,
      });
      const [wx, wy] = designToScreen(vt, pose.footX, pose.footY);
      const wb = spriteBounds(
        vt,
        pose.footX,
        pose.footY,
        WORKER_SPRITE_DESIGN_PX,
        workerSpec.scale,
        workerSpec.anchor,
        pose.yBobPx
      );
      const badgeProvider = redactMode
        ? s.workerNumbered(redactedWorkerBadgeIdx++)
        : shortProvider(scrubAll(meta.provider));
      workerOverlays.push({
        provider: badgeProvider,
        activity: scrubAll(meta.activity),
        unverifiableWarning: meta.liveness === 'Unverifiable' && meta.kind === 'Entering',
        screenX: wx,
        screenY: wy,
        spriteRect: wb,
        dimmed: motionDimmed,
      });
    }

    if (input.ownerAvatar?.roaming) {
      const ownerFootX = input.ownerAvatar.x * theme.designSize[0];
      const ownerFootY = input.ownerAvatar.y * theme.designSize[1];
      const bob = input.ownerAvatar.isMoving
        ? -Math.abs(Math.sin(input.ownerAvatar.walkPhase)) * 4.5 * vt.scale
        : Math.sin(elapsedSecs * 2.5) * 0.9 * vt.scale;
      actors.push({
        botId: null,
        footX: ownerFootX,
        footY: ownerFootY,
        zBias: 2,
        spritePath: resolveCharacterSpritePath('ddochi'),
        scale: 1,
        anchor: [0.5, 0.9],
        basePx: BOT_SPRITE_DESIGN_PX,
        yBobPx: bob,
        facing: input.ownerAvatar.facing,
        carryProp: null,
        grayscale: false,
        dimmed: false,
        filterHighlighted: false,
        spotlighted: false,
        selected: false,
        needsOwner: false,
        isWorker: false,
        isOwner: true,
        ownerTag: input.ownerAvatar.ownerTag,
      });
    }

    // Y-sort strictly by (footY, zBias)
    actors.sort((a, b) => a.footY - b.footY || a.zBias - b.zBias);
    botOverlays.sort((a, b) => a.screenY - b.screenY || a.botId.localeCompare(b.botId));

    // Team Zones Floor Overlay (drawn beneath desks, collab overlay, and actors)
    if (input.showZones !== false && input.zones && input.zones.length > 0) {
      this.paintTeamZonesOverlay(
        ctx,
        vt,
        theme.designSize,
        input.zones,
        redactMode,
        locale,
        uiScale
      );
    }

    // Collaboration Network Overlay (drawn beneath actors & nameplates)
    if (input.showCollabNetwork && input.collabEdges && input.collabEdges.length > 0) {
      this.paintCollabNetworkOverlay(
        ctx,
        vt,
        input.collabEdges,
        layout,
        motion,
        elapsedSecs,
        uiScale,
        filterSet
      );
    }

    // Owner Roaming destination ripple marker
    if (input.ownerAvatar?.roaming && input.ownerAvatar.ripple) {
      const rip = input.ownerAvatar.ripple;
      const t = Math.max(0, Math.min(1, rip.age / Math.max(0.01, rip.ttl)));
      const [rx, ry] = designToScreen(
        vt,
        rip.x * theme.designSize[0],
        rip.y * theme.designSize[1]
      );
      const rad = (6 + t * 22) * vt.scale;
      ctx.save();
      ctx.globalAlpha = Math.max(0, (1 - t) * 0.85);
      ctx.beginPath();
      ctx.ellipse(rx, ry, rad, rad * 0.45, 0, 0, Math.PI * 2);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2 * Math.max(0.7, uiScale);
      ctx.stroke();
      ctx.restore();
    }

    // Paint actors
    for (const actor of actors) {
      const [fx, fy] = designToScreen(vt, actor.footX, actor.footY);
      const shadowW = (actor.isWorker ? 40 : 56) * vt.scale;
      const shadowH = (actor.isWorker ? 12 : 16) * vt.scale;
      const sx = fx - shadowW * 0.5;
      const sy = fy - shadowH * 0.45;

      ctx.save();
      if (actor.dimmed) {
        ctx.globalAlpha = 0.24;
      }

      if (actor.spotlighted) {
        const pulse = 0.5 + 0.5 * Math.sin(this.camera.spotlightElapsedSecs * 7.5);
        const rx = shadowW * (0.76 + pulse * 0.14);
        const ry = shadowH * (0.95 + pulse * 0.2);
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(fx, fy - 2 * vt.scale, rx, ry, 0, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(250, 204, 21, ${0.14 + pulse * 0.14})`;
        ctx.fill();
        ctx.lineWidth = 2.4 * Math.max(0.8, uiScale);
        ctx.strokeStyle = `rgba(250, 204, 21, ${0.65 + pulse * 0.35})`;
        ctx.stroke();
        ctx.restore();
      } else if (actor.filterHighlighted && !actor.selected) {
        drawRoundedRect(ctx, sx - 6, sy - 4, shadowW + 12, shadowH + 8, 14);
        ctx.fillStyle = 'rgba(56, 189, 248, 0.14)';
        ctx.fill();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.72)';
        ctx.stroke();
      }

      if (actor.nearbyHighlight) {
        ctx.save();
        drawRoundedRect(ctx, sx - 8, sy - 6, shadowW + 16, shadowH + 12, 16);
        ctx.fillStyle = 'rgba(250, 204, 21, 0.22)';
        ctx.fill();
        ctx.lineWidth = 2.2;
        ctx.strokeStyle = '#fbbf24';
        ctx.stroke();
        ctx.restore();
      }

      if (actor.isDragging) {
        ctx.save();
        drawRoundedRect(ctx, sx - 8, sy - 6, shadowW + 16, shadowH + 12, 16);
        ctx.fillStyle = 'rgba(56, 189, 248, 0.16)';
        ctx.fill();
        ctx.setLineDash([5 * vt.scale, 4 * vt.scale]);
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#38bdf8';
        ctx.stroke();
        ctx.restore();
      } else if (actor.selected) {
        drawRoundedRect(ctx, sx - 5, sy - 4, shadowW + 10, shadowH + 8, 14);
        ctx.fillStyle = 'rgba(56, 189, 248, 0.2)';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#38bdf8';
        ctx.stroke();
      } else if (actor.needsOwner) {
        drawRoundedRect(ctx, sx - 4, sy - 3, shadowW + 8, shadowH + 6, 14);
        ctx.fillStyle = 'rgba(250, 204, 21, 0.18)';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = pulseHigh ? '#facc15' : '#f59e0b';
        ctx.stroke();
      }

      drawRoundedRect(ctx, sx, sy, shadowW, shadowH, 12);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.28)';
      ctx.fill();

      if (actor.isOwner) {
        this.paintOwnerAvatar(
          ctx,
          fx,
          fy + actor.yBobPx,
          vt.scale,
          actor.facing,
          actor.ownerTag ?? 'YOU',
          uiScale
        );
        ctx.restore();
        continue;
      }

      const sb = spriteBounds(
        vt,
        actor.footX,
        actor.footY,
        actor.basePx,
        actor.scale,
        actor.anchor,
        actor.yBobPx
      );
      const spriteImg = this.loadImage(actor.spritePath);
      ctx.save();
      if (actor.grayscale || runtimeDimmed) {
        ctx.filter = 'grayscale(90%) opacity(75%)';
      }
      if (spriteImg) {
        if (actor.isCustomAvatar) {
          const pad = Math.min(sb[2], sb[3]) * 0.08;
          const bx = sb[0] + pad;
          const by = sb[1] + pad;
          const bw = Math.max(8, sb[2] - pad * 2);
          const bh = Math.max(8, sb[3] - pad * 2);
          const rad = Math.max(6, Math.min(bw, bh) * 0.28);
          drawRoundedRect(ctx, bx, by + 2 * vt.scale, bw, bh, rad);
          ctx.fillStyle = 'rgba(15, 23, 42, 0.32)';
          ctx.fill();
          drawRoundedRect(ctx, bx, by, bw, bh, rad);
          ctx.fillStyle = '#181c26';
          ctx.fill();

          ctx.save();
          drawRoundedRect(ctx, bx, by, bw, bh, rad);
          ctx.clip();
          ctx.drawImage(spriteImg, bx, by, bw, bh);
          ctx.restore();

          drawRoundedRect(ctx, bx, by, bw, bh, rad);
          ctx.lineWidth = Math.max(1.2, 1.8 * vt.scale);
          ctx.strokeStyle = actor.selected ? '#38bdf8' : 'rgba(248, 250, 252, 0.85)';
          ctx.stroke();
        } else {
          ctx.drawImage(spriteImg, sb[0], sb[1], sb[2], sb[3]);
        }
      } else {
        drawRoundedRect(ctx, sb[0], sb[1], sb[2], sb[3], 10);
        ctx.fillStyle = '#334155';
        ctx.fill();
      }
      ctx.restore();

      if (actor.carryProp) {
        const dir = actor.facing === 'Left' ? -1 : 1;
        const [cx, cy] = designToScreen(vt, actor.footX + dir * 24, actor.footY - 30);
        this.paintCarryProp(ctx, actor.carryProp, cx, cy + actor.yBobPx, vt.scale);
      }
      ctx.restore();
    }

    // Flying props, curved couriers & particles
    for (const fp of motion.flyingProps) {
      this.paintFlyingProp(ctx, vt, fp);
    }
    for (const courier of motion.couriers.slice(0, MAX_COURIERS)) {
      this.paintFlyingCourier(ctx, vt, courier);
    }
    for (const p of motion.particles.slice(0, MAX_PARTICLES)) {
      this.paintParticle(ctx, vt, p);
    }

    // Atmosphere lighting glaze & desk lamps (before UI nameplates/bubbles so text stays 100% crisp)
    this.paintAtmosphereOverlay(
      ctx,
      vt,
      bgW,
      bgH,
      atmospherePhase,
      orderedBots,
      layout.botDesks,
      layout.bossDesk
    );

    // Ambient Weather Layer (rain, snow, starlight)
    this.paintWeatherOverlay(ctx, vt, bgW, bgH, weatherKind, atmospherePhase, elapsedSecs);

    // Cozy ambient details: coffee mug steam, long-idle Zzz floaters & error desk beacon/smoke
    this.paintCozyAmbientDetails(
      ctx,
      vt,
      orderedBots,
      layout.botDesks,
      motion,
      atmospherePhase,
      displayTimestampMs,
      elapsedSecs,
      filterSet
    );

    // RPG unlockable pixel desk props on each bot's desk surface
    this.paintRpgDeskProps(
      ctx,
      vt,
      orderedBots,
      layout.botDesks,
      input.rpgProfiles,
      elapsedSecs,
      filterSet
    );

    // Huddle / Mini Standup golden collaboration sparkle rings (visible even with Collab Overlay OFF)
    if (motion.huddles.length > 0) {
      this.paintHuddleSparkles(ctx, vt, motion.huddles, uiScale);
    }

    // Overlays & obstacles for speech bubbles
    const obstacles: Rect[] = [];
    const bgLeft = vt.originX;
    const bgTop = vt.originY;
    const bgRight = bgLeft + bgW;
    const bgBottom = bgTop + bgH;

    // Landmarks
    const landmarks: Array<[number, number, string, string]> = [
      [theme.bossDesk.x, theme.bossDesk.y - 38, `★ ${theme.bossDesk.label}`, 'rgba(194, 134, 10, 0.94)'],
      [theme.officeDoor.x, theme.officeDoor.y - 30, `▸ ${theme.officeDoor.label}`, 'rgba(28, 118, 156, 0.92)'],
      [theme.automationBoard.x, theme.automationBoard.y - 26, `◷ ${theme.automationBoard.label}`, 'rgba(98, 48, 166, 0.92)'],
    ];
    const landmarkRects: Rect[] = [];
    for (const [lx, ly, label, bg] of landmarks) {
      const rect = this.paintLandmark(ctx, vt, lx, ly, label, bg, uiScale, bgLeft, bgTop, bgRight, bgBottom);
      obstacles.push(rect);
      landmarkRects.push(rect);
    }

    const bounds: Rect = [bgLeft, bgTop, bgRight - bgLeft, bgBottom - bgTop];
    if (input.brand) {
      const brandRect = this.paintBrand(ctx, input.brand, landmarkRects[0], uiScale, bounds, input.redactMode);
      if (brandRect) obstacles.push(brandRect);
    }
    if (input.projectBoard) {
      const nowMs = input.displayTimestampMs ?? Date.now();
      obstacles.push(
        this.paintProjectBoard(ctx, input.projectBoard, landmarkRects[2], uiScale, bounds, input.redactMode, nowMs, s)
      );
    }

    // Desk mini-props
    for (const dp of deskProps) {
      const left = Math.max(bgLeft + 4, Math.min(bgRight - 34 * uiScale, dp.screenX));
      const top = Math.max(bgTop + 4, Math.min(bgBottom - 24 * uiScale, dp.screenY));
      ctx.font = `700 ${Math.round(10 * uiScale)}px ${CANVAS_FONT_FAMILY}`;
      const estW = Math.max(24 * uiScale, ctx.measureText(dp.glyph).width + 12 * uiScale);
      const estH = 20 * uiScale;
      drawRoundedRect(ctx, left, top, estW, estH, 6 * uiScale);
      ctx.fillStyle = dp.bg;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = dp.border;
      ctx.stroke();
      ctx.fillStyle = dp.fg;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillText(dp.glyph, left + estW * 0.5, top + estH * 0.5);
      obstacles.push([left, top, estW, estH]);
    }

    // Worker mini badges
    for (const w of workerOverlays) {
      obstacles.push(w.spriteRect);
      const label = w.unverifiableWarning ? `${w.provider} ?` : w.provider;
      const badgeBg = w.unverifiableWarning
        ? 'rgba(100, 116, 139, 0.94)'
        : w.activity === 'blocked'
          ? 'rgba(234, 88, 12, 0.94)'
          : 'rgba(15, 118, 110, 0.94)';
      ctx.save();
      if (w.dimmed) ctx.globalAlpha = 0.24;
      ctx.font = `600 ${Math.round(9 * uiScale)}px ${CANVAS_FONT_FAMILY}`;
      const estW = Math.max(32 * uiScale, ctx.measureText(label).width + 12 * uiScale);
      const estH = 18 * uiScale;
      const left = Math.max(bgLeft + 4, Math.min(bgRight - estW - 4, w.screenX - 20 * vt.scale));
      const top = Math.max(bgTop + 4, Math.min(bgBottom - estH - 4, w.screenY - 46 * vt.scale));
      drawRoundedRect(ctx, left, top, estW, estH, 5 * uiScale);
      ctx.fillStyle = badgeBg;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, left + estW * 0.5, top + estH * 0.5);
      ctx.restore();
      obstacles.push([left, top, estW, estH]);
    }

    // Bot overlays + hitboxes
    const isCrowdedStage = orderedBots.length > 14;
    const npScale = isCrowdedStage ? uiScale * 0.9 : uiScale;
    const boxWScale = isCrowdedStage ? 0.9 : 1;
    const nextHitBoxes: HitBox[] = [];
    for (const overlay of botOverlays) {
      obstacles.push(overlay.spriteRect);
      const boxW = Math.max(96 * boxWScale, Math.min(148 * boxWScale, 138 * vt.scale * boxWScale));
      const left = Math.max(bgLeft + 4, Math.min(bgRight - boxW - 4, overlay.screenX - boxW * 0.5));
      const spriteSpan = Math.max(26 * uiScale, overlay.screenY - overlay.spriteTopY);
      const spacerH = spriteSpan + 2 * npScale;
      const hasCallout = overlay.status.kind === 'NeedsOwner';
      const calloutH = hasCallout ? 20 * npScale : 0;
      const pillH = overlay.taskTitle ? 38 * npScale : 24 * npScale;
      const estHeight = spacerH + pillH + calloutH;
      const desiredTop = overlay.spriteTopY - (hasCallout ? 20 * npScale : 0);
      const top = Math.max(bgTop + 4, Math.min(bgBottom - estHeight - 4, desiredTop));

      ctx.save();
      if (overlay.dimmed) ctx.globalAlpha = 0.24;

      if (overlay.isMvp) {
        const crownW = 20 * npScale;
        const crownH = 16 * npScale;
        const crownX = hasCallout
          ? Math.min(bgRight - crownW - 4, overlay.spriteRect[0] + overlay.spriteRect[2] - 4 * npScale)
          : overlay.screenX - crownW * 0.5;
        const crownY = Math.max(bgTop + 3, overlay.spriteTopY - crownH - (hasCallout ? 2 : 3) * npScale);
        drawRoundedRect(ctx, crownX, crownY, crownW, crownH, 6 * npScale);
        ctx.fillStyle = 'rgba(250, 204, 21, 0.96)';
        ctx.fill();
        ctx.strokeStyle = '#92400e';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.font = `700 ${Math.round(10 * npScale)}px ${CANVAS_FONT_FAMILY}`;
        ctx.fillStyle = '#451a03';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('👑', crownX + crownW * 0.5, crownY + crownH * 0.52);
        obstacles.push([crownX, crownY, crownW, crownH]);
      }

      if (overlay.status.kind === 'NeedsOwner') {
        const notice = s.calloutNeedsOwner(overlay.status.count);
        drawRoundedRect(ctx, left, top, boxW, calloutH - 2, 7 * npScale);
        ctx.fillStyle = pulseHigh ? '#facc15' : '#fbbf24';
        ctx.fill();
        ctx.strokeStyle = '#78350f';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.font = `700 ${Math.round(9.5 * npScale)}px ${CANVAS_FONT_FAMILY}`;
        ctx.fillStyle = '#451a03';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(
          truncateTextToWidth(ctx, notice, boxW - 8),
          left + boxW * 0.5,
          top + (calloutH - 2) * 0.5
        );
        obstacles.push([left, top, boxW, calloutH]);
      }

      const pillTop = top + calloutH + spacerH;
      obstacles.push([left, pillTop, boxW, pillH]);

      drawRoundedRect(ctx, left, pillTop, boxW, pillH, 8 * npScale);
      ctx.fillStyle = overlay.selected ? 'rgba(15, 23, 42, 0.95)' : 'rgba(24, 24, 27, 0.88)';
      ctx.fill();
      ctx.lineWidth = overlay.selected ? 1.6 : 1;
      ctx.strokeStyle = overlay.selected
        ? '#38bdf8'
        : hasCallout
          ? pulseHigh
            ? '#facc15'
            : '#f59e0b'
          : 'rgba(255,255,255,0.2)';
      ctx.stroke();

      const badge = statusBadgeStyle(overlay.status, redactMode, locale);
      const workerTag = overlay.activeWorkerCount > 0 ? `+${overlay.activeWorkerCount}` : null;
      ctx.font = `600 ${Math.round(9 * npScale)}px ${CANVAS_FONT_FAMILY}`;
      const badgeW = Math.min(boxW * 0.45, ctx.measureText(badge.text).width + 10 * npScale);
      const workerW = workerTag ? ctx.measureText(workerTag).width + 8 * npScale : 0;
      const rowY = pillTop + (overlay.taskTitle ? 11 * npScale : pillH * 0.5);

      const rightUsed = badgeW + (workerW > 0 ? workerW + 3 : 0) + 6 * npScale;
      const nameMaxW = Math.max(24, boxW - rightUsed - 8 * npScale);
      ctx.font = `600 ${Math.round(10.5 * npScale)}px ${CANVAS_FONT_FAMILY}`;
      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(truncateTextToWidth(ctx, overlay.name, nameMaxW), left + 6 * npScale, rowY);

      let cursorRight = left + boxW - 5 * npScale;
      if (workerTag) {
        const wx = cursorRight - workerW;
        drawRoundedRect(ctx, wx, rowY - 7 * npScale, workerW, 14 * npScale, 4 * npScale);
        ctx.fillStyle = '#0f766e';
        ctx.fill();
        ctx.font = `600 ${Math.round(8.5 * npScale)}px ${CANVAS_FONT_FAMILY}`;
        ctx.fillStyle = '#ccfbf1';
        ctx.textAlign = 'center';
        ctx.fillText(workerTag, wx + workerW * 0.5, rowY);
        cursorRight = wx - 3;
      }

      const bx = cursorRight - badgeW;
      drawRoundedRect(ctx, bx, rowY - 7 * npScale, badgeW, 14 * npScale, 4 * npScale);
      ctx.fillStyle = badge.bg;
      ctx.fill();
      ctx.font = `600 ${Math.round(8.5 * npScale)}px ${CANVAS_FONT_FAMILY}`;
      ctx.fillStyle = badge.fg;
      ctx.textAlign = 'center';
      ctx.fillText(truncateTextToWidth(ctx, badge.text, badgeW - 4), bx + badgeW * 0.5, rowY);

      if (overlay.taskTitle) {
        ctx.font = `400 ${Math.round(9 * npScale)}px ${CANVAS_FONT_FAMILY}`;
        ctx.fillStyle = '#cbd5e1';
        ctx.textAlign = 'center';
        ctx.fillText(
          truncateTextToWidth(ctx, overlay.taskTitle, boxW - 10 * npScale),
          left + boxW * 0.5,
          pillTop + 27 * npScale
        );
      }

      let hasLvBadge = false;
      let lvYPos = pillTop;
      let lvRightEdge = left;
      if (overlay.rpgLevel !== null && overlay.rpgLevel >= 1) {
        const lvText = `Lv.${overlay.rpgLevel}`;
        ctx.font = `700 ${Math.round(8.5 * npScale)}px ${CANVAS_FONT_FAMILY}`;
        const lvW = Math.max(24 * npScale, ctx.measureText(lvText).width + 8 * npScale);
        const lvH = 13 * npScale;
        const lvX = left + 2 * npScale;
        const lvY = Math.max(bgTop + 3, pillTop - lvH - 2 * npScale);
        drawRoundedRect(ctx, lvX, lvY, lvW, lvH, 5 * npScale);
        ctx.fillStyle = overlay.rpgLevel >= 5 ? 'rgba(180, 83, 9, 0.94)' : 'rgba(67, 56, 202, 0.92)';
        ctx.fill();
        ctx.strokeStyle = overlay.rpgLevel >= 5 ? '#facc15' : 'rgba(165, 180, 252, 0.85)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = '#fefce8';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(lvText, lvX + lvW * 0.5, lvY + lvH * 0.52);
        obstacles.push([lvX, lvY, lvW, lvH]);
        hasLvBadge = true;
        lvYPos = lvY;
        lvRightEdge = lvX + lvW + 3 * npScale;
      }

      if (overlay.stuckMinutes !== null && overlay.stuckMinutes > 0) {
        const stuckText = s.watchdogBadge(overlay.stuckMinutes);
        ctx.font = `700 ${Math.round(8.5 * npScale)}px ${CANVAS_FONT_FAMILY}`;
        const stuckW = Math.max(38 * npScale, ctx.measureText(stuckText).width + 10 * npScale);
        const stuckH = 13 * npScale;
        const desiredStuckX = left + boxW - stuckW - 2 * npScale;
        const overlapsLevel = hasLvBadge && desiredStuckX < lvRightEdge;
        let stuckX = desiredStuckX;
        let stuckY = Math.max(bgTop + 3, pillTop - stuckH - 2 * npScale);
        if (overlapsLevel) {
          const aboveLvY = lvYPos - stuckH - 2 * npScale;
          if (aboveLvY >= bgTop + 3) {
            stuckY = aboveLvY;
          } else {
            // At top clamp, shift horizontally beside Lv. badge instead of stacking onto the same Y
            stuckX = lvRightEdge;
            stuckY = lvYPos;
          }
        }
        drawRoundedRect(ctx, stuckX, stuckY, stuckW, stuckH, 5 * npScale);
        ctx.fillStyle = 'rgba(120, 53, 15, 0.90)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.82)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = '#fef3c7';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(stuckText, stuckX + stuckW * 0.5, stuckY + stuckH * 0.52);
        obstacles.push([stuckX, stuckY, stuckW, stuckH]);
      }
      ctx.restore();

      // Click hitbox covers both sprite and nameplate
      const hbLeft = Math.min(overlay.spriteRect[0], left);
      const hbTop = Math.min(overlay.spriteRect[1], top);
      const hbRight = Math.max(overlay.spriteRect[0] + overlay.spriteRect[2], left + boxW);
      const hbBottom = Math.max(overlay.spriteRect[1] + overlay.spriteRect[3], pillTop + pillH);
      nextHitBoxes.push({
        botId: overlay.botId,
        rect: [hbLeft, hbTop, hbRight - hbLeft, hbBottom - hbTop],
      });
    }
    this.hitBoxes = nextHitBoxes;

    // Speech bubbles (max 5, obstacle-avoiding)
    for (const bubble of motion.bubbles.slice(0, MAX_BUBBLES)) {
      const [ax, ay] = motion.bubbleAnchorPos(bubble);
      const [sx, sy] = designToScreen(vt, ax, ay);
      const text = redactMode ? bubble.redactedText : bubble.normalText;
      const estW = estimateBubbleWidth(text);
      const estH = 26;
      const [bLeft, bTop] = placeSpeechBubble(
        sx,
        sy,
        vt.scale,
        estW,
        estH,
        [bgLeft, bgTop, bgRight, bgBottom],
        obstacles
      );
      obstacles.push([bLeft, bTop, estW, estH]);
      const col = bubbleColors(bubble.kind);
      drawRoundedRect(ctx, bLeft, bTop, estW, estH, 9);
      ctx.fillStyle = col.bg;
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = col.border;
      ctx.stroke();
      ctx.font = `600 10.5px ${CANVAS_FONT_FAMILY}`;
      ctx.fillStyle = col.fg;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(truncateTextToWidth(ctx, text, estW - 14), bLeft + estW * 0.5, bTop + estH * 0.5);
    }

    // Milestone celebration banner pill (top-center, translucent, unobtrusive)
    if (motion.milestoneBanner) {
      this.paintMilestoneBanner(ctx, vt, bgW, motion.milestoneBanner, s.milestoneBannerText(motion.milestoneBanner.count), uiScale);
    }

    ctx.restore();
  }

  private paintAtmosphereOverlay(
    ctx: CanvasRenderingContext2D,
    vt: ViewportTransform,
    bgW: number,
    bgH: number,
    phase: AtmospherePhase,
    orderedBots: readonly BotState[],
    botDesks: ReadonlyMap<string, { x: number; y: number; workerOffset: [number, number] }>,
    bossDesk: [number, number]
  ): void {
    ctx.save();
    ctx.beginPath();
    ctx.rect(vt.originX, vt.originY, bgW, bgH);
    ctx.clip();

    if (phase === 'day') {
      const beam = ctx.createLinearGradient(
        vt.originX + bgW * 0.08,
        vt.originY,
        vt.originX + bgW * 0.56,
        vt.originY + bgH * 0.68
      );
      beam.addColorStop(0, 'rgba(255, 248, 220, 0.065)');
      beam.addColorStop(0.55, 'rgba(255, 248, 220, 0.03)');
      beam.addColorStop(1, 'rgba(255, 248, 220, 0)');
      ctx.fillStyle = beam;
      ctx.beginPath();
      ctx.moveTo(vt.originX + bgW * 0.06, vt.originY);
      ctx.lineTo(vt.originX + bgW * 0.34, vt.originY);
      ctx.lineTo(vt.originX + bgW * 0.62, vt.originY + bgH * 0.72);
      ctx.lineTo(vt.originX + bgW * 0.24, vt.originY + bgH * 0.72);
      ctx.closePath();
      ctx.fill();
    } else if (phase === 'sunset') {
      ctx.fillStyle = 'rgba(255, 138, 76, 0.14)';
      ctx.fillRect(vt.originX, vt.originY, bgW, bgH);

      const rayGrad = ctx.createLinearGradient(
        vt.originX + bgW * 0.05,
        vt.originY,
        vt.originX + bgW * 0.72,
        vt.originY + bgH * 0.85
      );
      rayGrad.addColorStop(0, 'rgba(255, 206, 120, 0.16)');
      rayGrad.addColorStop(0.6, 'rgba(255, 148, 86, 0.05)');
      rayGrad.addColorStop(1, 'rgba(255, 138, 76, 0)');
      ctx.fillStyle = rayGrad;
      ctx.beginPath();
      ctx.moveTo(vt.originX + bgW * 0.04, vt.originY);
      ctx.lineTo(vt.originX + bgW * 0.38, vt.originY);
      ctx.lineTo(vt.originX + bgW * 0.76, vt.originY + bgH * 0.9);
      ctx.lineTo(vt.originX + bgW * 0.28, vt.originY + bgH * 0.9);
      ctx.closePath();
      ctx.fill();

      const depthGrad = ctx.createRadialGradient(
        vt.originX + bgW * 0.5,
        vt.originY + bgH * 0.42,
        bgW * 0.24,
        vt.originX + bgW * 0.5,
        vt.originY + bgH * 0.5,
        bgW * 0.72
      );
      depthGrad.addColorStop(0, 'rgba(67, 20, 7, 0)');
      depthGrad.addColorStop(1, 'rgba(67, 20, 7, 0.16)');
      ctx.fillStyle = depthGrad;
      ctx.fillRect(vt.originX, vt.originY, bgW, bgH);
    } else {
      ctx.fillStyle = 'rgba(12, 20, 44, 0.34)';
      ctx.fillRect(vt.originX, vt.originY, bgW, bgH);

      // Subtle warm pendant glow on Owner Desk
      const [bx, by] = designToScreen(vt, bossDesk[0], bossDesk[1] - 20);
      const bossRadius = 115 * vt.scale;
      const bossGlow = ctx.createRadialGradient(bx, by, 6 * vt.scale, bx, by, bossRadius);
      bossGlow.addColorStop(0, 'rgba(255, 214, 138, 0.18)');
      bossGlow.addColorStop(0.55, 'rgba(255, 198, 108, 0.08)');
      bossGlow.addColorStop(1, 'rgba(255, 214, 138, 0)');
      ctx.fillStyle = bossGlow;
      ctx.beginPath();
      ctx.arc(bx, by, bossRadius, 0, Math.PI * 2);
      ctx.fill();

      // Warm desk lamp radial glow over each Working or NeedsOwner bot desk
      const lampRadius = 104 * vt.scale;
      for (const bot of orderedBots) {
        if (bot.status.kind !== 'Working' && bot.status.kind !== 'NeedsOwner') continue;
        const desk = botDesks.get(bot.id);
        if (!desk) continue;
        const [lx, ly] = designToScreen(vt, desk.x, desk.y - 24);
        const lampGlow = ctx.createRadialGradient(lx, ly, 4 * vt.scale, lx, ly, lampRadius);
        lampGlow.addColorStop(0, 'rgba(255, 214, 138, 0.24)');
        lampGlow.addColorStop(0.5, 'rgba(255, 204, 118, 0.11)');
        lampGlow.addColorStop(1, 'rgba(255, 214, 138, 0)');
        ctx.fillStyle = lampGlow;
        ctx.beginPath();
        ctx.arc(lx, ly, lampRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
  }

  private paintTeamZonesOverlay(
    ctx: CanvasRenderingContext2D,
    vt: ViewportTransform,
    designSize: readonly [number, number],
    zones: readonly TeamZone[],
    redactMode: boolean,
    locale: UiLocale,
    uiScale: number
  ): void {
    const [designW, designH] = designSize;
    ctx.save();
    zones.forEach((zone, idx) => {
      const palette = zoneColorPalette(zone.color);
      const [zx, zy] = designToScreen(vt, zone.x * designW, zone.y * designH);
      const zw = zone.w * designW * vt.scale;
      const zh = zone.h * designH * vt.scale;
      const radius = 14 * vt.scale;

      drawRoundedRect(ctx, zx, zy, zw, zh, radius);
      ctx.fillStyle = palette.fill;
      ctx.fill();

      ctx.save();
      ctx.setLineDash([6 * vt.scale, 4 * vt.scale]);
      ctx.lineWidth = 1.6 * uiScale;
      ctx.strokeStyle = palette.border;
      ctx.stroke();
      ctx.restore();

      const label = formatZoneDisplayLabel(zone, idx, redactMode, locale);
      ctx.font = `700 ${Math.round(9.5 * uiScale)}px ${CANVAS_FONT_FAMILY}`;
      const padX = 7 * uiScale;
      const pillW = Math.min(Math.max(36 * uiScale, zw - 12 * uiScale), ctx.measureText(label).width + padX * 2);
      const pillH = 18 * uiScale;
      const pillX = zx + 7 * uiScale;
      const pillY = zy + 7 * uiScale;

      drawRoundedRect(ctx, pillX, pillY, pillW, pillH, 6 * uiScale);
      ctx.fillStyle = palette.pillBg;
      ctx.fill();
      ctx.strokeStyle = palette.border;
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = palette.pillFg;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(truncateTextToWidth(ctx, label, pillW - padX), pillX + pillW * 0.5, pillY + pillH * 0.52);
    });
    ctx.restore();
  }

  private paintCozyAmbientDetails(
    ctx: CanvasRenderingContext2D,
    vt: ViewportTransform,
    orderedBots: readonly BotState[],
    botDesks: ReadonlyMap<string, { x: number; y: number; workerOffset: [number, number] }>,
    motion: MotionDirector,
    phase: AtmospherePhase,
    displayTimestampMs: number,
    elapsedSecs: number,
    filterSet: ReadonlySet<string> | null
  ): void {
    const s = Math.max(0.55, vt.scale);
    orderedBots.forEach((bot, idx) => {
      const desk = botDesks.get(bot.id);
      if (!desk) return;
      const pose = motion.actorPose(`bot:${bot.id}`, [desk.x, desk.y]);
      if (pose.isWalking) return;
      const [sx, sy] = designToScreen(vt, pose.footX, pose.footY);
      const dimmedAlpha = filterSet !== null && !filterSet.has(bot.id) ? 0.24 : 1;

      // Steaming coffee mug for Working bots during sunset or night
      if (bot.status.kind === 'Working' && (phase === 'sunset' || phase === 'night')) {
        const sideSign = desk.workerOffset[0] > 0 ? -1 : 1;
        const mx = sx + sideSign * 30 * s;
        const my = sy - 10 * s;
        ctx.save();
        ctx.globalAlpha = dimmedAlpha;
        // Mug body
        drawRoundedRect(ctx, mx - 5.5 * s, my - 5 * s, 11 * s, 9.5 * s, 2.2 * s);
        ctx.fillStyle = '#f8fafc';
        ctx.fill();
        ctx.strokeStyle = '#78350f';
        ctx.lineWidth = 1.2 * s;
        ctx.stroke();
        // Coffee rim
        ctx.fillStyle = '#6b3e1f';
        ctx.fillRect(mx - 4.2 * s, my - 4.2 * s, 8.4 * s, 2 * s);
        // Handle
        ctx.beginPath();
        ctx.arc(mx + 5.8 * s, my - 0.5 * s, 2.7 * s, -Math.PI * 0.5, Math.PI * 0.5);
        ctx.strokeStyle = '#e2e8f0';
        ctx.lineWidth = 1.3 * s;
        ctx.stroke();
        // Rising steam wisps
        for (let w = 0; w < 2; w++) {
          const cycle = (elapsedSecs * 0.75 + idx * 0.37 + w * 0.48) % 1;
          const wy = my - 7 * s - cycle * 14 * s;
          const wx = mx + (-2 + w * 4) * s + Math.sin(cycle * Math.PI * 2 + w) * 2.2 * s;
          ctx.globalAlpha = Math.max(0, (1 - cycle) * 0.75) * dimmedAlpha;
          ctx.beginPath();
          ctx.arc(wx, wy, (1.6 + cycle * 1.2) * s, 0, Math.PI * 2);
          ctx.fillStyle = '#fef3c7';
          ctx.fill();
        }
        ctx.restore();
      }

      // Gentle floating Zzz letters for long-idle bots (Idle >= 5m or Idle at night)
      if (isBotLongIdle(bot, phase, displayTimestampMs)) {
        const letters = ['Z', 'z', 'z'] as const;
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (let i = 0; i < letters.length; i++) {
          const cycle = (elapsedSecs * 0.45 + idx * 0.31 + i * 0.33) % 1;
          const alpha = cycle < 0.2 ? cycle / 0.2 : Math.max(0, 1 - (cycle - 0.2) / 0.8);
          const zx = sx + (20 + i * 6) * s + Math.sin(cycle * Math.PI * 2 + i) * 3 * s;
          const zy = sy - (48 + i * 6) * s - cycle * 22 * s;
          const fontPx = Math.round((10.5 - i * 1.3) * s);
          ctx.globalAlpha = alpha * 0.9 * dimmedAlpha;
          ctx.font = `700 ${fontPx}px ${CANVAS_FONT_FAMILY}`;
          ctx.strokeStyle = 'rgba(15, 23, 42, 0.75)';
          ctx.lineWidth = 2.2 * s;
          ctx.strokeText(letters[i], zx, zy);
          ctx.fillStyle = phase === 'night' ? '#bae6fd' : '#e0f2fe';
          ctx.fillText(letters[i], zx, zy);
        }
        ctx.restore();
      }

      // Error desk warning beacon & tiny rising smoke puffs (clear of nameplates & Needs You badges)
      if (hasErrorDeskBeacon(bot)) {
        const sideSign = desk.workerOffset[0] > 0 ? -1 : 1;
        const bx = sx + sideSign * 26 * s;
        const by = sy - 54 * s;
        const pulse = 0.5 + 0.5 * Math.sin(elapsedSecs * 8.5 + idx * 1.1);
        ctx.save();
        ctx.globalAlpha = dimmedAlpha;
        // Beacon halo
        const haloRadius = (10 + pulse * 6) * s;
        const halo = ctx.createRadialGradient(bx, by, 1 * s, bx, by, haloRadius);
        halo.addColorStop(0, `rgba(239, 68, 68, ${0.35 + pulse * 0.28})`);
        halo.addColorStop(0.55, `rgba(245, 158, 11, ${0.14 + pulse * 0.14})`);
        halo.addColorStop(1, 'rgba(239, 68, 68, 0)');
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(bx, by, haloRadius, 0, Math.PI * 2);
        ctx.fill();

        // Beacon dome
        ctx.beginPath();
        ctx.arc(bx, by, 3.8 * s, 0, Math.PI * 2);
        ctx.fillStyle = pulse > 0.5 ? '#ef4444' : '#f59e0b';
        ctx.fill();
        ctx.lineWidth = 1 * s;
        ctx.strokeStyle = '#fef2f2';
        ctx.stroke();

        // 3 tiny rising grey-white smoke puffs
        for (let p = 0; p < 3; p++) {
          const cycle = (elapsedSecs * 0.65 + idx * 0.29 + p * 0.33) % 1;
          const px = bx + Math.sin(cycle * Math.PI * 2 + p * 1.4) * 3.5 * s + (p - 1) * 1.4 * s;
          const py = by - 7 * s - cycle * 19 * s;
          const pr = (2.1 + cycle * 2.6) * s;
          ctx.globalAlpha = Math.max(0, (1 - cycle) * 0.62) * dimmedAlpha;
          ctx.beginPath();
          ctx.arc(px, py, pr, 0, Math.PI * 2);
          ctx.fillStyle = p % 2 === 0 ? '#e2e8f0' : '#cbd5e1';
          ctx.fill();
        }
        ctx.restore();
      }
    });
  }

  private paintWeatherOverlay(
    ctx: CanvasRenderingContext2D,
    vt: ViewportTransform,
    bgW: number,
    bgH: number,
    weatherKind: WeatherKind,
    phase: AtmospherePhase,
    elapsedSecs: number
  ): void {
    if (weatherKind === 'clear') return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(vt.originX, vt.originY, bgW, bgH);
    ctx.clip();

    if (weatherKind === 'rain') {
      ctx.fillStyle = phase === 'night' ? 'rgba(12, 26, 52, 0.12)' : 'rgba(14, 30, 58, 0.08)';
      ctx.fillRect(vt.originX, vt.originY, bgW, bgH);

      ctx.lineCap = 'round';
      for (const p of this.weather.particles) {
        const [x1, y1] = designToScreen(vt, p.x, p.y);
        const [x2, y2] = designToScreen(vt, p.x - p.length * 0.22, p.y + p.length);
        ctx.globalAlpha = p.alpha;
        ctx.strokeStyle = p.tint;
        ctx.lineWidth = Math.max(1, p.radius * vt.scale);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }

      for (const r of this.weather.ripples) {
        const t = Math.max(0, Math.min(1, r.age / Math.max(0.01, r.duration)));
        const [rx, ry] = designToScreen(vt, r.x, r.y);
        const rad = (2 + t * r.maxRadius) * vt.scale;
        ctx.globalAlpha = (1 - t) * 0.42;
        ctx.strokeStyle = '#bae6fd';
        ctx.lineWidth = Math.max(0.8, 1.2 * vt.scale);
        ctx.beginPath();
        ctx.ellipse(rx, ry, rad, rad * 0.36, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    } else if (weatherKind === 'snow') {
      for (const p of this.weather.particles) {
        const [sx, sy] = designToScreen(vt, p.x, p.y);
        ctx.globalAlpha = p.alpha;
        ctx.fillStyle = p.tint;
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(1.2, p.radius * vt.scale), 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // starlight motes
      const phaseBoost = phase === 'night' ? 1.0 : phase === 'sunset' ? 0.82 : 0.58;
      for (const p of this.weather.particles) {
        const twinkle = 0.45 + 0.55 * Math.sin(elapsedSecs * 2.4 + p.phase + p.age);
        const [sx, sy] = designToScreen(vt, p.x, p.y);
        const r = Math.max(1.3, p.radius * vt.scale);
        ctx.globalAlpha = p.alpha * twinkle * phaseBoost;
        ctx.fillStyle = p.tint;
        ctx.beginPath();
        ctx.arc(sx, sy, r * 2.1, 0, Math.PI * 2);
        ctx.fill();

        // Crisp 4-point star core
        ctx.globalAlpha = Math.min(1, p.alpha * twinkle * 1.25 * phaseBoost);
        ctx.beginPath();
        ctx.moveTo(sx, sy - r * 1.6);
        ctx.lineTo(sx + r * 0.5, sy);
        ctx.lineTo(sx, sy + r * 1.6);
        ctx.lineTo(sx - r * 0.5, sy);
        ctx.closePath();
        ctx.fill();
      }
    }

    ctx.restore();
  }

  private paintHuddleSparkles(
    ctx: CanvasRenderingContext2D,
    vt: ViewportTransform,
    huddles: readonly HuddleSparkle[],
    uiScale: number
  ): void {
    for (const h of huddles) {
      const t = Math.max(0, Math.min(1, h.elapsed / Math.max(0.01, h.duration)));
      const fade = t < 0.15 ? t / 0.15 : t > 0.72 ? Math.max(0, (1 - t) / 0.28) : 1;
      const [fx, fy] = designToScreen(vt, h.from[0], h.from[1] - 24);
      const [tx, ty] = designToScreen(vt, h.to[0], h.to[1] - 24);
      const mx = (fx + tx) * 0.5;
      const my = (fy + ty) * 0.5 - 12 * vt.scale;

      ctx.save();
      ctx.globalAlpha = fade * 0.88;
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.quadraticCurveTo(mx, my - 18 * vt.scale, tx, ty);
      ctx.setLineDash([4 * uiScale, 4 * uiScale]);
      ctx.lineWidth = 1.8 * uiScale;
      ctx.strokeStyle = 'rgba(250, 204, 21, 0.72)';
      ctx.stroke();
      ctx.setLineDash([]);

      const ringR = (12 + Math.sin(h.elapsed * 6) * 2.5) * vt.scale;
      ctx.beginPath();
      ctx.ellipse(mx, my, ringR * 1.25, ringR * 0.75, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(250, 204, 21, 0.16)';
      ctx.fill();
      ctx.lineWidth = 1.6 * uiScale;
      ctx.strokeStyle = '#fde047';
      ctx.stroke();

      for (let i = 0; i < 4; i++) {
        const ang = h.elapsed * 3.2 + (i * Math.PI) / 2;
        const sx = mx + Math.cos(ang) * ringR * 1.25;
        const sy = my + Math.sin(ang) * ringR * 0.75;
        const sr = 3.2 * uiScale;
        ctx.beginPath();
        ctx.moveTo(sx, sy - sr);
        ctx.lineTo(sx + sr * 0.6, sy);
        ctx.lineTo(sx, sy + sr);
        ctx.lineTo(sx - sr * 0.6, sy);
        ctx.closePath();
        ctx.fillStyle = i % 2 === 0 ? '#fef08a' : '#facc15';
        ctx.fill();
      }
      ctx.restore();
    }
  }

  private paintMilestoneBanner(
    ctx: CanvasRenderingContext2D,
    vt: ViewportTransform,
    bgW: number,
    banner: MilestoneBanner,
    label: string,
    uiScale: number
  ): void {
    const progress = 1 - banner.ttl / Math.max(0.01, banner.maxTtl);
    const alpha = progress < 0.12 ? progress / 0.12 : banner.ttl < 0.45 ? Math.max(0, banner.ttl / 0.45) : 1;
    if (alpha <= 0.02) return;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `700 ${Math.round(11.5 * uiScale)}px ${CANVAS_FONT_FAMILY}`;
    const pillW = Math.min(bgW - 24, Math.max(180 * uiScale, ctx.measureText(label).width + 28 * uiScale));
    const pillH = 28 * uiScale;
    const x = vt.originX + bgW * 0.5 - pillW * 0.5;
    const y = vt.originY + 12 * uiScale;

    drawRoundedRect(ctx, x, y, pillW, pillH, 999);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(250, 204, 21, 0.88)';
    ctx.stroke();

    ctx.fillStyle = '#fef9c3';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(truncateTextToWidth(ctx, label, pillW - 18), x + pillW * 0.5, y + pillH * 0.5);
    ctx.restore();
  }

  private paintFlyingCourier(
    ctx: CanvasRenderingContext2D,
    vt: ViewportTransform,
    courier: FlyingCourier
  ): void {
    const t =
      courier.duration <= 1e-6 ? 1 : Math.max(0, Math.min(1, courier.elapsed / courier.duration));
    const oneMinusT = 1 - t;
    const xDesign =
      oneMinusT * oneMinusT * courier.from[0] +
      2 * oneMinusT * t * courier.control[0] +
      t * t * courier.to[0];
    const yDesign =
      oneMinusT * oneMinusT * courier.from[1] +
      2 * oneMinusT * t * courier.control[1] +
      t * t * courier.to[1];

    const txDesign =
      2 * oneMinusT * (courier.control[0] - courier.from[0]) +
      2 * t * (courier.to[0] - courier.control[0]);
    const tyDesign =
      2 * oneMinusT * (courier.control[1] - courier.from[1]) +
      2 * t * (courier.to[1] - courier.control[1]);

    const groundXDesign = courier.from[0] + (courier.to[0] - courier.from[0]) * t;
    const groundYDesign = courier.from[1] + (courier.to[1] - courier.from[1]) * t;
    const [gx, gy] = designToScreen(vt, groundXDesign, groundYDesign);
    const [x, y] = designToScreen(vt, xDesign, yDesign);
    const s = Math.max(0.55, vt.scale);

    ctx.save();
    // Dashed curved trail tail behind courier
    const trailStartT = Math.max(0, t - 0.36);
    if (t > trailStartT + 0.01) {
      ctx.beginPath();
      const steps = 10;
      for (let i = 0; i <= steps; i++) {
        const st = trailStartT + ((t - trailStartT) * i) / steps;
        const omt = 1 - st;
        const pxD =
          omt * omt * courier.from[0] + 2 * omt * st * courier.control[0] + st * st * courier.to[0];
        const pyD =
          omt * omt * courier.from[1] + 2 * omt * st * courier.control[1] + st * st * courier.to[1];
        const [px, py] = designToScreen(vt, pxD, pyD);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.setLineDash([4 * s, 4 * s]);
      ctx.lineWidth = 1.6 * s;
      ctx.strokeStyle =
        courier.kind === 'paper_plane' ? 'rgba(125, 211, 252, 0.8)' : 'rgba(253, 224, 71, 0.8)';
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Subtle ground drop shadow
    drawRoundedRect(ctx, gx - 8 * s, gy - 2.5 * s, 16 * s, 5 * s, 4 * s);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.28)';
    ctx.fill();

    // Rotated courier icon
    const angle = Math.atan2(tyDesign, txDesign);
    ctx.translate(x, y);

    if (courier.kind === 'paper_plane') {
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.moveTo(13 * s, 0);
      ctx.lineTo(-9 * s, 7.5 * s);
      ctx.lineTo(-4.5 * s, 0);
      ctx.lineTo(-9 * s, -7.5 * s);
      ctx.closePath();
      ctx.fillStyle = '#f8fafc';
      ctx.fill();
      ctx.strokeStyle = '#0284c7';
      ctx.lineWidth = 1.4 * s;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(13 * s, 0);
      ctx.lineTo(-4.5 * s, 0);
      ctx.lineTo(-9 * s, 7.5 * s);
      ctx.closePath();
      ctx.fillStyle = '#bae6fd';
      ctx.fill();
    } else {
      const tilt = Math.max(-0.28, Math.min(0.28, angle * 0.25));
      ctx.rotate(tilt);
      const w = 18 * s;
      const h = 13 * s;
      drawRoundedRect(ctx, -w * 0.5, -h * 0.5, w, h, 2.2 * s);
      ctx.fillStyle = '#fef9c3';
      ctx.fill();
      ctx.strokeStyle = '#d97706';
      ctx.lineWidth = 1.4 * s;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-w * 0.45, -h * 0.38);
      ctx.lineTo(0, h * 0.1);
      ctx.lineTo(w * 0.45, -h * 0.38);
      ctx.strokeStyle = '#b45309';
      ctx.lineWidth = 1.2 * s;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, h * 0.08, 2.1 * s, 0, Math.PI * 2);
      ctx.fillStyle = '#ef4444';
      ctx.fill();
    }

    ctx.restore();
  }

  private buildDeskMiniProp(
    status: BotActivityStatus,
    dx: number,
    dy: number,
    bossDesk: [number, number],
    phase: number,
    vt: ViewportTransform,
    deskScreen: [number, number],
    hasVisibleWorker: boolean,
    workerOffsetX: number,
    redactMode: boolean
  ): { glyph: string; bg: string; border: string; fg: string; screenX: number; screenY: number } | null {
    const placeLeft = hasVisibleWorker && workerOffsetX > 0;
    const xShift = (placeLeft ? -28 : 22) * vt.scale;
    switch (status.kind) {
      case 'Working':
        if (redactMode) return null;
        return {
          glyph: classifyToolGlyph(status.tool),
          bg: 'rgba(13, 46, 109, 0.92)',
          border: 'rgba(84, 165, 255, 0.9)',
          fg: '#e0f2fe',
          screenX: deskScreen[0] + xShift,
          screenY: deskScreen[1] - 36 * vt.scale,
        };
      case 'Idle':
        return {
          glyph: '☕',
          bg: 'rgba(81, 56, 31, 0.88)',
          border: 'rgba(209, 152, 71, 0.85)',
          fg: '#fef3c7',
          screenX: deskScreen[0] + xShift,
          screenY: deskScreen[1] - 32 * vt.scale,
        };
      case 'WaitingAnswer':
        return {
          glyph: '⏳',
          bg: 'rgba(128, 86, 14, 0.92)',
          border: 'rgba(250, 204, 21, 0.95)',
          fg: '#fef9c3',
          screenX: deskScreen[0] + xShift,
          screenY: deskScreen[1] - 36 * vt.scale,
        };
      case 'Paused':
        return {
          glyph: 'Zzz',
          bg: 'rgba(50, 62, 82, 0.9)',
          border: 'rgba(100, 128, 173, 0.8)',
          fg: '#dbeafe',
          screenX: deskScreen[0] + (placeLeft ? -28 : 18) * vt.scale,
          screenY: deskScreen[1] - 46 * vt.scale,
        };
      case 'NeedsOwner': {
        const vx = bossDesk[0] - dx;
        const vy = bossDesk[1] - dy;
        const len = Math.max(1, Math.hypot(vx, vy));
        const dirX = (vx / len) * 26;
        const dirY = (vy / len) * 16 - 44 + Math.sin(phase * 7) * 4;
        const [wx, wy] = designToScreen(vt, dx + dirX, dy + dirY);
        return {
          glyph: '👋',
          bg: 'rgba(249, 198, 6, 0.96)',
          border: 'rgba(145, 81, 8, 0.95)',
          fg: '#451a03',
          screenX: wx - 10,
          screenY: wy - 10,
        };
      }
      case 'Blocked':
        return {
          glyph: '🔒',
          bg: 'rgba(174, 73, 9, 0.94)',
          border: 'rgba(251, 146, 60, 0.95)',
          fg: '#ffffff',
          screenX: deskScreen[0] + xShift,
          screenY: deskScreen[1] - 40 * vt.scale,
        };
      case 'Error':
        return {
          glyph: '✕',
          bg: 'rgba(175, 19, 19, 0.94)',
          border: 'rgba(248, 113, 113, 0.95)',
          fg: '#ffffff',
          screenX: deskScreen[0] + xShift,
          screenY: deskScreen[1] - 40 * vt.scale,
        };
    }
  }

  private paintLandmark(
    ctx: CanvasRenderingContext2D,
    vt: ViewportTransform,
    dx: number,
    dy: number,
    label: string,
    bg: string,
    uiScale: number,
    bgLeft: number,
    bgTop: number,
    bgRight: number,
    bgBottom: number
  ): Rect {
    const [ptX, ptY] = designToScreen(vt, dx, dy);
    ctx.font = `700 ${Math.round(10.5 * uiScale)}px ${CANVAS_FONT_FAMILY}`;
    const estW = Math.max(64 * uiScale, ctx.measureText(label).width + 18 * uiScale);
    const estH = 24 * uiScale;
    const left = Math.max(bgLeft + 4, Math.min(bgRight - estW - 4, ptX - 52 * vt.scale));
    const top = Math.max(bgTop + 4, Math.min(bgBottom - estH - 4, ptY));

    drawRoundedRect(ctx, left, top, estW, estH, 7 * uiScale);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, left + estW * 0.5, top + estH * 0.5);
    return [left, top, estW, estH];
  }

  /** Logo plaque above the boss desk label; falls back to the company name. */
  private paintBrand(
    ctx: CanvasRenderingContext2D,
    rawBrand: BrandInfo,
    anchor: Rect,
    uiScale: number,
    bounds: Rect,
    redactMode: boolean
  ): Rect | null {
    const brand = sanitizeBrand(rawBrand);
    if (!brand) return null;
    const img = !redactMode && brand.logo ? this.loadImage(brand.logo) : null;
    const h = 26 * uiScale;
    const pad = 6 * uiScale;
    ctx.font = `800 ${Math.round(12 * uiScale)}px ${CANVAS_FONT_FAMILY}`;
    const label = redactMode ? '★' : brand.name;
    const w = img
      ? (h - pad) * (img.naturalWidth / Math.max(1, img.naturalHeight)) + pad * 2
      : ctx.measureText(label).width + pad * 2;
    const [bx, by, bw, bh] = bounds;
    const left = Math.max(bx + 4, Math.min(bx + bw - w - 4, anchor[0] + anchor[2] * 0.5 - w * 0.5));
    const top = Math.max(by + 4, Math.min(by + bh - h - 4, anchor[1] - h - 4 * uiScale));
    drawRoundedRect(ctx, left, top, w, h, 7 * uiScale);
    ctx.fillStyle = 'rgba(8, 14, 38, 0.82)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(120, 170, 255, 0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
    if (img) {
      ctx.drawImage(img, left + pad, top + pad * 0.5, w - pad * 2, h - pad);
    } else {
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, left + w * 0.5, top + h * 0.5);
    }
    return [left, top, w, h];
  }

  /** Project list with backlog counts, hung under the Automation Board label. */
  private paintProjectBoard(
    ctx: CanvasRenderingContext2D,
    board: ProjectBoard,
    anchor: Rect,
    uiScale: number,
    bounds: Rect,
    redactMode: boolean,
    nowMs: number,
    s: ReturnType<typeof tStrings>
  ): Rect {
    const labels = boardProjectLabels(board, redactMode);
    const rows = board.projects.slice(0, MAX_BOARD_ROWS);
    const totals = boardTotals(board);
    const maxBacklog = Math.max(1, ...rows.map((p) => p.backlog));
    const rowH = 15 * uiScale;
    const headH = 18 * uiScale;
    const footH = 14 * uiScale;
    const pad = 7 * uiScale;
    const w = 196 * uiScale;
    const extra = board.projects.length > MAX_BOARD_ROWS ? 1 : 0;
    const h = pad + headH + (Math.max(1, rows.length) + extra) * rowH + footH + pad * 0.5;
    const [bx, by, bw, bh] = bounds;
    const left = Math.max(bx + 4, Math.min(bx + bw - w - 4, anchor[0]));
    const top = Math.max(by + 4, Math.min(by + bh - h - 4, anchor[1] + anchor[3] + 4 * uiScale));

    drawRoundedRect(ctx, left, top, w, h, 8 * uiScale);
    ctx.fillStyle = 'rgba(14, 10, 34, 0.86)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(160, 120, 255, 0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = `800 ${Math.round(10.5 * uiScale)}px ${CANVAS_FONT_FAMILY}`;
    ctx.fillText(s.projectBoardTitle, left + pad, top + pad + headH * 0.5);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffd36b';
    ctx.fillText(s.projectBoardTotal(totals.backlog), left + w - pad, top + pad + headH * 0.5);

    let y = top + pad + headH;
    ctx.font = `600 ${Math.round(9.5 * uiScale)}px ${CANVAS_FONT_FAMILY}`;
    if (rows.length === 0) {
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillText(s.projectBoardEmpty, left + pad, y + rowH * 0.5);
      y += rowH;
    }
    const countW = 26 * uiScale;
    const nameW = w - pad * 2 - countW - 4 * uiScale;
    rows.forEach((p, i) => {
      const cy = y + rowH * 0.5;
      // Backlog bar behind the name, proportional to the busiest project.
      const barW = Math.max(2, nameW * (p.backlog / maxBacklog));
      drawRoundedRect(ctx, left + pad, y + 2 * uiScale, barW, rowH - 4 * uiScale, 3 * uiScale);
      ctx.fillStyle = 'rgba(124, 92, 255, 0.35)';
      ctx.fill();
      ctx.textAlign = 'left';
      ctx.fillStyle = '#eef0ff';
      ctx.fillText(fitText(ctx, labels[i] ?? '', nameW - 4 * uiScale), left + pad + 3 * uiScale, cy);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#ffd36b';
      ctx.fillText(String(p.backlog), left + w - pad, cy);
      y += rowH;
    });
    if (extra) {
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillText(s.projectBoardMore(board.projects.length - MAX_BOARD_ROWS), left + pad, y + rowH * 0.5);
      y += rowH;
    }

    const updated = Date.parse(board.updatedAt);
    const stale = !Number.isFinite(updated) || nowMs - updated > PROJECT_BOARD_STALE_MS;
    const when = Number.isFinite(updated)
      ? new Date(updated).toLocaleString(undefined, {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '?';
    ctx.font = `500 ${Math.round(8.5 * uiScale)}px ${CANVAS_FONT_FAMILY}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = stale ? '#ffb347' : 'rgba(255,255,255,0.55)';
    const foot = stale ? s.projectBoardStale(when) : `${board.source ? `${board.source} · ` : ''}${when}`;
    ctx.fillText(fitText(ctx, foot, w - pad * 2), left + pad, y + footH * 0.5);
    return [left, top, w, h];
  }

  private paintCarryProp(
    ctx: CanvasRenderingContext2D,
    prop: CarryProp,
    cx: number,
    cy: number,
    scale: number
  ): void {
    const s = Math.max(0.5, scale);
    ctx.save();
    if (prop === 'YellowEnvelope') {
      const w = 18 * s;
      const h = 13 * s;
      drawRoundedRect(ctx, cx - w * 0.5, cy - h * 0.5, w, h, 2);
      ctx.fillStyle = '#facc15';
      ctx.fill();
      ctx.strokeStyle = '#a16207';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - w * 0.45, cy - h * 0.35);
      ctx.lineTo(cx, cy + h * 0.1);
      ctx.lineTo(cx + w * 0.45, cy - h * 0.35);
      ctx.strokeStyle = '#854d0e';
      ctx.stroke();
    } else if (prop === 'ReportBox') {
      const w = 16 * s;
      const h = 15 * s;
      drawRoundedRect(ctx, cx - w * 0.5, cy - h * 0.5, w, h, 2.5);
      ctx.fillStyle = '#d97706';
      ctx.fill();
      ctx.strokeStyle = '#78350f';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#fef3c7';
      ctx.fillRect(cx - w * 0.42, cy - 1.5 * s, w * 0.84, 3 * s);
    } else if (prop === 'GreenRibbonBox') {
      const w = 17 * s;
      const h = 16 * s;
      drawRoundedRect(ctx, cx - w * 0.5, cy - h * 0.5, w, h, 3);
      ctx.fillStyle = '#86efac';
      ctx.fill();
      ctx.strokeStyle = '#15803d';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#16a34a';
      ctx.fillRect(cx - 1.5 * s, cy - h * 0.5, 3 * s, h);
      ctx.fillRect(cx - w * 0.5, cy - 1.5 * s, w, 3 * s);
    } else if (prop === 'RedXDoc') {
      const w = 14 * s;
      const h = 17 * s;
      drawRoundedRect(ctx, cx - w * 0.5, cy - h * 0.5, w, h, 2);
      ctx.fillStyle = '#fef2f2';
      ctx.fill();
      ctx.strokeStyle = '#dc2626';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - 3.5 * s, cy - 3.5 * s);
      ctx.lineTo(cx + 3.5 * s, cy + 3.5 * s);
      ctx.moveTo(cx + 3.5 * s, cy - 3.5 * s);
      ctx.lineTo(cx - 3.5 * s, cy + 3.5 * s);
      ctx.lineWidth = 2;
      ctx.stroke();
    } else if (prop === 'QuestionMark') {
      const r = 15 * s;
      drawRoundedRect(ctx, cx - r * 0.5, cy - r * 0.5, r, r, r * 0.5);
      ctx.fillStyle = '#dbeafe';
      ctx.fill();
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      const w = 14 * s;
      const h = 16 * s;
      drawRoundedRect(ctx, cx - w * 0.5, cy - h * 0.5, w, h, 2);
      ctx.fillStyle = '#e2e8f0';
      ctx.fill();
      ctx.strokeStyle = '#64748b';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }

  private paintFlyingProp(
    ctx: CanvasRenderingContext2D,
    vt: ViewportTransform,
    fp: FlyingProp
  ): void {
    const t = fp.duration <= 1e-6 ? 1 : Math.max(0, Math.min(1, fp.elapsed / fp.duration));
    const gx = fp.start[0] + (fp.end[0] - fp.start[0]) * t;
    const gy = fp.start[1] + (fp.end[1] - fp.start[1]) * t;
    const lift = fp.arcHeight * 4 * t * (1 - t);
    const [groundX, groundY] = designToScreen(vt, gx, gy);
    const [x, y] = designToScreen(vt, gx, gy - lift);
    const s = Math.max(0.5, vt.scale);

    ctx.save();
    drawRoundedRect(ctx, groundX - 9 * s, groundY - 3 * s, 18 * s, 6 * s, 6);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.34)';
    ctx.fill();

    if (fp.kind.kind === 'PaperAirplane') {
      const dx = fp.end[0] - fp.start[0];
      const dy = fp.end[1] - fp.start[1] - fp.arcHeight * 4 * (1 - 2 * t);
      const len = Math.max(0.001, Math.hypot(dx, dy));
      const fwdX = dx / len;
      const fwdY = dy / len;
      const perpX = -fwdY;
      const perpY = fwdX;
      ctx.beginPath();
      ctx.moveTo(x + fwdX * 13 * s, y + fwdY * 13 * s);
      ctx.lineTo(x - fwdX * 9 * s + perpX * 7.5 * s, y - fwdY * 9 * s + perpY * 7.5 * s);
      ctx.lineTo(x - fwdX * 4 * s, y - fwdY * 4 * s);
      ctx.lineTo(x - fwdX * 9 * s - perpX * 7.5 * s, y - fwdY * 9 * s - perpY * 7.5 * s);
      ctx.closePath();
      ctx.fillStyle = fp.kind.isFloodReplacement ? '#bae6fd' : '#f8fafc';
      ctx.fill();
      ctx.strokeStyle = '#0284c7';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    } else if (fp.kind.kind === 'BossStamp') {
      const w = 22 * s;
      const h = 16 * s;
      drawRoundedRect(ctx, x - w * 0.5, y - h * 0.5, w, h, 4);
      ctx.fillStyle = '#fef08a';
      ctx.fill();
      ctx.strokeStyle = '#ca8a04';
      ctx.lineWidth = 2;
      ctx.stroke();
      const seal = 8 * s;
      drawRoundedRect(ctx, x - seal * 0.5, y - seal * 0.5, seal, seal, seal * 0.5);
      ctx.fillStyle = '#dc2626';
      ctx.fill();
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      const w = 16 * s;
      const h = 19 * s;
      const border = fp.kind.success ? '#16a34a' : '#dc2626';
      drawRoundedRect(ctx, x - w * 0.5, y - h * 0.5, w, h, 2.5);
      ctx.fillStyle = '#f8fafc';
      ctx.fill();
      ctx.strokeStyle = border;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.beginPath();
      if (fp.kind.success) {
        ctx.moveTo(x - 4 * s, y);
        ctx.lineTo(x - 1 * s, y + 3.5 * s);
        ctx.lineTo(x + 4.5 * s, y - 4 * s);
      } else {
        ctx.moveTo(x - 3.5 * s, y - 3.5 * s);
        ctx.lineTo(x + 3.5 * s, y + 3.5 * s);
        ctx.moveTo(x + 3.5 * s, y - 3.5 * s);
        ctx.lineTo(x - 3.5 * s, y + 3.5 * s);
      }
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
  }

  private paintParticle(
    ctx: CanvasRenderingContext2D,
    vt: ViewportTransform,
    p: Particle
  ): void {
    const alpha = Math.max(0, Math.min(1, 1 - p.age / Math.max(0.01, p.ttl)));
    if (alpha <= 0.02) return;
    const [x, y] = designToScreen(vt, p.x, p.y);
    const sz = p.size * Math.max(0.6, vt.scale);

    ctx.save();
    ctx.globalAlpha = alpha;
    if (p.kind === 'GreenCheckConfetti' || p.kind === 'GrayArchive' || p.kind === 'MilestoneConfetti') {
      ctx.fillStyle = p.colorHex;
      if (p.kind === 'MilestoneConfetti') {
        ctx.translate(x, y);
        ctx.rotate(p.age * 7 + p.vx * 0.05);
        ctx.fillRect(-sz * 0.55, -sz * 0.35, sz * 1.1, sz * 0.7);
      } else {
        ctx.fillRect(x - sz * 0.5, y - sz * 0.5, sz, sz * 0.8);
      }
    } else if (p.kind === 'Sparkle') {
      ctx.beginPath();
      ctx.moveTo(x, y - sz);
      ctx.lineTo(x + sz * 0.55, y);
      ctx.lineTo(x, y + sz);
      ctx.lineTo(x - sz * 0.55, y);
      ctx.closePath();
      ctx.fillStyle = p.colorHex;
      ctx.fill();
    } else if (p.kind === 'SweatDrop') {
      drawRoundedRect(ctx, x - sz * 0.4, y - sz * 0.6, sz * 0.8, sz * 1.2, sz * 0.5);
      ctx.fillStyle = p.colorHex;
      ctx.fill();
    } else {
      drawRoundedRect(ctx, x - sz * 0.55, y - sz * 0.35, sz * 1.1, sz * 0.9, 2);
      ctx.fillStyle = p.colorHex;
      ctx.fill();
      ctx.beginPath();
      const shift = p.kind === 'LockOpen' ? -sz * 0.25 : 0;
      ctx.moveTo(x - sz * 0.3, y - sz * 0.35);
      ctx.lineTo(x - sz * 0.3, y - sz * 0.8 + shift);
      ctx.lineTo(x + sz * 0.3, y - sz * 0.8 + shift);
      if (p.kind === 'LockOrange') {
        ctx.lineTo(x + sz * 0.3, y - sz * 0.35);
      }
      ctx.strokeStyle = p.colorHex;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }

  private paintCollabNetworkOverlay(
    ctx: CanvasRenderingContext2D,
    vt: ViewportTransform,
    edges: readonly CollabEdge[],
    layout: MotionDirector['layout'],
    motion: MotionDirector,
    elapsedSecs: number,
    uiScale: number,
    filterSet: ReadonlySet<string> | null
  ): void {
    const resolveNodeDesignPos = (node: CollabEdge['from']): [number, number] | null => {
      if (node.kind === 'bot') {
        const d = layout.botDesks.get(node.botId);
        if (!d) return null;
        const p = motion.actorPose(`bot:${node.botId}`, [d.x, d.y]);
        return [p.footX, p.footY - 22];
      }
      if (node.kind === 'worker') {
        const w = layout.workerSeats.get(node.dispatchId);
        if (!w) return null;
        const p = motion.actorPose(`worker:${node.dispatchId}`, [w.x, w.y]);
        return [p.footX, p.footY - 16];
      }
      return [layout.automationBoard[0], layout.automationBoard[1] - 12];
    };

    const nodeMatchesFilter = (node: CollabEdge['from']): boolean => {
      if (!filterSet) return true;
      if (node.kind === 'bot') return filterSet.has(node.botId);
      if (node.kind === 'worker') {
        const w = layout.workerSeats.get(node.dispatchId);
        return w ? filterSet.has(w.parentBotId) : false;
      }
      return false;
    };

    const topPillLimit = 5;
    let renderedCount = 0;

    edges.forEach((edge, idx) => {
      const fromD = resolveNodeDesignPos(edge.from);
      const toD = resolveNodeDesignPos(edge.to);
      if (!fromD || !toD) return;
      const [fx, fy] = designToScreen(vt, fromD[0], fromD[1]);
      const [tx, ty] = designToScreen(vt, toD[0], toD[1]);
      const dist = Math.hypot(tx - fx, ty - fy);
      if (dist < 4) return;

      const midX = (fx + tx) * 0.5;
      const midY = (fy + ty) * 0.5;
      const nx = -(ty - fy) / dist;
      const ny = (tx - fx) / dist;
      const bendSign = idx % 2 === 0 ? 1 : -1;
      const bend = Math.min(48 * vt.scale, Math.max(14 * vt.scale, dist * 0.18)) * bendSign;
      const cx = midX + nx * bend;
      const cy = midY + ny * bend;

      const edgeMatched = !filterSet || nodeMatchesFilter(edge.from) || nodeMatchesFilter(edge.to);
      const alphaScale = edgeMatched ? 1 : 0.22;

      const strokeCol =
        edge.kind === 'bot_bot'
          ? `rgba(56, 189, 248, ${0.65 * alphaScale})`
          : edge.kind === 'bot_worker'
            ? `rgba(45, 212, 191, ${0.68 * alphaScale})`
            : `rgba(192, 132, 252, ${0.62 * alphaScale})`;
      const dotCol =
        edge.kind === 'bot_bot'
          ? '#e0f2fe'
          : edge.kind === 'bot_worker'
            ? '#ccfbf1'
            : '#f3e8ff';
      const lineW = Math.min(4.8, 1.35 + Math.log2(edge.weight + 1) * 0.95) * Math.max(0.75, uiScale);

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.quadraticCurveTo(cx, cy, tx, ty);
      ctx.lineWidth = lineW * 2.2;
      ctx.strokeStyle = strokeCol;
      ctx.globalAlpha = 0.22 * alphaScale;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.quadraticCurveTo(cx, cy, tx, ty);
      ctx.lineWidth = lineW;
      ctx.strokeStyle = strokeCol;
      ctx.globalAlpha = 1;
      ctx.stroke();

      // Animated flow dot along active edge
      if (edge.active) {
        const t = (elapsedSecs * 0.45 + idx * 0.23) % 1;
        const omt = 1 - t;
        const dx = omt * omt * fx + 2 * omt * t * cx + t * t * tx;
        const dy = omt * omt * fy + 2 * omt * t * cy + t * t * ty;
        ctx.beginPath();
        ctx.arc(dx, dy, Math.max(2.2, lineW * 1.15), 0, Math.PI * 2);
        ctx.fillStyle = dotCol;
        ctx.globalAlpha = alphaScale;
        ctx.fill();
      }

      // Unobtrusive anonymized count pill on top-N strongest edges
      if (renderedCount < topPillLimit && edgeMatched) {
        renderedCount += 1;
        const px = 0.25 * fx + 0.5 * cx + 0.25 * tx;
        const py = 0.25 * fy + 0.5 * cy + 0.25 * ty;
        const pillText = `×${edge.weight}`;
        ctx.font = `700 ${Math.round(8.5 * uiScale)}px ${CANVAS_FONT_FAMILY}`;
        const pw = Math.max(20 * uiScale, ctx.measureText(pillText).width + 8 * uiScale);
        const ph = 14 * uiScale;
        drawRoundedRect(ctx, px - pw * 0.5, py - ph * 0.5, pw, ph, 5 * uiScale);
        ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
        ctx.fill();
        ctx.strokeStyle = strokeCol;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = '#f8fafc';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(pillText, px, py);
      }

      ctx.restore();
    });
  }

  private paintOwnerAvatar(
    ctx: CanvasRenderingContext2D,
    fx: number,
    fy: number,
    scale: number,
    facing: Facing,
    ownerTag: string,
    uiScale: number
  ): void {
    const s = Math.max(0.55, scale);
    const dir = facing === 'Left' ? -1 : 1;
    ctx.save();
    // Crisp pixel-style Owner Avatar (navy coat, warm face, headset/crown badge)
    // Legs / shoes
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(fx - 8 * s, fy - 12 * s, 6 * s, 10 * s);
    ctx.fillRect(fx + 2 * s, fy - 12 * s, 6 * s, 10 * s);
    // Coat / torso
    drawRoundedRect(ctx, fx - 12 * s, fy - 33 * s, 24 * s, 22 * s, 5 * s);
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.4 * s;
    ctx.stroke();
    // Tie / collar accent
    ctx.fillStyle = '#facc15';
    ctx.fillRect(fx - 2 * s, fy - 31 * s, 4 * s, 11 * s);
    // Head
    drawRoundedRect(ctx, fx - 11 * s, fy - 53 * s, 22 * s, 20 * s, 7 * s);
    ctx.fillStyle = '#fde68a';
    ctx.fill();
    ctx.strokeStyle = '#78350f';
    ctx.lineWidth = 1.2 * s;
    ctx.stroke();
    // Hair
    drawRoundedRect(ctx, fx - 11 * s, fy - 55 * s, 22 * s, 8 * s, 4 * s);
    ctx.fillStyle = '#334155';
    ctx.fill();
    // Eyes (shifted slightly toward facing direction)
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(fx + (dir * 2 - 4) * s, fy - 44 * s, 2.5 * s, 3.2 * s);
    ctx.fillRect(fx + (dir * 2 + 2) * s, fy - 44 * s, 2.5 * s, 3.2 * s);
    // Golden crown accent on top
    ctx.fillStyle = '#facc15';
    ctx.beginPath();
    ctx.moveTo(fx - 7 * s, fy - 55 * s);
    ctx.lineTo(fx - 7 * s, fy - 63 * s);
    ctx.lineTo(fx - 3 * s, fy - 59 * s);
    ctx.lineTo(fx, fy - 65 * s);
    ctx.lineTo(fx + 3 * s, fy - 59 * s);
    ctx.lineTo(fx + 7 * s, fy - 63 * s);
    ctx.lineTo(fx + 7 * s, fy - 55 * s);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#b45309';
    ctx.lineWidth = 1 * s;
    ctx.stroke();

    // YOU / 나 micro-tag
    ctx.font = `700 ${Math.round(9.5 * uiScale)}px ${CANVAS_FONT_FAMILY}`;
    const tagW = Math.max(28 * uiScale, ctx.measureText(ownerTag).width + 10 * uiScale);
    const tagH = 15 * uiScale;
    const tagX = fx - tagW * 0.5;
    const tagY = fy - 82 * s;
    drawRoundedRect(ctx, tagX, tagY, tagW, tagH, 6 * uiScale);
    ctx.fillStyle = 'rgba(202, 138, 4, 0.96)';
    ctx.fill();
    ctx.strokeStyle = '#fef08a';
    ctx.lineWidth = 1.1;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ownerTag, fx, tagY + tagH * 0.52);
    ctx.restore();
  }

  private paintRpgDeskProps(
    ctx: CanvasRenderingContext2D,
    vt: ViewportTransform,
    orderedBots: readonly BotState[],
    botDesks: ReadonlyMap<string, { x: number; y: number; workerOffset: [number, number] }>,
    rpgProfiles: Readonly<Record<string, BotRpgProfile>> | undefined,
    elapsedSecs: number,
    filterSet: ReadonlySet<string> | null
  ): void {
    if (!rpgProfiles) return;
    const s = Math.max(0.55, vt.scale);
    orderedBots.forEach((bot, idx) => {
      if (!isSafeKey(bot.id) || !Object.hasOwn(rpgProfiles, bot.id)) return;
      const propId: DeskPropId = rpgProfiles[bot.id].equippedProp;
      if (propId === 'none') return;
      const desk = botDesks.get(bot.id);
      if (!desk) return;
      const [sx, sy] = designToScreen(vt, desk.x, desk.y);
      // Place prop on opposite side of the desk from workerOffset & coffee mug
      const sideSign = desk.workerOffset[0] > 0 ? 1 : -1;
      const px = sx + sideSign * 31 * s;
      const py = sy - 11 * s;
      const dimmedAlpha = filterSet !== null && !filterSet.has(bot.id) ? 0.24 : 1;

      ctx.save();
      ctx.globalAlpha = dimmedAlpha;
      switch (propId) {
        case 'rubber_duck': {
          // Yellow pixel duck with orange beak
          drawRoundedRect(ctx, px - 6 * s, py - 3 * s, 12 * s, 7 * s, 3 * s);
          ctx.fillStyle = '#facc15';
          ctx.fill();
          ctx.strokeStyle = '#a16207';
          ctx.lineWidth = 1 * s;
          ctx.stroke();
          drawRoundedRect(ctx, px - 3.5 * s, py - 9 * s, 7.5 * s, 7 * s, 3 * s);
          ctx.fillStyle = '#fde047';
          ctx.fill();
          ctx.stroke();
          // Orange beak
          ctx.fillStyle = '#f97316';
          ctx.fillRect(px + 3.5 * s, py - 6.5 * s, 3.5 * s, 2.2 * s);
          // Tiny eye
          ctx.fillStyle = '#0f172a';
          ctx.fillRect(px + 1 * s, py - 7.2 * s, 1.5 * s, 1.5 * s);
          break;
        }
        case 'mini_plant': {
          // Terracotta pot + green pixel leaves
          ctx.fillStyle = '#c2410c';
          ctx.beginPath();
          ctx.moveTo(px - 5 * s, py - 4 * s);
          ctx.lineTo(px + 5 * s, py - 4 * s);
          ctx.lineTo(px + 3.5 * s, py + 4 * s);
          ctx.lineTo(px - 3.5 * s, py + 4 * s);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = '#ea580c';
          ctx.fillRect(px - 5.8 * s, py - 5.5 * s, 11.6 * s, 2.2 * s);
          // Leaves
          ctx.fillStyle = '#22c55e';
          ctx.beginPath();
          ctx.ellipse(px - 4 * s, py - 9 * s, 4 * s, 2.6 * s, -0.45, 0, Math.PI * 2);
          ctx.ellipse(px + 4 * s, py - 9 * s, 4 * s, 2.6 * s, 0.45, 0, Math.PI * 2);
          ctx.ellipse(px, py - 11.5 * s, 2.8 * s, 4.2 * s, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#4ade80';
          ctx.fillRect(px - 1 * s, py - 12 * s, 2 * s, 4 * s);
          break;
        }
        case 'mech_keyboard': {
          // Compact RGB-accented mechanical keyboard
          drawRoundedRect(ctx, px - 10 * s, py - 3.5 * s, 20 * s, 8 * s, 2 * s);
          ctx.fillStyle = '#1e293b';
          ctx.fill();
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 1.1 * s;
          ctx.stroke();
          // Keycap rows
          ctx.fillStyle = '#cbd5e1';
          for (let kx = -7.5; kx <= 6.5; kx += 3.5) {
            ctx.fillRect(px + kx * s, py - 2 * s, 2.5 * s, 2 * s);
            ctx.fillRect(px + kx * s, py + 0.8 * s, 2.5 * s, 2 * s);
          }
          // RGB underglow strip
          const rgbCols = ['#38bdf8', '#a78bfa', '#f472b6', '#4ade80'];
          const col = rgbCols[Math.floor(elapsedSecs * 2 + idx) % rgbCols.length];
          ctx.fillStyle = col;
          ctx.fillRect(px - 8.5 * s, py + 3.5 * s, 17 * s, 1.5 * s);
          break;
        }
        case 'dual_monitor': {
          // Secondary glowing monitor angled on desk
          ctx.fillStyle = '#334155';
          ctx.fillRect(px - 1.5 * s, py - 1 * s, 3 * s, 5 * s);
          ctx.fillRect(px - 5 * s, py + 3 * s, 10 * s, 2 * s);
          drawRoundedRect(ctx, px - 10 * s, py - 14 * s, 20 * s, 13 * s, 2 * s);
          ctx.fillStyle = '#0f172a';
          ctx.fill();
          ctx.strokeStyle = '#64748b';
          ctx.lineWidth = 1.2 * s;
          ctx.stroke();
          // Glowing screen code lines
          ctx.fillStyle = '#0ea5e9';
          ctx.fillRect(px - 8 * s, py - 12 * s, 16 * s, 9 * s);
          ctx.fillStyle = '#e0f2fe';
          ctx.fillRect(px - 6.5 * s, py - 10.5 * s, 9 * s, 1.5 * s);
          ctx.fillStyle = '#4ade80';
          ctx.fillRect(px - 6.5 * s, py - 7.8 * s, 12 * s, 1.5 * s);
          ctx.fillStyle = '#fde047';
          ctx.fillRect(px - 6.5 * s, py - 5.2 * s, 7 * s, 1.5 * s);
          break;
        }
        case 'cat_plush': {
          // Cute perched desk cat with wagging tail
          const tailWag = Math.sin(elapsedSecs * 3.5 + idx) * 2.5 * s;
          // Tail
          ctx.beginPath();
          ctx.moveTo(px + 5 * s, py + 2 * s);
          ctx.quadraticCurveTo(px + 10 * s, py - 3 * s + tailWag, px + 8 * s, py - 8 * s + tailWag);
          ctx.strokeStyle = '#fb923c';
          ctx.lineWidth = 2.4 * s;
          ctx.lineCap = 'round';
          ctx.stroke();
          // Body + head
          drawRoundedRect(ctx, px - 6 * s, py - 4 * s, 12 * s, 8 * s, 4 * s);
          ctx.fillStyle = '#fed7aa';
          ctx.fill();
          ctx.strokeStyle = '#c2410c';
          ctx.lineWidth = 1 * s;
          ctx.stroke();
          drawRoundedRect(ctx, px - 5.5 * s, py - 11.5 * s, 11 * s, 8.5 * s, 4 * s);
          ctx.fillStyle = '#ffedd5';
          ctx.fill();
          ctx.stroke();
          // Pointy ears
          ctx.fillStyle = '#fb923c';
          ctx.beginPath();
          ctx.moveTo(px - 5 * s, py - 11 * s);
          ctx.lineTo(px - 3.5 * s, py - 15 * s);
          ctx.lineTo(px - 1 * s, py - 11 * s);
          ctx.moveTo(px + 1 * s, py - 11 * s);
          ctx.lineTo(px + 3.5 * s, py - 15 * s);
          ctx.lineTo(px + 5 * s, py - 11 * s);
          ctx.fill();
          // Cozy eyes
          ctx.fillStyle = '#431407';
          ctx.fillRect(px - 3 * s, py - 8 * s, 1.8 * s, 1.8 * s);
          ctx.fillRect(px + 1.2 * s, py - 8 * s, 1.8 * s, 1.8 * s);
          break;
        }
        case 'gold_trophy': {
          // Gleaming gold chalice trophy + animated shimmer
          ctx.fillStyle = '#78350f';
          ctx.fillRect(px - 5 * s, py + 2 * s, 10 * s, 3 * s);
          ctx.fillStyle = '#eab308';
          ctx.fillRect(px - 1.5 * s, py - 2 * s, 3 * s, 4.5 * s);
          // Cup body
          ctx.beginPath();
          ctx.moveTo(px - 6.5 * s, py - 11.5 * s);
          ctx.lineTo(px + 6.5 * s, py - 11.5 * s);
          ctx.lineTo(px + 4 * s, py - 2 * s);
          ctx.lineTo(px - 4 * s, py - 2 * s);
          ctx.closePath();
          ctx.fillStyle = '#facc15';
          ctx.fill();
          ctx.strokeStyle = '#a16207';
          ctx.lineWidth = 1.1 * s;
          ctx.stroke();
          // Handles
          ctx.beginPath();
          ctx.arc(px - 6.5 * s, py - 7.5 * s, 2.6 * s, Math.PI * 0.5, Math.PI * 1.5);
          ctx.strokeStyle = '#facc15';
          ctx.lineWidth = 1.4 * s;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(px + 6.5 * s, py - 7.5 * s, 2.6 * s, -Math.PI * 0.5, Math.PI * 0.5);
          ctx.stroke();
          // Shimmer star
          const twinkle = 0.5 + 0.5 * Math.sin(elapsedSecs * 4.5 + idx);
          ctx.fillStyle = `rgba(254, 249, 195, ${0.4 + twinkle * 0.6})`;
          const sr = (2.2 + twinkle * 1.6) * s;
          ctx.beginPath();
          ctx.moveTo(px + 4 * s, py - 13 * s - sr);
          ctx.lineTo(px + 4 * s + sr * 0.55, py - 13 * s);
          ctx.lineTo(px + 4 * s, py - 13 * s + sr);
          ctx.lineTo(px + 4 * s - sr * 0.55, py - 13 * s);
          ctx.closePath();
          ctx.fill();
          break;
        }
      }
      ctx.restore();
    });
  }

  dispose(): void {
    this.destroyed = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.resizeObserver?.disconnect();
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('resize', this.handleWindowResize);
    }
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
    this.canvas.removeEventListener('click', this.handleClick);
    this.canvas.removeEventListener('dblclick', this.handleDoubleClick);
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('pointercancel', this.handlePointerCancel);
    this.canvas.removeEventListener('pointerleave', this.handlePointerLeave);
    this.canvas.removeEventListener('wheel', this.handleWheel);
    this.imageCache.clear();
    this.bgCacheCanvas = null;
    this.bgCacheCtx = null;
    this.bgCacheKey = '';
  }
}

/** Truncates `text` with an ellipsis so it fits `maxW` pixels in the current font. */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${text.slice(0, lo)}…` : '…';
}
