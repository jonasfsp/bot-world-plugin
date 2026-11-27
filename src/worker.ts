import type { JsonValue, OrcaWorkerApi } from 'orca/worker';
import {
  applyRpgActionToStore,
  applyWorldEventsToRpgStore,
  buildRpgProfilesForSnapshot,
  createEmptyBotRpgStore,
  equipDeskPropInStore,
  sanitizeBotRpgStore,
} from '../shared/bot-rpg.ts';
import {
  MAX_CREATOR_AVATARS,
  MAX_STORED_CREATOR_BYTES,
  createEmptyCreatorAssetsState,
  parseAndValidateCreatorPack,
  sanitizeCreatorAssetsState,
  sanitizePackName,
  utf8JsonBytes,
  validateCustomAssetDataUrl,
} from '../shared/creator-studio.ts';
import {
  effectiveLocale,
  localizeBotErrorMessage,
  normalizeLanguageSetting,
  tStrings,
} from '../shared/i18n.ts';
import {
  DEFAULT_STUCK_THRESHOLD_MIN,
  StuckWatchdogTracker,
  clampStuckThresholdMin,
  stuckAlertsSignature,
} from '../shared/watchdog.ts';
import { listBotGroups, scopeSnapshotToGroup } from '../shared/filter.ts';
import { DesktopNotificationManager } from './desktop-notify.ts';
import {
  diffSnapshots,
  extractWorkerSeq,
  formatEventSummaries,
  redactWorldEvent,
  resolveHandle,
} from './events.ts';
import {
  type CliEnvelope,
  MAX_ITEM_NUMBER,
  OrcaCli,
  OrcaCliError,
  type OrcaClient,
  replyNeedsOwnerItem,
  sendQuickBotMessage,
  setOrcaCliDiagnosticLogger,
  validateQuickMessageBody,
} from './orca-cli.ts';
import { PollerSession } from './poller.ts';
import './protocol.ts';
import { redactLabel, scrubAll } from './redact.ts';
import { TimelineBuffer, scrubFullSnapshot } from './timeline.ts';
import {
  type ActorRef,
  type AtmosphereMode,
  type BotRpgStore,
  type BotWorldStatePayload,
  type CharacterId,
  type CreatorAssetsState,
  type FocusTerminalResponse,
  type ItemReplyResponse,
  type LanguageSetting,
  MAX_BOT_APPEARANCES,
  type OpenWorkspaceResponse,
  type QuickSendResponse,
  type SoundMode,
  type StuckAlert,
  type ThemeId,
  type UiLocale,
  type ViewMode,
  type WeatherMode,
  type WorldEventRecord,
  type WorldSnapshot,
  botStatusLabel,
  createEmptySnapshot,
  isPoolCharacterId,
  isSafeKey,
  isValidAtmosphereMode,
  isValidDeskPropId,
  isValidLanguageSetting,
  isValidRpgXpAction,
  isValidSoundMode,
  isValidThemeId,
  isValidViewMode,
  isValidWeatherMode,
  isWorkerActive,
  isWorkerVisibleOnStage,
  stripDangerousKeys,
  toPlainSafeRecord,
} from './types.ts';
import {
  type WeeklyTrendStore,
  getLastSevenDaysTrend,
  hydrateWeeklyTrendStore,
  mergeWeeklyTrendStore,
} from './weekly-trend.ts';

const STORAGE_PREFS_KEY = 'botWorld.prefs';
const STORAGE_TIMELINE_KEY = 'botWorld.timeline';
const STORAGE_WEEKLY_TREND_KEY = 'botWorld.weeklyTrend';
const STORAGE_RPG_KEY = 'botWorld.rpg.v1';
const STORAGE_CREATOR_KEY = 'botWorld.creator.v1';
export const MAX_IPC_PAYLOAD_BYTES = 220 * 1024;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const LOCALE_TAG_RE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8}){0,6}$/;
const utf8Encoder = new TextEncoder();

function utf8ByteLength(value: unknown): number {
  return utf8Encoder.encode(JSON.stringify(value)).byteLength;
}

