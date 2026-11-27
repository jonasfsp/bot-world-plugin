import type {
  AtmosphereMode,
  BotRpgProfile,
  BotWorldCreatorPack,
  BotWorldStatePayload,
  CharacterId,
  CreatorAssetsState,
  DeskPropId,
  FocusTerminalResponse,
  ItemReplyResponse,
  LanguageSetting,
  OpenWorkspaceResponse,
  QuickSendResponse,
  RpgXpAction,
  SoundMode,
  ThemeId,
  UiLocale,
  ViewMode,
  WeatherMode,
} from './types.ts';

declare module 'orca' {
  interface PluginRequests {
    'botWorld.getState': {
      input?: { sinceMs?: number; locale?: string };
      output: BotWorldStatePayload;
    };
    'botWorld.refresh': {
      input?: { locale?: string };
      output: BotWorldStatePayload;
    };
    'botWorld.setTheme': {
      input: { themeId: string };
      output: { themeId: ThemeId };
    };
    'botWorld.setAtmosphereMode': {
      input: { atmosphereMode: AtmosphereMode };
      output: { atmosphereMode: AtmosphereMode };
    };
    'botWorld.setWeatherMode': {
      input: { weatherMode: WeatherMode };
      output: { weatherMode: WeatherMode };
    };
    'botWorld.setSoundMode': {
      input: { soundMode: SoundMode };
      output: { soundMode: SoundMode };
    };
    'botWorld.setGroupFilter': {
      input: { group: string };
      output: { groupFilter: string };
    };
    'botWorld.setViewMode': {
      input: { viewMode: ViewMode };
      output: { viewMode: ViewMode };
    };
    'botWorld.setRedactMode': {
      input: { redactMode: boolean };
      output: { redactMode: boolean };
    };
    'botWorld.setBotAppearance': {
      input: { botId: string; characterId: string };
      output: { botAppearances: Record<string, CharacterId> };
    };
    'botWorld.setLanguage': {
      input: { language: LanguageSetting; hostLocale?: string };
      output: { languageSetting: LanguageSetting; locale: UiLocale };
    };
    'botWorld.sendQuickMessage': {
      input: { botId: string; message: string };
      output: QuickSendResponse;
    };
    'botWorld.replyNeedsOwnerItem': {
      input: { botId: string; itemNumber: number; answerText: string };
      output: ItemReplyResponse;
    };
    'botWorld.focusTerminal': {
      input: { terminalId: string };
      output: FocusTerminalResponse;
    };
    'botWorld.openWorkspace': {
      input: { workspaceId: string };
      output: OpenWorkspaceResponse;
    };
    'botWorld.awardRpgXp': {
      input: { botId: string; action: RpgXpAction };
      output: {
        ok: boolean;
        reason?: 'unknown_bot' | 'cooldown';
        profile?: BotRpgProfile;
        xpAwarded: number;
        leveledUp: boolean;
        cooldownRemainingMs?: number;
        rpgProfiles: Record<string, BotRpgProfile>;
      };
    };
    'botWorld.equipDeskProp': {
      input: { botId: string; propId: DeskPropId };
      output: {
        ok: boolean;
        reason?: 'unknown_bot' | 'prop_locked';
        profile?: BotRpgProfile;
        rpgProfiles: Record<string, BotRpgProfile>;
      };
    };
    'botWorld.getCreatorAssets': {
      input?: undefined;
      output: CreatorAssetsState;
    };
    'botWorld.setCustomAvatar': {
      input: { botId: string; dataUrl: string | null };
      output: CreatorAssetsState;
    };
    'botWorld.setCustomBackground': {
      input: { dataUrl: string | null };
      output: CreatorAssetsState;
    };
    'botWorld.importCreatorPack': {
      input: { pack: BotWorldCreatorPack };
      output: CreatorAssetsState;
    };
    'botWorld.resetCustomAssets': {
      input?: { target?: 'all' | 'background' | 'avatars' };
      output: CreatorAssetsState;
    };
    'botWorld.setUiActive': {
      input: { active: boolean; clientId?: string };
      output: { uiActive: boolean; fastIntervalMs: number };
    };
  }

  interface PluginPanelEvents {
    'botWorld.stateUpdated': BotWorldStatePayload;
  }
}

export {};
