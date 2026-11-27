import { diffSnapshots } from '../src/events.ts';
import '../src/protocol.ts';
import { scrubAll } from '../src/redact.ts';
import { formatTimeHms } from '../src/timeline.ts';
import {
  type AtmosphereMode,
  type BotRpgProfile,
  type BotWorldDocumentData,
  type BotWorldStatePayload,
  type BroadcastChromaKey,
  type CharacterId,
  type CreatorAssetsState,
  DEFAULT_BOTWORLD_DOCUMENT,
  type DeskCoordinate,
  type DeskPropId,
  type LanguageSetting,
  type PetToyKind,
  type RpgXpAction,
  type SoundMode,
  type StuckAlert,
  type TeamZone,
  type ThemeId,
  type UiLocale,
  type ViewMode,
  type WeatherMode,
  type WorldSnapshot,
  type ZoneColor,
  createEmptySnapshot,
  isSafeKey,
} from '../src/types.ts';
import { getThemeConfig } from '../shared/assets-catalog.ts';
import {
  renderBotDetail,
  renderEventTimelineList,
} from '../shared/bot-detail-view.ts';
import { BroadcastBarController } from '../shared/broadcast-bar.ts';
import {
  CAMERA_ZOOM_STEP,
  pickNextFocusBotId,
  resolveFollowTargetBotId,
} from '../shared/camera.ts';
import { buildCollabNetwork } from '../shared/collab-network.ts';
import {
  type CreatorStudioTab,
  buildCreatorPackFromState,
  createEmptyCreatorAssetsState,
  creatorModalRenderKey,
  downloadCreatorPack,
  parseAndValidateCreatorPack,
  renderCreatorStudioModal,
  resolveImportedPackAvatars,
  sanitizeUploadedImage,
  validateCustomAssetDataUrl,
} from '../shared/creator-studio.ts';
import { type DemoOfficeSession, createDemoOfficeSession } from '../shared/demo-office.ts';
import { clearChildren, el } from '../shared/dom.ts';
import {
  STATUS_FILTER_PRESETS,
  type StatusFilterPreset,
  countFilterPresets,
  filterBotIds,
  getBotRedactedAlias,
  isFilterActive,
  orderedSnapshotBotIds,
} from '../shared/filter.ts';
import { createGroupSelect } from '../shared/group-select.ts';
import { effectiveLocale, getHostLocale, resolveUiLocale, tStrings } from '../shared/i18n.ts';
import { setButtonContent, svgIcon } from '../shared/icons.ts';
import {
  MilestoneTracker,
  MotionDirector,
  REPLAY_SPEEDS,
  ReplayController,
  type ReplaySpeed,
} from '../shared/motion.ts';
import { computeOfficeBadges } from '../shared/office-badges.ts';
import {
  buildOfficeReport,
  formatReportMarkdown,
  formatStandupMarkdown,
  renderOfficeReportModal,
} from '../shared/office-report.ts';
import {
  computeStuckAlerts,
  stuckAlertByBotMap,
  stuckAlertsSignature,
} from '../shared/watchdog.ts';
import { OwnerAvatarController, type OwnerInteractionAction } from '../shared/owner-avatar.ts';
import { PetTerrariumRenderer } from '../shared/pet-terrarium.ts';
import { capturePhotoCard } from '../shared/photo-card.ts';
import { QuickSendBar } from '../shared/quick-send.ts';
import {
  mapKeyToShortcutAction,
  nextAtmosphereMode,
  nextSoundMode,
  nextThemeId,
  nextWeatherMode,
  renderShortcutsModal,
  shouldIgnoreShortcutEvent,
} from '../shared/shortcuts.ts';
import { SoundscapeEngine } from '../shared/soundscape.ts';
import { StageRenderer, resolveAtmospherePhase } from '../shared/stage-renderer.ts';
import { TimelapseController } from '../shared/timelapse.ts';
import {
  createToolbarChrome,
  syncToolbarChrome,
  watchDocumentVisibility,
} from '../shared/toolbar-chrome.ts';
import { attachTooltips, setTooltip } from '../shared/tooltip.ts';
import { resolveWeatherKind } from '../shared/weather.ts';
import {
  cloneStarterTeamZones,
  createNextZonePlacement,
  renderZonesModal,
  zonesModalRenderKey,
} from '../shared/zones.ts';
import { startBotWorldDocSession } from './doc-sync.ts';

const root = document.getElementById('app');
if (!root) {
  throw new Error('Missing #app container');
}

const initialLocale = resolveUiLocale(getHostLocale());
const initialStrings = tStrings(initialLocale);

const state: {
  payload: BotWorldStatePayload;
  docData: BotWorldDocumentData;
  hoveredBotId: string | null;
  eventsDrawerOpen: boolean;
  shortcutsOpen: boolean;
  reportOpen: boolean;
  zonesOpen: boolean;
  creatorOpen: boolean;
  creatorTab: CreatorStudioTab;
  creatorTargetBotId: string | null;
  creatorStatusMessage: string | null;
  creatorStatusIsError: boolean;
  broadcastChromaKey: BroadcastChromaKey;
  lastNonBroadcastViewMode: 'office' | 'pet';
  reportCopied: boolean;
  standupCopied: boolean;
  selectionCleared: boolean;
  filterPreset: StatusFilterPreset;
  searchQuery: string;
  showCollabNetwork: boolean;
} = {
  payload: {
    snapshot: createEmptySnapshot(),
    events: [],
    keyframes: [],
    activeTheme: 'startup_office',
    atmosphereMode: 'auto',
    weatherMode: 'auto',
    soundMode: 'off',
    viewMode: 'office',
    allowQuickSend: false,
    redactMode: false,
    botAppearances: {},
    rpgProfiles: {},
    pollIntervalSec: 5,
    locale: initialLocale,
    languageSetting: 'auto',
    weeklyTrend: [],
  },
  docData: {
    ...DEFAULT_BOTWORLD_DOCUMENT,
    botAppearances: {},
    customDeskPositions: {},
    zones: [],
    showZones: true,
  },
  hoveredBotId: null,
  eventsDrawerOpen: true,
  shortcutsOpen: false,
  reportOpen: false,
  zonesOpen: false,
  creatorOpen: false,
  creatorTab: 'avatars',
  creatorTargetBotId: null,
  creatorStatusMessage: null,
  creatorStatusIsError: false,
  broadcastChromaKey: 'green',
  lastNonBroadcastViewMode: 'office',
  reportCopied: false,
  standupCopied: false,
  selectionCleared: false,
  filterPreset: 'all',
  searchQuery: '',
  showCollabNetwork: false,
};

let docSession: Awaited<ReturnType<typeof startBotWorldDocSession>> | null = null;
const liveMotion = new MotionDirector();
const replay = new ReplayController();
const timelapse = new TimelapseController();
const soundscape = new SoundscapeEngine();
const liveMilestones = new MilestoneTracker();
const demoMilestones = new MilestoneTracker();
const ownerAvatar = new OwnerAvatarController();
const prevBotLevels = new Map<string, number>();
let ownerRoamRafId: number | null = null;
let lastOwnerRoamMs = 0;
let prevLiveSnapshot: WorldSnapshot = createEmptySnapshot();
let livePayload: BotWorldStatePayload = state.payload;
let replayTimerId: number | null = null;
let lastReplayTickMs = 0;
let reportCopiedTimer: number | null = null;
let standupCopiedTimer: number | null = null;
let copiedReplyTimer: number | null = null;
let followNoticeTimer: number | null = null;
let followNoticeActive = false;
let stageToastTimer: number | null = null;

let demoSession: DemoOfficeSession | null = null;
let demoTimerId: number | null = null;
let demoThemeId: ThemeId = 'startup_office';
let demoAtmosphereMode: AtmosphereMode = 'auto';
let demoWeatherMode: WeatherMode = 'auto';
let demoSoundMode: SoundMode = 'off';
let demoViewMode: ViewMode = 'office';
let demoRedactMode = false;
let demoLanguageSetting: LanguageSetting = 'auto';
let demoAppearances: Record<string, CharacterId> = {};
let demoCustomPositions: Record<string, DeskCoordinate> = {};
let demoZones: TeamZone[] = [];
let demoShowZones = true;
let demoSelectedBotId: string | null = null;
let liveCreatorAssets: CreatorAssetsState = createEmptyCreatorAssetsState();
let demoCreatorAssets: CreatorAssetsState = createEmptyCreatorAssetsState();
let lastCreatorFetchedAtMs = -1;
let creatorAssetsFetching = false;
let quickSending = false;
let replyingItemKey: string | null = null;
let copiedReplyText: string | null = null;
const needsYouDrafts = new Map<string, string>();
function setNeedsYouDraft(itemKey: string, value: string): void {
  if (value.length === 0) {
    needsYouDrafts.delete(itemKey);
    return;
  }
  if (!needsYouDrafts.has(itemKey) && needsYouDrafts.size >= 128) {
    const oldest = needsYouDrafts.keys().next().value;
    if (oldest !== undefined) needsYouDrafts.delete(oldest);
  }
  needsYouDrafts.set(itemKey, value);
}
const demoReplyTimers = new Set<number>();
const tooltipController = attachTooltips(root);

function isDemoMode(): boolean {
  return demoSession !== null;
}

function currentLocale(): UiLocale {
  const setting = isDemoMode() ? demoLanguageSetting : state.payload.languageSetting;
  return effectiveLocale(setting, getHostLocale());
}

// Toolbar
const uiClientId = `editor-${Math.random().toString(36).slice(2, 10)}`;
let lastReportedUiActive: boolean | null = null;
function reportUiActive(active: boolean): void {
  if (lastReportedUiActive === active) return;
  lastReportedUiActive = active;
  if (typeof orca === 'undefined' || !orca.plugin?.request) return;
  void orca.plugin.request('botWorld.setUiActive', { active, clientId: uiClientId }).catch(() => {});
}

const toolbarChrome = createToolbarChrome('editor', initialLocale, {
  onSelectTheme: (themeId) => void switchTheme(themeId).catch(() => {}),
  onToggleViewMode: () => void toggleViewMode().catch(() => {}),
  onToggleRoam: () => void toggleRoamMode().catch(() => {}),
  onToggleBroadcast: () => void toggleBroadcastMode().catch(() => {}),
  onCycleAtmosphere: () => void cycleAtmosphere().catch(() => {}),
  onCycleWeather: () => void cycleWeather().catch(() => {}),
  onCycleSound: () => void cycleSound(true).catch(() => {}),
  onFocusSpotlight: () => cycleFocusSpotlight(),
  onToggleCollab: () => {
    state.showCollabNetwork = !state.showCollabNetwork;
    renderUi();
  },
  onToggleZones: () => toggleZonesModal(),
  onToggleCreatorStudio: () => toggleCreatorStudioModal(),
  onTakePhoto: () => void triggerPhotoCardSnapshot().catch(() => {}),
  onToggleReport: () => toggleReportModal(),
  onToggleRedact: () => void toggleRedact().catch(() => {}),
  onToggleLanguage: () => void toggleLanguage().catch(() => {}),
  onToggleDemo: () => {
    if (isDemoMode()) {
      exitDemoMode();
    } else {
      enterDemoMode();
    }
  },
  onToggleHelp: () => {
    state.shortcutsOpen = !state.shortcutsOpen;
    if (state.shortcutsOpen) {
      ownerAvatar.clearKeys();
      state.reportOpen = false;
      state.zonesOpen = false;
      state.creatorOpen = false;
      renderReportModal();
      renderZonesManager();
      renderCreatorStudio();
    }
    renderShortcutsHelp();
    syncChromeLocale(currentLocale());
  },
  onRefresh: () => void triggerRefresh().catch(() => {}),
});
const toolbar = toolbarChrome.root;
const refreshBtn = toolbarChrome.refreshBtn;

const resetSeatsBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-hud-btn bw-hud-reset-seats',
    tooltip: initialStrings.tipResetSeats,
    disabled: true,
    onClick: () => resetCustomSeats(),
  },
  initialStrings.resetSeats
) as HTMLButtonElement;

const demoHintText = el('span', null, initialStrings.demoModeHint);
const demoHintBanner = el('div', { className: 'bw-hint-banner bw-hidden' }, demoHintText);

// Filter & Search bar
const filterChipButtons = new Map<StatusFilterPreset, HTMLButtonElement>();
const filterChipsWrap = el('div', { className: 'bw-filter-chips' });
for (const preset of STATUS_FILTER_PRESETS) {
  const btn = el(
    'button',
    {
      type: 'button',
      className: preset === 'all' ? 'bw-filter-chip bw-filter-chip-active' : 'bw-filter-chip',
      onClick: () => {
        state.filterPreset = preset;
        renderUi();
      },
    },
    `${initialStrings.filterPresetLabels[preset]} (0)`
  ) as HTMLButtonElement;
  filterChipButtons.set(preset, btn);
  filterChipsWrap.appendChild(btn);
}

const searchInput = el('input', {
  type: 'text',
  className: 'bw-search-input',
  placeholder: initialStrings.searchPlaceholder,
  ariaLabel: initialStrings.searchPlaceholder,
  onInput: () => {
    state.searchQuery = searchInput.value;
    renderUi();
  },
}) as HTMLInputElement;

const searchClearBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn bw-btn-ghost bw-hidden',
    title: initialStrings.searchClearTitle,
    ariaLabel: initialStrings.searchClearTitle,
    onClick: () => {
      state.searchQuery = '';
      searchInput.value = '';
      renderUi();
    },
  },
  '✕'
) as HTMLButtonElement;

const filterMatchPill = el('span', { className: 'bw-filter-match-pill bw-hidden' }, '0/0');
const groupSelect = createGroupSelect((group) => void setGroupFilterValue(group).catch(() => {}));

async function setGroupFilterValue(group: string): Promise<void> {
  if (isDemoMode()) return;
  // The board's selected bot lives in the .botworld document; leave it alone.
  state.selectionCleared = false;
  state.payload = { ...state.payload, groupFilter: group };
  livePayload = state.payload;
  renderUi();
  try {
    const res = await orca.plugin.request('botWorld.setGroupFilter', { group });
    state.payload = { ...state.payload, groupFilter: res.groupFilter };
    livePayload = state.payload;
    renderUi();
  } catch {
    // The next state update from the worker carries the saved choice.
  }
}
const filterBar = el(
  'div',
  { className: 'bw-filter-bar' },
  filterChipsWrap,
  el('div', { className: 'bw-filter-search-wrap' }, groupSelect.element, filterMatchPill, searchInput, searchClearBtn)
);

