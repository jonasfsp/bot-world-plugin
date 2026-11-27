import {
  type AtmosphereMode,
  type BroadcastChromaKey,
  type CharacterId,
  type DeskPropId,
  type LanguageSetting,
  type SoundMode,
  type ThemeId,
  type UiLocale,
  type ViewMode,
  type WeatherMode,
  type ZoneColor,
  isValidLanguageSetting,
} from '../src/types.ts';

export type { LanguageSetting, UiLocale } from '../src/types.ts';

export function resolveUiLocale(rawLocale?: string | null): UiLocale {
  if (typeof rawLocale !== 'string') return 'en';
  const normalized = rawLocale.trim().toLowerCase();
  if (normalized === 'ko' || normalized.startsWith('ko-') || normalized.startsWith('ko_')) {
    return 'ko';
  }
  return 'en';
}

export function getHostLocale(): string {
  if (typeof orca !== 'undefined' && typeof orca.locale === 'string' && orca.locale.trim().length > 0) {
    return orca.locale.trim();
  }
  if (typeof navigator !== 'undefined' && typeof navigator.language === 'string' && navigator.language.trim().length > 0) {
    return navigator.language.trim();
  }
  return 'en';
}

export function pickLocale<T>(byLocale: Readonly<Record<UiLocale, T>>, locale: UiLocale = 'en'): T {
  return locale === 'ko' ? byLocale.ko : byLocale.en;
}

export function normalizeLanguageSetting(value: unknown): LanguageSetting {
  return isValidLanguageSetting(value) ? value : 'auto';
}

export function effectiveLocale(
  setting: LanguageSetting,
  hostLocale?: string | null
): UiLocale {
  if (setting === 'en') return 'en';
  if (setting === 'ko') return 'ko';
  return resolveUiLocale(hostLocale);
}

export function formatTimeHms(epochMs: number, locale: UiLocale = 'en'): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) {
    return '--:--:--';
  }
  if (locale === 'ko') {
    const totalSecs = Math.floor(epochMs / 1000);
    const kstSecs = ((totalSecs + 9 * 3600) % 86_400 + 86_400) % 86_400;
    const h = Math.floor(kstSecs / 3600);
    const m = Math.floor((kstSecs % 3600) / 60);
    const s = kstSecs % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  try {
    const formatted = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(epochMs));
    if (/^\d{2}:\d{2}:\d{2}$/.test(formatted)) {
      return formatted;
    }
  } catch {
    // Fallback below
  }
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export type CharacterTextSpec = {
  displayName: string;
  shortName: string;
  roleHint: string;
};

export const CHARACTER_TEXTS: Readonly<Record<UiLocale, Readonly<Record<CharacterId, CharacterTextSpec>>>> =
  Object.freeze({
    en: Object.freeze({
      ddochi: { displayName: 'Owl', shortName: 'Owl', roleHint: 'Coordinator' },
      security: {
        displayName: 'Hedgehog',
        shortName: 'Hedgehog',
        roleHint: 'Security · Auth',
      },
      iac: { displayName: 'Octopus', shortName: 'Octopus', roleHint: 'Infra · DevOps' },
      cloud_ops: {
        displayName: 'Ice Fox',
        shortName: 'Ice Fox',
        roleHint: 'Cloud · Deploy',
      },
      cost: { displayName: 'Frog', shortName: 'Frog', roleHint: 'Cost · Metrics' },
      internal_tools: {
        displayName: 'Raccoon',
        shortName: 'Raccoon',
        roleHint: 'Tools · Auto',
      },
      personal_assist: {
        displayName: 'Penguin',
        shortName: 'Penguin',
        roleHint: 'Assistant · Docs',
      },
      cve: { displayName: 'Detective Bear', shortName: 'Bear', roleHint: 'Audit · CVE' },
      doc_review: {
        displayName: 'Alpaca',
        shortName: 'Alpaca',
        roleHint: 'Review · QA',
      },
      bot_world: {
        displayName: 'Cat Bot',
        shortName: 'Cat Bot',
        roleHint: 'Monitor · UI',
      },
      worker_helper: { displayName: 'Worker', shortName: 'Worker', roleHint: 'Sub-Worker' },
    }),
    ko: Object.freeze({
      ddochi: { displayName: '부엉이', shortName: '부엉이', roleHint: '조율·리더' },
      security: { displayName: '고슴도치', shortName: '고슴도치', roleHint: '보안·인증' },
      iac: { displayName: '문어', shortName: '문어', roleHint: '인프라·DevOps' },
      cloud_ops: {
        displayName: '여우',
        shortName: '여우',
        roleHint: '클라우드·배포',
      },
      cost: { displayName: '개구리', shortName: '개구리', roleHint: '비용·지표' },
      internal_tools: {
        displayName: '너구리',
        shortName: '너구리',
        roleHint: '도구·자동화',
      },
      personal_assist: {
        displayName: '펭귄',
        shortName: '펭귄',
        roleHint: '보조·정리',
      },
      cve: {
        displayName: '탐정 곰',
        shortName: '탐정 곰',
        roleHint: '취약점·감사',
      },
      doc_review: {
        displayName: '알파카',
        shortName: '알파카',
        roleHint: '리뷰·QA',
      },
      bot_world: {
        displayName: '고양이 봇',
        shortName: '고양이 봇',
        roleHint: '모니터·UI',
      },
      worker_helper: { displayName: '도우미', shortName: '도우미', roleHint: '하위 작업 도우미' },
    }),
  });

export type LandmarkKind = 'bossDesk' | 'officeDoor' | 'automationBoard';