function truncateUiText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, maxChars).join('')}…`;
}

function redactSafeHandle(actor: ActorRef, locale: UiLocale = 'en'): string {
  switch (actor.kind) {
    case 'Bot':
      return actor.botId;
    case 'Worker':
      return `dispatch:${actor.dispatchId}`;
    case 'BossDesk':
      return 'orca:items';
    case 'AutomationBoard':
      return 'orca:automations';
    case 'OfficeDoor':
      return 'orca:door';
    case 'Unknown':
    default:
      return tStrings(locale).privateLabel;
  }
}

type StoredPrefs = {
  activeTheme: ThemeId;
  atmosphereMode: AtmosphereMode;
  weatherMode: WeatherMode;
  soundMode: SoundMode;
  viewMode: ViewMode;
  redactMode: boolean;
  botAppearances: Record<string, CharacterId>;
  languageSetting: LanguageSetting;
  hasThemeOverride: boolean;
  hasAtmosphereOverride: boolean;
  hasWeatherOverride: boolean;
  hasViewModeOverride: boolean;
  hasRedactOverride: boolean;
  hasLanguageOverride: boolean;
  /** Bot group to show ('' = all bots). */
  groupFilter: string;
};

const MAX_GROUP_FILTER_CHARS = 80;

/** A group name from the UI or storage: '' (all bots) or a short single-line name. */
export function sanitizeGroupFilter(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length > MAX_GROUP_FILTER_CHARS || CONTROL_CHAR_RE.test(trimmed)) return null;
  return trimmed;
}

export type QuickSendFn = (botName: string, message: string) => Promise<CliEnvelope<unknown>>;
export type ItemReplyFn = (
  botName: string,
  itemNumber: number,
  answerText: string
) => Promise<CliEnvelope<unknown>>;
export const QUICK_SEND_COOLDOWN_MS = 2_000;

function validateHostTargetId(raw: unknown, fieldName: string): string {
  if (typeof raw !== 'string') {
    throw makeHostError('invalid_params', `Invalid ${fieldName}`);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 128 || CONTROL_CHAR_RE.test(trimmed)) {
    throw makeHostError('invalid_params', `Invalid ${fieldName}`);
  }
  return trimmed;
}

function makeHostError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

function validatePrefs(
  raw: unknown,
  defaults: {
    theme: ThemeId;
    atmosphere: AtmosphereMode;
    weather: WeatherMode;
    viewMode: ViewMode;
    redact: boolean;
    language: LanguageSetting;
  }
): StoredPrefs {
  const base: StoredPrefs = {
    activeTheme: defaults.theme,
    atmosphereMode: defaults.atmosphere,
    weatherMode: defaults.weather,
    soundMode: 'off',
    viewMode: defaults.viewMode,
    redactMode: defaults.redact,
    botAppearances: {},
    languageSetting: defaults.language,
    hasThemeOverride: false,
    hasAtmosphereOverride: false,
    hasWeatherOverride: false,
    hasViewModeOverride: false,
    hasRedactOverride: false,
    hasLanguageOverride: false,
    groupFilter: '',
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return base;
  }
  const clean = stripDangerousKeys(raw as Record<string, unknown>);
  if (isValidThemeId(clean.activeTheme)) {
    base.activeTheme = clean.activeTheme;
    base.hasThemeOverride = clean.hasThemeOverride === true;
  }
  if (isValidAtmosphereMode(clean.atmosphereMode)) {
    base.atmosphereMode = clean.atmosphereMode;
    base.hasAtmosphereOverride = clean.hasAtmosphereOverride === true;
  }
  if (isValidWeatherMode(clean.weatherMode)) {
    base.weatherMode = clean.weatherMode;
    base.hasWeatherOverride = clean.hasWeatherOverride === true;
  }
  if (isValidSoundMode(clean.soundMode)) {
    base.soundMode = clean.soundMode;
  }
  if (isValidViewMode(clean.viewMode)) {
    base.viewMode = clean.viewMode;
    base.hasViewModeOverride = clean.hasViewModeOverride === true;
  }
  if (typeof clean.redactMode === 'boolean') {
    base.redactMode = clean.redactMode;
    base.hasRedactOverride = clean.hasRedactOverride === true;
  }
  if (isValidLanguageSetting(clean.languageSetting)) {
    base.languageSetting = clean.languageSetting;
    base.hasLanguageOverride = clean.hasLanguageOverride === true;
  }
  base.groupFilter = sanitizeGroupFilter(clean.groupFilter) ?? '';
  if (clean.botAppearances && typeof clean.botAppearances === 'object' && !Array.isArray(clean.botAppearances)) {
    const map = new Map<string, CharacterId>();
    for (const [botId, charId] of Object.entries(clean.botAppearances as Record<string, unknown>)) {
      if (map.size >= MAX_BOT_APPEARANCES) break;
      if (
        isSafeKey(botId) &&
        botId.length <= 128 &&
        !CONTROL_CHAR_RE.test(botId) &&
        isPoolCharacterId(charId)
      ) {
        map.set(botId, charId);
      }
    }
    base.botAppearances = toPlainSafeRecord(map);
  }
  return base;
}

export function prepareSnapshotForUi(
  snapshot: WorldSnapshot,
  redactMode: boolean,
  locale: UiLocale = 'en'
): WorldSnapshot {
  const s = tStrings(locale);
  const scrubbed = scrubFullSnapshot(snapshot);
  if (!redactMode) {
    const bots: WorldSnapshot['bots'] = {};
    for (const [id, bot] of Object.entries(scrubbed.bots)) {
      if (!isSafeKey(id)) continue;
      const localizedStatus =
        bot.status.kind === 'Error' && bot.status.message !== null
          ? {
              kind: 'Error' as const,
              message: localizeBotErrorMessage(bot.status.message, locale),
            }
          : bot.status;
      Object.defineProperty(bots, id, {
        value: {
          ...bot,
          status: localizedStatus,
          specialty: truncateUiText(bot.specialty, 200),
          currentTaskTitle:
            bot.currentTaskTitle !== null ? truncateUiText(bot.currentTaskTitle, 200) : null,
          currentTool: bot.currentTool !== null ? truncateUiText(bot.currentTool, 80) : null,
        },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    const items: WorldSnapshot['items'] = {};
    for (const [id, it] of Object.entries(scrubbed.items)) {
      if (!isSafeKey(id)) continue;
      const safeOptions = Array.isArray(it.questionOptions)
        ? it.questionOptions.slice(0, 6).map((opt) => ({
            label: truncateUiText(opt.label, 100),
            ...(opt.detail ? { detail: truncateUiText(opt.detail, 200) } : {}),
            ...(opt.recommended === true ? { recommended: true } : {}),
          }))
        : [];
      Object.defineProperty(items, id, {
        value: {
          ...it,
          title: truncateUiText(it.title, 200),
          questionPrompt:
            it.questionPrompt !== null ? truncateUiText(it.questionPrompt, 300) : null,
          questionOptions: safeOptions,
        },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    const automations: WorldSnapshot['automations'] = {};
    for (const [id, auto] of Object.entries(scrubbed.automations)) {
      if (!isSafeKey(id)) continue;
      Object.defineProperty(automations, id, {
        value: {
          ...auto,
          name: truncateUiText(auto.name, 120),
          lastError: auto.lastError !== null ? truncateUiText(auto.lastError, 240) : null,
        },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return {
      ...scrubbed,
      runtime: {
        ...scrubbed.runtime,
        errorMessage:
          scrubbed.runtime.errorMessage !== null
            ? truncateUiText(scrubbed.runtime.errorMessage, 240)
            : null,
      },
      bots,
      items,
      automations,
      inboxCursor: {
        ...scrubbed.inboxCursor,
        seenIds: [],
      },
      recentMessages: scrubbed.recentMessages.map((m) => ({
        ...m,
        subject: truncateUiText(m.subject, 200),
        body: truncateUiText(m.body, 240),
        payload: null,
      })),
    };
  }

  const bots: WorldSnapshot['bots'] = {};
  for (const [id, bot] of Object.entries(scrubbed.bots)) {
    if (!isSafeKey(id)) continue;
    const statusLabel = botStatusLabel(bot.status, locale);
    let maskedStatus = bot.status;
    if (bot.status.kind === 'Working') {
      maskedStatus = { kind: 'Working', tool: null };
    } else if (bot.status.kind === 'NeedsOwner') {
      maskedStatus = {
        kind: 'NeedsOwner',
        count: bot.status.count,
        prompt: null,
        optionsCount: bot.status.optionsCount,
      };
    } else if (bot.status.kind === 'Blocked') {
      maskedStatus = { kind: 'Blocked', reason: null };
    } else if (bot.status.kind === 'Error') {
      maskedStatus = {
        kind: 'Error',
        message: bot.status.message !== null ? s.errorHiddenLabel : null,
      };
    }

    Object.defineProperty(bots, id, {
      value: {
        ...bot,
        agent: s.privateLabel,
        specialty: '',
        status: maskedStatus,
        currentTaskTitle: redactLabel(bot.name, statusLabel),
        currentTool: null,
      },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  const workers: WorldSnapshot['workers'] = {};
  let workerIdx = 1;
  for (const [id, w] of Object.entries(scrubbed.workers)) {
    if (!isSafeKey(id)) continue;
    Object.defineProperty(workers, id, {
      value: {
        ...w,
        provider: s.workerNumbered(workerIdx++),
        model: null,
        toolName: null,
        taskTitle: null,
        worktreeId: null,
      },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  const items: WorldSnapshot['items'] = {};
  for (const [id, it] of Object.entries(scrubbed.items)) {
    if (!isSafeKey(id)) continue;
    Object.defineProperty(items, id, {
      value: {
        ...it,
        title: `#${it.number}`,
        questionPrompt: null,
        questionOptions: [],
      },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  const automations: WorldSnapshot['automations'] = {};
  const autoEntries = Object.entries(scrubbed.automations)
    .filter(([id]) => isSafeKey(id))
    .sort((a, b) => a[1].name.localeCompare(b[1].name, locale, { numeric: true }));
  let autoIdx = 1;
  for (const [id, auto] of autoEntries) {
    Object.defineProperty(automations, id, {
      value: {
        ...auto,
        name: s.automationNumbered(autoIdx++),
        lastError: auto.lastError ? s.errorHiddenLabel : null,
      },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return {
    ...scrubbed,
    runtime: {
      ...scrubbed.runtime,
      errorMessage: scrubbed.runtime.errorMessage !== null ? s.errorHiddenLabel : null,
    },
    bots,
    workers,
    items,
    automations,
    inboxCursor: {
      ...scrubbed.inboxCursor,
      seenIds: [],
    },
    recentMessages: scrubbed.recentMessages.map((m) => {
      const fromActor = resolveHandle(m.fromHandle, m.runId, scrubbed, scrubbed, locale);
      const toActor = resolveHandle(m.toHandle, m.runId, scrubbed, scrubbed, locale);
      return {
        ...m,
        fromHandle: redactSafeHandle(fromActor, locale),
        toHandle: redactSafeHandle(toActor, locale),
        subject: '',
        body: '',
        threadId: null,
        payload: null,
      };
    }),
  };
}

export function buildStatusBarText(
  snapshot: WorldSnapshot,
  redactMode: boolean,
  locale: UiLocale = 'en'
): string {
  const s = tStrings(locale);
  const bots = Object.values(snapshot.bots);
  const botCount = bots.length;
  const workingCount = bots.filter((b) => b.status.kind === 'Working').length;
  const needsOwnerCount = bots.filter((b) => b.status.kind === 'NeedsOwner').length;
  const activeWorkerCount = Object.values(snapshot.workers).filter((w) => isWorkerActive(w)).length;

  if (!snapshot.runtime.connected && botCount === 0) {
    return redactMode ? s.statusBarOfflineRedacted : s.statusBarOffline;
  }

  if (locale === 'ko') {
    if (redactMode) {
      const parts = [s.statusBarBrand, s.statusBarRedactedTag, `작업 ${workingCount}`];
      if (activeWorkerCount > 0) parts.push(`워커 +${activeWorkerCount}`);
      if (needsOwnerCount > 0) parts.push(`결정 ${needsOwnerCount}`);
      return parts.join(' · ');
    }
    if (needsOwnerCount > 0) {
      const parts = [s.statusBarBrand, `결정 ${needsOwnerCount}`];
      if (workingCount > 0) parts.push(`작업 ${workingCount}`);
      if (activeWorkerCount > 0) parts.push(`워커 +${activeWorkerCount}`);
      return parts.join(' · ');
    }
    if (workingCount > 0 || activeWorkerCount > 0) {
      const parts = [s.statusBarBrand, `작업 ${workingCount}`];
      if (activeWorkerCount > 0) parts.push(`워커 +${activeWorkerCount}`);
      return parts.join(' · ');
    }
    return `${s.statusBarBrand} · 대기 ${botCount}`;
  }

  if (redactMode) {
    return `${s.statusBarBrand} · ${s.statusBarRedactedTag} · ${workingCount}/${botCount} active`;
  }
  if (needsOwnerCount > 0) {
    const parts = [s.statusBarBrand, `${needsOwnerCount} needs you`];
    if (workingCount > 0) parts.push(`${workingCount} working`);
    if (activeWorkerCount > 0) parts.push(`+${activeWorkerCount} workers`);
    return parts.join(' · ');
  }
  if (workingCount > 0 || activeWorkerCount > 0) {
    const parts = [s.statusBarBrand, `${workingCount} working`];
    if (activeWorkerCount > 0) parts.push(`+${activeWorkerCount} workers`);
    return parts.join(' · ');
  }
  return `${s.statusBarBrand} · ${botCount} idle`;
}

export function formatStatusBarParams(
  snapshot: WorldSnapshot,
  redactMode: boolean,
  locale: UiLocale = 'en'
): {
  id: 'bot-world-status';
  text: string;
  icon: 'bot';
  tone: 'neutral' | 'accent' | 'warning';
  tooltip: string;
} {
  const s = tStrings(locale);
  const bots = Object.values(snapshot.bots);
  const botCount = bots.length;
  const workingCount = bots.filter((b) => b.status.kind === 'Working').length;
  const needsOwnerCount = bots.filter((b) => b.status.kind === 'NeedsOwner').length;
  const activeWorkerCount = Object.values(snapshot.workers).filter((w) => isWorkerActive(w)).length;
  const text = buildStatusBarText(snapshot, redactMode, locale);

  if (!snapshot.runtime.connected && botCount === 0) {
    return {
      id: 'bot-world-status',
      text,
      icon: 'bot',
      tone: 'warning',
      tooltip: redactMode ? s.statusBarOfflineTooltipRedacted : s.statusBarOfflineTooltip,
    };
  }

  const tone: 'neutral' | 'accent' | 'warning' =
    needsOwnerCount > 0
      ? 'warning'
      : workingCount > 0 || activeWorkerCount > 0
        ? 'accent'
        : 'neutral';

  if (locale === 'ko') {
    const tooltip = redactMode
      ? `가림 모드 활성 · 작업 ${workingCount} · 워커 ${activeWorkerCount} · 결정 대기 ${needsOwnerCount}`
      : needsOwnerCount > 0
        ? `결정 대기 ${needsOwnerCount} · 작업 중 ${workingCount} · 활성 워커 ${activeWorkerCount}`
        : workingCount > 0 || activeWorkerCount > 0
          ? `작업 중 ${workingCount} · 활성 워커 ${activeWorkerCount} · 전체 봇 ${botCount}`
          : `전체 봇 ${botCount} · 모두 대기 중`;
    return { id: 'bot-world-status', text, icon: 'bot', tone, tooltip };
  }

  const tooltip = redactMode
    ? `Redact mode active · ${workingCount} working · ${activeWorkerCount} workers · ${needsOwnerCount} needs you`
    : needsOwnerCount > 0
      ? `${needsOwnerCount} needs you · ${workingCount} working · ${activeWorkerCount} active workers`
      : workingCount > 0 || activeWorkerCount > 0
        ? `${workingCount} working · ${activeWorkerCount} active workers · ${botCount} total bots`
        : `${botCount} total bots · All idle`;
  return { id: 'bot-world-status', text, icon: 'bot', tone, tooltip };
}

export class BotWorldWorkerController {
  private readonly orca: OrcaWorkerApi;
  private readonly cli: OrcaClient;
  private readonly quickSendFn: QuickSendFn;
  private readonly itemReplyFn: ItemReplyFn;
  private readonly nowMs: () => number;
  private readonly quickSendCooldowns = new Map<string, number>();
  private readonly itemReplyCooldowns = new Map<string, number>();
  private readonly rpgActionCooldowns = new Map<string, number>();
  private readonly seenRpgEventIds = new Set<string>();
  private readonly desktopNotifier = new DesktopNotificationManager();
  private readonly watchdogTracker = new StuckWatchdogTracker();
  private lastStuckAlerts: StuckAlert[] = [];
  private lastStuckSig = '';
  private readonly session = new PollerSession();
  private timeline = new TimelineBuffer();
  private weeklyTrendStore: WeeklyTrendStore = { days: [], seenIds: [] };
  private rpgStore: BotRpgStore = createEmptyBotRpgStore();
  private creatorStore: CreatorAssetsState = createEmptyCreatorAssetsState();
  private prefs: StoredPrefs = {
    activeTheme: 'startup_office',
    atmosphereMode: 'auto',
    weatherMode: 'auto',
    soundMode: 'off',
    viewMode: 'office',
    redactMode: false,
    botAppearances: {},
    languageSetting: 'auto',
    hasThemeOverride: false,
    hasAtmosphereOverride: false,
    hasWeatherOverride: false,
    hasViewModeOverride: false,
    hasRedactOverride: false,
    hasLanguageOverride: false,
    groupFilter: '',
  };
  private pollIntervalSec = 5;
  private hostLocale = 'en';
  private lastSettings: {
    defaultTheme: ThemeId;
    atmosphereMode: AtmosphereMode;
    weatherMode: WeatherMode;
    viewMode: ViewMode;
    allowQuickSend: boolean;
    desktopNotifications: boolean;
    stuckThresholdMin: number;
    redactMode: boolean;
    pollIntervalSec: number;
    language: LanguageSetting;
  } = {
    defaultTheme: 'startup_office',
    atmosphereMode: 'auto',
    weatherMode: 'auto',
    viewMode: 'office',
    allowQuickSend: false,
    desktopNotifications: false,
    stuckThresholdMin: DEFAULT_STUCK_THRESHOLD_MIN,
    redactMode: false,
    pollIntervalSec: 5,
    language: 'auto',
  };
  private prevSnapshot: WorldSnapshot = createEmptySnapshot();
  private workerSeqCounter = 0;
  private readonly workerSeqMap = new Map<string, number>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private eventDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pollInFlight: Promise<void> | null = null;
  private settingsUpdateQueue: Promise<void> = Promise.resolve();
  private readonly activeUiClients = new Set<string>();
  private autoLoopEnabled = false;
  private disposed = false;
  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor(
    orca: OrcaWorkerApi,
    cli?: OrcaClient,
    options?: { quickSend?: QuickSendFn; replyNeedsOwnerItem?: ItemReplyFn; nowMs?: () => number }
  ) {
    this.orca = orca;
    this.cli = cli ?? new OrcaCli();
    this.quickSendFn =
      options?.quickSend ?? ((botName, message) => sendQuickBotMessage(botName, message));
    this.itemReplyFn =
      options?.replyNeedsOwnerItem ??
      ((botName, itemNumber, answerText) => replyNeedsOwnerItem(botName, itemNumber, answerText));
    this.nowMs = options?.nowMs ?? (() => Date.now());
    try {
      this.hostLocale = Intl.DateTimeFormat().resolvedOptions().locale || 'en';
    } catch {
      this.hostLocale = 'en';
    }
  }

  currentLocale(): UiLocale {
    return effectiveLocale(this.prefs.languageSetting, this.hostLocale);
  }

  private setHostLocale(rawLocale: unknown): boolean {
    if (rawLocale === undefined || rawLocale === null) return false;
    if (
      typeof rawLocale !== 'string' ||
      rawLocale.length > 64 ||
      CONTROL_CHAR_RE.test(rawLocale)
    ) {
      throw makeHostError('invalid_params', 'Invalid locale');
    }
    const trimmed = rawLocale.trim();
    if (trimmed.length === 0 || trimmed !== rawLocale || !LOCALE_TAG_RE.test(trimmed)) {
      throw makeHostError('invalid_params', 'Invalid locale');
    }
    const prevEffective = this.currentLocale();
    this.hostLocale = trimmed;
    return this.currentLocale() !== prevEffective;
  }

  async init(options?: { disableAutoLoop?: boolean }): Promise<void> {
    const settings = await this.readSettings();
    this.lastSettings = settings;
    this.pollIntervalSec = settings.pollIntervalSec;
    this.session.setPollIntervalSec(this.pollIntervalSec);

    const storedPrefs = await this.orca.storage.get(STORAGE_PREFS_KEY);
    this.prefs = validatePrefs(storedPrefs, {
      theme: settings.defaultTheme,
      atmosphere: settings.atmosphereMode,
      weather: settings.weatherMode,
      viewMode: settings.viewMode,
      redact: settings.redactMode,
      language: settings.language,
    });

    const storedTimeline = await this.orca.storage.get(STORAGE_TIMELINE_KEY);
    const initNowMs = Date.now();
    this.timeline = TimelineBuffer.hydrate(storedTimeline, initNowMs);
    const storedWeeklyTrend = await this.orca.storage.get(STORAGE_WEEKLY_TREND_KEY);
    this.weeklyTrendStore = hydrateWeeklyTrendStore(storedWeeklyTrend, initNowMs);
    const storedRpg = await this.orca.storage.get(STORAGE_RPG_KEY);
    this.rpgStore = sanitizeBotRpgStore(storedRpg, initNowMs);
    const storedCreator = await this.orca.storage.get(STORAGE_CREATOR_KEY);
    this.creatorStore = sanitizeCreatorAssetsState(storedCreator, 0);
    if (this.timeline.eventLog.length > 0) {
      const mergedInit = mergeWeeklyTrendStore(
        this.weeklyTrendStore,
        this.timeline.eventLog,
        initNowMs
      );
      this.weeklyTrendStore = mergedInit.store;
      if (mergedInit.changed) {
        await this.persistWeeklyTrend();
      }
    }
    for (const rec of this.timeline.eventLog) {
      if (rec.event.kind === 'WorkerStart') {
        const seq = extractWorkerSeq(rec);
        if (seq !== undefined) {
          if (!this.workerSeqMap.has(rec.event.dispatchId)) {
            if (this.workerSeqMap.size >= 512) {
              const oldest = this.workerSeqMap.keys().next().value;
              if (oldest !== undefined) this.workerSeqMap.delete(oldest);
            }
            this.workerSeqMap.set(rec.event.dispatchId, seq);
          }
          if (seq > this.workerSeqCounter) {
            this.workerSeqCounter = seq;
          }
        }
      }
    }

    this.registerHandlers();
    await this.updateStatusBar();

    if (!options?.disableAutoLoop) {
      this.autoLoopEnabled = true;
      void this.executeScheduledPoll();
    }
  }

  private async readSettings(): Promise<{
    defaultTheme: ThemeId;
    atmosphereMode: AtmosphereMode;
    weatherMode: WeatherMode;
    viewMode: ViewMode;
    allowQuickSend: boolean;
    desktopNotifications: boolean;
    stuckThresholdMin: number;
    redactMode: boolean;
    pollIntervalSec: number;
    language: LanguageSetting;
  }> {
    let defaultTheme: ThemeId = 'startup_office';
    let atmosphereMode: AtmosphereMode = 'auto';
    let weatherMode: WeatherMode = 'auto';
    let viewMode: ViewMode = 'office';
    let allowQuickSend = false;
    let desktopNotifications = false;
    let stuckThresholdMin = DEFAULT_STUCK_THRESHOLD_MIN;
    let redactMode = false;
    let pollIntervalSec = 5;
    let language: LanguageSetting = 'auto';
    try {
      const all = await this.orca.settings.get();
      if (all && typeof all === 'object') {
        if (isValidThemeId(all.defaultTheme)) {
          defaultTheme = all.defaultTheme;
        }
        if (isValidAtmosphereMode(all.atmosphereMode)) {
          atmosphereMode = all.atmosphereMode;
        }
        if (isValidWeatherMode(all.weatherMode)) {
          weatherMode = all.weatherMode;
        }
        if (isValidViewMode(all.viewMode)) {
          viewMode = all.viewMode;
        }
        if (typeof all.allowQuickSend === 'boolean') {
          allowQuickSend = all.allowQuickSend;
        }
        if (typeof all.desktopNotifications === 'boolean') {
          desktopNotifications = all.desktopNotifications;
        }
        if (all.stuckThresholdMin !== undefined) {
          stuckThresholdMin = clampStuckThresholdMin(all.stuckThresholdMin);
        }
        if (typeof all.redactMode === 'boolean') {
          redactMode = all.redactMode;
        }
        if (typeof all.pollIntervalSec === 'number' && Number.isFinite(all.pollIntervalSec)) {
          pollIntervalSec = Math.max(2, Math.min(60, Math.trunc(all.pollIntervalSec)));
        }
        language = normalizeLanguageSetting(all.language);
      }
    } catch {
      // Fallback to defaults if settings cannot be read
    }
    return {
      defaultTheme,
      atmosphereMode,
      weatherMode,
      viewMode,
      allowQuickSend,
      desktopNotifications,
      stuckThresholdMin,
      redactMode,
      pollIntervalSec,
      language,
    };
  }

  private assignWorkerSeq(dispatchId: string): number {
    const existing = this.workerSeqMap.get(dispatchId);
    if (existing !== undefined) return existing;
    this.workerSeqCounter += 1;
    if (this.workerSeqMap.size >= 512) {
      const oldest = this.workerSeqMap.keys().next().value;
      if (oldest !== undefined) this.workerSeqMap.delete(oldest);
    }
    this.workerSeqMap.set(dispatchId, this.workerSeqCounter);
    return this.workerSeqCounter;
  }

  buildStatePayload(sinceMs?: number): BotWorldStatePayload {
    const redact = this.prefs.redactMode;
    const locale = this.currentLocale();
    const s = tStrings(locale);
    const groupFilter = this.prefs.groupFilter;
    const scopedSnapshot = scopeSnapshotToGroup(this.session.snapshot, groupFilter);
    const safeSnapshot = prepareSnapshotForUi(scopedSnapshot, redact, locale);
    const trendNowMs = this.session.snapshot.capturedAt > 0 ? this.session.snapshot.capturedAt : Date.now();
    const stuckAlerts = this.watchdogTracker.getAlerts(scopedSnapshot, {
      thresholdMin: this.lastSettings.stuckThresholdMin,
      nowMs: this.nowMs(),
      redactMode: redact,
      locale,
    });
    const payload: BotWorldStatePayload = {
      snapshot: safeSnapshot,
      events: [],
      keyframes: [],
      activeTheme: this.prefs.activeTheme,
      atmosphereMode: this.prefs.atmosphereMode,
      weatherMode: this.prefs.weatherMode,
      soundMode: this.prefs.soundMode,
      viewMode: this.prefs.viewMode,
      allowQuickSend: this.lastSettings.allowQuickSend,
      desktopNotifications: this.lastSettings.desktopNotifications,
      stuckThresholdMin: this.lastSettings.stuckThresholdMin,
      stuckAlerts,
      redactMode: redact,
      botAppearances: { ...this.prefs.botAppearances },
      rpgProfiles: buildRpgProfilesForSnapshot(this.rpgStore, safeSnapshot),
      pollIntervalSec: this.pollIntervalSec,
      locale,
      languageSetting: this.prefs.languageSetting,
      weeklyTrend: getLastSevenDaysTrend(this.weeklyTrendStore.days, trendNowMs),
      creatorUpdatedAtMs: this.creatorStore.updatedAtMs,
      groupFilter,
      availableGroups: listBotGroups(this.session.snapshot),
    };

    const baseBytes = utf8ByteLength(payload);
    const timelineBudget = Math.max(0, MAX_IPC_PAYLOAD_BYTES - baseBytes - 1024);
    const { events, keyframes } = this.timeline.exportBounded(sinceMs, timelineBudget);

    const safeEvents = events.map((ev): WorldEventRecord => {
      const seqHint =
        ev.event.kind === 'WorkerStart'
          ? (extractWorkerSeq(ev) ?? this.assignWorkerSeq(ev.event.dispatchId))
          : 1;
      const [summary, redactedSummary] = formatEventSummaries(ev.event, seqHint, locale);
      const out: WorldEventRecord = redact
        ? {
            timestampMs: ev.timestampMs,
            summary: redactedSummary,
            redactedSummary,
            event: redactWorldEvent(
              ev.event,
              (dispatchId) =>
                s.workerNumbered(
                  ev.event.kind === 'WorkerStart' && dispatchId === ev.event.dispatchId
                    ? seqHint
                    : this.assignWorkerSeq(dispatchId)
                ),
              locale
            ),
          }
        : {
            timestampMs: ev.timestampMs,
            summary,
            redactedSummary,
            event: ev.event,
          };
      if (ev.event.kind === 'WorkerStart') {
        out.workerSeq = seqHint;
      }
      return out;
    });
    const safeKeyframes = keyframes.map((kf) => ({
      timestampMs: kf.timestampMs,
      snapshot: prepareSnapshotForUi(scopeSnapshotToGroup(kf.snapshot, groupFilter), redact, locale),
    }));

    payload.events = safeEvents;
    payload.keyframes = safeKeyframes;

    this.trimPayloadToBudget(payload);

    return payload;
  }

  private trimPayloadToBudget(payload: BotWorldStatePayload): void {
    let totalBytes = utf8ByteLength(payload);
    while (
      totalBytes > MAX_IPC_PAYLOAD_BYTES &&
      (payload.keyframes.length > 0 || payload.events.length > 0)
    ) {
      if (payload.keyframes.length > 0) {
        payload.keyframes.splice(0, Math.max(1, Math.floor(payload.keyframes.length / 4)));
      } else if (payload.events.length > 0) {
        payload.events.splice(0, Math.max(1, Math.floor(payload.events.length / 4)));
      }
      totalBytes = utf8ByteLength(payload);
    }

    // If snapshot alone still exceeds MAX_IPC_PAYLOAD_BYTES, trim non-critical snapshot tails
    while (totalBytes > MAX_IPC_PAYLOAD_BYTES && payload.snapshot.recentMessages.length > 0) {
      payload.snapshot.recentMessages.splice(
        0,
        Math.max(1, Math.floor(payload.snapshot.recentMessages.length / 2))
      );
      totalBytes = utf8ByteLength(payload);
    }
    if (totalBytes > MAX_IPC_PAYLOAD_BYTES) {
      for (const [uid, it] of Object.entries(payload.snapshot.items)) {
        if (it.status === 'done' || it.status === 'canceled' || it.status === 'closed') {
          delete payload.snapshot.items[uid];
        }
      }
      totalBytes = utf8ByteLength(payload);
    }
    if (totalBytes > MAX_IPC_PAYLOAD_BYTES) {
      for (const [id, w] of Object.entries(payload.snapshot.workers)) {
        if (!isWorkerVisibleOnStage(w)) {
          delete payload.snapshot.workers[id];
        }
      }
      totalBytes = utf8ByteLength(payload);
    }
    if (totalBytes > MAX_IPC_PAYLOAD_BYTES) {
      payload.snapshot.chatIndex = {};
      payload.snapshot.runBotIndex = {};
      totalBytes = utf8ByteLength(payload);
    }

    // Large-fleet defense (e.g., 40+ bots): strip bot specialties, shorten task titles, and prune remaining items
    if (totalBytes > MAX_IPC_PAYLOAD_BYTES) {
      for (const bot of Object.values(payload.snapshot.bots)) {
        bot.specialty = '';
        if (bot.currentTaskTitle !== null) {
          bot.currentTaskTitle = truncateUiText(bot.currentTaskTitle, 48);
        }
        if (bot.currentTool !== null) {
          bot.currentTool = truncateUiText(bot.currentTool, 24);
        }
        if (bot.status.kind === 'NeedsOwner' && bot.status.prompt !== null) {
          bot.status = { ...bot.status, prompt: truncateUiText(bot.status.prompt, 48) };
        } else if (bot.status.kind === 'Blocked' && bot.status.reason !== null) {
          bot.status = { ...bot.status, reason: truncateUiText(bot.status.reason, 48) };
        } else if (bot.status.kind === 'Error' && bot.status.message !== null) {
          bot.status = { ...bot.status, message: truncateUiText(bot.status.message, 48) };
        }
      }
      for (const [uid, it] of Object.entries(payload.snapshot.items)) {
        if (it.status !== 'needs_you') {
          delete payload.snapshot.items[uid];
        } else {
          it.title = truncateUiText(it.title, 48);
          if (it.questionPrompt !== null) {
            it.questionPrompt = truncateUiText(it.questionPrompt, 48);
          }
          it.questionOptions = [];
        }
      }
      totalBytes = utf8ByteLength(payload);
    }
    if (totalBytes > MAX_IPC_PAYLOAD_BYTES) {
      for (const bot of Object.values(payload.snapshot.bots)) {
        bot.currentTaskTitle = null;
        bot.currentTool = null;
      }
      payload.snapshot.items = {};
      for (const auto of Object.values(payload.snapshot.automations)) {
        auto.name = truncateUiText(auto.name, 32);
        auto.lastError = null;
      }
      totalBytes = utf8ByteLength(payload);
    }
    if (totalBytes > MAX_IPC_PAYLOAD_BYTES) {
      payload.snapshot.automations = {};
      payload.snapshot.workers = {};
      payload.botAppearances = {};
      totalBytes = utf8ByteLength(payload);
    }
    if (totalBytes > MAX_IPC_PAYLOAD_BYTES) {
      payload.rpgProfiles = {};
      payload.stuckAlerts = [];
      totalBytes = utf8ByteLength(payload);
    }
    while (totalBytes > MAX_IPC_PAYLOAD_BYTES && payload.snapshot.botOrder.length > 0) {
      const removedId = payload.snapshot.botOrder.pop();
      if (removedId && isSafeKey(removedId)) {
        delete payload.snapshot.bots[removedId];
      }
      totalBytes = utf8ByteLength(payload);
    }
    if (totalBytes > MAX_IPC_PAYLOAD_BYTES) {
      const keys = Object.keys(payload.snapshot.bots);
      while (totalBytes > MAX_IPC_PAYLOAD_BYTES && keys.length > 0) {
        const k = keys.pop();
        if (k && isSafeKey(k)) delete payload.snapshot.bots[k];
        totalBytes = utf8ByteLength(payload);
      }
    }
  }

  private async persistPrefs(): Promise<void> {
    await this.orca.storage.set(STORAGE_PREFS_KEY, this.prefs as unknown as JsonValue);
  }

  private async persistTimeline(): Promise<void> {
    const data = this.timeline.serialize();
    await this.orca.storage.set(STORAGE_TIMELINE_KEY, data as unknown as JsonValue);
  }

  private async persistWeeklyTrend(): Promise<void> {
    await this.orca.storage.set(
      STORAGE_WEEKLY_TREND_KEY,
      this.weeklyTrendStore as unknown as JsonValue
    );
  }

  private async persistRpgStore(): Promise<void> {
    await this.orca.storage.set(STORAGE_RPG_KEY, this.rpgStore as unknown as JsonValue);
  }

  private async persistCreatorStore(): Promise<void> {
    if (utf8JsonBytes(this.creatorStore) > MAX_STORED_CREATOR_BYTES) {
      throw makeHostError('invalid_params', 'Creator assets exceed storage cap');
    }
    await this.orca.storage.set(STORAGE_CREATOR_KEY, this.creatorStore as unknown as JsonValue);
  }

  private nextCreatorTimestamp(): number {
    return Math.max(this.creatorStore.updatedAtMs + 1, this.nowMs());
  }

  private cloneCreatorState(): CreatorAssetsState {
    return {
      packName: this.creatorStore.packName,
      customBackground: this.creatorStore.customBackground,
      customAvatars: { ...this.creatorStore.customAvatars },
      updatedAtMs: this.creatorStore.updatedAtMs,
    };
  }

  private async updateStatusBar(): Promise<void> {
    if (!this.orca.host.has('statusBar.update')) return;
    try {
      const params = formatStatusBarParams(
        this.session.snapshot,
        this.prefs.redactMode,
        this.currentLocale()
      );
      await this.orca.host.call('statusBar.update', params);
    } catch {
      // Ignore status bar refusal in headless/non-desktop tests
    }
  }

  private postStateUpdated(): void {
    try {
      const payload = this.buildStatePayload();
      this.orca.panels.post('botWorld.stateUpdated', payload);
    } catch {
      // Never throw from fire-and-forget post
    }
  }

  async runPollTick(
    options: boolean | { forceFull?: boolean; forceFast?: boolean } = false
  ): Promise<void> {
    const forceFull = typeof options === 'boolean' ? options : Boolean(options.forceFull);
    const forceFast = typeof options === 'boolean' ? false : Boolean(options.forceFast);
    if (this.disposed) return;
    if (this.pollInFlight) {
      let coalesced = false;
      while (this.pollInFlight) {
        if (!forceFull && !forceFast) {
          coalesced = true;
        }
        try {
          await this.pollInFlight;
        } catch {
          // Prior failure does not block queued poll
        }
        if (this.disposed) return;
      }
      if (coalesced) return;
    }
    if (this.disposed) return;

    const work = (async () => {
      const nowMs = this.nowMs();
      const hadPrevBots = Object.keys(this.prevSnapshot.bots).length > 0;
      const { snapshot } = await this.session.step(this.cli, { forceFull, forceFast, nowMs });
      if (this.disposed) return;

      const locale = this.currentLocale();
      if (!snapshot) {
        const latest = this.session.getLatestSnapshot();
        if (latest.initialSyncComplete && Object.keys(latest.bots).length > 0) {
          const nextAlerts = this.watchdogTracker.evaluate(latest, {
            thresholdMin: this.lastSettings.stuckThresholdMin,
            nowMs,
            redactMode: this.prefs.redactMode,
            locale,
          });
          const nextSig = stuckAlertsSignature(nextAlerts);
          if (nextSig !== this.lastStuckSig) {
            this.lastStuckAlerts = nextAlerts;
            this.lastStuckSig = nextSig;
            if (nextAlerts.length > 0) {
              await this.desktopNotifier.notifyStuckAlerts({
                alerts: nextAlerts,
                snapshot: latest,
                enabled: this.lastSettings.desktopNotifications,
                thresholdMin: this.lastSettings.stuckThresholdMin,
                redactMode: this.prefs.redactMode,
                locale,
                nowMs,
                orca: this.orca,
              });
            }
            this.postStateUpdated();
          }
        }
        return;
      }

      const suppressDiff = !hadPrevBots || !snapshot.initialSyncComplete;
      const newEvents = diffSnapshots(this.prevSnapshot, snapshot, suppressDiff, locale);
      for (const ev of newEvents) {
        const seqHint = ev.kind === 'WorkerStart' ? this.assignWorkerSeq(ev.dispatchId) : 1;
        this.timeline.pushEvent(ev, nowMs, seqHint, locale);
      }

      const keyframeRecorded = this.timeline.maybeRecordLiveKeyframe(
        snapshot,
        nowMs,
        newEvents.length > 0
      );

      let rpgChanged = false;
      if (!suppressDiff && newEvents.length > 0) {
        const rpgRes = applyWorldEventsToRpgStore(
          this.rpgStore,
          newEvents,
          this.seenRpgEventIds,
          nowMs
        );
        rpgChanged = rpgRes.changed;
      }

      const stuckAlerts = this.watchdogTracker.evaluate(snapshot, {
        thresholdMin: this.lastSettings.stuckThresholdMin,
        nowMs,
        redactMode: this.prefs.redactMode,
        locale,
      });
      this.lastStuckAlerts = stuckAlerts;
      this.lastStuckSig = stuckAlertsSignature(stuckAlerts);

      if (!suppressDiff) {
        await this.desktopNotifier.evaluateAndNotify({
          prevSnapshot: this.prevSnapshot,
          nextSnapshot: snapshot,
          enabled: this.lastSettings.desktopNotifications,
          redactMode: this.prefs.redactMode,
          locale,
          nowMs,
          orca: this.orca,
        });
        await this.desktopNotifier.notifyStuckAlerts({
          alerts: stuckAlerts,
          snapshot,
          enabled: this.lastSettings.desktopNotifications,
          thresholdMin: this.lastSettings.stuckThresholdMin,
          redactMode: this.prefs.redactMode,
          locale,
          nowMs,
          orca: this.orca,
        });
      }

      this.prevSnapshot = structuredClone(snapshot);

      if (newEvents.length > 0 || keyframeRecorded) {
        await this.persistTimeline();
      }
      if (rpgChanged) {
        await this.persistRpgStore();
      }
      if (newEvents.length > 0) {
        const mergedTrend = mergeWeeklyTrendStore(
          this.weeklyTrendStore,
          this.timeline.eventLog,
          nowMs
        );
        this.weeklyTrendStore = mergedTrend.store;
        if (mergedTrend.changed) {
          await this.persistWeeklyTrend();
        }
      }
      await this.updateStatusBar();
      this.postStateUpdated();
    })();

    this.pollInFlight = work;
    try {
      await work;
    } finally {
      if (this.pollInFlight === work) {
        this.pollInFlight = null;
      }
    }
  }

  private async executeScheduledPoll(): Promise<void> {
    try {
      await this.runPollTick(false);
    } catch {
      // Never let a single poll exception permanently halt the polling loop
    } finally {
      if (!this.disposed) {
        const retrySecs = this.session.snapshot.runtime.retryAfterSecs;
        const nextDelay = retrySecs !== null ? retrySecs * 1000 : this.session.getFastIntervalMs();
        this.scheduleNextPoll(nextDelay);
      }
    }
  }

  private scheduleNextPoll(delayMs: number): void {
    if (this.disposed) return;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    const clamped = Math.max(50, Math.min(60_000, delayMs));
    this.pollTimer = setTimeout(() => {
      void this.executeScheduledPoll();
    }, clamped);
  }

  private registerHandlers(): void {
    this.disposables.push(
      this.orca.panels.handle('botWorld.getState', async (input) => {
        if (input !== undefined && input !== null) {
          if (typeof input !== 'object' || Array.isArray(input)) {
            throw makeHostError('invalid_params', 'input must be an object');
          }
          const clean = stripDangerousKeys(input as Record<string, unknown>);
          if (
            clean.sinceMs !== undefined &&
            (typeof clean.sinceMs !== 'number' || !Number.isFinite(clean.sinceMs) || clean.sinceMs < 0)
          ) {
            throw makeHostError('invalid_params', 'sinceMs must be a non-negative finite number');
          }
          if (this.setHostLocale(clean.locale)) {
            await this.updateStatusBar();
          }
          return this.buildStatePayload(clean.sinceMs as number | undefined);
        }
        return this.buildStatePayload();
      }),

      this.orca.panels.handle('botWorld.refresh', async (input) => {
        if (input !== undefined && input !== null) {
          if (typeof input !== 'object' || Array.isArray(input)) {
            throw makeHostError('invalid_params', 'input must be an object');
          }
          const clean = stripDangerousKeys(input as Record<string, unknown>);
          this.setHostLocale(clean.locale);
        }
        await this.runPollTick(true);
        return this.buildStatePayload();
      }),

      this.orca.panels.handle('botWorld.setLanguage', async (input) => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw makeHostError('invalid_params', 'input must be an object');
        }
        const clean = stripDangerousKeys(input as Record<string, unknown>);
        if (!isValidLanguageSetting(clean.language)) {
          throw makeHostError('invalid_params', 'Invalid language');
        }
        if (clean.hostLocale !== undefined) {
          this.setHostLocale(clean.hostLocale);
        }
        this.prefs.languageSetting = clean.language;
        this.prefs.hasLanguageOverride = true;
        await this.persistPrefs();
        await this.updateStatusBar();
        this.postStateUpdated();
        return {
          languageSetting: this.prefs.languageSetting,
          locale: this.currentLocale(),
        };
      }),

      this.orca.panels.handle('botWorld.setTheme', async (input) => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw makeHostError('invalid_params', 'input must be an object');
        }
        const clean = stripDangerousKeys(input as Record<string, unknown>);
        if (!isValidThemeId(clean.themeId)) {
          throw makeHostError('invalid_params', 'Invalid themeId');
        }
        this.prefs.activeTheme = clean.themeId;
        this.prefs.hasThemeOverride = true;
        await this.persistPrefs();
        this.postStateUpdated();
        return { themeId: this.prefs.activeTheme };
      }),

      this.orca.panels.handle('botWorld.setAtmosphereMode', async (input) => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw makeHostError('invalid_params', 'input must be an object');
        }
        const clean = stripDangerousKeys(input as Record<string, unknown>);
        if (!isValidAtmosphereMode(clean.atmosphereMode)) {
          throw makeHostError('invalid_params', 'Invalid atmosphereMode');
        }
        this.prefs.atmosphereMode = clean.atmosphereMode;
        this.prefs.hasAtmosphereOverride = true;
        await this.persistPrefs();
        this.postStateUpdated();
        return { atmosphereMode: this.prefs.atmosphereMode };
      }),

      this.orca.panels.handle('botWorld.setWeatherMode', async (input) => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw makeHostError('invalid_params', 'input must be an object');
        }
        const clean = stripDangerousKeys(input as Record<string, unknown>);
        if (!isValidWeatherMode(clean.weatherMode)) {
          throw makeHostError('invalid_params', 'Invalid weatherMode');
        }
        this.prefs.weatherMode = clean.weatherMode;
        this.prefs.hasWeatherOverride = true;
        await this.persistPrefs();
        this.postStateUpdated();
        return { weatherMode: this.prefs.weatherMode };
      }),

      this.orca.panels.handle('botWorld.setSoundMode', async (input) => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw makeHostError('invalid_params', 'input must be an object');
        }
        const clean = stripDangerousKeys(input as Record<string, unknown>);
        if (!isValidSoundMode(clean.soundMode)) {
          throw makeHostError('invalid_params', 'Invalid soundMode');
        }
        this.prefs.soundMode = clean.soundMode;
        await this.persistPrefs();
        this.postStateUpdated();
        return { soundMode: this.prefs.soundMode };
      }),

      this.orca.panels.handle('botWorld.setGroupFilter', async (input) => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw makeHostError('invalid_params', 'input must be an object');
        }
        const clean = stripDangerousKeys(input as Record<string, unknown>);
        const group = sanitizeGroupFilter(clean.group);
        if (group === null) {
          throw makeHostError('invalid_params', 'Invalid group');
        }
        this.prefs.groupFilter = group;
        await this.persistPrefs();
        this.postStateUpdated();
        return { groupFilter: this.prefs.groupFilter };
      }),

      this.orca.panels.handle('botWorld.setViewMode', async (input) => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw makeHostError('invalid_params', 'input must be an object');
        }
        const clean = stripDangerousKeys(input as Record<string, unknown>);
        if (!isValidViewMode(clean.viewMode)) {
          throw makeHostError('invalid_params', 'Invalid viewMode');
        }
        this.prefs.viewMode = clean.viewMode;
        this.prefs.hasViewModeOverride = true;
        await this.persistPrefs();
        this.postStateUpdated();
        return { viewMode: this.prefs.viewMode };
      }),

      this.orca.panels.handle('botWorld.focusTerminal', async (input): Promise<FocusTerminalResponse> => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw makeHostError('invalid_params', 'input must be an object');
        }
        const clean = stripDangerousKeys(input as Record<string, unknown>);
        const terminalId = validateHostTargetId(clean.terminalId, 'terminalId');
        if (!this.orca.host.has('terminal.focus')) {
          return { ok: false, focused: false, reason: 'unavailable' };
        }
        try {
          const res = await this.orca.host.call('terminal.focus', { terminalId });
          const focused = Boolean(res?.focused);
          return focused ? { ok: true, focused: true } : { ok: true, focused: false, reason: 'not_focused' };
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'refused';
          return { ok: false, focused: false, reason: scrubAll(msg) };
        }
      }),

      this.orca.panels.handle('botWorld.openWorkspace', async (input): Promise<OpenWorkspaceResponse> => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw makeHostError('invalid_params', 'input must be an object');
        }
        const clean = stripDangerousKeys(input as Record<string, unknown>);
        const workspaceId = validateHostTargetId(clean.workspaceId, 'workspaceId');
        if (!this.orca.host.has('workspace.open')) {
          return { ok: false, opened: false, reason: 'unavailable' };
        }
        try {
          const res = await this.orca.host.call('workspace.open', { workspaceId });
          return { ok: true, opened: Boolean(res?.opened) };
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'refused';
          return { ok: false, opened: false, reason: scrubAll(msg) };
        }
      }),

      this.orca.panels.handle('botWorld.sendQuickMessage', async (input): Promise<QuickSendResponse> => {
        await this.settingsUpdateQueue;
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw makeHostError('invalid_params', 'input must be an object');
        }
        const s = tStrings(this.currentLocale());
        if (!this.lastSettings.allowQuickSend) {
          return { ok: false, code: 'disabled', error: s.quickSendDisabledError };
        }
        const clean = stripDangerousKeys(input as Record<string, unknown>);
        const rawBotId = clean.botId;
        if (
          typeof rawBotId !== 'string' ||
          !isSafeKey(rawBotId) ||
          rawBotId.length > 128 ||
          CONTROL_CHAR_RE.test(rawBotId)
        ) {
          return { ok: false, code: 'invalid_params', error: s.quickSendUnknownBotError };
        }
        let cleanMessage: string;
        try {
          cleanMessage = validateQuickMessageBody(clean.message as string);
        } catch (err) {
          return {
            ok: false,
            code: 'invalid_params',
            error: err instanceof OrcaCliError ? s.quickSendInvalidError : s.quickSendInvalidError,
          };
        }

        const latestSnap = this.session.getLatestSnapshot();
        if (!Object.hasOwn(latestSnap.bots, rawBotId)) {
          return { ok: false, code: 'unknown_bot', error: s.quickSendUnknownBotError };
        }
        const bot = latestSnap.bots[rawBotId];

        const now = this.nowMs();
        const prevSentAt = this.quickSendCooldowns.get(rawBotId);
        if (prevSentAt !== undefined && now - prevSentAt < QUICK_SEND_COOLDOWN_MS) {
          return { ok: false, code: 'rate_limited', error: s.quickSendRateLimitedError };
        }

        if (this.quickSendCooldowns.size >= 256) {
          const oldestKey = this.quickSendCooldowns.keys().next().value;
          if (oldestKey !== undefined) this.quickSendCooldowns.delete(oldestKey);
        }
        this.quickSendCooldowns.set(rawBotId, now);

        try {
          await this.quickSendFn(bot.name, cleanMessage);
        } catch (err) {
          const rawMsg = err instanceof Error ? err.message : 'Quick Send failed';
          return { ok: false, code: 'cli_error', error: scrubAll(rawMsg) };
        }

        try {
          await this.runPollTick(true);
        } catch {
          // Best-effort immediate refresh after successful quick send
        }

        return { ok: true, botId: bot.id, botName: scrubAll(bot.name) };
      }),

      this.orca.panels.handle('botWorld.replyNeedsOwnerItem', async (input): Promise<ItemReplyResponse> => {
        await this.settingsUpdateQueue;
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw makeHostError('invalid_params', 'input must be an object');
        }
        const s = tStrings(this.currentLocale());
        if (!this.lastSettings.allowQuickSend) {
          return { ok: false, code: 'disabled', error: s.needsYouReplyDisabledError };
        }
        const clean = stripDangerousKeys(input as Record<string, unknown>);
        const rawBotId = clean.botId;
        if (
          typeof rawBotId !== 'string' ||
          !isSafeKey(rawBotId) ||
          rawBotId.length > 128 ||
          CONTROL_CHAR_RE.test(rawBotId)
        ) {
          return { ok: false, code: 'invalid_params', error: s.quickSendUnknownBotError };
        }
        const rawItemNumber = clean.itemNumber;
        if (
          typeof rawItemNumber !== 'number' ||
          !Number.isSafeInteger(rawItemNumber) ||
          rawItemNumber < 1 ||
          rawItemNumber > MAX_ITEM_NUMBER
        ) {
          return { ok: false, code: 'invalid_params', error: s.quickSendInvalidError };
        }
        let cleanAnswer: string;
        try {
          cleanAnswer = validateQuickMessageBody(clean.answerText as string);
        } catch {
          return { ok: false, code: 'invalid_params', error: s.quickSendInvalidError };
        }

        const latestSnap = this.session.getLatestSnapshot();
        if (!Object.hasOwn(latestSnap.bots, rawBotId)) {
          return { ok: false, code: 'unknown_bot', error: s.quickSendUnknownBotError };
        }
        const bot = latestSnap.bots[rawBotId];
        const matchingItem = Object.values(latestSnap.items).find(
          (it) =>
            it.status === 'needs_you' &&
            it.number === rawItemNumber &&
            (it.ownerBotId === bot.id || it.ownerBotName === bot.name)
        );
        if (!matchingItem) {
          return { ok: false, code: 'unknown_item', error: s.needsYouUnknownItemError };
        }

        const now = this.nowMs();
        const prevSentAt = this.itemReplyCooldowns.get(rawBotId);
        if (prevSentAt !== undefined && now - prevSentAt < QUICK_SEND_COOLDOWN_MS) {
          return { ok: false, code: 'rate_limited', error: s.quickSendRateLimitedError };
        }
        if (this.itemReplyCooldowns.size >= 256) {
          const oldestKey = this.itemReplyCooldowns.keys().next().value;
          if (oldestKey !== undefined) this.itemReplyCooldowns.delete(oldestKey);
        }
        this.itemReplyCooldowns.set(rawBotId, now);

        try {
          await this.itemReplyFn(bot.name, rawItemNumber, cleanAnswer);
        } catch (err) {
          const rawMsg = err instanceof Error ? err.message : 'Decision reply failed';
          return { ok: false, code: 'cli_error', error: scrubAll(rawMsg) };
        }

        try {
          await this.runPollTick(true);
        } catch {
          // Best-effort immediate refresh after successful item reply
        }

        return {
          ok: true,
          botId: bot.id,
          botName: scrubAll(bot.name),
          itemNumber: rawItemNumber,
        };
      }),

      this.orca.panels.handle('botWorld.awardRpgXp', async (input) => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw makeHostError('invalid_params', 'input must be an object');
        }
        const clean = stripDangerousKeys(input as Record<string, unknown>);
        const botId = clean.botId;
        const action = clean.action;
        if (
          typeof botId !== 'string' ||
          !isSafeKey(botId) ||
          botId.length > 128 ||
          CONTROL_CHAR_RE.test(botId)
        ) {
          throw makeHostError('invalid_params', 'Invalid botId');
        }
        if (!isValidRpgXpAction(action)) {
          throw makeHostError('invalid_params', 'Invalid action');
        }
        const latestSnap = this.session.getLatestSnapshot();
        if (!Object.hasOwn(latestSnap.bots, botId)) {
          return {
            ok: false,
            reason: 'unknown_bot' as const,
            xpAwarded: 0,
            leveledUp: false,
            rpgProfiles: buildRpgProfilesForSnapshot(this.rpgStore, latestSnap),
          };
        }
        const res = applyRpgActionToStore(
          this.rpgStore,
          botId,
          action,
          this.nowMs(),
          this.rpgActionCooldowns
        );
        if (res.ok) {
          await this.persistRpgStore();
          this.postStateUpdated();
        }
        return {
          ...res,
          rpgProfiles: buildRpgProfilesForSnapshot(this.rpgStore, latestSnap),
        };
      }),

      this.orca.panels.handle('botWorld.equipDeskProp', async (input) => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw makeHostError('invalid_params', 'input must be an object');
        }
        const clean = stripDangerousKeys(input as Record<string, unknown>);
        const botId = clean.botId;
        const propId = clean.propId;
        if (
          typeof botId !== 'string' ||
          !isSafeKey(botId) ||
          botId.length > 128 ||
          CONTROL_CHAR_RE.test(botId)
        ) {
          throw makeHostError('invalid_params', 'Invalid botId');
        }
        if (!isValidDeskPropId(propId)) {
          throw makeHostError('invalid_params', 'Invalid propId');
        }
        const latestSnap = this.session.getLatestSnapshot();
        if (!Object.hasOwn(latestSnap.bots, botId)) {
          return {
            ok: false,
            reason: 'unknown_bot' as const,
            rpgProfiles: buildRpgProfilesForSnapshot(this.rpgStore, latestSnap),
          };
        }
        const res = equipDeskPropInStore(this.rpgStore, botId, propId, this.nowMs());
        if (res.ok) {
          await this.persistRpgStore();
          this.postStateUpdated();
        }
        return {
          ...res,
          rpgProfiles: buildRpgProfilesForSnapshot(this.rpgStore, latestSnap),
        };
      }),

      this.orca.panels.handle('botWorld.setRedactMode', async (input) => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw makeHostError('invalid_params', 'input must be an object');
        }
        const clean = stripDangerousKeys(input as Record<string, unknown>);
        if (typeof clean.redactMode !== 'boolean') {
          throw makeHostError('invalid_params', 'redactMode must be a boolean');
        }
        this.prefs.redactMode = clean.redactMode;
        this.prefs.hasRedactOverride = true;
        await this.persistPrefs();
        await this.updateStatusBar();
        this.postStateUpdated();
        return { redactMode: this.prefs.redactMode };
      }),

      this.orca.panels.handle('botWorld.setBotAppearance', async (input) => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw makeHostError('invalid_params', 'input must be an object');
        }
        const clean = stripDangerousKeys(input as Record<string, unknown>);
        const botId = clean.botId;
        const characterId = clean.characterId;
        if (
          typeof botId !== 'string' ||
          !isSafeKey(botId) ||
          botId.length > 128 ||
          CONTROL_CHAR_RE.test(botId)
        ) {
          throw makeHostError('invalid_params', 'Invalid botId');
        }
        if (!isPoolCharacterId(characterId)) {
          throw makeHostError('invalid_params', 'Invalid characterId');
        }
        if (
          !Object.hasOwn(this.prefs.botAppearances, botId) &&
          Object.keys(this.prefs.botAppearances).length >= MAX_BOT_APPEARANCES
        ) {
          throw makeHostError('invalid_params', 'Too many botAppearances entries');
        }
        Object.defineProperty(this.prefs.botAppearances, botId, {
          value: characterId,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        await this.persistPrefs();
        this.postStateUpdated();
        return { botAppearances: { ...this.prefs.botAppearances } };
      }),

      this.orca.panels.handle('botWorld.getCreatorAssets', async () => {
        return this.cloneCreatorState();
      }),

      this.orca.panels.handle('botWorld.setCustomAvatar', async (input) => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw makeHostError('invalid_params', 'input must be an object');
        }
        const clean = stripDangerousKeys(input as Record<string, unknown>);
        const botId = clean.botId;
        if (
          typeof botId !== 'string' ||
          !isSafeKey(botId) ||
          botId.length > 128 ||
          CONTROL_CHAR_RE.test(botId)
        ) {
          throw makeHostError('invalid_params', 'Invalid botId');
        }
        const nextAvatars = { ...this.creatorStore.customAvatars };
        if (clean.dataUrl === null) {
          delete nextAvatars[botId];
        } else {
          const valid = validateCustomAssetDataUrl(clean.dataUrl, 'avatar');
          if (!valid) {
            throw makeHostError('invalid_params', 'Invalid custom avatar dataUrl');
          }
          if (
            !Object.hasOwn(nextAvatars, botId) &&
            Object.keys(nextAvatars).length >= MAX_CREATOR_AVATARS
          ) {
            throw makeHostError('invalid_params', 'Too many custom avatars');
          }
          Object.defineProperty(nextAvatars, botId, {
            value: valid,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        const candidate: CreatorAssetsState = {
          packName: this.creatorStore.packName,
          customBackground: this.creatorStore.customBackground,
          customAvatars: nextAvatars,
          updatedAtMs: this.nextCreatorTimestamp(),
        };
        if (utf8JsonBytes(candidate) > MAX_STORED_CREATOR_BYTES) {
          throw makeHostError('invalid_params', 'Creator assets exceed storage cap');
        }
        this.creatorStore = candidate;
        await this.persistCreatorStore();
        this.postStateUpdated();
        return this.cloneCreatorState();
      }),

      this.orca.panels.handle('botWorld.setCustomBackground', async (input) => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw makeHostError('invalid_params', 'input must be an object');
        }
        const clean = stripDangerousKeys(input as Record<string, unknown>);
        let nextBg: string | null = null;
        if (clean.dataUrl !== null) {
          const valid = validateCustomAssetDataUrl(clean.dataUrl, 'background');
          if (!valid) {
            throw makeHostError('invalid_params', 'Invalid custom background dataUrl');
          }
          nextBg = valid;
        }
        const candidate: CreatorAssetsState = {
          packName: this.creatorStore.packName,
          customBackground: nextBg,
          customAvatars: { ...this.creatorStore.customAvatars },
          updatedAtMs: this.nextCreatorTimestamp(),
        };
        if (utf8JsonBytes(candidate) > MAX_STORED_CREATOR_BYTES) {
          throw makeHostError('invalid_params', 'Creator assets exceed storage cap');
        }
        this.creatorStore = candidate;
        await this.persistCreatorStore();
        this.postStateUpdated();
        return this.cloneCreatorState();
      }),

      this.orca.panels.handle('botWorld.importCreatorPack', async (input) => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw makeHostError('invalid_params', 'input must be an object');
        }
        const clean = stripDangerousKeys(input as Record<string, unknown>);
        if (!clean.pack || typeof clean.pack !== 'object' || Array.isArray(clean.pack)) {
          throw makeHostError('invalid_params', 'Invalid pack');
        }
        const parsed = parseAndValidateCreatorPack(JSON.stringify(clean.pack));
        if (!parsed.ok) {
          throw makeHostError('invalid_params', `Invalid creator pack: ${parsed.error}`);
        }
        const candidate: CreatorAssetsState = {
          packName: sanitizePackName(parsed.pack.packName, 'Custom Pack'),
          customBackground: parsed.pack.customBackground ?? null,
          customAvatars: { ...parsed.pack.customAvatars },
          updatedAtMs: this.nextCreatorTimestamp(),
        };
        if (utf8JsonBytes(candidate) > MAX_STORED_CREATOR_BYTES) {
          throw makeHostError('invalid_params', 'Creator pack exceeds storage cap');
        }
        this.creatorStore = candidate;
        await this.persistCreatorStore();
        this.postStateUpdated();
        return this.cloneCreatorState();
      }),

      this.orca.panels.handle('botWorld.resetCustomAssets', async (input) => {
        let target: 'all' | 'background' | 'avatars' = 'all';
        if (input && typeof input === 'object' && !Array.isArray(input)) {
          const clean = stripDangerousKeys(input as Record<string, unknown>);
          if (clean.target === 'background' || clean.target === 'avatars' || clean.target === 'all') {
            target = clean.target;
          }
        }
        this.creatorStore = {
          packName: target === 'all' ? 'Custom Pack' : this.creatorStore.packName,
          customBackground: target === 'avatars' ? this.creatorStore.customBackground : null,
          customAvatars: target === 'background' ? { ...this.creatorStore.customAvatars } : {},
          updatedAtMs: this.nextCreatorTimestamp(),
        };
        await this.persistCreatorStore();
        this.postStateUpdated();
        return this.cloneCreatorState();
      }),

      this.orca.panels.handle('botWorld.setUiActive', async (input) => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw makeHostError('invalid_params', 'input must be an object');
        }
        const clean = stripDangerousKeys(input as Record<string, unknown>);
        if (typeof clean.active !== 'boolean') {
          throw makeHostError('invalid_params', 'active must be a boolean');
        }
        let clientId = 'default';
        if (clean.clientId !== undefined) {
          clientId = validateHostTargetId(clean.clientId, 'clientId');
          if (!isSafeKey(clientId)) {
            throw makeHostError('invalid_params', 'Invalid clientId');
          }
        }
        const wasActive = this.session.isUiActive();
        if (clean.active) {
          if (!this.activeUiClients.has(clientId) && this.activeUiClients.size >= 64) {
            const oldest = this.activeUiClients.values().next().value;
            if (oldest !== undefined) this.activeUiClients.delete(oldest);
          }
          this.activeUiClients.add(clientId);
        } else {
          this.activeUiClients.delete(clientId);
        }
        const uiActive = this.activeUiClients.size > 0;
        this.session.setUiActive(uiActive);
        if (!wasActive && uiActive && !this.disposed && this.autoLoopEnabled) {
          this.scheduleNextPoll(50);
        }
        return {
          uiActive,
          fastIntervalMs: this.session.getFastIntervalMs(),
        };
      }),

      this.orca.events.on('agent.status.changed', () => {
        if (this.disposed) return;
        if (this.eventDebounceTimer) clearTimeout(this.eventDebounceTimer);
        this.eventDebounceTimer = setTimeout(() => {
          this.eventDebounceTimer = null;
          void this.runPollTick({ forceFast: true })
            .catch(() => {})
            .finally(() => {
              if (!this.disposed && this.autoLoopEnabled) {
                const retrySecs = this.session.snapshot.runtime.retryAfterSecs;
                const nextDelay =
                  retrySecs !== null ? retrySecs * 1000 : this.session.getFastIntervalMs();
                this.scheduleNextPoll(nextDelay);
              }
            });
        }, 250);
      }),

      this.orca.settings.onDidChange(() => {
        this.settingsUpdateQueue = this.settingsUpdateQueue.then(async () => {
          if (this.disposed) return;
          const next = await this.readSettings();
          const prev = this.lastSettings;
          this.lastSettings = next;
          this.pollIntervalSec = next.pollIntervalSec;
          this.session.setPollIntervalSec(this.pollIntervalSec);

          let prefsChanged = false;
          if (next.defaultTheme !== prev.defaultTheme || !this.prefs.hasThemeOverride) {
            this.prefs.activeTheme = next.defaultTheme;
            if (next.defaultTheme !== prev.defaultTheme) {
              this.prefs.hasThemeOverride = false;
            }
            prefsChanged = true;
          }
          if (next.atmosphereMode !== prev.atmosphereMode || !this.prefs.hasAtmosphereOverride) {
            this.prefs.atmosphereMode = next.atmosphereMode;
            if (next.atmosphereMode !== prev.atmosphereMode) {
              this.prefs.hasAtmosphereOverride = false;
            }
            prefsChanged = true;
          }
          if (next.weatherMode !== prev.weatherMode || !this.prefs.hasWeatherOverride) {
            this.prefs.weatherMode = next.weatherMode;
            if (next.weatherMode !== prev.weatherMode) {
              this.prefs.hasWeatherOverride = false;
            }
            prefsChanged = true;
          }
          if (next.viewMode !== prev.viewMode || !this.prefs.hasViewModeOverride) {
            this.prefs.viewMode = next.viewMode;
            if (next.viewMode !== prev.viewMode) {
              this.prefs.hasViewModeOverride = false;
            }
            prefsChanged = true;
          }
          if (next.redactMode !== prev.redactMode || !this.prefs.hasRedactOverride) {
            this.prefs.redactMode = next.redactMode;
            if (next.redactMode !== prev.redactMode) {
              this.prefs.hasRedactOverride = false;
            }
            prefsChanged = true;
          }
          if (next.language !== prev.language || !this.prefs.hasLanguageOverride) {
            this.prefs.languageSetting = next.language;
            if (next.language !== prev.language) {
              this.prefs.hasLanguageOverride = false;
            }
            prefsChanged = true;
          }
          if (prefsChanged) {
            await this.persistPrefs();
          }
          await this.updateStatusBar();
          this.postStateUpdated();
        }).catch(() => {});
        return this.settingsUpdateQueue;
      }),

      this.orca.commands.register('bot-world.open', async () => {
        await this.runPollTick(false);
        const botCount = Object.keys(this.session.snapshot.bots).length;
        return tStrings(this.currentLocale()).cmdOpenResult(botCount);
      }),

      this.orca.commands.register('bot-world.refresh', async () => {
        await this.runPollTick(true);
        const botCount = Object.keys(this.session.snapshot.bots).length;
        return tStrings(this.currentLocale()).cmdRefreshResult(botCount);
      })
    );
  }

  dispose(): void {
    this.disposed = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.eventDebounceTimer) {
      clearTimeout(this.eventDebounceTimer);
      this.eventDebounceTimer = null;
    }
    if (this.cli instanceof OrcaCli) {
      this.cli.stop();
    }
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
    this.orca.log('bot-world worker deactivated');
  }
}

let activeController: BotWorldWorkerController | null = null;

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  if (activeController) {
    activeController.dispose();
    activeController = null;
  }
  // Discovery/spawn diagnostics (presence-only env info, rate-limited) go to the plugin log.
  setOrcaCliDiagnosticLogger((line) => orca.log(line));
  const controller = new BotWorldWorkerController(orca);
  activeController = controller;
  await controller.init();
  orca.log('bot-world worker activated');
}

export async function deactivate(): Promise<void> {
  setOrcaCliDiagnosticLogger(null);
  if (activeController) {
    activeController.dispose();
    activeController = null;
  }
}