// Main 2-column area
const canvasEl = el('canvas', { className: 'bw-stage-canvas' }) as HTMLCanvasElement;
const petCanvasEl = el('canvas', { className: 'bw-stage-canvas bw-hidden' }) as HTMLCanvasElement;
const stageOverlayNote = el('div', { className: 'bw-stage-overlay-note' }, initialStrings.live);
const stageToast = el('div', { className: 'bw-stage-toast bw-hidden' });
const petCoffeeBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-pet-action-btn',
    tooltip: initialStrings.petActionCoffeeTitle,
    onClick: () => handleDropPetToy('coffee'),
  },
  svgIcon('coffee', 12),
  el('span', { className: 'bw-btn-label' }, initialStrings.petActionCoffee)
) as HTMLButtonElement;
const petBallBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-pet-action-btn',
    tooltip: initialStrings.petActionBallTitle,
    onClick: () => handleDropPetToy('ball'),
  },
  svgIcon('ball', 12),
  el('span', { className: 'bw-btn-label' }, initialStrings.petActionBall)
) as HTMLButtonElement;
const petTreatBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-pet-action-btn',
    tooltip: initialStrings.petActionTreatTitle,
    onClick: () => handleDropPetToy('treat'),
  },
  svgIcon('cookie', 12),
  el('span', { className: 'bw-btn-label' }, initialStrings.petActionTreat)
) as HTMLButtonElement;
const petExitBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-pet-action-btn',
    tooltip: initialStrings.petExitTip,
    tooltipKbd: 'G',
    onClick: () => void toggleViewMode().catch(() => {}),
  },
  svgIcon('building', 12),
  el('span', { className: 'bw-btn-label' }, initialStrings.petExitButton)
) as HTMLButtonElement;
const petActionStrip = el(
  'div',
  { className: 'bw-pet-action-strip bw-hidden' },
  petCoffeeBtn,
  petBallBtn,
  petTreatBtn,
  petExitBtn
);
const broadcastBar = new BroadcastBarController({
  onSelectChroma: (key) => {
    state.broadcastChromaKey = key;
    renderUi();
  },
  onToggleRedact: () => void toggleRedact().catch(() => {}),
  onDropToy: (kind) => handleDropPetToy(kind),
  onExit: () => void exitBroadcastMode().catch(() => {}),
});
const zoomOutBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-hud-btn',
    title: initialStrings.zoomOutTitle,
    ariaLabel: initialStrings.zoomOutTitle,
    onClick: () => renderer.zoomBy(-CAMERA_ZOOM_STEP),
  },
  '−'
);
const zoomResetBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-hud-btn',
    title: initialStrings.zoomResetTitle(100),
    onClick: () => renderer.resetCamera(),
  },
  '100%'
);
const zoomInBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-hud-btn',
    title: initialStrings.zoomInTitle,
    ariaLabel: initialStrings.zoomInTitle,
    onClick: () => renderer.zoomBy(CAMERA_ZOOM_STEP),
  },
  '+'
);
const followHudBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-hud-btn',
    title: initialStrings.followButtonTitle,
    onClick: () => toggleFollowCam(),
  },
  `📌 ${initialStrings.followButton}`
);
const cameraHud = el(
  'div',
  { className: 'bw-camera-hud' },
  zoomOutBtn,
  zoomResetBtn,
  zoomInBtn,
  followHudBtn,
  resetSeatsBtn
);
const roamHudTarget = el('span', { className: 'bw-roam-hud-target' });
const roamHighFiveBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-roam-hud-btn',
    onClick: () => void triggerOwnerProximityInteraction('high_five').catch(() => {}),
  },
  initialStrings.roamHudHighFive
) as HTMLButtonElement;
const roamCoffeeBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-roam-hud-btn',
    onClick: () => void triggerOwnerProximityInteraction('coffee').catch(() => {}),
  },
  initialStrings.roamHudCoffee
) as HTMLButtonElement;
const roamHud = el(
  'div',
  { className: 'bw-roam-hud bw-hidden' },
  roamHudTarget,
  roamHighFiveBtn,
  roamCoffeeBtn
);
const stageWrap = el(
  'div',
  { className: 'bw-stage-wrap-editor' },
  canvasEl,
  petCanvasEl,
  stageOverlayNote,
  stageToast,
  cameraHud,
  roamHud,
  petActionStrip,
  broadcastBar.root
);
stageWrap.addEventListener('pointermove', (ev) => {
  if (!isBroadcastMode()) return;
  const rect = stageWrap.getBoundingClientRect();
  if (ev.clientX - rect.left >= rect.width - 340 && ev.clientY - rect.top <= 96) {
    broadcastBar.revealTemporarily();
  }
});
const quickSendBar = new QuickSendBar({
  onSelectBot: (botId) => {
    state.selectionCleared = false;
    if (isDemoMode()) {
      demoSelectedBotId = botId;
    } else {
      updateDocumentPrefs({ selectedBotId: botId });
    }
    renderUi();
  },
  onSend: (botId, message) => void handleQuickSend(botId, message).catch(() => {}),
});
const editorStageCol = el('div', { className: 'bw-editor-stage-col' }, stageWrap, quickSendBar.root);
const detailSidebar = el('div', { className: 'bw-editor-sidebar' });
const editorBody = el('div', { className: 'bw-editor-body' }, editorStageCol, detailSidebar);

// Bottom 24h timeline bar
const playBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn',
    onClick: () => {
      timelapse.stop();
      const locale = currentLocale();
      const theme = getThemeConfig(activeThemeId(), locale);
      replay.togglePlay(
        state.payload.keyframes,
        state.payload.events,
        state.payload.snapshot,
        theme,
        locale,
        activeCustomPositions()
      );
      syncReplayLoop();
      renderUi();
    },
  },
  initialStrings.play
);

const timelapseBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn',
    tooltip: initialStrings.timelapseButtonTitle,
    ariaLabel: initialStrings.timelapseButtonTitle,
    onClick: () => toggleTimelapse(),
  },
  svgIcon('clock'),
  el('span', { className: 'bw-btn-label' }, initialStrings.timelapseButton)
) as HTMLButtonElement;

const liveBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn bw-btn-active',
    onClick: () => {
      timelapse.stop();
      replay.returnToLive();
      syncReplayLoop();
      renderUi();
    },
  },
  initialStrings.live
);

const speedButtons = new Map<ReplaySpeed, HTMLButtonElement>();
const speedSeg = el('div', {
  className: 'bw-seg',
  role: 'group',
  ariaLabel: initialStrings.speedAriaLabel,
});
for (const spd of REPLAY_SPEEDS) {
  const btn = el(
    'button',
    {
      type: 'button',
      className: spd === 1 ? 'bw-seg-btn bw-seg-btn-active' : 'bw-seg-btn',
      onClick: () => {
        replay.speed = spd;
        renderUi();
      },
    },
    `${spd}x`
  );
  speedButtons.set(spd, btn);
  speedSeg.appendChild(btn);
}

const scrubber = el('input', {
  type: 'range',
  className: 'bw-scrubber',
  min: '0',
  max: '1000',
  step: '1',
  value: '1000',
  ariaLabel: initialStrings.scrubberAriaLabel,
  onInput: () => {
    timelapse.stop();
    const frac = Number(scrubber.value) / 1000;
    const locale = currentLocale();
    const theme = getThemeConfig(activeThemeId(), locale);
    replay.seekFraction(
      frac,
      state.payload.keyframes,
      state.payload.events,
      state.payload.snapshot,
      theme,
      locale,
      activeCustomPositions()
    );
    syncReplayLoop();
    renderUi();
  },
}) as HTMLInputElement;

const timeLabel = el('span', { className: 'bw-time-label' }, '--:--:--');
const drawerToggleBtn = el(
  'button',
  {
    type: 'button',
    className: 'bw-btn',
    onClick: () => {
      state.eventsDrawerOpen = !state.eventsDrawerOpen;
      renderUi();
    },
  },
  initialStrings.eventLog
);

const timelineControls = el(
  'div',
  { className: 'bw-timeline-controls' },
  liveBtn,
  playBtn,
  timelapseBtn,
  speedSeg,
  scrubber,
  timeLabel,
  drawerToggleBtn
);
const eventsDrawer = el('div', { className: 'bw-events-drawer' });
const timelineBar = el('div', { className: 'bw-timeline-bar' }, timelineControls, eventsDrawer);
const shortcutsBackdrop = el('div', {
  className: 'bw-modal-backdrop bw-hidden',
  onClick: () => {
    state.shortcutsOpen = false;
    renderShortcutsHelp();
    syncChromeLocale(currentLocale());
  },
});
const reportBackdrop = el('div', {
  className: 'bw-modal-backdrop bw-hidden',
  onClick: () => {
    state.reportOpen = false;
    renderReportModal();
    syncChromeLocale(currentLocale());
  },
});
const zonesBackdrop = el('div', {
  className: 'bw-modal-backdrop bw-hidden',
  onClick: () => {
    state.zonesOpen = false;
    renderZonesManager();
    syncChromeLocale(currentLocale());
  },
});
const creatorBackdrop = el('div', {
  className: 'bw-modal-backdrop bw-hidden',
  onClick: () => {
    state.creatorOpen = false;
    renderCreatorStudio();
    syncChromeLocale(currentLocale());
  },
});

root.appendChild(toolbar);
root.appendChild(filterBar);
root.appendChild(demoHintBanner);
root.appendChild(editorBody);
root.appendChild(timelineBar);
root.appendChild(shortcutsBackdrop);
root.appendChild(reportBackdrop);
root.appendChild(zonesBackdrop);
root.appendChild(creatorBackdrop);