export type UiDictionary = {
  appTitlePanel: string;
  appTitleEditor: string;
  themeAriaLabel: string;
  themeShort: Record<ThemeId, string>;
  themeFull: Record<ThemeId, string>;
  landmarks: Record<LandmarkKind, string>;
  redactOn: string;
  redactOff: string;
  refresh: string;
  langToggleText: string;
  langToggleTitle: string;
  connecting: string;
  offline: string;
  connectedBots: (count: number) => string;
  offlineRetry: (secs: number) => string;
  boardHint: string;
  tabDetail: string;
  tabTimeline: string;
  backToLive: string;
  docSynced: string;
  docReadOnly: string;
  live: string;
  replay: string;
  play: string;
  pause: string;
  speedAriaLabel: string;
  scrubberAriaLabel: string;
  eventLog: string;
  stageOverlayLive: string;
  stageOverlayOffline: string;
  stageOverlayHover: (botName: string) => string;
  stageOverlayReplay: (hms: string) => string;
  badgeWorking: string;
  badgeIdle: string;
  badgeWaiting: string;
  badgeBlocked: string;
  badgeNeedsYou: (optionsCount: number) => string;
  badgeError: string;
  badgePaused: string;
  calloutNeedsOwner: (count: number) => string;
  privateLabel: string;
  errorHiddenLabel: string;
  interruptedLabel: string;
  automationDispatchFailedLabel: string;
  workerGeneric: string;
  workerNumbered: (seq: number) => string;
  workerWithProvider: (provider: string) => string;
  botGeneric: string;
  botNumbered: (seq: number) => string;
  ownerActor: string;
  unknownActor: string;
  automationGeneric: string;
  automationNumbered: (idx: number) => string;
  selectBotTitle: string;
  noBotsTitle: string;
  selectBotDescWithBots: string;
  selectBotDescEmpty: string;
  demoButton: string;
  tryDemoOffice: string;
  exitDemoOffice: string;
  demoModeBadge: (count: number) => string;
  demoModeHint: string;
  avatarAlt: (name: string) => string;
  redactSpecialtyHidden: string;
  closeDetailAria: string;
  sectionActiveTask: string;
  needsDecisionPrefix: (prompt: string) => string;
  noActiveTask: string;
  usingToolPrefix: (tool: string) => string;
  sectionSwitchCharacter: string;
  sectionRecentMessages: string;
  noRecentMessages: string;
  msgTypeLabels: Record<string, string>;
  msgTypeDefault: string;
  msgTypeFallback: (typeLabel: string) => string;
  msgRedactedSummary: (botName: string, typeLabel: string) => string;
  sectionOpenItems: string;
  noOpenItems: string;
  itemStatusLabels: Record<string, string>;
  sectionWorkers: string;
  noWorkers: string;
  livenessLabels: Record<'Live' | 'Exited' | 'Unverifiable', string>;
  workerStateLabels: Record<string, string>;
  workerRedactedDetail: (botName: string, stateLabel: string) => string;
  noTaskDetails: string;
  sectionAutomations: string;
  noAutomations: string;
  autoCompletedNoReply: string;
  autoCompleted: string;
  autoFailed: string;
  autoIdle: string;
  autoDisabled: string;
  noEventsRecorded: string;
  recordedEventFallback: string;
  cmdOpenResult: (botCount: number) => string;
  cmdRefreshResult: (botCount: number) => string;
  statusBarOfflineRedacted: string;
  statusBarOffline: string;
  statusBarOfflineTooltipRedacted: string;
  statusBarOfflineTooltip: string;
  statusBarBrand: string;
  statusBarRedactedTag: string;
  atmosphereAriaLabel: string;
  atmosphereModes: Record<AtmosphereMode, string>;
  atmosphereToggleTitle: (modeLabel: string) => string;
  themeToggleTitle: string;
  redactToggleTitle: string;
  demoToggleTitle: string;
  playToggleTitle: string;
  shortcutsTitle: string;
  shortcutsSubtitle: string;
  shortcutsButtonTitle: string;
  shortcutsClose: string;
  shortcutToggleTheme: string;
  shortcutToggleRedact: string;
  shortcutSwitchLanguage: string;
  shortcutCycleAtmosphere: string;
  shortcutToggleDemo: string;
  shortcutTogglePlay: string;
  shortcutToggleReport: string;
  shortcutClearOrClose: string;
  shortcutShowHelp: string;
  resetSeats: string;
  resetSeatsTitle: string;
  reportButton: string;
  reportButtonTitle: string;
  reportTitle: string;
  reportSubtitle: (windowHours: number, generatedHms: string) => string;
  reportRedactedBadge: string;
  reportRedactedNotice: string;
  reportCopyMarkdown: string;
  reportCopied: string;
  reportClose: string;
  reportKpiTotalEvents: string;
  reportKpiWorkerRuns: string;
  reportKpiCollaborations: string;
  reportKpiAutoSuccess: string;
  reportAutoCountSub: (succeeded: number, total: number) => string;
  reportAutoNone: string;
  reportActiveBotsMeta: (active: number, total: number, needsOwner: number) => string;
  reportSectionTopBots: string;
  reportNoBotActivity: string;
  reportBotEventCount: (count: number, pct: number) => string;
  reportSectionHourly: string;
  reportSectionBadges: string;
  reportNoBadges: string;
  focusButton: string;
  focusButtonTitle: string;
  followButton: string;
  followButtonActive: string;
  followButtonTitle: string;
  zoomInTitle: string;
  zoomOutTitle: string;
  zoomResetTitle: (pct: number) => string;
  collabButton: string;
  collabButtonTitle: string;
  filterPresetLabels: Record<'all' | 'working' | 'needs_you' | 'error' | 'workers', string>;
  searchPlaceholder: string;
  groupAll: string;
  projectBoardTitle: string;
  projectBoardTotal: (n: number) => string;
  projectBoardEmpty: string;
  projectBoardMore: (n: number) => string;
  projectBoardStale: (when: string) => string;
  groupSelectLabel: string;
  groupAlias: (n: number) => string;
  searchClearTitle: string;
  filterMatchCount: (matched: number, total: number) => string;
  sectionBadges: string;
  badgeMvpLabel: string;
  badgeMvpDesc: string;
  badgeDelegatorLabel: string;
  badgeDelegatorDesc: string;
  badgeNightOwlLabel: string;
  badgeNightOwlDesc: string;
  badgeSteadyLabel: string;
  badgeSteadyDesc: string;
  shortcutFocusUrgent: string;
  shortcutToggleFollow: string;
  shortcutResetCamera: string;
  shortcutFocusSearch: string;
  shortcutToggleCollab: string;
  weatherAriaLabel: string;
  weatherModes: Record<WeatherMode, string>;
  weatherToggleTitle: (modeLabel: string) => string;
  soundAriaLabel: string;
  soundModes: Record<SoundMode, string>;
  soundToggleTitle: (modeLabel: string) => string;
  milestoneBannerText: (count: number) => string;
  followNoMatchNotice: string;
  shortcutCycleWeather: string;
  shortcutToggleSound: string;
  photoButton: string;
  photoButtonTitle: string;
  photoSavedToast: string;
  photoCardKpiBots: string;
  photoCardKpiWorking: string;
  photoCardKpiWorkers: string;
  photoCardKpiEvents24h: string;
  photoCardRedactedBadge: string;
  timelapseButton: string;
  timelapseButtonTitle: string;
  reportSectionWeekly: string;
  reportWeeklyColumns: {
    date: string;
    events: string;
    tasksDone: string;
    workers: string;
    collaborations: string;
  };
  zonesButton: string;
  zonesButtonTitle: string;
  zonesModalTitle: string;
  zonesModalSubtitle: string;
  zonesModalPanelSubtitle: string;
  zonesVisibleOn: string;
  zonesVisibleOff: string;
  zonesLoadPreset: string;
  zonesClearAll: string;
  zonesAddButton: string;
  zonesLabelPlaceholder: string;
  zonesColorAriaLabel: string;
  zonesEmptyNote: string;
  zonesLimitNote: (max: number) => string;
  zonesDeleteTitle: string;
  zonesClose: string;
  zoneRedactedLabel: (index: number) => string;
  zoneColorNames: Record<ZoneColor, string>;
  shortcutTakePhotoCard: string;
  shortcutToggleZones: string;
  viewModeOfficeButton: string;
  viewModePetButton: string;
  viewModeToggleTitle: (currentMode: ViewMode) => string;
  shortcutToggleViewMode: string;
  petOverlayHint: string;
  petActionCoffee: string;
  petActionBall: string;
  petActionTreat: string;
  petActionCoffeeTitle: string;
  petActionBallTitle: string;
  petActionTreatTitle: string;
  petKnockLabel: string;
  petNeedsYouSign: string;
  petReactionsHeadpat: readonly string[];
  petReactionCoffee: string;
  petReactionTreat: string;
  petReactionBall: string;
  petReactionDone: string;
  petReactionQuickMsg: string;
  teleportTerminalButton: string;
  teleportTerminalTitle: string;
  teleportWorkspaceButton: string;
  teleportWorkspaceTitle: string;
  teleportJumpActiveButton: string;
  demoTeleportTerminalToast: string;
  demoTeleportWorkspaceToast: string;
  teleportFailedToast: (reason?: string) => string;
  quickSendTitle: string;
  quickSendTargetAria: string;
  quickSendPlaceholder: string;
  quickSendButton: string;
  quickSendSending: string;
  quickSendReadOnlyBadge: string;
  quickSendDisabledTooltip: string;
  quickSendDisabledError: string;
  quickSendRateLimitedError: string;
  quickSendUnknownBotError: string;
  quickSendInvalidError: string;
  quickSendFailedToast: (reason: string) => string;
  quickSendSentToast: (botName: string) => string;
  quickSendChips: readonly { label: string; prompt: string }[];
  quickSendDemoReply: string;
  quickSendRedactedBubble: string;
  rpgSectionTitle: string;
  rpgLevelBadge: (level: number, title: string) => string;
  rpgXpProgress: (xp: number, nextXp: number) => string;
  rpgLevelTitles: readonly [string, string, string, string, string, string];
  rpgDeskPropTitle: string;
  rpgPropLabels: Record<DeskPropId, string>;
  rpgPropLockedHint: (unlockLevel: number) => string;
  rpgLevelUpBubble: (level: number) => string;
  reportSectionRpg: string;
  reportNoRpgBots: string;
  roamButton: string;
  roamButtonTitle: string;
  ownerTag: string;
  roamHudHighFive: string;
  roamHudCoffee: string;
  roamReactionHighFive: string;
  roamReactionCoffee: string;
  shortcutToggleRoam: string;
  shortcutHighFive: string;
  shortcutHandCoffee: string;
  banterPairs: readonly { a: string; b: string }[];
  notifyNeedsYouTitle: (botName: string) => string;
  notifyNeedsYouBody: (prompt: string | null) => string;
  notifyNeedsYouTitleRedacted: string;
  notifyNeedsYouBodyRedacted: (seq: number) => string;
  notifyErrorTitle: (botName: string) => string;
  notifyErrorBody: (message: string | null) => string;
  notifyErrorTitleRedacted: string;
  notifyErrorBodyRedacted: (seq: number) => string;
  broadcastButton: string;
  broadcastButtonTitle: string;
  shortcutToggleBroadcast: string;
  broadcastChromaLabels: Record<BroadcastChromaKey, string>;
  broadcastRedactOn: string;
  broadcastRedactOff: string;
  broadcastExitButton: string;
  broadcastExitTip: string;
  petExitButton: string;
  petExitTip: string;
  studioButton: string;
  studioButtonTitle: string;
  shortcutToggleCreatorStudio: string;
  creatorModalTitle: string;
  creatorModalSubtitle: string;
  creatorClose: string;
  creatorTabAvatars: string;
  creatorTabAvatarsTip: string;
  creatorTabBackground: string;
  creatorTabBackgroundTip: string;
  creatorSelectBotAria: string;
  creatorSelectBotTip: string;
  creatorResetAvatar: string;
  creatorResetAvatarTip: string;
  creatorAvatarDropTitle: string;
  creatorAvatarDropSub: string;
  creatorAvatarDropTip: string;
  creatorAvatarPreviewAlt: string;
  creatorBgDropTitle: string;
  creatorBgDropSub: string;
  creatorBgDropTip: string;
  creatorBgPreviewAlt: string;
  creatorResetBg: string;
  creatorResetBgTip: string;
  creatorExportPack: string;
  creatorExportPackTip: string;
  creatorImportPack: string;
  creatorImportPackTip: string;
  creatorResetAll: string;
  creatorResetAllTip: string;
  creatorNoBots: string;
  creatorStatusSaved: string;
  creatorStatusReset: string;
  creatorStatusPackExported: string;
  creatorStatusPackImported: (count: number) => string;
  creatorErrorType: string;
  creatorErrorSize: string;
  creatorErrorDecode: string;
  creatorErrorPack: string;
  detailCustomAvatarUploadTip: string;
  detailCustomAvatarReset: string;
  detailCustomAvatarResetTip: string;
  tipThemeSelect: string;
  tipPetMode: string;
  tipOfficeMode: string;
  tipRoam: string;
  tipStream: string;
  tipStudio: string;
  tipAtmosphere: (modeLabel: string) => string;
  tipWeather: (modeLabel: string) => string;
  tipSound: (modeLabel: string) => string;
  tipFocus: string;
  tipCollab: string;
  tipZones: string;
  tipPhoto: string;
  tipReport: string;
  tipRedact: string;
  tipLanguage: string;
  tipDemo: string;
  tipShortcuts: string;
  tipRefresh: string;
  tipResetSeats: string;
  tipFilterPreset: (preset: 'all' | 'working' | 'needs_you' | 'error' | 'workers') => string;
  tipSearchInput: string;
  tipSearchClear: string;
  tipQuickSendTarget: string;
  tipQuickSendSend: string;
  tipZoomOut: string;
  tipZoomReset: (pct: number) => string;
  tipZoomIn: string;
  tipFollowCam: string;
  tipRoamHighFive: string;
  tipRoamCoffee: string;
  tipTimelineLive: string;
  tipTimelinePlay: string;
  tipTimelineTimelapse: string;
  tipTimelineSpeed: (speed: number) => string;
  tipTimelineDrawer: string;
  tipSwitchCharacter: (displayName: string, roleHint: string) => string;
  needsYouCardTitle: string;
  needsYouRecommendedBadge: string;
  needsYouCustomPlaceholder: string;
  needsYouSendReply: string;
  needsYouSending: string;
  needsYouReadOnlyHint: string;
  needsYouCopyReply: string;
  needsYouCopiedReply: string;
  needsYouJumpTerminal: string;
  needsYouRedactedPrompt: string;
  needsYouReplySentToast: (botName: string, itemNumber: number) => string;
  needsYouReplyFailedToast: (reason: string) => string;
  needsYouReplyDisabledError: string;
  needsYouUnknownItemError: string;
  watchdogBadge: (minutes: number) => string;
  watchdogStuckTitle: (minutes: number) => string;
  watchdogStuckDetail: (statusLabel: string, tool: string | null, task: string | null) => string;
  watchdogStuckRedactedDetail: (minutes: number) => string;
  notifyStuckTitle: (botName: string, minutes: number) => string;
  notifyStuckBody: (task: string | null, tool: string | null, minutes: number) => string;
  notifyStuckTitleRedacted: string;
  notifyStuckBodyRedacted: (seq: number, minutes: number) => string;
  reportCopyStandup: string;
  reportStandupPreviewTitle: string;
  standupTitle: string;
  standupColumns: {
    bot: string;
    estWork: string;
    completed: string;
    needsYou: string;
    stuck: string;
    status: string;
  };
  standupNoBots: string;
};