const renderer = new StageRenderer(canvasEl, {
  onSelectBot: (botId) => {
    state.selectionCleared = false;
    if (isDemoMode()) {
      demoSelectedBotId = botId;
    } else {
      updateDocumentPrefs({ selectedBotId: botId });
    }
    if (renderer.camera.followBotId && renderer.camera.followBotId !== botId) {
      renderer.camera.setFollowBot(botId);
    }
    renderUi();
  },
  onHoverBot: (botId) => {
    if (state.hoveredBotId !== botId) {
      state.hoveredBotId = botId;
      updateStageOverlayLabel();
    }
  },
  onMoveBot: (botId, pos) => {
    if (!isSafeKey(botId)) return;
    if (isDemoMode()) {
      demoCustomPositions = { ...demoCustomPositions, [botId]: pos };
    } else {
      const nextPositions = { ...(state.docData.customDeskPositions ?? {}) };
      Object.defineProperty(nextPositions, botId, {
        value: pos,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      updateDocumentPrefs({ customDeskPositions: nextPositions });
    }
    renderUi();
  },
  onCameraChange: () => {
    updateCameraHud(currentLocale());
  },
  onDoubleClickFloor: (nx, ny) => {
    if (!ownerAvatar.roaming || isPetMode()) return;
    ownerAvatar.walkToNormalized(nx, ny);
    syncOwnerRoamLoop();
    renderUi();
  },
});

const petRenderer = new PetTerrariumRenderer(petCanvasEl, {
  onSelectAndPet: (botId) => {
    state.selectionCleared = false;
    if (isDemoMode()) {
      demoSelectedBotId = botId;
    } else {
      updateDocumentPrefs({ selectedBotId: botId });
    }
    soundscape.playCue('task_done', { suppressed: false });
    void awardBotRpgXp(botId, 'headpat').catch(() => {});
    renderUi();
  },
  onHoverBot: (botId) => {
    if (state.hoveredBotId !== botId) {
      state.hoveredBotId = botId;
      updateStageOverlayLabel();
    }
  },
});

function activeViewMode(): ViewMode {
  if (isDemoMode()) return demoViewMode;
  return state.payload.viewMode ?? 'office';
}

function isBroadcastMode(): boolean {
  return activeViewMode() === 'broadcast';
}

function isPetMode(): boolean {
  const vm = activeViewMode();
  return vm === 'pet' || vm === 'broadcast';
}

function activeCreatorAssets(): CreatorAssetsState {
  return isDemoMode() ? demoCreatorAssets : liveCreatorAssets;
}

function handleDropPetToy(kind: PetToyKind): void {
  petRenderer.engine.dropToy(kind);
  soundscape.playCue('handoff', { suppressed: false });
  const snap = state.payload.snapshot;
  const targetId = resolveSelectedBotId(snap) ?? snap.botOrder[0] ?? null;
  if (targetId) {
    void awardBotRpgXp(targetId, 'toy').catch(() => {});
  }
  petRenderer.renderNow();
}

function activeRpgProfiles(): Record<string, BotRpgProfile> {
  return state.payload.rpgProfiles ?? {};
}

function seedOrCelebrateRpgLevels(
  profiles: Readonly<Record<string, BotRpgProfile>> | undefined,
  seedOnly: boolean,
  locale: UiLocale
): void {
  if (!profiles) return;
  for (const [botId, prof] of Object.entries(profiles)) {
    if (!isSafeKey(botId) || !prof) continue;
    const prev = prevBotLevels.get(botId);
    if (prev === undefined || seedOnly) {
      prevBotLevels.set(botId, prof.level);
      continue;
    }
    if (prof.level > prev) {
      prevBotLevels.set(botId, prof.level);
      if (!replay.isReplay) {
        liveMotion.triggerLevelUp(botId, prof.level, undefined, locale);
        soundscape.playMilestoneCue({ suppressed: false });
      }
    } else {
      prevBotLevels.set(botId, prof.level);
    }
  }
}

async function awardBotRpgXp(botId: string, action: RpgXpAction): Promise<void> {
  if (!isSafeKey(botId)) return;
  const locale = currentLocale();
  if (isDemoMode() && demoSession) {
    const res = demoSession.awardRpgXp(botId, action);
    if (res.ok) {
      syncDemoTick(false, true);
    }
    return;
  }
  try {
    const res = await orca.plugin.request('botWorld.awardRpgXp', { botId, action });
    if (res.rpgProfiles) {
      seedOrCelebrateRpgLevels(res.rpgProfiles, false, locale);
      state.payload = { ...state.payload, rpgProfiles: res.rpgProfiles };
      livePayload = state.payload;
      renderUi(true);
    }
  } catch {
    // Ignore RPG XP failure
  }
}

async function equipBotDeskProp(botId: string, propId: DeskPropId): Promise<void> {
  if (!isSafeKey(botId)) return;
  if (isDemoMode() && demoSession) {
    const res = demoSession.equipDeskProp(botId, propId);
    if (res.ok) {
      syncDemoTick(false, true);
    }
    return;
  }
  try {
    const res = await orca.plugin.request('botWorld.equipDeskProp', { botId, propId });
    if (res.rpgProfiles) {
      state.payload = { ...state.payload, rpgProfiles: res.rpgProfiles };
      livePayload = state.payload;
      renderUi(true);
    }
  } catch {
    // Ignore equip failure
  }
}

function normalizedBotPositions(
  snap: WorldSnapshot,
  themeId: ThemeId,
  locale: UiLocale
): {
  positions: Map<string, [number, number]>;
  bossDeskNorm: [number, number];
  designSize: [number, number];
} {
  const theme = getThemeConfig(themeId, locale);
  liveMotion.syncLayout(snap, theme, activeCustomPositions());
  const dw = Math.max(1, theme.designSize[0]);
  const dh = Math.max(1, theme.designSize[1]);
  const positions = new Map<string, [number, number]>();
  for (const [botId, desk] of liveMotion.layout.botDesks.entries()) {
    const pose = liveMotion.actorPose(`bot:${botId}`, [desk.x, desk.y]);
    positions.set(botId, [pose.footX / dw, pose.footY / dh]);
  }
  return {
    positions,
    bossDeskNorm: [theme.bossDesk.x / dw, theme.bossDesk.y / dh],
    designSize: theme.designSize,
  };
}

function updateOwnerRoamHud(
  snap: WorldSnapshot,
  redactMode: boolean,
  locale: UiLocale
): string | null {
  const petActive = isPetMode();
  if (!ownerAvatar.roaming || petActive || replay.isReplay) {
    roamHud.classList.add('bw-hidden');
    return null;
  }
  const { positions } = normalizedBotPositions(snap, activeThemeId(), locale);
  const nearby = ownerAvatar.findNearbyBot(snap, positions);
  if (!nearby) {
    roamHud.classList.add('bw-hidden');
    return null;
  }
  const bot = snap.bots[nearby.botId];
  if (!bot) {
    roamHud.classList.add('bw-hidden');
    return null;
  }
  const s = tStrings(locale);
  const displayName = redactMode
    ? getBotRedactedAlias(bot.id, snap, locale)
    : scrubAll(bot.name);
  const nowMs = Date.now();
  roamHudTarget.textContent = displayName;
  roamHighFiveBtn.textContent = s.roamHudHighFive;
  roamCoffeeBtn.textContent = s.roamHudCoffee;
  roamHighFiveBtn.disabled = !ownerAvatar.canInteract(bot.id, 'high_five', nowMs);
  roamCoffeeBtn.disabled = !ownerAvatar.canInteract(bot.id, 'coffee', nowMs);
  roamHud.classList.remove('bw-hidden');
  return bot.id;
}

async function triggerOwnerProximityInteraction(action: OwnerInteractionAction): Promise<void> {
  if (!ownerAvatar.roaming || isPetMode() || replay.isReplay) return;
  const snap = currentDisplayedSnapshot();
  const locale = currentLocale();
  const themeId = activeThemeId();
  const { positions, designSize } = normalizedBotPositions(snap, themeId, locale);
  const nearby = ownerAvatar.findNearbyBot(snap, positions);
  if (!nearby) return;
  const nowMs = Date.now();
  if (!ownerAvatar.canInteract(nearby.botId, action, nowMs)) return;

  ownerAvatar.recordInteraction(nearby.botId, action, nowMs);
  const botNorm = positions.get(nearby.botId) ?? [ownerAvatar.x, ownerAvatar.y];
  const ownerDesign: [number, number] = [ownerAvatar.x * designSize[0], ownerAvatar.y * designSize[1]];
  const botDesign: [number, number] = [botNorm[0] * designSize[0], botNorm[1] * designSize[1]];
  liveMotion.triggerOwnerInteraction(action, ownerDesign, nearby.botId, botDesign, locale);
  soundscape.playCue(action === 'high_five' ? 'task_done' : 'handoff', { suppressed: false });
  renderUi();
  await awardBotRpgXp(nearby.botId, action);
}

function syncOwnerRoamLoop(): void {
  if (ownerAvatar.roaming && !isPetMode() && visibilityWatcher.isVisible()) {
    if (ownerRoamRafId === null) {
      lastOwnerRoamMs = performance.now();
      const tick = (nowMs: number) => {
        if (!ownerAvatar.roaming || isPetMode() || !visibilityWatcher.isVisible()) {
          ownerRoamRafId = null;
          return;
        }
        const dtSecs = Math.max(0, Math.min(0.25, (nowMs - lastOwnerRoamMs) / 1000));
        lastOwnerRoamMs = nowMs;
        const moved = ownerAvatar.step(dtSecs);
        if (moved) {
          const snap = currentDisplayedSnapshot();
          const locale = currentLocale();
          const redactMode = activeRedactMode();
          const nearbyBotId = updateOwnerRoamHud(snap, redactMode, locale);
          const s = tStrings(locale);
          const themeId = activeThemeId();
          const appearances = mergedAppearances();
          const selectedId = resolveSelectedBotId(snap);
          const displayTimestampMs = replay.isReplay
            ? replay.cursorMs
            : snap.capturedAt > 0
              ? snap.capturedAt
              : Date.now();
          const filterMatchedBotIds = isFilterActive(state.filterPreset, state.searchQuery)
            ? filterBotIds(snap, {
                preset: state.filterPreset,
                query: state.searchQuery,
                redactMode,
                locale,
              })
            : null;
          renderer.update({
            snapshot: snap,
            themeId,
            atmosphereMode: activeAtmosphereMode(),
            weatherMode: activeWeatherMode(),
            displayTimestampMs,
            selectedBotId: selectedId,
            redactMode,
            botAppearances: appearances,
            customDeskPositions: activeCustomPositions(),
            brand: isDemoMode() ? null : (state.docData.brand ?? null),
            projectBoard: isDemoMode() ? null : (state.docData.projectBoard ?? null),
            rpgProfiles: activeRpgProfiles(),
            ownerAvatar: {
              roaming: ownerAvatar.roaming,
              x: ownerAvatar.x,
              y: ownerAvatar.y,
              facing: ownerAvatar.facing,
              walkPhase: ownerAvatar.walkPhase,
              isMoving: ownerAvatar.isMoving,
              ripple: ownerAvatar.ripple,
              nearbyBotId,
              ownerTag: s.ownerTag,
            },
            motion: replay.isReplay ? replay.motion : liveMotion,
            replay,
            locale,
            filterMatchedBotIds,
            showCollabNetwork: state.showCollabNetwork,
            collabEdges: state.showCollabNetwork
              ? buildCollabNetwork(state.payload.events, snap, { nowMs: displayTimestampMs })
              : [],
            mvpBotId: computeOfficeBadges(state.payload.events, snap, {
              nowMs: displayTimestampMs,
              redactMode,
              locale,
            }).mvpBotId,
            zones: activeZones(),
            showZones: activeShowZones(),
            timelapseActive: timelapse.active,
            customBackground: activeCreatorAssets().customBackground,
            customAvatars: activeCreatorAssets().customAvatars,
            stuckAlerts: activeStuckAlerts(snap, displayTimestampMs, redactMode, locale),
          });
        }
        if (ownerAvatar.roaming && !isPetMode() && visibilityWatcher.isVisible()) {
          ownerRoamRafId = requestAnimationFrame(tick);
        } else {
          ownerRoamRafId = null;
        }
      };
      ownerRoamRafId = requestAnimationFrame(tick);
    }
  } else if (ownerRoamRafId !== null) {
    cancelAnimationFrame(ownerRoamRafId);
    ownerRoamRafId = null;
  }
}

async function toggleRoamMode(): Promise<void> {
  if (isPetMode()) {
    await setViewModeValue('office');
  }
  const locale = currentLocale();
  const { bossDeskNorm } = normalizedBotPositions(
    currentDisplayedSnapshot(),
    activeThemeId(),
    locale
  );
  ownerAvatar.toggleRoaming(bossDeskNorm);
  ownerAvatar.clearKeys();
  syncOwnerRoamLoop();
  renderUi();
}

function activeThemeId(): ThemeId {
  if (isDemoMode()) return demoThemeId;
  return state.docData.themeId ?? state.payload.activeTheme;
}

function activeAtmosphereMode(): AtmosphereMode {
  if (isDemoMode()) return demoAtmosphereMode;
  return state.docData.atmosphereMode ?? state.payload.atmosphereMode ?? 'auto';
}

function activeWeatherMode(): WeatherMode {
  if (isDemoMode()) return demoWeatherMode;
  return state.docData.weatherMode ?? state.payload.weatherMode ?? 'auto';
}

function activeSoundMode(): SoundMode {
  if (isDemoMode()) return demoSoundMode;
  return state.payload.soundMode ?? 'off';
}

function activeRedactMode(): boolean {
  if (isDemoMode()) return demoRedactMode;
  return Boolean(state.payload.redactMode) || Boolean(state.docData.redactMode);
}

function mergedAppearances(): Record<string, CharacterId> {
  if (isDemoMode()) return { ...demoAppearances };
  return {
    ...state.payload.botAppearances,
    ...state.docData.botAppearances,
  };
}

function activeCustomPositions(): Record<string, DeskCoordinate> {
  if (isDemoMode()) return demoCustomPositions;
  return state.docData.customDeskPositions ?? {};
}

function activeZones(): TeamZone[] {
  if (isDemoMode()) return demoZones;
  return state.docData.zones ?? [];
}

function activeShowZones(): boolean {
  if (isDemoMode()) return demoShowZones;
  return state.docData.showZones !== false;
}

function setZonesState(nextZones: TeamZone[], nextShow?: boolean): void {
  if (isDemoMode()) {
    demoZones = nextZones;
    if (nextShow !== undefined) demoShowZones = nextShow;
  } else {
    updateDocumentPrefs({
      zones: nextZones,
      ...(nextShow !== undefined ? { showZones: nextShow } : {}),
    });
  }
  renderUi();
}

function toggleZonesVisibility(): void {
  const nextShow = !activeShowZones();
  if (isDemoMode()) {
    demoShowZones = nextShow;
  } else {
    updateDocumentPrefs({ showZones: nextShow });
  }
  renderUi();
}

function resetCustomSeats(): void {
  if (isDemoMode()) {
    demoCustomPositions = {};
  } else {
    updateDocumentPrefs({ customDeskPositions: {} });
  }
  renderUi();
}

function currentDisplayedSnapshot(): WorldSnapshot {
  return replay.isReplay ? replay.snapshot : state.payload.snapshot;
}

function updateDocumentPrefs(patch: Partial<BotWorldDocumentData>): void {
  const next: BotWorldDocumentData = {
    version: 1,
    themeId: patch.themeId ?? state.docData.themeId,
    atmosphereMode: patch.atmosphereMode ?? state.docData.atmosphereMode ?? 'auto',
    weatherMode: patch.weatherMode ?? state.docData.weatherMode ?? 'auto',
    redactMode: patch.redactMode ?? state.docData.redactMode,
    selectedBotId:
      patch.selectedBotId !== undefined ? patch.selectedBotId : state.docData.selectedBotId,
    botAppearances: patch.botAppearances ?? { ...state.docData.botAppearances },
    customDeskPositions:
      patch.customDeskPositions ?? { ...(state.docData.customDeskPositions ?? {}) },
    zones: patch.zones ?? [...(state.docData.zones ?? [])],
    showZones: patch.showZones !== undefined ? patch.showZones : (state.docData.showZones !== false),
  };
  state.docData = next;
  if (docSession && !docSession.readOnly) {
    docSession.change(next);
  }
}

function showStageToast(message: string): void {
  stageToast.textContent = message;
  stageToast.classList.remove('bw-hidden');
  if (stageToastTimer !== null) {
    clearTimeout(stageToastTimer);
  }
  stageToastTimer = window.setTimeout(() => {
    stageToast.classList.add('bw-hidden');
    stageToastTimer = null;
  }, 2200);
}

async function triggerPhotoCardSnapshot(): Promise<void> {
  if (isPetMode()) {
    petRenderer.renderNow();
  } else {
    renderer.renderNow();
  }
  const locale = currentLocale();
  const s = tStrings(locale);
  const snap = currentDisplayedSnapshot();
  const timestampMs = replay.isReplay
    ? replay.cursorMs
    : snap.capturedAt > 0
      ? snap.capturedAt
      : Date.now();
  const res = await capturePhotoCard(isPetMode() ? petCanvasEl : canvasEl, {
    snapshot: snap,
    events: state.payload.events,
    themeId: activeThemeId(),
    atmosphereMode: activeAtmosphereMode(),
    weatherMode: activeWeatherMode(),
    redactMode: activeRedactMode(),
    locale,
    timestampMs,
  });
  if (res.ok) {
    showStageToast(s.photoSavedToast);
  }
}

function showFollowNoMatchNotice(): void {
  followNoticeActive = true;
  if (followNoticeTimer !== null) {
    clearTimeout(followNoticeTimer);
  }
  updateStageOverlayLabel();
  followNoticeTimer = window.setTimeout(() => {
    followNoticeActive = false;
    followNoticeTimer = null;
    updateStageOverlayLabel();
  }, 2400);
}

function updateStageOverlayLabel(): void {
  const locale = currentLocale();
  const s = tStrings(locale);
  const redactMode = activeRedactMode();
  if (followNoticeActive) {
    stageOverlayNote.textContent = s.followNoMatchNotice;
    return;
  }
  const snap = currentDisplayedSnapshot();
  if (replay.isReplay) {
    stageOverlayNote.textContent = s.stageOverlayReplay(formatTimeHms(replay.cursorMs, locale));
    return;
  }
  const hid = state.hoveredBotId;
  if (hid && isSafeKey(hid) && Object.hasOwn(snap.bots, hid)) {
    const hoverName = redactMode
      ? getBotRedactedAlias(hid, snap, locale)
      : scrubAll(snap.bots[hid].name);
    stageOverlayNote.textContent = s.stageOverlayHover(hoverName);
    return;
  }
  if (isPetMode()) {
    stageOverlayNote.textContent = s.petOverlayHint;
    return;
  }
  stageOverlayNote.textContent = snap.runtime.connected ? s.stageOverlayLive : s.stageOverlayOffline;
}

function resolveSelectedBotId(snap: WorldSnapshot): string | null {
  if (state.selectionCleared) {
    return null;
  }
  let selectedId = isDemoMode() ? demoSelectedBotId : state.docData.selectedBotId;
  if (selectedId && !Object.hasOwn(snap.bots, selectedId)) {
    selectedId = null;
  }
  if (!selectedId) {
    selectedId =
      snap.botOrder.find((id) => Object.hasOwn(snap.bots, id)) ?? Object.keys(snap.bots)[0] ?? null;
  }
  return selectedId;
}

function renderShortcutsHelp(): void {
  renderShortcutsModal(shortcutsBackdrop, {
    open: state.shortcutsOpen,
    locale: currentLocale(),
    isEditor: true,
    onClose: () => {
      state.shortcutsOpen = false;
      renderShortcutsHelp();
      syncChromeLocale(currentLocale());
    },
  });
}

function activeStuckAlerts(
  snap: WorldSnapshot = currentDisplayedSnapshot(),
  displayTimestampMs: number = snap.capturedAt > 0 ? snap.capturedAt : Date.now(),
  redactMode: boolean = activeRedactMode(),
  locale: UiLocale = currentLocale()
): StuckAlert[] {
  if (replay.isReplay) {
    return [];
  }
  if (isDemoMode()) {
    return computeStuckAlerts(snap, {
      thresholdMin: state.payload.stuckThresholdMin ?? 15,
      nowMs: displayTimestampMs,
      redactMode,
      locale,
    });
  }
  return state.payload.stuckAlerts ?? [];
}

async function copyReportMarkdown(text: string, target: 'report' | 'standup' = 'report'): Promise<void> {
  const ok = await copyTextToClipboard(text);
  if (ok) {
    if (target === 'standup') {
      state.standupCopied = true;
      renderReportModal();
      if (standupCopiedTimer !== null) {
        clearTimeout(standupCopiedTimer);
      }
      standupCopiedTimer = window.setTimeout(() => {
        state.standupCopied = false;
        standupCopiedTimer = null;
        if (state.reportOpen) {
          renderReportModal();
        }
      }, 1800);
      return;
    }
    state.reportCopied = true;
    renderReportModal();
    if (reportCopiedTimer !== null) {
      clearTimeout(reportCopiedTimer);
    }
    reportCopiedTimer = window.setTimeout(() => {
      state.reportCopied = false;
      reportCopiedTimer = null;
      if (state.reportOpen) {
        renderReportModal();
      }
    }, 1800);
  }
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  let ok = false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch {
    ok = false;
  }
  if (!ok && typeof document !== 'undefined' && typeof document.execCommand === 'function') {
    let ta: HTMLTextAreaElement | null = null;
    try {
      ta = document.createElement('textarea');
      ta.value = text;
      ta.className = 'bw-sr-only';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    } finally {
      if (ta && ta.parentNode) {
        document.body.removeChild(ta);
      }
    }
  }
  return ok;
}

function renderReportModal(): void {
  if (!state.reportOpen) {
    clearChildren(reportBackdrop);
    reportBackdrop.classList.add('bw-hidden');
    return;
  }
  const locale = currentLocale();
  const redactMode = activeRedactMode();
  const snap = state.payload.snapshot;
  const stuckAlerts = isDemoMode()
    ? computeStuckAlerts(snap, {
        thresholdMin: state.payload.stuckThresholdMin ?? 15,
        nowMs: snap.capturedAt > 0 ? snap.capturedAt : Date.now(),
        redactMode,
        locale,
      })
    : (state.payload.stuckAlerts ?? []);
  const report = buildOfficeReport(state.payload.events, snap, {
    redactMode,
    locale,
    weeklyTrend: state.payload.weeklyTrend,
    rpgProfiles: activeRpgProfiles(),
    stuckAlerts,
  });
  renderOfficeReportModal(reportBackdrop, {
    open: state.reportOpen,
    report,
    redactMode,
    locale,
    copied: state.reportCopied,
    standupCopied: state.standupCopied,
    onCopyMarkdown: () => {
      const md = formatReportMarkdown(report, { redactMode, locale });
      void copyReportMarkdown(md, 'report').catch(() => {});
    },
    onCopyStandupMarkdown: () => {
      const md = formatStandupMarkdown(report, { redactMode, locale });
      void copyReportMarkdown(md, 'standup').catch(() => {});
    },
    onClose: () => {
      state.reportOpen = false;
      renderReportModal();
      syncChromeLocale(currentLocale());
    },
  });
}

function toggleReportModal(): void {
  state.reportOpen = !state.reportOpen;
  if (state.reportOpen) {
    ownerAvatar.clearKeys();
    state.shortcutsOpen = false;
    state.zonesOpen = false;
    state.creatorOpen = false;
    state.reportCopied = false;
    state.standupCopied = false;
    renderShortcutsHelp();
    renderZonesManager();
    renderCreatorStudio();
  }
  renderReportModal();
  syncChromeLocale(currentLocale());
}

let lastZonesModalKey: string | null = null;

function renderZonesManager(): void {
  const open = state.zonesOpen;
  const zones = activeZones();
  const showZones = activeShowZones();
  const redactMode = activeRedactMode();
  const locale = currentLocale();
  const demoMode = isDemoMode();
  const nextKey = zonesModalRenderKey({
    open,
    zones,
    showZones,
    redactMode,
    locale,
    demoMode,
    persisted: true,
  });
  if (nextKey === lastZonesModalKey) {
    return;
  }
  lastZonesModalKey = nextKey;
  renderZonesModal(zonesBackdrop, {
    open,
    zones,
    showZones,
    redactMode,
    locale,
    persisted: true,
    onToggleShowZones: () => toggleZonesVisibility(),
    onLoadStarterPreset: () => setZonesState(cloneStarterTeamZones(), true),
    onAddZone: (label: string, color: ZoneColor) => {
      const current = activeZones();
      const next = createNextZonePlacement(current, label, color);
      if (next) {
        setZonesState([...current, next], true);
      }
    },
    onDeleteZone: (zoneId: string) => {
      setZonesState(activeZones().filter((z) => z.id !== zoneId));
    },
    onClearZones: () => setZonesState([]),
    onClose: () => {
      state.zonesOpen = false;
      renderZonesManager();
      syncChromeLocale(currentLocale());
    },
  });
}

function toggleZonesModal(): void {
  state.zonesOpen = !state.zonesOpen;
  if (state.zonesOpen) {
    ownerAvatar.clearKeys();
    state.shortcutsOpen = false;
    state.reportOpen = false;
    state.creatorOpen = false;
    renderShortcutsHelp();
    renderReportModal();
    renderCreatorStudio();
  }
  renderZonesManager();
  syncChromeLocale(currentLocale());
}

let lastCreatorModalKey: string | null = null;

function setCreatorStatus(message: string | null, isError = false): void {
  state.creatorStatusMessage = message;
  state.creatorStatusIsError = isError;
  renderCreatorStudio();
}

async function fetchLiveCreatorAssets(): Promise<void> {
  if (creatorAssetsFetching) return;
  creatorAssetsFetching = true;
  try {
    const assets = await orca.plugin.request('botWorld.getCreatorAssets');
    liveCreatorAssets = assets;
    lastCreatorFetchedAtMs = assets.updatedAtMs;
    renderUi(true);
  } catch {
    // Ignore transient fetch failure
  } finally {
    creatorAssetsFetching = false;
  }
}

async function handleUploadCustomAvatar(botId: string, file: File): Promise<void> {
  if (!isSafeKey(botId)) return;
  const s = tStrings(currentLocale());
  const sanitized = await sanitizeUploadedImage(file, 'avatar');
  if (!sanitized.ok) {
    const errMsg =
      sanitized.reason === 'unsupported_type'
        ? s.creatorErrorType
        : sanitized.reason === 'too_large' || sanitized.reason === 'output_too_large'
          ? s.creatorErrorSize
          : s.creatorErrorDecode;
    setCreatorStatus(errMsg, true);
    showStageToast(errMsg);
    return;
  }
  if (isDemoMode()) {
    const nextAvatars = { ...demoCreatorAssets.customAvatars };
    Object.defineProperty(nextAvatars, botId, {
      value: sanitized.dataUrl,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    demoCreatorAssets = {
      ...demoCreatorAssets,
      customAvatars: nextAvatars,
      updatedAtMs: Date.now(),
    };
    setCreatorStatus(s.creatorStatusSaved, false);
    showStageToast(s.creatorStatusSaved);
    renderUi(true);
    return;
  }
  try {
    const res = await orca.plugin.request('botWorld.setCustomAvatar', {
      botId,
      dataUrl: sanitized.dataUrl,
    });
    liveCreatorAssets = res;
    lastCreatorFetchedAtMs = res.updatedAtMs;
    setCreatorStatus(s.creatorStatusSaved, false);
    showStageToast(s.creatorStatusSaved);
    renderUi(true);
  } catch {
    setCreatorStatus(s.creatorErrorSize, true);
    showStageToast(s.creatorErrorSize);
  }
}

async function handleResetCustomAvatar(botId: string): Promise<void> {
  if (!isSafeKey(botId)) return;
  const s = tStrings(currentLocale());
  if (isDemoMode()) {
    const nextAvatars = { ...demoCreatorAssets.customAvatars };
    delete nextAvatars[botId];
    demoCreatorAssets = {
      ...demoCreatorAssets,
      customAvatars: nextAvatars,
      updatedAtMs: Date.now(),
    };
    setCreatorStatus(s.creatorStatusReset, false);
    renderUi(true);
    return;
  }
  try {
    const res = await orca.plugin.request('botWorld.setCustomAvatar', {
      botId,
      dataUrl: null,
    });
    liveCreatorAssets = res;
    lastCreatorFetchedAtMs = res.updatedAtMs;
    setCreatorStatus(s.creatorStatusReset, false);
    renderUi(true);
  } catch {
    // Ignore
  }
}

async function handleUploadCustomBackground(file: File): Promise<void> {
  const s = tStrings(currentLocale());
  const sanitized = await sanitizeUploadedImage(file, 'background');
  if (!sanitized.ok) {
    const errMsg =
      sanitized.reason === 'unsupported_type'
        ? s.creatorErrorType
        : sanitized.reason === 'too_large' || sanitized.reason === 'output_too_large'
          ? s.creatorErrorSize
          : s.creatorErrorDecode;
    setCreatorStatus(errMsg, true);
    showStageToast(errMsg);
    return;
  }
  if (isDemoMode()) {
    demoCreatorAssets = {
      ...demoCreatorAssets,
      customBackground: sanitized.dataUrl,
      updatedAtMs: Date.now(),
    };
    setCreatorStatus(s.creatorStatusSaved, false);
    renderUi(true);
    return;
  }
  try {
    const res = await orca.plugin.request('botWorld.setCustomBackground', {
      dataUrl: sanitized.dataUrl,
    });
    liveCreatorAssets = res;
    lastCreatorFetchedAtMs = res.updatedAtMs;
    setCreatorStatus(s.creatorStatusSaved, false);
    renderUi(true);
  } catch {
    setCreatorStatus(s.creatorErrorSize, true);
  }
}

async function handleResetCustomBackground(): Promise<void> {
  const s = tStrings(currentLocale());
  if (isDemoMode()) {
    demoCreatorAssets = {
      ...demoCreatorAssets,
      customBackground: null,
      updatedAtMs: Date.now(),
    };
    setCreatorStatus(s.creatorStatusReset, false);
    renderUi(true);
    return;
  }
  try {
    const res = await orca.plugin.request('botWorld.setCustomBackground', { dataUrl: null });
    liveCreatorAssets = res;
    lastCreatorFetchedAtMs = res.updatedAtMs;
    setCreatorStatus(s.creatorStatusReset, false);
    renderUi(true);
  } catch {
    // Ignore
  }
}

async function handleResetAllCreatorAssets(): Promise<void> {
  const s = tStrings(currentLocale());
  if (isDemoMode()) {
    demoCreatorAssets = createEmptyCreatorAssetsState(Date.now());
    setCreatorStatus(s.creatorStatusReset, false);
    renderUi(true);
    return;
  }
  try {
    const res = await orca.plugin.request('botWorld.resetCustomAssets', { target: 'all' });
    liveCreatorAssets = res;
    lastCreatorFetchedAtMs = res.updatedAtMs;
    setCreatorStatus(s.creatorStatusReset, false);
    renderUi(true);
  } catch {
    // Ignore
  }
}

function handleExportCreatorPack(): void {
  const s = tStrings(currentLocale());
  const snap = currentDisplayedSnapshot();
  const pack = buildCreatorPackFromState(activeCreatorAssets(), {
    botOrder: orderedSnapshotBotIds(snap),
  });
  const res = downloadCreatorPack(pack);
  if (res.ok) {
    setCreatorStatus(s.creatorStatusPackExported, false);
  }
}

async function handleImportCreatorPackFile(file: File): Promise<void> {
  const s = tStrings(currentLocale());
  let text = '';
  try {
    text = await file.text();
  } catch {
    setCreatorStatus(s.creatorErrorPack, true);
    return;
  }
  const parsed = parseAndValidateCreatorPack(text);
  if (!parsed.ok) {
    setCreatorStatus(s.creatorErrorPack, true);
    return;
  }
  const snap = currentDisplayedSnapshot();
  const botOrder = orderedSnapshotBotIds(snap);
  const resolvedAvatars = resolveImportedPackAvatars(parsed.pack, botOrder);
  const resolvedPack = {
    ...parsed.pack,
    customAvatars: resolvedAvatars,
  };
  const count = Object.keys(resolvedAvatars).length;
  if (isDemoMode()) {
    demoCreatorAssets = {
      packName: resolvedPack.packName,
      customBackground: resolvedPack.customBackground ?? null,
      customAvatars: resolvedAvatars,
      updatedAtMs: Date.now(),
    };
    setCreatorStatus(s.creatorStatusPackImported(count), false);
    renderUi(true);
    return;
  }
  try {
    const res = await orca.plugin.request('botWorld.importCreatorPack', { pack: resolvedPack });
    liveCreatorAssets = res;
    lastCreatorFetchedAtMs = res.updatedAtMs;
    setCreatorStatus(s.creatorStatusPackImported(count), false);
    renderUi(true);
  } catch {
    setCreatorStatus(s.creatorErrorPack, true);
  }
}

function renderCreatorStudio(): void {
  const open = state.creatorOpen;
  const snap = currentDisplayedSnapshot();
  const ordered = orderedSnapshotBotIds(snap);
  const targetBotId =
    state.creatorTargetBotId && ordered.includes(state.creatorTargetBotId)
      ? state.creatorTargetBotId
      : resolveSelectedBotId(snap);
  const redactMode = activeRedactMode();
  const locale = currentLocale();
  const assets = activeCreatorAssets();
  const nextKey = creatorModalRenderKey({
    open,
    tab: state.creatorTab,
    selectedBotId: targetBotId,
    redactMode,
    locale,
    demoMode: isDemoMode(),
    creatorAssets: assets,
    statusMessage: state.creatorStatusMessage,
  });
  if (nextKey === lastCreatorModalKey) {
    return;
  }
  lastCreatorModalKey = nextKey;
  renderCreatorStudioModal(creatorBackdrop, {
    open,
    tab: state.creatorTab,
    onChangeTab: (tab) => {
      state.creatorTab = tab;
      state.creatorStatusMessage = null;
      renderCreatorStudio();
    },
    snapshot: snap,
    selectedBotId: targetBotId,
    onChangeTargetBot: (botId) => {
      state.creatorTargetBotId = botId;
      state.creatorStatusMessage = null;
      renderCreatorStudio();
    },
    creatorAssets: assets,
    redactMode,
    locale,
    statusMessage: state.creatorStatusMessage,
    statusIsError: state.creatorStatusIsError,
    onUploadAvatar: (botId, file) => void handleUploadCustomAvatar(botId, file).catch(() => {}),
    onResetAvatar: (botId) => void handleResetCustomAvatar(botId).catch(() => {}),
    onUploadBackground: (file) => void handleUploadCustomBackground(file).catch(() => {}),
    onResetBackground: () => void handleResetCustomBackground().catch(() => {}),
    onExportPack: () => handleExportCreatorPack(),
    onImportPackFile: (file) => void handleImportCreatorPackFile(file).catch(() => {}),
    onResetAll: () => void handleResetAllCreatorAssets().catch(() => {}),
    onClose: () => {
      state.creatorOpen = false;
      state.creatorStatusMessage = null;
      renderCreatorStudio();
      syncChromeLocale(currentLocale());
    },
  });
}

function toggleCreatorStudioModal(forceTab?: CreatorStudioTab): void {
  if (forceTab && !state.creatorOpen) {
    state.creatorTab = forceTab;
  }
  state.creatorOpen = !state.creatorOpen;
  if (state.creatorOpen) {
    ownerAvatar.clearKeys();
    state.shortcutsOpen = false;
    state.reportOpen = false;
    state.zonesOpen = false;
    state.creatorStatusMessage = null;
    state.creatorTargetBotId = resolveSelectedBotId(currentDisplayedSnapshot());
    renderShortcutsHelp();
    renderReportModal();
    renderZonesManager();
  }
  renderCreatorStudio();
  syncChromeLocale(currentLocale());
}

function toggleTimelapse(): void {
  if (timelapse.active) {
    timelapse.stop();
    syncReplayLoop();
    renderUi();
    return;
  }
  const locale = currentLocale();
  const theme = getThemeConfig(activeThemeId(), locale);
  const bounds = replay.timeBounds(state.payload.keyframes, state.payload.events);
  const fallbackMs =
    state.payload.snapshot.capturedAt > 0 ? state.payload.snapshot.capturedAt : Date.now();
  const start = timelapse.start(bounds, fallbackMs);
  replay.isPlaying = false;
  replay.seekTo(
    start.cursorMs,
    state.payload.keyframes,
    state.payload.events,
    state.payload.snapshot,
    theme,
    locale,
    activeCustomPositions()
  );
  syncReplayLoop();
  renderUi();
}

function updateCameraHud(locale: UiLocale): void {
  const s = tStrings(locale);
  const pct = renderer.camera.zoomPercent();
  zoomResetBtn.textContent = `${pct}%`;
  setTooltip(zoomResetBtn, s.tipZoomReset(pct), '0');
  zoomResetBtn.className = renderer.camera.isZoomed() ? 'bw-hud-btn bw-hud-btn-active' : 'bw-hud-btn';
  setTooltip(zoomOutBtn, s.tipZoomOut);
  zoomOutBtn.setAttribute('aria-label', s.zoomOutTitle);
  setTooltip(zoomInBtn, s.tipZoomIn);
  zoomInBtn.setAttribute('aria-label', s.zoomInTitle);
  const following = renderer.camera.followBotId !== null;
  followHudBtn.textContent = `📌 ${following ? s.followButtonActive : s.followButton}`;
  setTooltip(followHudBtn, s.tipFollowCam, 'F');
  followHudBtn.className = following ? 'bw-hud-btn bw-hud-btn-active' : 'bw-hud-btn';
  const hasCustomSeats = Object.keys(activeCustomPositions()).length > 0;
  resetSeatsBtn.textContent = s.resetSeats;
  resetSeatsBtn.disabled = !hasCustomSeats;
  setTooltip(resetSeatsBtn, s.tipResetSeats);
}

function cycleFocusSpotlight(): void {
  const snap = currentDisplayedSnapshot();
  const locale = currentLocale();
  const redactMode = activeRedactMode();
  const activeFilter = isFilterActive(state.filterPreset, state.searchQuery)
    ? filterBotIds(snap, {
        preset: state.filterPreset,
        query: state.searchQuery,
        redactMode,
        locale,
      })
    : undefined;
  const currentId = renderer.camera.spotlightBotId ?? resolveSelectedBotId(snap);
  const nextId = pickNextFocusBotId(snap, currentId, activeFilter);
  if (!nextId) return;
  state.selectionCleared = false;
  if (isDemoMode()) {
    demoSelectedBotId = nextId;
  } else {
    updateDocumentPrefs({ selectedBotId: nextId });
  }
  renderUi();
  renderer.focusBot(nextId);
}

function toggleFollowCam(): void {
  const snap = currentDisplayedSnapshot();
  const locale = currentLocale();
  const redactMode = activeRedactMode();
  const activeFilter = isFilterActive(state.filterPreset, state.searchQuery)
    ? filterBotIds(snap, {
        preset: state.filterPreset,
        query: state.searchQuery,
        redactMode,
        locale,
      })
    : null;

  const currentFollow = renderer.camera.followBotId;
  if (currentFollow !== null) {
    if (activeFilter && activeFilter.size === 0) {
      renderer.camera.releaseFollow();
      showFollowNoMatchNotice();
      renderUi();
      return;
    }
    if (!activeFilter || activeFilter.has(currentFollow)) {
      renderer.toggleFollow(currentFollow);
      renderUi();
      return;
    }
  }

  const selectedId = resolveSelectedBotId(snap);
  const targetId = resolveFollowTargetBotId(snap, selectedId, activeFilter);
  if (!targetId) {
    showFollowNoMatchNotice();
    renderUi();
    return;
  }
  if (targetId !== selectedId) {
    state.selectionCleared = false;
    if (isDemoMode()) {
      demoSelectedBotId = targetId;
    } else {
      updateDocumentPrefs({ selectedBotId: targetId });
    }
  }
  renderer.toggleFollow(targetId);
  renderUi();
}

function syncChromeLocale(locale: UiLocale): void {
  const s = tStrings(locale);
  const snap = currentDisplayedSnapshot();
  const botCount = Object.keys(snap.bots).length;
  syncToolbarChrome(toolbarChrome, {
    mode: 'editor',
    locale,
    themeId: activeThemeId(),
    atmosphereMode: activeAtmosphereMode(),
    weatherMode: activeWeatherMode(),
    soundMode: activeSoundMode(),
    viewMode: activeViewMode(),
    redactMode: activeRedactMode(),
    demoMode: isDemoMode(),
    roaming: ownerAvatar.roaming,
    showCollabNetwork: state.showCollabNetwork,
    zonesActive: state.zonesOpen || (activeShowZones() && activeZones().length > 0),
    creatorOpen: state.creatorOpen,
    reportOpen: state.reportOpen,
    shortcutsOpen: state.shortcutsOpen,
    connected: snap.runtime.connected,
    retryAfterSecs: snap.runtime.retryAfterSecs,
    botCount,
    docReadOnly: docSession?.readOnly ?? false,
  });
  setTooltip(roamHighFiveBtn, s.tipRoamHighFive, 'H');
  setTooltip(roamCoffeeBtn, s.tipRoamCoffee, 'K');
  setButtonContent(petCoffeeBtn, 'coffee', s.petActionCoffee);
  setTooltip(petCoffeeBtn, s.petActionCoffeeTitle);
  setButtonContent(petBallBtn, 'ball', s.petActionBall);
  setTooltip(petBallBtn, s.petActionBallTitle);
  setButtonContent(petTreatBtn, 'cookie', s.petActionTreat);
  setTooltip(petTreatBtn, s.petActionTreatTitle);
  setButtonContent(petExitBtn, 'building', s.petExitButton);
  setTooltip(petExitBtn, s.petExitTip, 'G');
  searchInput.placeholder = s.searchPlaceholder;
  searchInput.setAttribute('aria-label', s.searchPlaceholder);
  setTooltip(searchInput, s.tipSearchInput, '/');
  setTooltip(searchClearBtn, s.tipSearchClear, 'Esc');
  searchClearBtn.setAttribute('aria-label', s.searchClearTitle);
  updateCameraHud(locale);
  demoHintText.textContent = s.demoModeHint;
  demoHintBanner.classList.toggle('bw-hidden', !isDemoMode());
  liveBtn.textContent = s.live;
  setTooltip(liveBtn, s.tipTimelineLive);
  setTooltip(playBtn, s.tipTimelinePlay, 'Space');
  speedSeg.setAttribute('aria-label', s.speedAriaLabel);
  for (const [spd, btn] of speedButtons.entries()) {
    setTooltip(btn, s.tipTimelineSpeed(spd));
  }
  scrubber.setAttribute('aria-label', s.scrubberAriaLabel);
  drawerToggleBtn.textContent = s.eventLog;
  setTooltip(drawerToggleBtn, s.tipTimelineDrawer);
}

function renderToolbarOnly(
  themeId: ThemeId,
  redactMode: boolean,
  snap: WorldSnapshot,
  locale: UiLocale
): void {
  const s = tStrings(locale);
  const botCount = Object.keys(snap.bots).length;
  syncToolbarChrome(toolbarChrome, {
    mode: 'editor',
    locale,
    themeId,
    atmosphereMode: activeAtmosphereMode(),
    weatherMode: activeWeatherMode(),
    soundMode: activeSoundMode(),
    viewMode: activeViewMode(),
    redactMode,
    demoMode: isDemoMode(),
    roaming: ownerAvatar.roaming,
    showCollabNetwork: state.showCollabNetwork,
    zonesActive: state.zonesOpen || (activeShowZones() && activeZones().length > 0),
    creatorOpen: state.creatorOpen,
    reportOpen: state.reportOpen,
    shortcutsOpen: state.shortcutsOpen,
    connected: snap.runtime.connected,
    retryAfterSecs: snap.runtime.retryAfterSecs,
    botCount,
    docReadOnly: docSession?.readOnly ?? false,
  });
  const hasCustomSeats = Object.keys(activeCustomPositions()).length > 0;
  resetSeatsBtn.textContent = s.resetSeats;
  resetSeatsBtn.disabled = !hasCustomSeats;
}

function renderTimelineControlsOnly(snap: WorldSnapshot, locale: UiLocale): void {
  const s = tStrings(locale);
  liveBtn.className = !replay.isReplay ? 'bw-btn bw-btn-active' : 'bw-btn';
  playBtn.textContent = replay.isReplay && replay.isPlaying ? s.pause : s.play;
  setButtonContent(
    timelapseBtn,
    'clock',
    timelapse.active ? timelapse.formatProgress() : s.timelapseButton
  );
  setTooltip(timelapseBtn, s.tipTimelineTimelapse);
  timelapseBtn.setAttribute('aria-label', s.timelapseButtonTitle);
  timelapseBtn.className = timelapse.active ? 'bw-btn bw-btn-active' : 'bw-btn';
  for (const [spd, btn] of speedButtons.entries()) {
    btn.className = replay.speed === spd ? 'bw-seg-btn bw-seg-btn-active' : 'bw-seg-btn';
  }

  const frac = replay.progressFraction(state.payload.keyframes, state.payload.events);
  scrubber.value = String(Math.round(frac * 1000));
  const displayTs = replay.isReplay ? replay.cursorMs : snap.capturedAt;
  timeLabel.textContent = `${replay.isReplay ? s.replay : s.live} ${formatTimeHms(displayTs, locale)}`;

  drawerToggleBtn.className = state.eventsDrawerOpen ? 'bw-btn bw-btn-active' : 'bw-btn';
  eventsDrawer.classList.toggle('bw-hidden', !state.eventsDrawerOpen);
}

function renderFilterBarOnly(
  snap: WorldSnapshot,
  redactMode: boolean,
  locale: UiLocale
): ReadonlySet<string> | null {
  const s = tStrings(locale);
  groupSelect.update({
    groups: isDemoMode() ? [] : (state.payload.availableGroups ?? []),
    selected: isDemoMode() ? '' : (state.payload.groupFilter ?? ''),
    redactMode,
    locale,
  });
  const counts = countFilterPresets(snap);
  for (const preset of STATUS_FILTER_PRESETS) {
    const btn = filterChipButtons.get(preset);
    if (!btn) continue;
    btn.textContent = `${s.filterPresetLabels[preset]} (${counts[preset]})`;
    btn.className =
      state.filterPreset === preset ? 'bw-filter-chip bw-filter-chip-active' : 'bw-filter-chip';
    setTooltip(btn, s.tipFilterPreset(preset));
  }
  searchClearBtn.classList.toggle('bw-hidden', state.searchQuery.length === 0);
  if (isFilterActive(state.filterPreset, state.searchQuery)) {
    const matched = filterBotIds(snap, {
      preset: state.filterPreset,
      query: state.searchQuery,
      redactMode,
      locale,
    });
    filterMatchPill.textContent = s.filterMatchCount(matched.size, counts.all);
    filterMatchPill.classList.remove('bw-hidden');
    return matched;
  }
  filterMatchPill.classList.add('bw-hidden');
  return null;
}

function renderStageFrame(
  themeId: ThemeId,
  redactMode: boolean,
  appearances: Record<string, CharacterId>,
  snap: WorldSnapshot,
  selectedId: string | null,
  locale: UiLocale
): void {
  const displayTimestampMs = replay.isReplay
    ? replay.cursorMs
    : snap.capturedAt > 0
      ? snap.capturedAt
      : Date.now();
  const filterMatchedBotIds = renderFilterBarOnly(snap, redactMode, locale);
  const collabEdges = state.showCollabNetwork
    ? buildCollabNetwork(state.payload.events, snap, { nowMs: displayTimestampMs })
    : [];
  const badgeSummary = computeOfficeBadges(state.payload.events, snap, {
    nowMs: displayTimestampMs,
    redactMode,
    locale,
  });
  updateStageOverlayLabel();
  const atmoMode = activeAtmosphereMode();
  const wMode = activeWeatherMode();
  const phase = resolveAtmospherePhase(atmoMode, displayTimestampMs);
  const wKind = resolveWeatherKind(wMode, phase, themeId);
  soundscape.updateAmbientContext(wKind, phase, themeId);

  const broadcastActive = isBroadcastMode();
  const petActive = isPetMode();
  const creatorAssets = activeCreatorAssets();
  root.classList.toggle('bw-broadcast-active', broadcastActive);
  canvasEl.classList.toggle('bw-hidden', petActive);
  petCanvasEl.classList.toggle('bw-hidden', !petActive);
  cameraHud.classList.toggle('bw-hidden', petActive);
  petActionStrip.classList.toggle('bw-hidden', !petActive || broadcastActive);
  stageOverlayNote.classList.toggle('bw-stage-overlay-note-pet', petActive);
  stageWrap.classList.toggle('bw-stage-pet-mode', petActive);
  broadcastBar.update({
    active: broadcastActive,
    chromaKey: state.broadcastChromaKey,
    redactMode,
    locale,
  });
  renderer.setActive(!petActive);
  petRenderer.setActive(petActive);
  if (petActive) {
    petRenderer.update({
      snapshot: snap,
      themeId,
      atmosphereMode: atmoMode,
      weatherMode: wMode,
      displayTimestampMs,
      selectedBotId: selectedId,
      redactMode,
      botAppearances: appearances,
      locale,
      filterMatchedBotIds,
      customAvatars: creatorAssets.customAvatars,
      rpgProfiles: activeRpgProfiles(),
      broadcastMode: broadcastActive,
      broadcastChromaKey: state.broadcastChromaKey,
    });
  }

  const liveActiveSnap = state.payload.snapshot;
  quickSendBar.update({
    snapshot: liveActiveSnap,
    selectedBotId: selectedId,
    redactMode,
    allowQuickSend: Boolean(state.payload.allowQuickSend),
    demoMode: isDemoMode(),
    locale,
    sending: quickSending,
  });

  if (!petActive) {
    const s = tStrings(locale);
    const nearbyBotId = updateOwnerRoamHud(snap, redactMode, locale);
    renderer.update({
      snapshot: snap,
      themeId,
      atmosphereMode: atmoMode,
      weatherMode: wMode,
      displayTimestampMs,
      selectedBotId: selectedId,
      redactMode,
      botAppearances: appearances,
      customDeskPositions: activeCustomPositions(),
            brand: isDemoMode() ? null : (state.docData.brand ?? null),
            projectBoard: isDemoMode() ? null : (state.docData.projectBoard ?? null),
      rpgProfiles: activeRpgProfiles(),
      ownerAvatar: {
        roaming: ownerAvatar.roaming,
        x: ownerAvatar.x,
        y: ownerAvatar.y,
        facing: ownerAvatar.facing,
        walkPhase: ownerAvatar.walkPhase,
        isMoving: ownerAvatar.isMoving,
        ripple: ownerAvatar.ripple,
        nearbyBotId,
        ownerTag: s.ownerTag,
      },
      motion: replay.isReplay ? replay.motion : liveMotion,
      replay,
      locale,
      filterMatchedBotIds,
      showCollabNetwork: state.showCollabNetwork,
      collabEdges,
      mvpBotId: badgeSummary.mvpBotId,
      zones: activeZones(),
      showZones: activeShowZones(),
      timelapseActive: timelapse.active,
      customBackground: creatorAssets.customBackground,
      customAvatars: creatorAssets.customAvatars,
      stuckAlerts: activeStuckAlerts(snap, displayTimestampMs, redactMode, locale),
    });
  } else {
    roamHud.classList.add('bw-hidden');
  }
}

let lastDetailDemoMode: boolean | null = null;
let lastDetailBotsRef: WorldSnapshot['bots'] | null = null;
let lastDetailWorkersRef: WorldSnapshot['workers'] | null = null;
let lastDetailItemsRef: WorldSnapshot['items'] | null = null;
let lastDetailAutosRef: WorldSnapshot['automations'] | null = null;
let lastDetailMsgsRef: WorldSnapshot['recentMessages'] | null = null;
let lastDetailEventsRef: BotWorldStatePayload['events'] | null = null;
let lastDetailConnected: boolean | null = null;
let lastDetailSelectedId: string | null | undefined = undefined;
let lastDetailRedact: boolean | null = null;
let lastDetailLocale: UiLocale | null = null;
let lastDetailAppearancesJson = '';
let lastDetailRpgJson = '';
let lastDetailCreatorTs = -1;
let lastDetailAllowQuickSend: boolean | null = null;
let lastDetailReplyingKey: string | null = null;
let lastDetailCopiedReply: string | null = null;
let lastDetailStuckSig = '';

let lastEventsRef: BotWorldStatePayload['events'] | null = null;
let lastEventsRedact: boolean | null = null;
let lastEventsLocale: UiLocale | null = null;
let lastEventsDrawerOpen: boolean | null = null;

function renderSidePanelsIfNeeded(
  snap: WorldSnapshot,
  selectedId: string | null,
  redactMode: boolean,
  appearances: Record<string, CharacterId>,
  locale: UiLocale,
  force = false
): void {
  const appearancesJson = JSON.stringify(appearances);
  const rpgProfiles = activeRpgProfiles();
  const rpgJson = JSON.stringify(rpgProfiles);
  const creatorAssets = activeCreatorAssets();
  const demoActive = isDemoMode();
  const allowQuickSend = Boolean(state.payload.allowQuickSend);
  const displayTs = replay.isReplay
    ? replay.cursorMs
    : snap.capturedAt > 0
      ? snap.capturedAt
      : Date.now();
  const stuckAlerts = activeStuckAlerts(snap, displayTs, redactMode, locale);
  const stuckSig = stuckAlertsSignature(stuckAlerts);
  const detailChanged =
    force ||
    demoActive !== lastDetailDemoMode ||
    snap.bots !== lastDetailBotsRef ||
    snap.workers !== lastDetailWorkersRef ||
    snap.items !== lastDetailItemsRef ||
    snap.automations !== lastDetailAutosRef ||
    snap.recentMessages !== lastDetailMsgsRef ||
    state.payload.events !== lastDetailEventsRef ||
    snap.runtime.connected !== lastDetailConnected ||
    selectedId !== lastDetailSelectedId ||
    redactMode !== lastDetailRedact ||
    locale !== lastDetailLocale ||
    appearancesJson !== lastDetailAppearancesJson ||
    rpgJson !== lastDetailRpgJson ||
    creatorAssets.updatedAtMs !== lastDetailCreatorTs ||
    allowQuickSend !== lastDetailAllowQuickSend ||
    replyingItemKey !== lastDetailReplyingKey ||
    copiedReplyText !== lastDetailCopiedReply ||
    stuckSig !== lastDetailStuckSig;

  if (detailChanged) {
    lastDetailDemoMode = demoActive;
    lastDetailBotsRef = snap.bots;
    lastDetailWorkersRef = snap.workers;
    lastDetailItemsRef = snap.items;
    lastDetailAutosRef = snap.automations;
    lastDetailMsgsRef = snap.recentMessages;
    lastDetailEventsRef = state.payload.events;
    lastDetailConnected = snap.runtime.connected;
    lastDetailSelectedId = selectedId;
    lastDetailRedact = redactMode;
    lastDetailLocale = locale;
    lastDetailAppearancesJson = appearancesJson;
    lastDetailRpgJson = rpgJson;
    lastDetailCreatorTs = creatorAssets.updatedAtMs;
    lastDetailAllowQuickSend = allowQuickSend;
    lastDetailReplyingKey = replyingItemKey;
    lastDetailCopiedReply = copiedReplyText;
    lastDetailStuckSig = stuckSig;

    const selectedBot =
      selectedId && isSafeKey(selectedId) && Object.hasOwn(snap.bots, selectedId)
        ? snap.bots[selectedId]
        : null;
    const badgeSummary = computeOfficeBadges(state.payload.events, snap, {
      redactMode,
      locale,
    });
    const customAvatarUrl =
      selectedBot && Object.hasOwn(creatorAssets.customAvatars, selectedBot.id)
        ? validateCustomAssetDataUrl(creatorAssets.customAvatars[selectedBot.id], 'avatar')
        : null;
    const stuckByBot = stuckAlertByBotMap(stuckAlerts);

    renderBotDetail(detailSidebar, {
      snapshot: snap,
      bot: selectedBot,
      redactMode,
      botAppearances: appearances,
      locale,
      botCount: Object.keys(snap.bots).length,
      badges: selectedBot ? (badgeSummary.badgesByBot[selectedBot.id] ?? []) : [],
      rpgProfile: selectedBot && Object.hasOwn(rpgProfiles, selectedBot.id) ? rpgProfiles[selectedBot.id] : null,
      onEquipProp: (botId, propId) => void equipBotDeskProp(botId, propId).catch(() => {}),
      onStartDemo: demoActive ? undefined : enterDemoMode,
      onSelectCharacter: (botId, charId) => void setBotAppearance(botId, charId).catch(() => {}),
      onFocusTerminal: (terminalId) => void focusTerminal(terminalId).catch(() => {}),
      onOpenWorkspace: (workspaceId) => void openWorkspace(workspaceId).catch(() => {}),
      customAvatarUrl,
      onUploadCustomAvatar: (botId, file) => void handleUploadCustomAvatar(botId, file).catch(() => {}),
      onResetCustomAvatar: (botId) => void handleResetCustomAvatar(botId).catch(() => {}),
      onOpenCreatorStudio: () => toggleCreatorStudioModal('avatars'),
      allowQuickSend,
      demoMode: demoActive,
      replyingItemKey,
      copiedReplyText,
      stuckAlert: selectedBot ? (stuckByBot.get(selectedBot.id) ?? null) : null,
      needsYouDrafts,
      onNeedsYouDraftChange: setNeedsYouDraft,
      onReplyNeedsOwnerItem: (botId, itemNumber, answerText) =>
        void handleReplyNeedsOwnerItem(botId, itemNumber, answerText).catch(() => {}),
      onCopyReplyText: (text) => void handleCopyReplyText(text).catch(() => {}),
    });
  }

  if (state.eventsDrawerOpen) {
    const eventsChanged =
      force ||
      state.payload.events !== lastEventsRef ||
      redactMode !== lastEventsRedact ||
      locale !== lastEventsLocale ||
      lastEventsDrawerOpen !== true;

    if (eventsChanged) {
      lastEventsRef = state.payload.events;
      lastEventsRedact = redactMode;
      lastEventsLocale = locale;
      lastEventsDrawerOpen = true;
      renderEventTimelineList(eventsDrawer, {
        events: state.payload.events,
        redactMode,
        limit: 120,
        locale,
        onJumpToTime: (ts) => {
          timelapse.stop();
          const curLocale = currentLocale();
          replay.seekTo(
            ts,
            state.payload.keyframes,
            state.payload.events,
            state.payload.snapshot,
            getThemeConfig(activeThemeId(), curLocale),
            curLocale,
            activeCustomPositions()
          );
          syncReplayLoop();
          renderUi();
        },
      });
    }
  } else {
    lastEventsDrawerOpen = false;
  }
}

function syncReplayLoop(): void {
  if (((replay.isReplay && replay.isPlaying) || timelapse.active) && visibilityWatcher.isVisible()) {
    if (replayTimerId === null) {
      lastReplayTickMs = performance.now();
      const tick = (nowMs: number) => {
        if (((!replay.isReplay || !replay.isPlaying) && !timelapse.active) || !visibilityWatcher.isVisible()) {
          replayTimerId = null;
          return;
        }
        const dtMs = Math.max(0, Math.min(250, nowMs - lastReplayTickMs));
        const dtSecs = dtMs / 1000;
        lastReplayTickMs = nowMs;
        const themeId = activeThemeId();
        const locale = currentLocale();
        const theme = getThemeConfig(themeId, locale);

        if (timelapse.active) {
          const stepRes = timelapse.advance(dtMs);
          replay.advanceToTimestamp(
            stepRes.cursorMs,
            dtSecs,
            state.payload.keyframes,
            state.payload.events,
            state.payload.snapshot,
            theme,
            locale,
            activeCustomPositions()
          );
          const displayTs = replay.isReplay
            ? replay.cursorMs
            : state.payload.snapshot.capturedAt || Date.now();
          const phase = resolveAtmospherePhase(activeAtmosphereMode(), displayTs);
          const wKind = resolveWeatherKind(activeWeatherMode(), phase, themeId);
          renderer.weather.step(dtSecs, wKind, theme.designSize);
        } else {
          replay.step(
            dtSecs,
            state.payload.keyframes,
            state.payload.events,
            state.payload.snapshot,
            theme,
            locale,
            activeCustomPositions()
          );
        }
        const snap = currentDisplayedSnapshot();
        const redactMode = activeRedactMode();
        const appearances = mergedAppearances();
        const selectedId = resolveSelectedBotId(snap);
        renderTimelineControlsOnly(snap, locale);
        renderStageFrame(themeId, redactMode, appearances, snap, selectedId, locale);
        renderSidePanelsIfNeeded(snap, selectedId, redactMode, appearances, locale, false);
        if ((replay.isPlaying || timelapse.active) && visibilityWatcher.isVisible()) {
          replayTimerId = requestAnimationFrame(tick);
        } else {
          replayTimerId = null;
        }
      };
      replayTimerId = requestAnimationFrame(tick);
    }
  } else if (replayTimerId !== null) {
    cancelAnimationFrame(replayTimerId);
    replayTimerId = null;
  }
}

function renderUi(forceSidePanels = false): void {
  const locale = currentLocale();
  const themeId = activeThemeId();
  const redactMode = activeRedactMode();
  const appearances = mergedAppearances();
  const snap = currentDisplayedSnapshot();
  const selectedId = resolveSelectedBotId(snap);

  syncChromeLocale(locale);
  renderToolbarOnly(themeId, redactMode, snap, locale);
  renderTimelineControlsOnly(snap, locale);
  renderStageFrame(themeId, redactMode, appearances, snap, selectedId, locale);
  renderSidePanelsIfNeeded(snap, selectedId, redactMode, appearances, locale, forceSidePanels);
  renderShortcutsHelp();
  renderReportModal();
  renderZonesManager();
  renderCreatorStudio();
}

function buildDemoPayload(): BotWorldStatePayload | null {
  if (!demoSession) return null;
  return demoSession.getPayload({
    themeId: demoThemeId,
    atmosphereMode: demoAtmosphereMode,
    weatherMode: demoWeatherMode,
    soundMode: demoSoundMode,
    redactMode: demoRedactMode,
    locale: currentLocale(),
    languageSetting: demoLanguageSetting,
    botAppearances: demoAppearances,
  });
}

function syncDemoTick(advance: boolean, forceSidePanels = false): void {
  if (!demoSession) return;
  const generatedCount = advance ? demoSession.tick().length : 0;
  const nextPayload = buildDemoPayload();
  if (!nextPayload) return;
  const locale = currentLocale();
  const theme = getThemeConfig(demoThemeId, locale);
  if (advance && generatedCount > 0 && !replay.isReplay) {
    seedOrCelebrateRpgLevels(nextPayload.rpgProfiles, false, locale);
    const newEvents = nextPayload.events.slice(-generatedCount).map((r) => r.event);
    liveMotion.enqueueEvents(newEvents, nextPayload.snapshot, theme, locale, activeCustomPositions());
    petRenderer.engine.onEvents(newEvents, locale);
    const crossed = demoMilestones.evaluateNewEvents(
      newEvents,
      nextPayload.snapshot.capturedAt || Date.now()
    );
    if (crossed !== null) {
      liveMotion.triggerMilestone(crossed, [theme.designSize[0] * 0.5, theme.designSize[1] * 0.24]);
      soundscape.playMilestoneCue({ suppressed: false });
    }
    soundscape.playEvents(newEvents, { suppressed: false });
  }
  state.payload = nextPayload;
  if (replay.isReplay) {
    replay.resyncSnapshot(
      nextPayload.keyframes,
      nextPayload.snapshot,
      theme,
      locale,
      activeCustomPositions()
    );
  }
  renderUi(forceSidePanels);
}

function syncDemoInterval(): void {
  if (isDemoMode() && visibilityWatcher.isVisible()) {
    if (demoTimerId === null) {
      demoTimerId = window.setInterval(() => {
        if (!demoSession || replay.isReplay || !visibilityWatcher.isVisible()) return;
        syncDemoTick(true);
      }, 2600);
    }
  } else if (demoTimerId !== null) {
    clearInterval(demoTimerId);
    demoTimerId = null;
  }
}

function enterDemoMode(): void {
  if (isDemoMode()) return;
  state.selectionCleared = false;
  demoThemeId = state.docData.themeId ?? livePayload.activeTheme;
  demoAtmosphereMode = state.docData.atmosphereMode ?? livePayload.atmosphereMode ?? 'auto';
  demoWeatherMode = state.docData.weatherMode ?? livePayload.weatherMode ?? 'auto';
  demoSoundMode = livePayload.soundMode ?? 'off';
  demoViewMode = livePayload.viewMode ?? 'office';
  demoRedactMode = Boolean(livePayload.redactMode) || Boolean(state.docData.redactMode);
  demoLanguageSetting = livePayload.languageSetting;
  demoAppearances = {};
  demoCreatorAssets = createEmptyCreatorAssetsState();
  demoCustomPositions = {};
  demoZones = (state.docData.zones ?? []).map((z) => ({ ...z }));
  demoShowZones = state.docData.showZones !== false;
  demoSelectedBotId = null;
  demoSession = createDemoOfficeSession();
  timelapse.stop();
  replay.returnToLive();
  liveMotion.clearTransients();
  syncReplayLoop();
  const initialDemo = buildDemoPayload();
  prevBotLevels.clear();
  if (initialDemo) {
    state.payload = initialDemo;
    seedOrCelebrateRpgLevels(initialDemo.rpgProfiles, true, currentLocale());
    demoSelectedBotId = initialDemo.snapshot.botOrder[0] ?? null;
    demoMilestones.seedBaseline(
      initialDemo.events,
      initialDemo.snapshot.capturedAt || Date.now()
    );
  } else {
    demoMilestones.reset();
  }
  syncDemoInterval();
  renderUi(true);
}

function clearDemoReplyTimers(): void {
  for (const tid of demoReplyTimers) {
    clearTimeout(tid);
  }
  demoReplyTimers.clear();
}

function exitDemoMode(): void {
  clearDemoReplyTimers();
  if (demoTimerId !== null) {
    clearInterval(demoTimerId);
    demoTimerId = null;
  }
  state.selectionCleared = false;
  demoSession = null;
  demoCreatorAssets = createEmptyCreatorAssetsState();
  demoCustomPositions = {};
  demoZones = [];
  demoShowZones = true;
  demoSelectedBotId = null;
  demoMilestones.reset();
  timelapse.stop();
  replay.returnToLive();
  liveMotion.clearTransients();
  syncReplayLoop();
  state.payload = livePayload;
  prevBotLevels.clear();
  seedOrCelebrateRpgLevels(livePayload.rpgProfiles, true, currentLocale());
  soundscape.setMode(livePayload.soundMode ?? 'off', { fromUserGesture: false });
  liveMilestones.seedBaseline(
    livePayload.events,
    livePayload.snapshot.capturedAt || Date.now()
  );
  renderUi(true);
  void triggerRefresh().catch(() => {});
}

function applyIncomingPayload(nextPayload: BotWorldStatePayload): void {
  livePayload = nextPayload;
  if (isDemoMode()) {
    return;
  }
  soundscape.setMode(nextPayload.soundMode ?? 'off', { fromUserGesture: false });
  const locale = effectiveLocale(nextPayload.languageSetting, getHostLocale());
  const theme = getThemeConfig(activeThemeId(), locale);
  const nowMs = nextPayload.snapshot.capturedAt > 0 ? nextPayload.snapshot.capturedAt : Date.now();
  const hadPrev = Object.keys(prevLiveSnapshot.bots).length > 0;
  seedOrCelebrateRpgLevels(nextPayload.rpgProfiles, !hadPrev || prevBotLevels.size === 0, locale);
  if (!liveMilestones.isSeeded() || !hadPrev || !nextPayload.snapshot.initialSyncComplete) {
    liveMilestones.seedBaseline(nextPayload.events, nowMs);
  } else {
    const newEvents = diffSnapshots(prevLiveSnapshot, nextPayload.snapshot, false, locale);
    if (newEvents.length > 0) {
      liveMotion.enqueueEvents(newEvents, nextPayload.snapshot, theme, locale, activeCustomPositions());
      petRenderer.engine.onEvents(newEvents, locale);
      const crossed = liveMilestones.evaluateNewEvents(newEvents, nowMs);
      if (crossed !== null && !replay.isReplay) {
        liveMotion.triggerMilestone(crossed, [
          theme.designSize[0] * 0.5,
          theme.designSize[1] * 0.24,
        ]);
        soundscape.playMilestoneCue({ suppressed: replay.isReplay });
      }
      soundscape.playEvents(newEvents, { suppressed: replay.isReplay });
    }
  }
  prevLiveSnapshot = nextPayload.snapshot;
  state.payload = nextPayload;
  if (
    typeof nextPayload.creatorUpdatedAtMs === 'number' &&
    nextPayload.creatorUpdatedAtMs !== lastCreatorFetchedAtMs
  ) {
    void fetchLiveCreatorAssets().catch(() => {});
  }
  if (replay.isReplay) {
    replay.resyncSnapshot(
      nextPayload.keyframes,
      nextPayload.snapshot,
      theme,
      locale,
      activeCustomPositions()
    );
  }
  renderUi();
}

async function switchTheme(themeId: ThemeId): Promise<void> {
  if (isDemoMode()) {
    demoThemeId = themeId;
    syncDemoTick(false, true);
    return;
  }
  updateDocumentPrefs({ themeId });
  renderUi();
  try {
    const res = await orca.plugin.request('botWorld.setTheme', { themeId });
    state.payload = { ...state.payload, activeTheme: res.themeId };
    livePayload = state.payload;
    renderUi();
  } catch {
    // Document change is already persisted locally in .botworld
  }
}

async function cycleAtmosphere(): Promise<void> {
  const nextMode = nextAtmosphereMode(activeAtmosphereMode());
  if (isDemoMode()) {
    demoAtmosphereMode = nextMode;
    syncDemoTick(false, true);
    return;
  }
  updateDocumentPrefs({ atmosphereMode: nextMode });
  renderUi();
  try {
    const res = await orca.plugin.request('botWorld.setAtmosphereMode', {
      atmosphereMode: nextMode,
    });
    state.payload = { ...state.payload, atmosphereMode: res.atmosphereMode };
    livePayload = state.payload;
    renderUi();
  } catch {
    // Document change is already persisted locally in .botworld
  }
}

async function cycleWeather(): Promise<void> {
  const nextMode = nextWeatherMode(activeWeatherMode());
  if (isDemoMode()) {
    demoWeatherMode = nextMode;
    syncDemoTick(false, true);
    return;
  }
  updateDocumentPrefs({ weatherMode: nextMode });
  renderUi();
  try {
    const res = await orca.plugin.request('botWorld.setWeatherMode', {
      weatherMode: nextMode,
    });
    state.payload = { ...state.payload, weatherMode: res.weatherMode };
    livePayload = state.payload;
    renderUi();
  } catch {
    // Document change is already persisted locally in .botworld
  }
}

async function cycleSound(fromUserGesture = false): Promise<void> {
  const nextMode = nextSoundMode(activeSoundMode());
  soundscape.setMode(nextMode, { fromUserGesture });
  if (isDemoMode()) {
    demoSoundMode = nextMode;
    syncDemoTick(false, false);
    return;
  }
  state.payload = { ...state.payload, soundMode: nextMode };
  livePayload = state.payload;
  renderUi();
  try {
    const res = await orca.plugin.request('botWorld.setSoundMode', {
      soundMode: nextMode,
    });
    state.payload = { ...state.payload, soundMode: res.soundMode };
    livePayload = state.payload;
    renderUi();
  } catch {
    // Keep local UI sound mode even if worker RPC fails
  }
}

async function setViewModeValue(nextMode: ViewMode): Promise<void> {
  if (nextMode !== 'broadcast') {
    state.lastNonBroadcastViewMode = nextMode;
  }
  if (nextMode === 'pet' || nextMode === 'broadcast') {
    ownerAvatar.clearKeys();
  }
  if (isDemoMode()) {
    demoViewMode = nextMode;
    syncDemoTick(false, false);
    return;
  }
  state.payload = { ...state.payload, viewMode: nextMode };
  livePayload = state.payload;
  renderUi();
  try {
    const res = await orca.plugin.request('botWorld.setViewMode', { viewMode: nextMode });
    state.payload = { ...state.payload, viewMode: res.viewMode };
    livePayload = state.payload;
    renderUi();
  } catch {
    // Keep local view mode even if worker RPC fails
  }
}

async function toggleViewMode(): Promise<void> {
  const cur = activeViewMode();
  const nextMode: ViewMode = cur === 'pet' ? 'office' : 'pet';
  await setViewModeValue(nextMode);
}

async function toggleBroadcastMode(): Promise<void> {
  const cur = activeViewMode();
  if (cur === 'broadcast') {
    await setViewModeValue(state.lastNonBroadcastViewMode);
  } else {
    state.lastNonBroadcastViewMode = cur === 'pet' ? 'pet' : 'office';
    await setViewModeValue('broadcast');
  }
}

async function exitBroadcastMode(): Promise<void> {
  if (!isBroadcastMode()) return;
  await setViewModeValue(state.lastNonBroadcastViewMode);
}

async function focusTerminal(terminalId: string): Promise<void> {
  const s = tStrings(currentLocale());
  if (isDemoMode()) {
    showStageToast(s.demoTeleportTerminalToast);
    return;
  }
  try {
    const res = await orca.plugin.request('botWorld.focusTerminal', { terminalId });
    if (!res.ok || !res.focused) {
      showStageToast(s.teleportFailedToast(res.reason));
    }
  } catch {
    showStageToast(s.teleportFailedToast());
  }
}

async function openWorkspace(workspaceId: string): Promise<void> {
  const s = tStrings(currentLocale());
  if (isDemoMode()) {
    showStageToast(s.demoTeleportWorkspaceToast);
    return;
  }
  try {
    const res = await orca.plugin.request('botWorld.openWorkspace', { workspaceId });
    if (!res.ok || !res.opened) {
      showStageToast(s.teleportFailedToast(res.reason));
    }
  } catch {
    showStageToast(s.teleportFailedToast());
  }
}

async function handleQuickSend(botId: string, message: string): Promise<void> {
  const locale = currentLocale();
  const s = tStrings(locale);
  const redactMode = activeRedactMode();
  const theme = getThemeConfig(activeThemeId(), locale);

  if (isDemoMode() && demoSession) {
    const res = demoSession.sendQuickMessage(botId, message);
    if (!res) return;
    quickSendBar.clearInput();
    const snap = state.payload.snapshot;
    liveMotion.launchQuickMessageCourier(
      botId,
      snap,
      theme,
      message,
      redactMode,
      activeCustomPositions(),
      locale
    );
    petRenderer.engine.dropQuickMessageLetter(botId, locale);
    soundscape.playCue('handoff', { suppressed: false });
    const targetDisplay = redactMode
      ? getBotRedactedAlias(botId, snap, locale)
      : scrubAll(res.botName);
    showStageToast(s.quickSendSentToast(targetDisplay));
    syncDemoTick(false, true);

    const timerId = window.setTimeout(() => {
      demoReplyTimers.delete(timerId);
      if (!demoSession) return;
      const replyEv = demoSession.receiveQuickMessageReply(botId, currentLocale());
      if (replyEv) {
        const nextPayload = buildDemoPayload();
        if (nextPayload) {
          const curLocale = currentLocale();
          const curTheme = getThemeConfig(demoThemeId, curLocale);
          liveMotion.enqueueEvents([replyEv], nextPayload.snapshot, curTheme, curLocale, activeCustomPositions());
          soundscape.playCue('handoff', { suppressed: false });
          state.payload = nextPayload;
          renderUi(true);
        }
      }
    }, 1200);
    demoReplyTimers.add(timerId);
    return;
  }

  if (!state.payload.allowQuickSend) {
    showStageToast(s.quickSendDisabledError);
    return;
  }

  quickSending = true;
  renderUi();
  try {
    const res = await orca.plugin.request('botWorld.sendQuickMessage', { botId, message });
    if (res.ok) {
      quickSendBar.clearInput();
      const snap = state.payload.snapshot;
      liveMotion.launchQuickMessageCourier(
        botId,
        snap,
        theme,
        message,
        redactMode,
        activeCustomPositions(),
        locale
      );
      petRenderer.engine.dropQuickMessageLetter(botId, locale);
      soundscape.playCue('handoff', { suppressed: false });
      const targetDisplay = redactMode
        ? getBotRedactedAlias(botId, snap, locale)
        : scrubAll(res.botName);
      showStageToast(s.quickSendSentToast(targetDisplay));
      const fresh = await orca.plugin.request('botWorld.getState', { locale: getHostLocale() });
      applyIncomingPayload(fresh);
    } else {
      showStageToast(s.quickSendFailedToast(res.error));
    }
  } catch {
    showStageToast(s.quickSendFailedToast('request failed'));
  } finally {
    quickSending = false;
    renderUi();
  }
}

async function handleCopyReplyText(text: string): Promise<void> {
  const ok = await copyTextToClipboard(text);
  if (!ok) return;
  copiedReplyText = text;
  renderUi(true);
  if (copiedReplyTimer !== null) {
    clearTimeout(copiedReplyTimer);
  }
  copiedReplyTimer = window.setTimeout(() => {
    copiedReplyText = null;
    copiedReplyTimer = null;
    renderUi(true);
  }, 1800);
}

async function handleReplyNeedsOwnerItem(
  botId: string,
  itemNumber: number,
  answerText: string
): Promise<void> {
  if (replyingItemKey !== null) return;
  const locale = currentLocale();
  const s = tStrings(locale);
  const redactMode = activeRedactMode();
  const theme = getThemeConfig(activeThemeId(), locale);

  if (isDemoMode() && demoSession) {
    const res = demoSession.replyNeedsOwnerItem(botId, itemNumber, answerText);
    if (!res) return;
    needsYouDrafts.delete(`${botId}:${itemNumber}`);
    const snap = state.payload.snapshot;
    liveMotion.launchQuickMessageCourier(
      botId,
      snap,
      theme,
      answerText,
      redactMode,
      activeCustomPositions(),
      locale
    );
    petRenderer.engine.dropQuickMessageLetter(botId, locale);
    soundscape.playCue('handoff', { suppressed: false });
    const targetDisplay = redactMode
      ? getBotRedactedAlias(botId, snap, locale)
      : scrubAll(res.botName);
    showStageToast(s.needsYouReplySentToast(targetDisplay, itemNumber));
    syncDemoTick(false, true);
    return;
  }

  if (!state.payload.allowQuickSend) {
    showStageToast(s.needsYouReplyDisabledError);
    return;
  }

  replyingItemKey = `${botId}:${itemNumber}`;
  renderUi(true);
  try {
    const res = await orca.plugin.request('botWorld.replyNeedsOwnerItem', {
      botId,
      itemNumber,
      answerText,
    });
    if (res.ok) {
      needsYouDrafts.delete(`${botId}:${itemNumber}`);
      const snap = state.payload.snapshot;
      liveMotion.launchQuickMessageCourier(
        botId,
        snap,
        theme,
        answerText,
        redactMode,
        activeCustomPositions(),
        locale
      );
      petRenderer.engine.dropQuickMessageLetter(botId, locale);
      soundscape.playCue('handoff', { suppressed: false });
      const targetDisplay = redactMode
        ? getBotRedactedAlias(botId, snap, locale)
        : scrubAll(res.botName);
      showStageToast(s.needsYouReplySentToast(targetDisplay, itemNumber));
      const fresh = await orca.plugin.request('botWorld.getState', { locale: getHostLocale() });
      applyIncomingPayload(fresh);
    } else {
      showStageToast(s.needsYouReplyFailedToast(res.error));
    }
  } catch {
    showStageToast(s.needsYouReplyFailedToast('request failed'));
  } finally {
    replyingItemKey = null;
    renderUi(true);
  }
}

async function toggleRedact(): Promise<void> {
  if (isDemoMode()) {
    demoRedactMode = !demoRedactMode;
    syncDemoTick(false, true);
    return;
  }
  const nextRedact = !activeRedactMode();
  updateDocumentPrefs({ redactMode: nextRedact });
  renderUi(true);
  try {
    const res = await orca.plugin.request('botWorld.setRedactMode', { redactMode: nextRedact });
    state.payload = { ...state.payload, redactMode: res.redactMode };
    livePayload = state.payload;
    renderUi(true);
    if (res.redactMode) {
      const fresh = await orca.plugin.request('botWorld.getState', { locale: getHostLocale() });
      applyIncomingPayload(fresh);
    }
  } catch {
    // Ignore
  }
}

async function toggleLanguage(): Promise<void> {
  const nextLanguage: LanguageSetting = currentLocale() === 'ko' ? 'en' : 'ko';
  if (isDemoMode()) {
    demoLanguageSetting = nextLanguage;
    syncDemoTick(false, true);
    return;
  }
  try {
    const res = await orca.plugin.request('botWorld.setLanguage', {
      language: nextLanguage,
      hostLocale: getHostLocale(),
    });
    state.payload = {
      ...state.payload,
      languageSetting: res.languageSetting,
      locale: res.locale,
    };
    livePayload = state.payload;
    renderUi(true);
    const fresh = await orca.plugin.request('botWorld.getState', { locale: getHostLocale() });
    applyIncomingPayload(fresh);
  } catch {
    // Ignore
  }
}

async function setBotAppearance(botId: string, characterId: CharacterId): Promise<void> {
  if (!isSafeKey(botId)) return;
  if (isDemoMode()) {
    Object.defineProperty(demoAppearances, botId, {
      value: characterId,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    syncDemoTick(false, true);
    return;
  }
  const nextAppearances = { ...state.docData.botAppearances };
  Object.defineProperty(nextAppearances, botId, {
    value: characterId,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  updateDocumentPrefs({ botAppearances: nextAppearances });
  renderUi();
  try {
    const res = await orca.plugin.request('botWorld.setBotAppearance', { botId, characterId });
    state.payload = { ...state.payload, botAppearances: res.botAppearances };
    livePayload = state.payload;
    renderUi();
  } catch {
    // Ignore
  }
}

async function triggerRefresh(): Promise<void> {
  if (isDemoMode()) {
    syncDemoTick(true, true);
    return;
  }
  refreshBtn.disabled = true;
  try {
    const next = await orca.plugin.request('botWorld.refresh', { locale: getHostLocale() });
    applyIncomingPayload(next);
  } catch {
    // Keep existing state when refresh fails
  } finally {
    refreshBtn.disabled = false;
  }
}

async function boot(): Promise<void> {
  renderUi(true);
  reportUiActive(visibilityWatcher.isVisible());
  try {
    orca.on('theme', ({ colorScheme }) => {
      document.documentElement.classList.toggle('light', colorScheme === 'light');
      document.documentElement.classList.toggle('dark', colorScheme === 'dark');
    });

    docSession = await startBotWorldDocSession();
    state.docData = docSession.value;
    docSession.onReplace((nextDoc) => {
      state.docData = nextDoc;
      renderUi(true);
    });

    let initial = await orca.plugin.request('botWorld.getState', { locale: getHostLocale() });
    // Only turn ON worker redactMode when document requests it; never auto-disable global redactMode=true
    if (state.docData.redactMode && !initial.redactMode) {
      await orca.plugin.request('botWorld.setRedactMode', { redactMode: true });
      initial = await orca.plugin.request('botWorld.getState', { locale: getHostLocale() });
    }
    if (initial.viewMode === 'pet' || initial.viewMode === 'office') {
      state.lastNonBroadcastViewMode = initial.viewMode;
    }
    void fetchLiveCreatorAssets().catch(() => {});

    orca.plugin.on('botWorld.stateUpdated', (payload) => {
      applyIncomingPayload(payload);
    });

    applyIncomingPayload(initial);
  } catch {
    renderUi(true);
  }
}

const handleGestureUnlock = (): void => {
  if (activeSoundMode() !== 'off' && !soundscape.isUnlocked()) {
    if (soundscape.unlockFromUserGesture()) {
      const displayTs = replay.isReplay
        ? replay.cursorMs
        : state.payload.snapshot.capturedAt > 0
          ? state.payload.snapshot.capturedAt
          : Date.now();
      const phase = resolveAtmospherePhase(activeAtmosphereMode(), displayTs);
      const wKind = resolveWeatherKind(activeWeatherMode(), phase, activeThemeId());
      soundscape.updateAmbientContext(wKind, phase, activeThemeId());
    }
  }
};

const handleKeyDown = (ev: KeyboardEvent): void => {
  handleGestureUnlock();
  const modalOpen = state.shortcutsOpen || state.reportOpen || state.zonesOpen || state.creatorOpen;
  if (shouldIgnoreShortcutEvent(ev, { modalOpen })) return;
  if (!modalOpen && ownerAvatar.roaming && activeViewMode() === 'office') {
    if (ownerAvatar.setMoveKey(ev.key, true)) {
      ev.preventDefault();
      syncOwnerRoamLoop();
      return;
    }
  }
  const action = mapKeyToShortcutAction(ev.key, { isEditor: true, modalOpen });
  if (!action) return;
  switch (action) {
    case 'toggleTheme': {
      void switchTheme(nextThemeId(activeThemeId())).catch(() => {});
      break;
    }
    case 'toggleRedact':
      void toggleRedact().catch(() => {});
      break;
    case 'toggleLanguage':
      void toggleLanguage().catch(() => {});
      break;
    case 'cycleAtmosphere':
      void cycleAtmosphere().catch(() => {});
      break;
    case 'cycleWeather':
      void cycleWeather().catch(() => {});
      break;
    case 'toggleSound':
      void cycleSound(true).catch(() => {});
      break;
    case 'toggleDemo':
      if (isDemoMode()) exitDemoMode();
      else enterDemoMode();
      break;
    case 'toggleReplayPlay': {
      ev.preventDefault();
      if (timelapse.active) {
        timelapse.stop();
        replay.isPlaying = false;
        syncReplayLoop();
        renderUi();
        break;
      }
      const locale = currentLocale();
      const theme = getThemeConfig(activeThemeId(), locale);
      replay.togglePlay(
        state.payload.keyframes,
        state.payload.events,
        state.payload.snapshot,
        theme,
        locale,
        activeCustomPositions()
      );
      syncReplayLoop();
      renderUi();
      break;
    }
    case 'toggleReport':
      toggleReportModal();
      break;
    case 'takePhotoCard':
      void triggerPhotoCardSnapshot().catch(() => {});
      break;
    case 'toggleZones':
      toggleZonesVisibility();
      break;
    case 'focusUrgent':
      cycleFocusSpotlight();
      break;
    case 'toggleFollowCam':
      toggleFollowCam();
      break;
    case 'resetCamera':
      renderer.resetCamera();
      break;
    case 'focusSearch':
      ev.preventDefault();
      searchInput.focus();
      searchInput.select();
      break;
    case 'toggleCollabNetwork':
      state.showCollabNetwork = !state.showCollabNetwork;
      renderUi();
      break;
    case 'toggleViewMode':
      void toggleViewMode().catch(() => {});
      break;
    case 'toggleBroadcast':
      void toggleBroadcastMode().catch(() => {});
      break;
    case 'toggleCreatorStudio':
      toggleCreatorStudioModal();
      break;
    case 'toggleRoam':
      void toggleRoamMode().catch(() => {});
      break;
    case 'highFiveNearby':
      void triggerOwnerProximityInteraction('high_five').catch(() => {});
      break;
    case 'handCoffeeNearby':
      void triggerOwnerProximityInteraction('coffee').catch(() => {});
      break;
    case 'toggleHelp':
      state.shortcutsOpen = !state.shortcutsOpen;
      if (state.shortcutsOpen) {
        ownerAvatar.clearKeys();
        state.reportOpen = false;
        state.zonesOpen = false;
        state.creatorOpen = false;
        renderReportModal();
        renderZonesManager();
        renderCreatorStudio();
      }
      renderShortcutsHelp();
      syncChromeLocale(currentLocale());
      break;
    case 'closeOrClearSelection':
      if (typeof document !== 'undefined' && document.activeElement === searchInput) {
        state.searchQuery = '';
        searchInput.value = '';
        searchInput.blur();
        renderUi();
      } else if (state.creatorOpen) {
        state.creatorOpen = false;
        state.creatorStatusMessage = null;
        renderCreatorStudio();
        syncChromeLocale(currentLocale());
      } else if (state.zonesOpen) {
        state.zonesOpen = false;
        renderZonesManager();
        syncChromeLocale(currentLocale());
      } else if (state.reportOpen) {
        state.reportOpen = false;
        renderReportModal();
        syncChromeLocale(currentLocale());
      } else if (state.shortcutsOpen) {
        state.shortcutsOpen = false;
        renderShortcutsHelp();
        syncChromeLocale(currentLocale());
      } else if (isBroadcastMode()) {
        void exitBroadcastMode().catch(() => {});
      } else if (timelapse.active) {
        timelapse.stop();
        syncReplayLoop();
        renderUi();
      } else if (renderer.camera.followBotId !== null) {
        renderer.camera.releaseFollow();
        updateCameraHud(currentLocale());
        renderer.renderNow();
      } else if (isFilterActive(state.filterPreset, state.searchQuery)) {
        state.filterPreset = 'all';
        state.searchQuery = '';
        searchInput.value = '';
        renderUi();
      } else {
        state.selectionCleared = true;
        if (isDemoMode()) {
          demoSelectedBotId = null;
        } else {
          updateDocumentPrefs({ selectedBotId: null });
        }
        renderUi(true);
      }
      break;
  }
};

const handleKeyUp = (ev: KeyboardEvent): void => {
  ownerAvatar.setMoveKey(ev.key, false);
};

const handleWindowBlur = (): void => {
  ownerAvatar.clearKeys();
};

const visibilityWatcher = watchDocumentVisibility((visible) => {
  reportUiActive(visible);
  renderer.setPageVisible(visible);
  petRenderer.setPageVisible(visible);
  syncOwnerRoamLoop();
  syncReplayLoop();
  syncDemoInterval();
  if (visible && isDemoMode() && !replay.isReplay) {
    syncDemoTick(false);
  }
});

window.addEventListener('keydown', handleKeyDown);
window.addEventListener('keyup', handleKeyUp);
window.addEventListener('blur', handleWindowBlur);
window.addEventListener('pointerdown', handleGestureUnlock);

let cleanedUp = false;
function cleanup(): void {
  if (cleanedUp) return;
  cleanedUp = true;
  reportUiActive(false);
  visibilityWatcher.dispose();
  clearDemoReplyTimers();
  if (demoTimerId !== null) {
    clearInterval(demoTimerId);
    demoTimerId = null;
  }
  if (reportCopiedTimer !== null) {
    clearTimeout(reportCopiedTimer);
    reportCopiedTimer = null;
  }
  if (standupCopiedTimer !== null) {
    clearTimeout(standupCopiedTimer);
    standupCopiedTimer = null;
  }
  if (copiedReplyTimer !== null) {
    clearTimeout(copiedReplyTimer);
    copiedReplyTimer = null;
  }
  if (followNoticeTimer !== null) {
    clearTimeout(followNoticeTimer);
    followNoticeTimer = null;
  }
  if (stageToastTimer !== null) {
    clearTimeout(stageToastTimer);
    stageToastTimer = null;
  }
  timelapse.stop();
  if (replayTimerId !== null) {
    cancelAnimationFrame(replayTimerId);
    replayTimerId = null;
  }
  if (ownerRoamRafId !== null) {
    cancelAnimationFrame(ownerRoamRafId);
    ownerRoamRafId = null;
  }
  ownerAvatar.clearKeys();
  needsYouDrafts.clear();
  window.removeEventListener('keydown', handleKeyDown);
  window.removeEventListener('keyup', handleKeyUp);
  window.removeEventListener('blur', handleWindowBlur);
  window.removeEventListener('pointerdown', handleGestureUnlock);
  soundscape.dispose();
  tooltipController.dispose();
  broadcastBar.dispose();
  docSession?.dispose();
  petRenderer.dispose();
  renderer.dispose();
}

window.addEventListener('beforeunload', cleanup);
window.addEventListener('pagehide', cleanup);

void boot().catch(() => {});