export const UI_STRINGS: Readonly<Record<UiLocale, UiDictionary>> = {
  en: {
    appTitlePanel: 'Bot World',
    appTitleEditor: 'Bot World Office',
    themeAriaLabel: 'Office Theme',
    themeShort: {
      startup_office: 'Startup',
      corporate_office: 'Corporate',
      cozy_cafe: 'Cafe',
      cyber_ops: 'Cyber Ops',
    },
    themeFull: {
      startup_office: 'Startup Office',
      corporate_office: 'Corporate Office',
      cozy_cafe: 'Cozy Cafe',
      cyber_ops: 'Cyber Ops',
    },
    landmarks: {
      bossDesk: 'Owner Desk',
      officeDoor: 'Entrance',
      automationBoard: 'Automation Board',
    },
    redactOn: 'Redact',
    redactOff: 'Redact',
    refresh: 'Refresh',
    langToggleText: 'EN',
    langToggleTitle: 'Switch language (EN / 한국어)',
    connecting: 'Connecting',
    offline: 'Offline',
    connectedBots: (count) => `Connected · ${count} ${count === 1 ? 'bot' : 'bots'}`,
    offlineRetry: (secs) => `Offline (${secs}s)`,
    boardHint:
      'Open New File → New Bot World Board (.botworld) for the wide office view and 24h timeline scrubber.',
    tabDetail: 'Bot Details',
    tabTimeline: 'Event Timeline',
    backToLive: 'Back to LIVE',
    docSynced: '.botworld synced',
    docReadOnly: 'Read-only board',
    live: 'LIVE',
    replay: 'REPLAY',
    play: '▶ Play',
    pause: '❚❚ Pause',
    speedAriaLabel: 'Playback speed',
    scrubberAriaLabel: '24-hour timeline scrubber',
    eventLog: 'Event Log',
    stageOverlayLive: 'LIVE · Click a bot',
    stageOverlayOffline: 'Waiting offline',
    stageOverlayHover: (botName) => `${botName} · Click for details`,
    stageOverlayReplay: (hms) => `REPLAY · ${hms}`,
    badgeWorking: '▶ Working',
    badgeIdle: '● Idle',
    badgeWaiting: '… Waiting',
    badgeBlocked: '■ Blocked',
    badgeNeedsYou: (optionsCount) => (optionsCount > 0 ? `★ Needs You (${optionsCount})` : '★ Needs You'),
    badgeError: '! Error',
    badgePaused: 'Zzz Paused',
    calloutNeedsOwner: (count) =>
      count > 1 ? `▲ Needs You (${count}) · Owner` : '▲ Needs You · Owner',
    privateLabel: 'Private',
    errorHiddenLabel: 'Error details hidden',
    interruptedLabel: 'Interrupted',
    automationDispatchFailedLabel: 'Automation failed',
    workerGeneric: 'Worker',
    workerNumbered: (seq) => `Worker #${seq}`,
    workerWithProvider: (provider) => `Worker(${provider})`,
    botGeneric: 'Bot',
    botNumbered: (seq) => `Bot #${seq}`,
    ownerActor: 'Owner',
    unknownActor: 'Unknown',
    automationGeneric: 'Automation',
    automationNumbered: (idx) => `Automation #${idx}`,
    selectBotTitle: 'Select a bot',
    noBotsTitle: 'No bots active yet',
    selectBotDescWithBots:
      'Click a bot on the office canvas to inspect active tasks, recent requests/replies, open items, sub-workers, and switch among 10 character avatars.',
    selectBotDescEmpty:
      'No bots yet. Create a bot in Orca and it will take a desk here automatically.',
    demoButton: 'Demo',
    tryDemoOffice: 'Try Demo Office',
    exitDemoOffice: 'Exit Demo',
    demoModeBadge: (count) => `Demo · ${count} bots`,
    demoModeHint:
      'Simulated demo office (read-only preview). Click Exit Demo to return to live Orca status.',
    avatarAlt: (name) => `${name} character`,
    redactSpecialtyHidden: 'Redact mode active: specialty hidden',
    closeDetailAria: 'Close details',
    sectionActiveTask: 'Active Task',
    needsDecisionPrefix: (prompt) => `Needs decision: ${prompt}`,
    noActiveTask: 'No active task',
    usingToolPrefix: (tool) => `Tool: ${tool}`,
    sectionSwitchCharacter: 'Switch Character (10)',
    sectionRecentMessages: 'Recent Requests / Replies',
    noRecentMessages: 'No recent requests or replies',
    msgTypeLabels: {
      handoff: 'Handoff',
      question: 'Question',
      worker_done: 'Done',
      escalation: 'Escalation',
      approval_closed: 'Approval',
      status: 'Report/Reply',
    },
    msgTypeDefault: 'Message',
    msgTypeFallback: (typeLabel) => `${typeLabel} message`,
    msgRedactedSummary: (botName, typeLabel) => `${botName} · Private ${typeLabel}`,
    sectionOpenItems: 'Open Items',
    noOpenItems: 'No open items',
    itemStatusLabels: {
      needs_you: 'Needs You',
      in_progress: 'In Progress',
      planned: 'Planned',
      done: 'Done',
      canceled: 'Canceled',
    },
    sectionWorkers: 'Sub-Workers',
    noWorkers: 'No sub-workers',
    livenessLabels: {
      Live: 'Live',
      Exited: 'Exited',
      Unverifiable: 'Unverifiable',
    },
    workerStateLabels: {
      working: 'Working',
      idle: 'Idle',
      blocked: 'Blocked',
      waiting: 'Waiting',
      done: 'Done',
      succeeded: 'Done',
      failed: 'Failed',
      canceled: 'Canceled',
      exited: 'Exited',
      released: 'Released',
    },
    workerRedactedDetail: (botName, stateLabel) => `${botName} · [Private Task] · ${stateLabel}`,
    noTaskDetails: 'No task details',
    sectionAutomations: 'Automations',
    noAutomations: 'No linked automations',
    autoCompletedNoReply: 'Done (No Reply)',
    autoCompleted: 'Done',
    autoFailed: 'Failed',
    autoIdle: 'Idle',
    autoDisabled: 'Disabled',
    noEventsRecorded: 'No events recorded yet.',
    recordedEventFallback: 'Recorded event',
    cmdOpenResult: (botCount) => `Bot World active (${botCount} ${botCount === 1 ? 'bot' : 'bots'})`,
    cmdRefreshResult: (botCount) =>
      `Bot World refreshed (${botCount} ${botCount === 1 ? 'bot' : 'bots'})`,
    statusBarOfflineRedacted: 'Bot World · Redacted · Offline',
    statusBarOffline: 'Bot World (Offline)',
    statusBarOfflineTooltipRedacted: 'Redact mode active · Offline',
    statusBarOfflineTooltip: 'Waiting for Orca runtime connection',
    statusBarBrand: 'Bot World',
    statusBarRedactedTag: 'Redacted',
    atmosphereAriaLabel: 'Office Atmosphere',
    atmosphereModes: {
      auto: 'Auto',
      day: 'Day',
      sunset: 'Sunset',
      night: 'Night',
    },
    atmosphereToggleTitle: (modeLabel) => `Cycle atmosphere (${modeLabel}) [A]`,
    themeToggleTitle: 'Switch office theme [T]',
    redactToggleTitle: 'Toggle redact mode [R]',
    demoToggleTitle: 'Toggle Demo Office [D]',
    playToggleTitle: 'Play / Pause replay [Space]',
    shortcutsTitle: 'Keyboard Shortcuts',
    shortcutsSubtitle: 'Press a key anywhere outside text inputs',
    shortcutsButtonTitle: 'Keyboard shortcuts [?]',
    shortcutsClose: 'Close',
    shortcutToggleTheme: 'Toggle theme',
    shortcutToggleRedact: 'Toggle redact mode',
    shortcutSwitchLanguage: 'Switch language',
    shortcutCycleAtmosphere: 'Cycle atmosphere',
    shortcutToggleDemo: 'Toggle demo office',
    shortcutTogglePlay: 'Play / Pause replay',
    shortcutToggleReport: '24h Office Report',
    shortcutClearOrClose: 'Clear selection / Close',
    shortcutShowHelp: 'Show shortcuts',
    resetSeats: 'Reset Seats',
    resetSeatsTitle: 'Reset custom bot seat positions to theme defaults',
    reportButton: 'Report',
    reportButtonTitle: '24h Office Digest Report [I]',
    reportTitle: '24h Office Digest',
    reportSubtitle: (windowHours, generatedHms) => `Last ${windowHours}h · Updated ${generatedHms}`,
    reportRedactedBadge: 'Redacted',
    reportRedactedNotice:
      'Aggregate counts & bot aliases only (bot names, task titles, tools, and sensitive summaries masked).',
    reportCopyMarkdown: 'Copy Markdown',
    reportCopied: 'Copied!',
    reportClose: 'Close',
    reportKpiTotalEvents: 'Total Events',
    reportKpiWorkerRuns: 'Sub-Worker Runs',
    reportKpiCollaborations: 'Collaborations',
    reportKpiAutoSuccess: 'Automation Rate',
    reportAutoCountSub: (succeeded, total) => `${succeeded}/${total} runs`,
    reportAutoNone: 'No runs',
    reportActiveBotsMeta: (active, total, needsOwner) =>
      `Active bots: ${active}/${total} · Needs you: ${needsOwner}`,
    reportSectionTopBots: 'Top Active Bots (24h)',
    reportNoBotActivity: 'No bot activity recorded in the last 24h.',
    reportBotEventCount: (count, pct) => `${count} (${pct}%)`,
    reportSectionHourly: '12-Hour Activity Trend',
    reportSectionBadges: 'Daily MVP & Office Badges',
    reportNoBadges: 'No office badges earned yet in the last 24h.',
    focusButton: 'Focus',
    focusButtonTitle: 'Focus urgent or active bot [N]',
    followButton: 'Follow',
    followButtonActive: 'Following',
    followButtonTitle: 'Toggle follow cam on selected bot [F]',
    zoomInTitle: 'Zoom in',
    zoomOutTitle: 'Zoom out',
    zoomResetTitle: (pct) => `Zoom ${pct}% · Click to reset [0]`,
    collabButton: 'Collab',
    collabButtonTitle: 'Toggle collaboration network overlay [C]',
    filterPresetLabels: {
      all: 'All',
      working: 'Working',
      needs_you: 'Needs You',
      error: 'Error',
      workers: 'Workers',
    },
    searchPlaceholder: 'Search bots… [/]',
    groupAll: 'All groups',
    projectBoardTitle: 'Projects · backlog',
    projectBoardTotal: (n) => `${n} total`,
    projectBoardEmpty: 'No backlog',
    projectBoardMore: (n) => `+${n} more`,
    projectBoardStale: (when) => `Out of date · ${when}`,
    groupSelectLabel: 'Show only this bot group',
    groupAlias: (n) => `Group #${n}`,
    searchClearTitle: 'Clear search [Esc]',
    filterMatchCount: (matched, total) => `${matched}/${total}`,
    sectionBadges: 'Office Badges (24h)',
    badgeMvpLabel: 'Daily MVP',
    badgeMvpDesc: 'Highest 24h activity score',
    badgeDelegatorLabel: 'Top Delegator',
    badgeDelegatorDesc: 'Most sub-worker delegations',
    badgeNightOwlLabel: 'Night Owl',
    badgeNightOwlDesc: 'Active during night hours (21:00–04:59)',
    badgeSteadyLabel: 'Error-Free Streak',
    badgeSteadyDesc: 'Active with zero error events in 24h',
    shortcutFocusUrgent: 'Focus urgent / active bot',
    shortcutToggleFollow: 'Toggle follow cam',
    shortcutResetCamera: 'Reset camera zoom & pan',
    shortcutFocusSearch: 'Search bots',
    shortcutToggleCollab: 'Toggle collaboration network',
    weatherAriaLabel: 'Office Weather',
    weatherModes: {
      auto: 'Auto',
      clear: 'Clear',
      rain: 'Rain',
      snow: 'Snow',
      starlight: 'Stars',
    },
    weatherToggleTitle: (modeLabel) => `Cycle weather (${modeLabel}) [W]`,
    soundAriaLabel: 'Office Sound',
    soundModes: {
      off: 'Off',
      chimes: 'Chimes',
      ambient: 'Ambient',
    },
    soundToggleTitle: (modeLabel) => `Cycle sound (${modeLabel}) [M]`,
    milestoneBannerText: (count) => `🎉 Milestone: ${count} Tasks Completed!`,
    followNoMatchNotice: 'No bots match active filter',
    shortcutCycleWeather: 'Cycle weather effect',
    shortcutToggleSound: 'Cycle sound mode',
    photoButton: 'Photo',
    photoButtonTitle: 'Save PNG photo card snapshot [P]',
    photoSavedToast: 'Photo card saved',
    photoCardKpiBots: 'Bots',
    photoCardKpiWorking: 'Working',
    photoCardKpiWorkers: 'Workers',
    photoCardKpiEvents24h: '24h Events',
    photoCardRedactedBadge: '🛡 REDACTED',
    timelapseButton: 'Timelapse',
    timelapseButtonTitle: '10-second daily timelapse replay',
    reportSectionWeekly: '7-Day Weekly Trend',
    reportWeeklyColumns: {
      date: 'Date',
      events: 'Events',
      tasksDone: 'Tasks Done',
      workers: 'Workers',
      collaborations: 'Collaborations',
    },
    zonesButton: 'Zones',
    zonesButtonTitle: 'Manage office team zones [Z]',
    zonesModalTitle: 'Team Zones',
    zonesModalSubtitle: 'Saved in .botworld · Press Z to toggle floor overlay',
    zonesModalPanelSubtitle: 'Session floor overlay · Press Z to toggle',
    zonesVisibleOn: 'Show Zones: ON',
    zonesVisibleOff: 'Show Zones: OFF',
    zonesLoadPreset: 'Load Starter Pods (3)',
    zonesClearAll: 'Clear All',
    zonesAddButton: 'Add Zone',
    zonesLabelPlaceholder: 'Zone name (e.g. Security Pod)',
    zonesColorAriaLabel: 'Zone color',
    zonesEmptyNote: 'No team zones yet. Load the 3-pod starter preset or add a custom zone.',
    zonesLimitNote: (max) => `Maximum of ${max} zones reached.`,
    zonesDeleteTitle: 'Delete zone',
    zonesClose: 'Close',
    zoneRedactedLabel: (index) => `Zone #${index}`,
    zoneColorNames: {
      cyan: 'Cyan',
      amber: 'Amber',
      violet: 'Violet',
      emerald: 'Emerald',
      rose: 'Rose',
    },
    shortcutTakePhotoCard: 'Save PNG photo card',
    shortcutToggleZones: 'Toggle team zones overlay',
    viewModeOfficeButton: 'Office',
    viewModePetButton: 'Pet',
    viewModeToggleTitle: (currentMode) =>
      currentMode === 'pet'
        ? 'Switch to Isometric Office [G]'
        : 'Switch to Pocket Pet Terrarium [G]',
    shortcutToggleViewMode: 'Toggle Office / Pocket Pet view',
    petOverlayHint: 'Pocket Pet · Click a pet to headpat',
    petActionCoffee: 'Coffee',
    petActionBall: 'Ball',
    petActionTreat: 'Treat',
    petActionCoffeeTitle: 'Drop a steaming coffee cup into the terrarium',
    petActionBallTitle: 'Toss a bouncy toy ball for pets to chase',
    petActionTreatTitle: 'Drop a cookie treat for a nearby pet',
    petKnockLabel: 'knock!',
    petNeedsYouSign: 'Needs You',
    petReactionsHeadpat: ['Thanks!', 'Ready to help!', 'Purr~'],
    petReactionCoffee: 'Mmm, coffee!',
    petReactionTreat: 'Yum!',
    petReactionBall: 'Wheee!',
    petReactionDone: 'All done!',
    petReactionQuickMsg: 'Got it!',
    teleportTerminalButton: '↗ Terminal',
    teleportTerminalTitle: 'Focus this worker terminal in Orca',
    teleportWorkspaceButton: '↗ Workspace',
    teleportWorkspaceTitle: 'Open this worker workspace in Orca',
    teleportJumpActiveButton: '↗ Jump to Active Terminal',
    demoTeleportTerminalToast: 'Demo mode: would jump to worker terminal',
    demoTeleportWorkspaceToast: 'Demo mode: would open worker workspace',
    teleportFailedToast: (reason) =>
      reason ? `Unable to jump (${reason})` : 'Unable to jump to target in Orca',
    quickSendTitle: 'Quick Send',
    quickSendTargetAria: 'Target bot',
    quickSendPlaceholder: 'Message selected bot… (Enter to send)',
    quickSendButton: '✈ Send',
    quickSendSending: 'Sending…',
    quickSendReadOnlyBadge: 'Read-only',
    quickSendDisabledTooltip:
      'Read-only by default. Enable "Allow Quick Send to Bots" in Plugin Settings (or try Demo Mode!).',
    quickSendDisabledError:
      'Quick Send is disabled. Enable "Allow Quick Send to Bots" in Plugin Settings.',
    quickSendRateLimitedError: 'Please wait 2 seconds before messaging this bot again.',
    quickSendUnknownBotError: 'Target bot was not found in the live snapshot.',
    quickSendInvalidError: 'Message must be 1–500 characters without control characters.',
    quickSendFailedToast: (reason) => `Quick Send failed: ${reason}`,
    quickSendSentToast: (botName) => `Sent to ${botName}`,
    quickSendChips: [
      { label: 'Status check', prompt: 'Status check: please share a brief progress update.' },
      { label: 'Review PR', prompt: 'Please review the latest PR and summarize key findings.' },
      { label: 'Run tests', prompt: 'Please run the test suite and report any failures.' },
    ],
    quickSendDemoReply: 'On it! Checking your request now.',
    quickSendRedactedBubble: '✉ Quick message',
    rpgSectionTitle: 'Bot Level & Desk Prop',
    rpgLevelBadge: (level, title) => `Lv.${level} · ${title}`,
    rpgXpProgress: (xp, nextXp) => `${xp} / ${nextXp} XP`,
    rpgLevelTitles: ['Intern', 'Junior', 'Engineer', 'Senior', 'Staff', 'Archmage'],
    rpgDeskPropTitle: 'Desk Prop',
    rpgPropLabels: {
      none: 'None',
      rubber_duck: 'Rubber Duck',
      mini_plant: 'Mini Plant',
      mech_keyboard: 'Mech Keyboard',
      dual_monitor: 'Dual Monitor',
      cat_plush: 'Desk Cat',
      gold_trophy: 'Gold Trophy',
    },
    rpgPropLockedHint: (unlockLevel) => `Unlocks at Lv.${unlockLevel}`,
    rpgLevelUpBubble: (level) => `⭐ Lv.${level} UP!`,
    reportSectionRpg: 'Bot Growth & Levels',
    reportNoRpgBots: 'No bot XP recorded yet.',
    roamButton: 'Roam',
    roamButtonTitle: 'Toggle Owner Roaming mode [V]',
    ownerTag: 'YOU',
    roamHudHighFive: '[H] 🙌 High-Five (+8 XP)',
    roamHudCoffee: '[K] ☕ Hand Coffee (+10 XP)',
    roamReactionHighFive: 'Nice! 🙌',
    roamReactionCoffee: 'Thanks for the coffee! ☕',
    shortcutToggleRoam: 'Toggle Owner Roaming mode',
    shortcutHighFive: 'High-Five nearby bot (Roaming)',
    shortcutHandCoffee: 'Hand coffee to nearby bot (Roaming)',
    banterPairs: [
      { a: 'Did anyone see my semicolon?', b: 'Check behind the coffee mug!' },
      { a: 'Refill break?', b: 'Oat latte please!' },
      { a: 'Tests are all green!', b: "Don't jinx it!" },
      { a: 'Is it Friday yet?', b: 'Almost—just two more PRs!' },
      { a: 'How is the build looking?', b: 'Smooth sailing so far!' },
      { a: 'Time for a quick stretch!', b: 'Shoulders back, deep breath!' },
      { a: 'Who ordered extra pixels?', b: 'Fresh from the sprite oven!' },
      { a: 'Cache is warm and cozy.', b: 'Best kind of afternoon!' },
      { a: 'Zero warnings on lint!', b: 'Frame that and hang it up!' },
      { a: 'Need a rubber duck?', b: 'Always ready to listen!' },
      { a: 'Another clean deploy!', b: 'High-fives all around!' },
      { a: 'Lo-fi beats on deck?', b: 'Volume set to cozy!' },
    ],
    notifyNeedsYouTitle: (botName) => `Bot World: ${botName} needs you`,
    notifyNeedsYouBody: (prompt) => prompt || 'Approval or reply requested.',
    notifyNeedsYouTitleRedacted: 'Bot World: Bot needs your attention',
    notifyNeedsYouBodyRedacted: (seq) => `Bot #${seq} requires review.`,
    notifyErrorTitle: (botName) => `Bot World: ${botName} error`,
    notifyErrorBody: (message) => message || 'Bot entered an error state.',
    notifyErrorTitleRedacted: 'Bot World: Bot encountered an error',
    notifyErrorBodyRedacted: (seq) => `Bot #${seq} reported an error.`,
    broadcastButton: 'Stream',
    broadcastButtonTitle: 'Chroma-key Broadcast Pet Bar for OBS & screen recording [B]',
    shortcutToggleBroadcast: 'Toggle Broadcast Chroma Bar',
    broadcastChromaLabels: {
      green: 'Chroma Green (#00b140)',
      blue: 'Chroma Blue (#0047bb)',
      black: 'Pure Black (#000000)',
      charcoal: 'Soft Charcoal (#11141b)',
    },
    broadcastRedactOn: 'Masked',
    broadcastRedactOff: 'Redact',
    broadcastExitButton: 'Exit',
    broadcastExitTip: 'Exit Broadcast mode',
    petExitButton: 'Office',
    petExitTip: 'Return to Isometric Office',
    studioButton: 'Studio',
    studioButtonTitle: 'Creator Studio: custom avatars, backgrounds & packs [U]',
    shortcutToggleCreatorStudio: 'Open Creator Studio',
    creatorModalTitle: 'Creator Studio',
    creatorModalSubtitle: 'Customize bot avatars, stage background, or share .botworld-pack.json',
    creatorClose: 'Close',
    creatorTabAvatars: 'Bot Avatars',
    creatorTabAvatarsTip: 'Upload or reset custom 128×128 raster avatars per bot',
    creatorTabBackground: 'Office Background',
    creatorTabBackgroundTip: 'Upload or reset a custom 1600×1000 stage backdrop',
    creatorSelectBotAria: 'Select bot for custom avatar',
    creatorSelectBotTip: 'Choose which bot receives the uploaded avatar',
    creatorResetAvatar: 'Reset Avatar',
    creatorResetAvatarTip: 'Restore default pixel sprite for this bot',
    creatorAvatarDropTitle: 'Drop PNG, JPEG, or WebP here (or click to browse)',
    creatorAvatarDropSub: 'Center-cropped to 128×128 PNG (max 4 MB raw, SVG blocked)',
    creatorAvatarDropTip: 'Drop or pick a raster image for this bot avatar',
    creatorAvatarPreviewAlt: 'Custom bot avatar preview',
    creatorBgDropTitle: 'Drop stage background image here (or click to browse)',
    creatorBgDropSub: 'Aspect-fitted up to 1600×1000 JPEG (max 4 MB raw, SVG blocked)',
    creatorBgDropTip: 'Drop or pick a custom office stage backdrop',
    creatorBgPreviewAlt: 'Custom office background preview',
    creatorResetBg: 'Reset to Theme Default',
    creatorResetBgTip: 'Remove custom background and restore theme artwork',
    creatorExportPack: 'Export Pack',
    creatorExportPackTip: 'Download current custom avatars and background as .botworld-pack.json',
    creatorImportPack: 'Import Pack',
    creatorImportPackTip: 'Load a validated .botworld-pack.json creator pack',
    creatorResetAll: 'Reset All',
    creatorResetAllTip: 'Clear all custom avatars and background',
    creatorNoBots: 'No bots in the current snapshot yet.',
    creatorStatusSaved: 'Saved custom asset.',
    creatorStatusReset: 'Restored default artwork.',
    creatorStatusPackExported: 'Exported .botworld-pack.json',
    creatorStatusPackImported: (count) => `Imported creator pack (${count} avatars).`,
    creatorErrorType: 'Only PNG, JPEG, and WebP images are supported (SVG/HTML rejected).',
    creatorErrorSize: 'File is too large (max 4 MB raw upload; packed limits apply).',
    creatorErrorDecode: 'Could not decode image file.',
    creatorErrorPack: 'Invalid or oversized .botworld-pack.json file.',
    detailCustomAvatarUploadTip: 'Drop an image here or click Studio to set a custom avatar',
    detailCustomAvatarReset: 'Reset Avatar',
    detailCustomAvatarResetTip: 'Restore the default pixel character sprite for this bot',
    tipThemeSelect: 'Switch office backdrop theme',
    tipPetMode: 'Switch to Pocket Pet Terrarium',
    tipOfficeMode: 'Return to Isometric Office view',
    tipRoam: 'Walk around the office as Owner (WASD / double-click floor)',
    tipStream: 'Open OBS-ready Chroma-Key Broadcast Pet Bar',
    tipStudio: 'Customize avatars, stage background, and export packs',
    tipAtmosphere: (modeLabel) => `Cycle time-of-day lighting (${modeLabel})`,
    tipWeather: (modeLabel) => `Cycle ambient weather effect (${modeLabel})`,
    tipSound: (modeLabel) => `Cycle cozy office soundscape (${modeLabel})`,
    tipFocus: 'Spotlight next urgent or active bot',
    tipCollab: 'Toggle 24h bot collaboration network overlay',
    tipZones: 'Configure team floor zones',
    tipPhoto: 'Save a PNG photo card of the current office state',
    tipReport: 'View 24h office digest & weekly trend',
    tipRedact: 'Mask sensitive bot names, tasks, tools, and logs',
    tipLanguage: 'Switch interface language (EN / 한국어)',
    tipDemo: 'Preview Bot World with a simulated live office',
    tipShortcuts: 'Show keyboard shortcuts',
    tipRefresh: 'Poll live Orca status now',
    tipResetSeats: 'Reset dragged bot desks to theme defaults',
    tipFilterPreset: (preset) => {
      switch (preset) {
        case 'all':
          return 'Show all bots on stage';
        case 'working':
          return 'Filter to bots currently working';
        case 'needs_you':
          return 'Filter to bots awaiting your approval or blocked';
        case 'error':
          return 'Filter to bots in an error state';
        case 'workers':
          return 'Filter to bots with active sub-workers';
      }
    },
    tipSearchInput: 'Filter bots by name, task, tool, or alias',
    tipSearchClear: 'Clear bot search filter',
    tipQuickSendTarget: 'Choose which bot receives your quick message',
    tipQuickSendSend: 'Send quick message to selected bot',
    tipZoomOut: 'Zoom camera out',
    tipZoomReset: (pct) => `Camera zoom ${pct}% — click to reset`,
    tipZoomIn: 'Zoom camera in',
    tipFollowCam: 'Lock camera to follow the selected bot',
    tipRoamHighFive: 'Give a nearby bot a high-five (+8 XP)',
    tipRoamCoffee: 'Hand coffee to a nearby bot (+10 XP)',
    tipTimelineLive: 'Jump back to live real-time state',
    tipTimelinePlay: 'Play or pause 24h timeline replay',
    tipTimelineTimelapse: 'Play 10-second 24h daily timelapse',
    tipTimelineSpeed: (speed) => `Set replay playback speed to ${speed}x`,
    tipTimelineDrawer: 'Toggle 24h event log drawer',
    tipSwitchCharacter: (displayName, roleHint) => `${displayName} · ${roleHint}`,
    needsYouCardTitle: 'Needs You · Quick Decision',
    needsYouRecommendedBadge: 'Recommended',
    needsYouCustomPlaceholder: 'Type a custom reply…',
    needsYouSendReply: 'Reply',
    needsYouSending: 'Sending…',
    needsYouReadOnlyHint: 'Read-only mode: copy a reply or jump to terminal to respond in Orca.',
    needsYouCopyReply: 'Copy Reply',
    needsYouCopiedReply: 'Copied!',
    needsYouJumpTerminal: '↗ Jump to Terminal',
    needsYouRedactedPrompt: 'Decision required (details hidden in Redact mode).',
    needsYouReplySentToast: (botName, itemNumber) => `Sent decision reply to ${botName} (#${itemNumber})`,
    needsYouReplyFailedToast: (reason) => `Decision reply failed: ${reason}`,
    needsYouReplyDisabledError:
      'Quick Reply is disabled. Enable "Allow Quick Send to Bots" in Plugin Settings.',
    needsYouUnknownItemError: 'Matching Needs You item was not found on this bot.',
    watchdogBadge: (minutes) => `⏳ ${minutes}m`,
    watchdogStuckTitle: (minutes) => `Stuck / Long-running (${minutes}m without change)`,
    watchdogStuckDetail: (statusLabel, tool, task) => {
      const parts = [statusLabel];
      if (tool) parts.push(`[${tool}]`);
      if (task) parts.push(task);
      return parts.join(' · ');
    },
    watchdogStuckRedactedDetail: (minutes) =>
      `No status/tool update for ${minutes}m (details hidden in Redact mode).`,
    notifyStuckTitle: (botName, minutes) => `Bot World: ${botName} stuck (${minutes}m)`,
    notifyStuckBody: (task, tool, minutes) => {
      const detail = [task, tool ? `[${tool}]` : null].filter(Boolean).join(' ');
      return detail
        ? `No progress for ${minutes}m — ${detail}`
        : `No status or tool change for ${minutes}m.`;
    },
    notifyStuckTitleRedacted: 'Bot World: Bot may be stuck',
    notifyStuckBodyRedacted: (seq, minutes) => `Bot #${seq} has had no progress for ${minutes}m.`,
    reportCopyStandup: 'Copy Standup MD',
    reportStandupPreviewTitle: 'Standup Markdown Preview',
    standupTitle: 'Daily Bot Standup Summary',
    standupColumns: {
      bot: 'Bot',
      estWork: 'Est. Work',
      completed: 'Done',
      needsYou: 'Needs You',
      stuck: 'Stuck',
      status: 'Status',
    },
    standupNoBots: 'No bot activity recorded for standup yet.',
  },
  ko: {
    appTitlePanel: '봇 월드',
    appTitleEditor: '봇 월드 사무실',
    themeAriaLabel: '사무실 테마',
    themeShort: {
      startup_office: '스타트업',
      corporate_office: '대기업',
      cozy_cafe: '코지 카페',
      cyber_ops: '사이버',
    },
    themeFull: {
      startup_office: '스타트업 사무실',
      corporate_office: '대기업 사무실',
      cozy_cafe: '코지 카페',
      cyber_ops: '사이버 관제실',
    },
    landmarks: {
      bossDesk: '사장님 책상',
      officeDoor: '출입구',
      automationBoard: '자동화 보드',
    },
    redactOn: '가림',
    redactOff: '가림',
    refresh: '새로고침',
    langToggleText: '한',
    langToggleTitle: '언어 전환 (EN / 한국어)',
    connecting: '연결 중',
    offline: '오프라인',
    connectedBots: (count) => `연결됨 · ${count}봇`,
    offlineRetry: (secs) => `오프라인 (${secs}s)`,
    boardHint: '넓은 전체 사무실 · 24h 스크러버는 새 파일 → 새 봇 월드 보드(.botworld)로 여세요.',
    tabDetail: '봇 상세',
    tabTimeline: '사건 타임라인',
    backToLive: 'LIVE 복귀',
    docSynced: '.botworld 동기화',
    docReadOnly: '읽기 전용 보드',
    live: 'LIVE',
    replay: 'REPLAY',
    play: '▶ 재생',
    pause: '❚❚ 일시정지',
    speedAriaLabel: '재생 배속',
    scrubberAriaLabel: '24시간 타임라인 스크러버',
    eventLog: '사건 로그',
    stageOverlayLive: 'LIVE · 봇 클릭 선택',
    stageOverlayOffline: '오프라인 대기',
    stageOverlayHover: (botName) => `${botName} · 클릭해 상세 보기`,
    stageOverlayReplay: (hms) => `REPLAY · ${hms}`,
    badgeWorking: '▶ 작업 중',
    badgeIdle: '● 대기',
    badgeWaiting: '… 응답',
    badgeBlocked: '■ 차단',
    badgeNeedsYou: (optionsCount) => (optionsCount > 0 ? `★ 결정 (${optionsCount})` : '★ 결정'),
    badgeError: '! 오류',
    badgePaused: 'Zzz 정지',
    calloutNeedsOwner: (count) =>
      count > 1 ? `▲ 결정 대기 (${count}) · 사장님` : '▲ 결정 대기 · 사장님',
    privateLabel: '비공개',
    errorHiddenLabel: '오류 상세 가려짐',
    interruptedLabel: '중단됨',
    automationDispatchFailedLabel: '자동화 실행 전달 실패',
    workerGeneric: '도우미',
    workerNumbered: (seq) => `도우미 #${seq}`,
    workerWithProvider: (provider) => `도우미(${provider})`,
    botGeneric: '봇',
    botNumbered: (seq) => `봇 #${seq}`,
    ownerActor: '사장님',
    unknownActor: '알 수 없음',
    automationGeneric: '정기 자동화',
    automationNumbered: (idx) => `정기 자동화 #${idx}`,
    selectBotTitle: '봇을 선택하세요',
    noBotsTitle: '아직 활성 봇이 없습니다',
    selectBotDescWithBots:
      '오피스 캔버스에서 봇을 클릭하면 진행 작업, 최근 요청/답변, 열린 항목, 소속 워커와 10종 캐릭터 교체를 볼 수 있습니다.',
    selectBotDescEmpty: '아직 생성된 봇이 없습니다. Orca에서 봇을 만들면 이곳 책상에 자동으로 배치됩니다.',
    demoButton: '데모',
    tryDemoOffice: '데모 오피스 체험',
    exitDemoOffice: '데모 종료',
    demoModeBadge: (count) => `데모 · 봇 ${count}개`,
    demoModeHint:
      "가상 데모 오피스(읽기 전용 미리보기)입니다. '데모 종료'를 누르면 실시간 Orca 상태로 돌아갑니다.",
    avatarAlt: (name) => `${name} 캐릭터`,
    redactSpecialtyHidden: '가림 모드 활성: 세부 분야 숨김',
    closeDetailAria: '상세 닫기',
    sectionActiveTask: '진행 중 작업',
    needsDecisionPrefix: (prompt) => `결정 필요: ${prompt}`,
    noActiveTask: '진행 중인 작업 없음',
    usingToolPrefix: (tool) => `사용 도구: ${tool}`,
    sectionSwitchCharacter: '캐릭터 교체 (10종)',
    sectionRecentMessages: '최근 요청 / 답변',
    noRecentMessages: '최근 요청/답변 없음',
    msgTypeLabels: {
      handoff: '인계',
      question: '질문',
      worker_done: '완료',
      escalation: '개입',
      approval_closed: '승인',
      status: '보고/답변',
    },
    msgTypeDefault: '메시지',
    msgTypeFallback: (typeLabel) => `${typeLabel} 메시지`,
    msgRedactedSummary: (botName, typeLabel) => `${botName} · ${typeLabel} 메시지`,
    sectionOpenItems: '열린 항목',
    noOpenItems: '열린 항목 없음',
    itemStatusLabels: {
      needs_you: '결정 대기',
      in_progress: '진행 중',
      planned: '예정됨',
      done: '완료',
      canceled: '취소됨',
    },
    sectionWorkers: '소속 워커',
    noWorkers: '소속 워커 없음',
    livenessLabels: {
      Live: '실행 중',
      Exited: '종료',
      Unverifiable: '미확인',
    },
    workerStateLabels: {
      working: '작업 중',
      idle: '대기',
      blocked: '차단됨',
      waiting: '대기 중',
      done: '완료',
      succeeded: '완료',
      failed: '실패',
      canceled: '취소',
      exited: '종료',
      released: '해제',
    },
    workerRedactedDetail: (botName, stateLabel) => `${botName} · 도우미 · ${stateLabel}`,
    noTaskDetails: '세부 작업 없음',
    sectionAutomations: '정기 자동화',
    noAutomations: '연결된 정기 자동화 없음',
    autoCompletedNoReply: '완료 (이상 없음)',
    autoCompleted: '완료',
    autoFailed: '실패',
    autoIdle: '대기',
    autoDisabled: '비활성',
    noEventsRecorded: '아직 기록된 사건이 없습니다.',
    recordedEventFallback: '기록된 사건',
    cmdOpenResult: (botCount) => `봇 월드 활성 (${botCount}개 봇)`,
    cmdRefreshResult: (botCount) => `봇 월드 새로고침 완료 (${botCount}개 봇)`,
    statusBarOfflineRedacted: '봇 월드 · 가림 · 오프라인',
    statusBarOffline: '봇 월드 (오프라인)',
    statusBarOfflineTooltipRedacted: '가림 모드 활성 · 오프라인',
    statusBarOfflineTooltip: 'Orca 런타임 연결 대기 중',
    statusBarBrand: '봇 월드',
    statusBarRedactedTag: '가림',
    atmosphereAriaLabel: '시간대 분위기',
    atmosphereModes: {
      auto: '자동',
      day: '낮',
      sunset: '노을',
      night: '야간',
    },
    atmosphereToggleTitle: (modeLabel) => `시간대 분위기 전환 (${modeLabel}) [A]`,
    themeToggleTitle: '사무실 테마 전환 [T]',
    redactToggleTitle: '가림 모드 전환 [R]',
    demoToggleTitle: '데모 오피스 전환 [D]',
    playToggleTitle: '리플레이 재생 / 일시정지 [Space]',
    shortcutsTitle: '단축키 안내',
    shortcutsSubtitle: '입력창 밖에서 키를 눌러 바로 실행할 수 있습니다',
    shortcutsButtonTitle: '단축키 도움말 [?]',
    shortcutsClose: '닫기',
    shortcutToggleTheme: '사무실 테마 전환',
    shortcutToggleRedact: '가림 모드 전환',
    shortcutSwitchLanguage: '언어 전환',
    shortcutCycleAtmosphere: '시간대 분위기 전환',
    shortcutToggleDemo: '데모 오피스 전환',
    shortcutTogglePlay: '리플레이 재생 / 일시정지',
    shortcutToggleReport: '24시간 사무실 리포트',
    shortcutClearOrClose: '선택 해제 / 닫기',
    shortcutShowHelp: '단축키 도움말',
    resetSeats: '자리 초기화',
    resetSeatsTitle: '사용자 지정 봇 자리 배치를 기본값으로 되돌립니다',
    reportButton: '리포트',
    reportButtonTitle: '24시간 사무실 리포트 [I]',
    reportTitle: '24시간 사무실 리포트',
    reportSubtitle: (windowHours, generatedHms) => `최근 ${windowHours}시간 · 기준 ${generatedHms}`,
    reportRedactedBadge: '가림 모드',
    reportRedactedNotice:
      '집계 수치와 봇 별칭만 표시됩니다 (봇 이름·작업 제목·도구·민감 요약 가림).',
    reportCopyMarkdown: '마크다운 복사',
    reportCopied: '복사됨!',
    reportClose: '닫기',
    reportKpiTotalEvents: '총 이벤트',
    reportKpiWorkerRuns: '서브워커 실행',
    reportKpiCollaborations: '협업 메시지',
    reportKpiAutoSuccess: '자동화 성공률',
    reportAutoCountSub: (succeeded, total) => `${succeeded}/${total}회 성공`,
    reportAutoNone: '실행 없음',
    reportActiveBotsMeta: (active, total, needsOwner) =>
      `활성 봇: ${active}/${total} · 결정 요청: ${needsOwner}건`,
    reportSectionTopBots: '가장 활발한 봇 Top 3 (24h)',
    reportNoBotActivity: '최근 24시간 동안 기록된 봇 활동이 없습니다.',
    reportBotEventCount: (count, pct) => `${count}건 (${pct}%)`,
    reportSectionHourly: '최근 12시간 활동 추이',
    reportSectionBadges: '오늘의 MVP & 오피스 배지',
    reportNoBadges: '최근 24시간 동안 획득한 오피스 배지가 없습니다.',
    focusButton: '포커스',
    focusButtonTitle: '긴급·작업 봇 집중 포커스 [N]',
    followButton: '추적',
    followButtonActive: '추적 중',
    followButtonTitle: '선택한 봇 카메라 추적 전환 [F]',
    zoomInTitle: '확대',
    zoomOutTitle: '축소',
    zoomResetTitle: (pct) => `배율 ${pct}% · 클릭해 초기화 [0]`,
    collabButton: '협업망',
    collabButtonTitle: '협업 네트워크 오버레이 전환 [C]',
    filterPresetLabels: {
      all: '전체',
      working: '작업 중',
      needs_you: '결정 대기',
      error: '오류',
      workers: '워커 보유',
    },
    searchPlaceholder: '봇 검색… [/]',
    groupAll: '모든 그룹',
    projectBoardTitle: '프로젝트 · 백로그',
    projectBoardTotal: (n) => `총 ${n}`,
    projectBoardEmpty: '백로그 없음',
    projectBoardMore: (n) => `+${n}개 더`,
    projectBoardStale: (when) => `오래된 데이터 · ${when}`,
    groupSelectLabel: '이 봇 그룹만 표시',
    groupAlias: (n) => `그룹 #${n}`,
    searchClearTitle: '검색 지우기 [Esc]',
    filterMatchCount: (matched, total) => `${matched}/${total}`,
    sectionBadges: '오피스 배지 (24h)',
    badgeMvpLabel: '오늘의 MVP',
    badgeMvpDesc: '최근 24시간 최고 활동 점수',
    badgeDelegatorLabel: '위임왕',
    badgeDelegatorDesc: '가장 많은 서브워커 위임',
    badgeNightOwlLabel: '야근 요정',
    badgeNightOwlDesc: '야간 시간대(21:00–04:59) 최다 활동',
    badgeSteadyLabel: '무오류',
    badgeSteadyDesc: '최근 24시간 오류 없이 안정 작동',
    shortcutFocusUrgent: '긴급·작업 봇 포커스',
    shortcutToggleFollow: '선택 봇 카메라 추적',
    shortcutResetCamera: '카메라 배율·위치 초기화',
    shortcutFocusSearch: '봇 검색창 포커스',
    shortcutToggleCollab: '협업 네트워크 오버레이',
    weatherAriaLabel: '사무실 날씨',
    weatherModes: {
      auto: '자동',
      clear: '맑음',
      rain: '비',
      snow: '눈',
      starlight: '별빛',
    },
    weatherToggleTitle: (modeLabel) => `날씨 전환 (${modeLabel}) [W]`,
    soundAriaLabel: '오피스 사운드',
    soundModes: {
      off: '음소거',
      chimes: '효과음',
      ambient: '앰비언트',
    },
    soundToggleTitle: (modeLabel) => `사운드 전환 (${modeLabel}) [M]`,
    milestoneBannerText: (count) => `🎉 마일스톤: 작업 ${count}건 완료!`,
    followNoMatchNotice: '현재 필터와 일치하는 봇이 없습니다',
    shortcutCycleWeather: '날씨 효과 전환',
    shortcutToggleSound: '사운드 모드 전환',
    photoButton: '포토 카드',
    photoButtonTitle: 'PNG 포토 카드 저장 [P]',
    photoSavedToast: '포토 카드 저장됨',
    photoCardKpiBots: '봇',
    photoCardKpiWorking: '작업 중',
    photoCardKpiWorkers: '워커',
    photoCardKpiEvents24h: '24h 이벤트',
    photoCardRedactedBadge: '🛡 가림 모드',
    timelapseButton: '타임랩스',
    timelapseButtonTitle: '10초 일간 타임랩스 재생',
    reportSectionWeekly: '7일 주간 활동 추이',
    reportWeeklyColumns: {
      date: '날짜',
      events: '이벤트',
      tasksDone: '완료 작업',
      workers: '워커',
      collaborations: '협업',
    },
    zonesButton: '구역',
    zonesButtonTitle: '사무실 팀 구역 관리 [Z]',
    zonesModalTitle: '팀 구역 관리',
    zonesModalSubtitle: '.botworld에 저장됨 · Z 키로 구역 오버레이 전환',
    zonesModalPanelSubtitle: '세션 내 바닥 구역 · Z 키로 전환',
    zonesVisibleOn: '구역 표시: ON',
    zonesVisibleOff: '구역 표시: OFF',
    zonesLoadPreset: '기본 3구역 불러오기',
    zonesClearAll: '전체 삭제',
    zonesAddButton: '구역 추가',
    zonesLabelPlaceholder: '구역 이름 (예: 보안 · 리뷰)',
    zonesColorAriaLabel: '구역 색상',
    zonesEmptyNote: '등록된 구역이 없습니다. 기본 3구역 프리셋을 불러오거나 새 구역을 추가하세요.',
    zonesLimitNote: (max) => `최대 ${max}개 구역까지 추가할 수 있습니다.`,
    zonesDeleteTitle: '구역 삭제',
    zonesClose: '닫기',
    zoneRedactedLabel: (index) => `구역 #${index}`,
    zoneColorNames: {
      cyan: '시안',
      amber: '앰버',
      violet: '바이올렛',
      emerald: '에메랄드',
      rose: '로즈',
    },
    shortcutTakePhotoCard: 'PNG 포토 카드 저장',
    shortcutToggleZones: '팀 구역 오버레이 전환',
    viewModeOfficeButton: '사무실',
    viewModePetButton: '펫',
    viewModeToggleTitle: (currentMode) =>
      currentMode === 'pet'
        ? '가상 사무실 보기로 전환 [G]'
        : '포켓 펫 테라리움으로 전환 [G]',
    shortcutToggleViewMode: '사무실 / 포켓 펫 화면 전환',
    petOverlayHint: '포켓 펫 · 펫을 클릭해 쓰다듬기',
    petActionCoffee: '커피',
    petActionBall: '공 놀이',
    petActionTreat: '간식',
    petActionCoffeeTitle: '테라리움에 따뜻한 커피를 내려놓기',
    petActionBallTitle: '펫들이 쫓아 노는 공 던지기',
    petActionTreatTitle: '가까운 펫에게 쿠키 간식 주기',
    petKnockLabel: '똑똑!',
    petNeedsYouSign: '결정 대기',
    petReactionsHeadpat: ['고마워요!', '힘낼게요!', '기분 좋아요!'],
    petReactionCoffee: '향긋한 커피!',
    petReactionTreat: '맛있어요!',
    petReactionBall: '신난다!',
    petReactionDone: '작업 완료!',
    petReactionQuickMsg: '메시지 확인!',
    teleportTerminalButton: '↗ 터미널',
    teleportTerminalTitle: 'Orca에서 이 워커 터미널로 이동',
    teleportWorkspaceButton: '↗ 워크스페이스',
    teleportWorkspaceTitle: 'Orca에서 이 워커 워크스페이스 열기',
    teleportJumpActiveButton: '↗ 활성 터미널로 이동',
    demoTeleportTerminalToast: '데모 모드: 실제 모드에서 해당 워커 터미널로 즉시 이동합니다',
    demoTeleportWorkspaceToast: '데모 모드: 실제 모드에서 해당 워커 워크스페이스를 엽니다',
    teleportFailedToast: (reason) =>
      reason ? `이동하지 못했습니다 (${reason})` : 'Orca에서 해당 대상으로 이동할 수 없습니다',
    quickSendTitle: '빠른 전송',
    quickSendTargetAria: '대상 봇',
    quickSendPlaceholder: '선택한 봇에게 메시지 보내기… (Enter 전송)',
    quickSendButton: '✈ 전송',
    quickSendSending: '전송 중…',
    quickSendReadOnlyBadge: '읽기 전용',
    quickSendDisabledTooltip:
      '기본값은 읽기 전용입니다. 플러그인 설정에서 "Allow Quick Send to Bots"를 켜거나 데모 모드에서 바로 체험해 보세요.',
    quickSendDisabledError:
      '빠른 전송이 비활성화되어 있습니다. 플러그인 설정에서 "Allow Quick Send to Bots"를 켜 주세요.',
    quickSendRateLimitedError: '잠시 후 다시 전송해 주세요 (봇별 2초 제한).',
    quickSendUnknownBotError: '대상 봇을 현재 스냅샷에서 찾을 수 없습니다.',
    quickSendInvalidError: '메시지는 제어 문자 없이 1~500자로 입력해 주세요.',
    quickSendFailedToast: (reason) => `빠른 전송 실패: ${reason}`,
    quickSendSentToast: (botName) => `${botName}에게 전송됨`,
    quickSendChips: [
      { label: '진행 상황', prompt: '현재 작업 진행 상황을 간단히 공유해 주세요.' },
      { label: 'PR 리뷰', prompt: '최신 PR 변경 사항을 리뷰하고 핵심 내용을 요약해 주세요.' },
      { label: '테스트 실행', prompt: '테스트를 실행하고 결과를 보고해 주세요.' },
    ],
    quickSendDemoReply: '확인했습니다! 요청하신 내용을 바로 살펴볼게요.',
    quickSendRedactedBubble: '✉ 빠른 메시지',
    rpgSectionTitle: '봇 레벨 & 책상 아이템',
    rpgLevelBadge: (level, title) => `Lv.${level} · ${title}`,
    rpgXpProgress: (xp, nextXp) => `${xp} / ${nextXp} XP`,
    rpgLevelTitles: ['인턴', '주니어', '엔지니어', '시니어', '스태프', '아크메이지'],
    rpgDeskPropTitle: '책상 아이템',
    rpgPropLabels: {
      none: '없음',
      rubber_duck: '러버덕',
      mini_plant: '미니 화분',
      mech_keyboard: '기계식 키보드',
      dual_monitor: '듀얼 모니터',
      cat_plush: '책상 냥이',
      gold_trophy: '황금 트로피',
    },
    rpgPropLockedHint: (unlockLevel) => `Lv.${unlockLevel}에 잠금 해제`,
    rpgLevelUpBubble: (level) => `⭐ Lv.${level} 달성!`,
    reportSectionRpg: '봇 성장 & 레벨',
    reportNoRpgBots: '아직 기록된 봇 경험치가 없습니다.',
    roamButton: '산책',
    roamButtonTitle: '사장님 산책 모드 전환 [V]',
    ownerTag: '나',
    roamHudHighFive: '[H] 🙌 하이파이브 (+8 XP)',
    roamHudCoffee: '[K] ☕ 커피 건네기 (+10 XP)',
    roamReactionHighFive: '나이스! 🙌',
    roamReactionCoffee: '커피 감사해요! ☕',
    shortcutToggleRoam: '사장님 산책 모드 전환',
    shortcutHighFive: '가까운 봇과 하이파이브 (산책 중)',
    shortcutHandCoffee: '가까운 봇에게 커피 건네기 (산책 중)',
    banterPairs: [
      { a: '커피 한 잔 하실래요?', b: '아이스 아메리카노요!' },
      { a: '테스트 다 통과했나요?', b: '방금 올그린 떴어요!' },
      { a: '잠깐 스트레칭 타임!', b: '어깨 펴고 다시 달려요!' },
      { a: '세미콜론 보신 분?', b: '머그컵 뒤에 숨어 있네요!' },
      { a: '오늘 빌드 상태 어때요?', b: '지금까지 아주 순조로워요!' },
      { a: '린트 경고 0건 달성!', b: '액자에 걸어 둬야겠네요!' },
      { a: '러버덕 상담 필요하세요?', b: '언제든 들어드릴게요!' },
      { a: '캐시가 따뜻하게 데워졌어요.', b: '오후 작업하기 딱 좋네요!' },
      { a: '깔끔한 배포 완료!', b: '다 같이 하이파이브!' },
      { a: '로파이 음악 틀까요?', b: '잔잔한 볼륨 좋아요!' },
      { a: '간식 시간 다가오나요?', b: '쿠키 한 조각 어때요!' },
      { a: '오늘도 화이팅입니다!', b: '차근차근 마무리해 봐요!' },
    ],
    notifyNeedsYouTitle: (botName) => `Bot World: ${botName} 결정 대기`,
    notifyNeedsYouBody: (prompt) => prompt || '승인 또는 응답이 필요합니다.',
    notifyNeedsYouTitleRedacted: 'Bot World: 봇 확인이 필요합니다',
    notifyNeedsYouBodyRedacted: (seq) => `봇 #${seq}의 확인이 필요합니다.`,
    notifyErrorTitle: (botName) => `Bot World: ${botName} 오류`,
    notifyErrorBody: (message) => message || '봇이 오류 상태가 되었습니다.',
    notifyErrorTitleRedacted: 'Bot World: 봇 오류가 발생했습니다',
    notifyErrorBodyRedacted: (seq) => `봇 #${seq}에서 오류가 발생했습니다.`,
    broadcastButton: '방송',
    broadcastButtonTitle: 'OBS·화면 녹화용 크로마키 방송 펫 바 [B]',
    shortcutToggleBroadcast: '크로마키 방송 펫 바 전환',
    broadcastChromaLabels: {
      green: '크로마 그린 (#00b140)',
      blue: '크로마 블루 (#0047bb)',
      black: '순수 블랙 (#000000)',
      charcoal: '소프트 차콜 (#11141b)',
    },
    broadcastRedactOn: '가림',
    broadcastRedactOff: '가림',
    broadcastExitButton: '나가기',
    broadcastExitTip: '방송 모드 종료',
    petExitButton: '사무실',
    petExitTip: '가상 사무실 보기로 복귀',
    studioButton: '스튜디오',
    studioButtonTitle: '크리에이터 스튜디오: 커스텀 아바타·배경·팩 [U]',
    shortcutToggleCreatorStudio: '크리에이터 스튜디오 열기',
    creatorModalTitle: '크리에이터 스튜디오',
    creatorModalSubtitle: '봇 아바타·배경 이미지를 바꾸거나 .botworld-pack.json 팩으로 공유하세요',
    creatorClose: '닫기',
    creatorTabAvatars: '봇 아바타',
    creatorTabAvatarsTip: '봇별 128×128 래스터 아바타 업로드 및 초기화',
    creatorTabBackground: '사무실 배경',
    creatorTabBackgroundTip: '1600×1000 무대 배경 이미지 업로드 및 초기화',
    creatorSelectBotAria: '커스텀 아바타 대상 봇 선택',
    creatorSelectBotTip: '커스텀 아바타를 적용할 봇을 선택합니다',
    creatorResetAvatar: '아바타 초기화',
    creatorResetAvatarTip: '이 봇의 기본 픽셀 캐릭터로 되돌립니다',
    creatorAvatarDropTitle: 'PNG · JPEG · WebP 이미지를 끌어다 놓거나 클릭해 선택',
    creatorAvatarDropSub: '128×128 PNG로 중앙 크롭·재인코딩 (원본 최대 4 MB, SVG 차단)',
    creatorAvatarDropTip: '이 봇에 적용할 아바타 이미지를 드롭하거나 선택합니다',
    creatorAvatarPreviewAlt: '커스텀 봇 아바타 미리보기',
    creatorBgDropTitle: '배경 이미지를 끌어다 놓거나 클릭해 선택',
    creatorBgDropSub: '비율 유지 최대 1600×1000 JPEG 재인코딩 (원본 최대 4 MB, SVG 차단)',
    creatorBgDropTip: '사무실 무대 전체 배경으로 쓸 이미지를 선택합니다',
    creatorBgPreviewAlt: '커스텀 사무실 배경 미리보기',
    creatorResetBg: '테마 기본 배경으로 복원',
    creatorResetBgTip: '커스텀 배경을 제거하고 기본 테마 배경을 씁니다',
    creatorExportPack: '팩 내보내기',
    creatorExportPackTip: '현재 커스텀 아바타와 배경을 .botworld-pack.json으로 저장',
    creatorImportPack: '팩 불러오기',
    creatorImportPackTip: '검증된 .botworld-pack.json 크리에이터 팩 불러오기',
    creatorResetAll: '전체 초기화',
    creatorResetAllTip: '모든 커스텀 아바타와 배경을 초기화합니다',
    creatorNoBots: '현재 스냅샷에 활성 봇이 없습니다.',
    creatorStatusSaved: '커스텀 애셋을 저장했습니다.',
    creatorStatusReset: '기본 그래픽으로 복원했습니다.',
    creatorStatusPackExported: '.botworld-pack.json 파일을 내보냈습니다.',
    creatorStatusPackImported: (count) => `크리에이터 팩을 불러왔습니다 (아바타 ${count}개).`,
    creatorErrorType: 'PNG, JPEG, WebP 이미지 형식만 지원합니다 (SVG/HTML 차단).',
    creatorErrorSize: '이미지 용량이 너무 큽니다 (원본 최대 4 MB).',
    creatorErrorDecode: '이미지를 디코딩하지 못했습니다.',
    creatorErrorPack: '유효하지 않거나 용량을 초과한 .botworld-pack.json 파일입니다.',
    detailCustomAvatarUploadTip: '이미지를 여기 끌어다 놓거나 스튜디오에서 커스텀 아바타를 설정하세요',
    detailCustomAvatarReset: '아바타 초기화',
    detailCustomAvatarResetTip: '이 봇의 기본 픽셀 캐릭터로 되돌립니다',
    tipThemeSelect: '사무실 무대 테마 변경',
    tipPetMode: '포켓 펫 테라리움 모드로 전환',
    tipOfficeMode: '가상 사무실 보기로 복귀',
    tipRoam: '사장님 캐릭터로 사무실 산책 (WASD / 바닥 더블클릭)',
    tipStream: 'OBS·녹화용 크로마키 방송 펫 바 열기',
    tipStudio: '커스텀 아바타·배경 편집 및 팩 공유',
    tipAtmosphere: (modeLabel) => `시간대 조명 전환 (${modeLabel})`,
    tipWeather: (modeLabel) => `날씨 효과 전환 (${modeLabel})`,
    tipSound: (modeLabel) => `사무실 사운드 전환 (${modeLabel})`,
    tipFocus: '긴급하거나 작업 중인 봇에 카메라 포커스',
    tipCollab: '24시간 봇 협업 네트워크 오버레이 전환',
    tipZones: '사무실 팀 구역 설정 열기',
    tipPhoto: '현재 사무실 상태를 PNG 포토 카드로 저장',
    tipReport: '24시간 사무실 리포트 및 주간 추이 보기',
    tipRedact: '민감한 봇 이름·작업·도구·메시지 가리기',
    tipLanguage: '표시 언어 전환 (EN / 한국어)',
    tipDemo: '가상 데모 오피스로 기능 미리보기',
    tipShortcuts: '키보드 단축키 목록 보기',
    tipRefresh: 'Orca 실시간 상태를 지금 다시 불러옵니다',
    tipResetSeats: '드래그로 옮긴 봇 책상을 기본 위치로 초기화',
    tipFilterPreset: (preset) => {
      switch (preset) {
        case 'all':
          return '모든 봇 표시';
        case 'working':
          return '작업 중인 봇만 필터링';
        case 'needs_you':
          return '결정 대기 또는 차단된 봇만 필터링';
        case 'error':
          return '오류 상태인 봇만 필터링';
        case 'workers':
          return '활성 서브워커가 있는 봇만 필터링';
      }
    },
    tipSearchInput: '이름·작업·도구·별칭으로 봇 검색',
    tipSearchClear: '검색어 지우기',
    tipQuickSendTarget: '빠른 메시지를 보낼 봇 선택',
    tipQuickSendSend: '선택한 봇에게 빠른 메시지 전송',
    tipZoomOut: '카메라 축소',
    tipZoomReset: (pct) => `현재 배율 ${pct}% — 클릭하면 기본 배율로 복원`,
    tipZoomIn: '카메라 확대',
    tipFollowCam: '선택한 봇을 카메라가 자동으로 따라가기',
    tipRoamHighFive: '가까운 봇과 하이파이브 (+8 XP)',
    tipRoamCoffee: '가까운 봇에게 커피 건네기 (+10 XP)',
    tipTimelineLive: '실시간 LIVE 상태로 복귀',
    tipTimelinePlay: '24시간 타임라인 리플레이 재생 / 일시정지',
    tipTimelineTimelapse: '24시간 활동을 10초 타임랩스로 재생',
    tipTimelineSpeed: (speed) => `리플레이 재생 속도를 ${speed}x로 설정`,
    tipTimelineDrawer: '24시간 이벤트 로그 서랍 열기 / 닫기',
    tipSwitchCharacter: (displayName, roleHint) => `${displayName} · ${roleHint}`,
    needsYouCardTitle: '결정 대기 · 원클릭 응답',
    needsYouRecommendedBadge: '추천',
    needsYouCustomPlaceholder: '직접 응답 입력…',
    needsYouSendReply: '응답 전송',
    needsYouSending: '전송 중…',
    needsYouReadOnlyHint: '읽기 전용 모드: 응답 텍스트를 복사하거나 터미널로 이동해 답변하세요.',
    needsYouCopyReply: '응답 복사',
    needsYouCopiedReply: '복사됨!',
    needsYouJumpTerminal: '↗ 터미널로 이동',
    needsYouRedactedPrompt: '결정이 필요합니다 (가림 모드에서 질문·선택지 숨김).',
    needsYouReplySentToast: (botName, itemNumber) => `${botName} (#${itemNumber})에 결정 응답 전송됨`,
    needsYouReplyFailedToast: (reason) => `결정 응답 전송 실패: ${reason}`,
    needsYouReplyDisabledError:
      '원클릭 응답이 비활성화되어 있습니다. 플러그인 설정에서 "Allow Quick Send to Bots"를 켜 주세요.',
    needsYouUnknownItemError: '해당 봇에서 일치하는 결정 대기 항목을 찾지 못했습니다.',
    watchdogBadge: (minutes) => `⏳ ${minutes}m`,
    watchdogStuckTitle: (minutes) => `정체 감지 (변화 없이 ${minutes}분 경과)`,
    watchdogStuckDetail: (statusLabel, tool, task) => {
      const parts = [statusLabel];
      if (tool) parts.push(`[${tool}]`);
      if (task) parts.push(task);
      return parts.join(' · ');
    },
    watchdogStuckRedactedDetail: (minutes) =>
      `${minutes}분간 상태/도구 변화 없음 (가림 모드에서 세부 내용 숨김).`,
    notifyStuckTitle: (botName, minutes) => `Bot World: ${botName} 정체 (${minutes}분)`,
    notifyStuckBody: (task, tool, minutes) => {
      const detail = [task, tool ? `[${tool}]` : null].filter(Boolean).join(' ');
      return detail
        ? `${minutes}분간 진행 변화 없음 — ${detail}`
        : `${minutes}분간 상태 또는 도구 변화가 없습니다.`;
    },
    notifyStuckTitleRedacted: 'Bot World: 봇 작업 정체 감지',
    notifyStuckBodyRedacted: (seq, minutes) => `봇 #${seq}의 작업이 ${minutes}분간 멈춰 있습니다.`,
    reportCopyStandup: '스탠드업 요약 복사',
    reportStandupPreviewTitle: '일일 스탠드업 요약 미리보기 (Markdown)',
    standupTitle: '일일 봇 스탠드업 요약',
    standupColumns: {
      bot: '봇',
      estWork: '추정 작업 시간',
      completed: '완료',
      needsYou: '결정 대기',
      stuck: '정체',
      status: '상태',
    },
    standupNoBots: '스탠드업 요약에 포함할 봇 활동이 아직 없습니다.',
  },
};

export function tStrings(locale: UiLocale = 'en'): UiDictionary {
  return pickLocale(UI_STRINGS, locale);
}

export function localizeBotErrorMessage(message: string, locale: UiLocale = 'en'): string {
  const s = tStrings(locale);
  const trimmed = message.trim();
  if (trimmed === 'Interrupted' || trimmed === '중단됨') {
    return s.interruptedLabel;
  }
  if (
    trimmed === '자동화 실행 전달 실패' ||
    trimmed === 'Automation dispatch failed' ||
    trimmed === 'Automation failed'
  ) {
    return s.automationDispatchFailedLabel;
  }
  if (trimmed === '오류 상세 가려짐' || trimmed === 'Error details hidden') {
    return s.errorHiddenLabel;
  }
  return message;
}
