import type { CliEnvelope } from './orca-cli.ts';
import { scrubAll } from './redact.ts';
import {
  type AutomationState,
  type BotActivityStatus,
  type BotItemState,
  type BotQuestionOption,
  type BotState,
  type InboxMessage,
  type WorkerLiveness,
  type WorkerState,
  type WorldSnapshot,
  isSafeKey,
  isWorkerActive,
  isWorkerVisibleOnStage,
} from './types.ts';

const MAX_SEEN_IDS = 256;
const MAX_CHAT_INDEX = 256;
const MAX_RUN_BOT_INDEX = 128;
const MAX_TERMINATED_WORKERS = 32;
const MAX_CLOSED_ITEMS = 60;
const WORKER_RETENTION_MS = 60 * 60 * 1000;
const CLOSED_ITEM_RETENTION_MS = 24 * 60 * 60 * 1000;

type RawObj = Record<string, unknown>;

function asObj(v: unknown): RawObj | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as RawObj) : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asBool(v: unknown): boolean {
  return typeof v === 'boolean' ? v : false;
}

function asNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function safeSet<V>(record: Record<string, V>, key: string, value: V): void {
  if (!isSafeKey(key)) return;
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function safeGet<V>(record: Record<string, V>, key: string): V | undefined {
  if (!isSafeKey(key)) return undefined;
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function safeDelete<V>(record: Record<string, V>, key: string): void {
  if (!isSafeKey(key)) return;
  if (Object.hasOwn(record, key)) {
    delete record[key];
  }
}

export function isParentBotAgent(agent: RawObj): boolean {
  const parentPane = asStr(agent.parentPaneKey);
  const activity = asObj(agent.activity);
  const childOf = activity ? asStr(activity.childOf) : null;
  const address = asStr(agent.address);

  const hasParentPane = parentPane !== null && parentPane.length > 0;
  const hasChildOf = childOf !== null && childOf.length > 0;
  const isSessionAddr = address !== null && address.startsWith('orca_session_id:');
  return isSessionAddr && !hasParentPane && !hasChildOf;
}

export function isChildWorkerAgent(agent: RawObj): boolean {
  const parentPane = asStr(agent.parentPaneKey);
  const activity = asObj(agent.activity);
  const childOf = activity ? asStr(activity.childOf) : null;
  const address = asStr(agent.address);

  const hasParentPane = parentPane !== null && parentPane.length > 0;
  const hasChildOf = childOf !== null && childOf.length > 0;
  const isTermAddr = address !== null && address.startsWith('term_');
  return isTermAddr || hasParentPane || hasChildOf;
}

export function applyRuntimeMeta(snapshot: WorldSnapshot, runtimeId: string | null): void {
  if (runtimeId && runtimeId.length > 0) {
    if (snapshot.runtime.runtimeId !== null && snapshot.runtime.runtimeId !== runtimeId) {
      snapshot.rebaselineNeeded = true;
    }
    snapshot.runtime.runtimeId = runtimeId;
  }
}

export function rebaselineSnapshot(snapshot: WorldSnapshot): void {
  snapshot.inboxCursor = {
    lastSequence: 0,
    seenIds: [],
    needsBackfill: false,
  };
  snapshot.recentMessages = [];
  snapshot.workers = {};
  snapshot.items = {};
  snapshot.runBotIndex = {};
  snapshot.rebaselineNeeded = false;
  snapshot.initialSyncComplete = false;
  recomputeBotStatuses(snapshot, null);
}

export function applyStatus(snapshot: WorldSnapshot, env: CliEnvelope<unknown>): void {
  applyRuntimeMeta(snapshot, env._meta?.runtimeId ?? null);
  if (!env.ok) {
    snapshot.runtime = {
      connected: false,
      reachable: false,
      state: 'unavailable',
      runtimeId: snapshot.runtime.runtimeId,
      appVersion: snapshot.runtime.appVersion,
      retryAfterSecs: snapshot.runtime.retryAfterSecs,
      errorMessage: env.error?.message ? scrubAll(String(env.error.message)) : null,
    };
    return;
  }

  const res = asObj(env.result);
  const rt = res ? asObj(res.runtime) : null;
  if (rt) {
    const rtId = asStr(rt.runtimeId);
    if (rtId) {
      applyRuntimeMeta(snapshot, rtId);
    }
    const reachable = asBool(rt.reachable);
    const state = asStr(rt.state) ?? 'unknown';
    snapshot.runtime.connected = reachable && state === 'ready';
    snapshot.runtime.reachable = reachable;
    snapshot.runtime.state = scrubAll(state);
    const appVer = asStr(rt.appVersion);
    snapshot.runtime.appVersion = appVer ? scrubAll(appVer) : null;
    snapshot.runtime.retryAfterSecs = null;
    snapshot.runtime.errorMessage = null;
  }
}

const MAX_BOT_GROUPS = 32;
const MAX_GROUP_NAME_CHARS = 80;
/** Orca names a bot's seat in a group chat `bot-group-member-<uuid>`; the chat title is the group. */
export const GROUP_CHAT_ID_PREFIX = 'bot-group-member-';

/** `bot list` → `server: { name, on }` for bots on a paired Orca server; null for local bots. */
export function parseBotServer(raw: unknown): string | null {
  const obj = asObj(raw);
  if (!obj) return null;
  const on = asStr(obj.on) ?? asStr(obj.name);
  if (!on) return null;
  const clean = scrubAll(on).trim();
  if (clean.length === 0 || clean.length > 128 || clean.startsWith('-')) return null;
  if (/[\x00-\x1f\x7f]/.test(clean)) return null;
  return clean;
}

export function cleanGroupName(raw: unknown): string | null {
  const title = asStr(raw);
  if (!title) return null;
  const clean = scrubAll(title).replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
  if (clean.length === 0) return null;
  return clean.length > MAX_GROUP_NAME_CHARS ? clean.slice(0, MAX_GROUP_NAME_CHARS) : clean;
}

function mergeRawBots(
  snapshot: WorldSnapshot,
  rawBots: unknown[],
  authoritativeOrder: boolean
): void {
  const validBots: RawObj[] = [];
  for (const item of rawBots) {
    const obj = asObj(item);
    if (!obj) continue;
    const id = asStr(obj.id);
    if (!id || !isSafeKey(id)) continue;
    validBots.push(obj);
  }

  if (authoritativeOrder && validBots.length > 0) {
    snapshot.botOrder = validBots.map((b) => String(b.id));
  }

  for (const raw of validBots) {
    const id = String(raw.id);
    if (!snapshot.botOrder.includes(id)) {
      snapshot.botOrder.push(id);
    }
    const cleanName = scrubAll(asStr(raw.name) ?? id);
    const cleanAgent = scrubAll(asStr(raw.agent) ?? '');
    const paused = asBool(raw.paused);
    const cleanSpecialty = scrubAll(asStr(raw.specialty) ?? '');
    const server = parseBotServer(raw.server);

    let entry = safeGet(snapshot.bots, id);
    if (!entry) {
      entry = {
        id,
        name: cleanName,
        agent: cleanAgent,
        paused,
        specialty: cleanSpecialty,
        status: paused ? { kind: 'Paused' } : { kind: 'Idle' },
        currentTaskTitle: null,
        currentTool: null,
        lastActivityAt: null,
        homeChatId: null,
        needsYouCount: 0,
        activeWorkerCount: 0,
        server,
      };
      safeSet(snapshot.bots, id, entry);
    } else {
      entry.server = server;
      entry.name = cleanName;
      entry.agent = cleanAgent;
      entry.paused = paused;
      entry.specialty = cleanSpecialty;
      if (paused) {
        entry.status = { kind: 'Paused' };
      }
    }
  }
}

export function applyBotList(snapshot: WorldSnapshot, env: CliEnvelope<unknown>): void {
  applyRuntimeMeta(snapshot, env._meta?.runtimeId ?? null);
  const res = asObj(env.result);
  if (!res) return;
  mergeRawBots(snapshot, asArray(res.bots), true);
}

export function isRawInboxHeader(title: string): boolean {
  const trimmed = title.trim();
  return (
    trimmed.startsWith('──── From:') ||
    trimmed.startsWith('---- From:') ||
    trimmed.startsWith('From:') ||
    trimmed.includes('──── From:') ||
    trimmed.includes('---- From:')
  );
}

export function isUsableTaskTitle(title: string): boolean {
  const trimmed = title.trim();
  return trimmed.length > 0 && trimmed !== 'Home' && !isRawInboxHeader(trimmed);
}

function findBotIdByName(snapshot: WorldSnapshot, name: string): string | null {
  const clean = scrubAll(name);
  for (const bot of Object.values(snapshot.bots)) {
    if (bot.name === name || bot.name === clean) {
      return bot.id;
    }
  }
  return null;
}

export function applyBotChats(snapshot: WorldSnapshot, env: CliEnvelope<unknown>): void {
  applyRuntimeMeta(snapshot, env._meta?.runtimeId ?? null);
  const res = asObj(env.result);
  if (!res) return;
  const botRef = asStr(res.bot);
  if (!botRef) return;
  const botId = findBotIdByName(snapshot, botRef);
  if (!botId) return;

  let latestAt: number | null = null;
  let bestTitleAt: number | null = null;
  let bestTitle: string | null = null;
  let homeChatId: string | null = null;
  const groups = new Set<string>();

  for (const rawChat of asArray(res.chats)) {
    const chat = asObj(rawChat);
    if (!chat) continue;
    const chatId = asStr(chat.id);
    if (!chatId || !isSafeKey(chatId)) continue;
    safeSet(snapshot.chatIndex, chatId, botId);

    if (chatId.startsWith(GROUP_CHAT_ID_PREFIX)) {
      // A group seat: its title names the group, not a task.
      const group = cleanGroupName(chat.title);
      if (group && !asBool(chat.closed) && groups.size < MAX_BOT_GROUPS) groups.add(group);
      continue;
    }

    if (asBool(chat.home) && homeChatId === null) {
      homeChatId = chatId;
    }
    const ts = asNum(chat.lastActivityAt);
    if (ts !== null) {
      if (latestAt === null || ts > latestAt) {
        latestAt = ts;
      }
      const title = asStr(chat.title);
      if (title && isUsableTaskTitle(title) && (bestTitleAt === null || ts > bestTitleAt)) {
        bestTitleAt = ts;
        bestTitle = scrubAll(title);
      }
    }
  }

  let inProgressTitle: string | null = null;
  let minIpNumber = Number.MAX_SAFE_INTEGER;
  for (const it of Object.values(snapshot.items)) {
    if (it.ownerBotId === botId && it.status === 'in_progress' && it.number < minIpNumber) {
      const cleaned = scrubAll(it.title);
      if (isUsableTaskTitle(cleaned)) {
        minIpNumber = it.number;
        inProgressTitle = cleaned;
      }
    }
  }

  const bot = safeGet(snapshot.bots, botId);
  if (bot) {
    bot.groups = [...groups].sort((a, b) => a.localeCompare(b));
    if (homeChatId !== null) {
      bot.homeChatId = homeChatId;
    }
    if (latestAt !== null && (bot.lastActivityAt === null || latestAt > bot.lastActivityAt)) {
      bot.lastActivityAt = latestAt;
    }
    if (bot.needsYouCount === 0) {
      if (inProgressTitle !== null) {
        bot.currentTaskTitle = inProgressTitle;
      } else if (bot.currentTaskTitle === null || !isUsableTaskTitle(bot.currentTaskTitle)) {
        bot.currentTaskTitle = bestTitle;
      }
    }
  }
}

function isClosedItemStatus(status: string): boolean {
  return status === 'done' || status === 'canceled' || status === 'closed';
}

export const MAX_QUESTION_OPTIONS = 6;
const MAX_OPTION_LABEL_CHARS = 100;
const MAX_OPTION_DETAIL_CHARS = 200;

function sanitizeOptionText(raw: unknown, maxChars: number): string {
  if (typeof raw !== 'string') return '';
  const collapsed = scrubAll(raw)
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (collapsed.length === 0) return '';
  const chars = Array.from(collapsed);
  if (chars.length <= maxChars) return collapsed;
  return `${chars.slice(0, maxChars - 1).join('').trim()}…`;
}

export function sanitizeQuestionOptions(rawOptions: unknown): BotQuestionOption[] {
  if (!Array.isArray(rawOptions)) return [];
  const out: BotQuestionOption[] = [];
  for (const rawOpt of rawOptions) {
    if (out.length >= MAX_QUESTION_OPTIONS) break;
    if (typeof rawOpt === 'string') {
      const label = sanitizeOptionText(rawOpt, MAX_OPTION_LABEL_CHARS);
      if (label.length > 0) {
        out.push({ label });
      }
      continue;
    }
    const obj = asObj(rawOpt);
    if (!obj) continue;
    const rawLabel =
      asStr(obj.label) ?? asStr(obj.title) ?? asStr(obj.text) ?? asStr(obj.value);
    const label = sanitizeOptionText(rawLabel, MAX_OPTION_LABEL_CHARS);
    if (label.length === 0) continue;
    const detail = sanitizeOptionText(
      asStr(obj.detail) ?? asStr(obj.description),
      MAX_OPTION_DETAIL_CHARS
    );
    const opt: BotQuestionOption = { label };
    if (detail.length > 0) {
      opt.detail = detail;
    }
    if (obj.recommended === true) {
      opt.recommended = true;
    }
    out.push(opt);
  }
  return out;
}

export function extractQuestionSummary(
  question: RawObj | null
): [string | null, number, BotQuestionOption[]] {
  if (!question) return [null, 0, []];
  const ask = asObj(question.ask);
  if (ask) {
    const questions = asArray(ask.questions);
    const first = questions.length > 0 ? asObj(questions[0]) : null;
    if (first) {
      const prompt = asStr(first.prompt) ?? '';
      const opts = asArray(first.options);
      const parsedOptions = sanitizeQuestionOptions(opts);
      return [prompt, opts.length, parsedOptions];
    }
  }
  return [asStr(question.text), 0, []];
}

export function applyBotItemsScoped(
  snapshot: WorldSnapshot,
  env: CliEnvelope<unknown>,
  all: boolean
): void {
  applyRuntimeMeta(snapshot, env._meta?.runtimeId ?? null);
  const res = asObj(env.result);
  if (!res) return;

  const resBotId = asStr(res.botId) ?? '';
  const resBotName = asStr(res.botName) ?? '';

  for (const [uid, item] of Object.entries(snapshot.items)) {
    const sameBot =
      (resBotId.length > 0 && item.ownerBotId === resBotId) ||
      (resBotName.length > 0 && item.ownerBotName === resBotName);
    if (!sameBot) continue;
    if (all || !isClosedItemStatus(item.status)) {
      safeDelete(snapshot.items, uid);
    }
  }

  for (const rawItem of asArray(res.items)) {
    const raw = asObj(rawItem);
    if (!raw) continue;
    const uid = asStr(raw.uid);
    if (!uid || !isSafeKey(uid)) continue;

    const owner = asObj(raw.owner);
    const ownerBotIdRaw = owner ? asStr(owner.botId) : null;
    const ownerBotId = ownerBotIdRaw && ownerBotIdRaw.length > 0 ? ownerBotIdRaw : resBotId;
    const ownerBotNameRaw = owner ? asStr(owner.name) : null;
    const ownerBotName =
      ownerBotNameRaw && ownerBotNameRaw.length > 0
        ? scrubAll(ownerBotNameRaw)
        : scrubAll(resBotName);

    const [qPrompt, optsCount, qOptions] = extractQuestionSummary(asObj(raw.question));
    const itemState: BotItemState = {
      uid,
      number: asNum(raw.number) ?? 0,
      ownerBotId,
      ownerBotName,
      title: scrubAll(asStr(raw.title) ?? ''),
      status: asStr(raw.status) ?? 'planned',
      version: asNum(raw.version) ?? 0,
      lastEventId: asStr(raw.lastEventId),
      questionPrompt: qPrompt !== null ? scrubAll(qPrompt) : null,
      questionOptions: qOptions,
      optionsCount: optsCount,
      updatedAt: asNum(raw.updatedAt) ?? asNum(raw.lastActivityAt),
    };
    safeSet(snapshot.items, uid, itemState);
  }

  recomputeBotStatuses(snapshot, null);
}

export function extractSessionIdFromRef(reference: string): string | null {
  if (reference.startsWith('structured-agent-session-')) {
    const rest = reference.slice('structured-agent-session-'.length);
    const colon = rest.indexOf(':');
    const id = colon >= 0 ? rest.slice(0, colon) : rest;
    return id.length > 0 ? id : null;
  }
  if (reference.startsWith('orca_session_id:')) {
    const rest = reference.slice('orca_session_id:'.length);
    return rest.length > 0 ? rest : null;
  }
  return null;
}

function resolveBotByLink(
  reference: string,
  paneToBot: Map<string, string>,
  sessionToBot: Map<string, string>
): string | null {
  const byPane = paneToBot.get(reference);
  if (byPane) return byPane;
  const sid = extractSessionIdFromRef(reference);
  if (sid) {
    const bySession = sessionToBot.get(sid);
    if (bySession) return bySession;
  }
  return sessionToBot.get(reference) ?? null;
}

function registerParentAgentLinks(
  agent: RawObj,
  botName: string,
  paneToBot: Map<string, string>,
  sessionToBot: Map<string, string>
): void {
  const pk = asStr(agent.paneKey);
  if (pk && pk.length > 0) {
    paneToBot.set(pk, botName);
    const sid = extractSessionIdFromRef(pk);
    if (sid) sessionToBot.set(sid, botName);
  }
  const orcaSid = asStr(agent.orcaSessionId);
  if (orcaSid && orcaSid.length > 0) {
    sessionToBot.set(orcaSid, botName);
  }
  const addr = asStr(agent.address);
  if (addr) {
    const sid = extractSessionIdFromRef(addr);
    if (sid) sessionToBot.set(sid, botName);
  }
}

function resolveChildParentBot(
  wt: RawObj,
  agent: RawObj,
  paneToBot: Map<string, string>,
  sessionToBot: Map<string, string>
): string | null {
  const wtBot = asStr(wt.bot);
  if (wtBot) return wtBot;
  const parentPane = asStr(agent.parentPaneKey);
  if (parentPane && parentPane.length > 0) {
    const found = resolveBotByLink(parentPane, paneToBot, sessionToBot);
    if (found) return found;
  }
  const activity = asObj(agent.activity);
  const childOf = activity ? asStr(activity.childOf) : null;
  if (childOf && childOf.length > 0) {
    const found = resolveBotByLink(childOf, paneToBot, sessionToBot);
    if (found) return found;
  }
  return null;
}

export function applyWorktreePs(snapshot: WorldSnapshot, env: CliEnvelope<unknown>): void {
  applyRuntimeMeta(snapshot, env._meta?.runtimeId ?? null);
  const res = asObj(env.result);
  if (!res) return;

  const otherBots = asArray(res.otherBots);
  if (otherBots.length > 0) {
    mergeRawBots(snapshot, otherBots, false);
  }

  const worktreeBot = new Map<string, string>();
  const paneToBot = new Map<string, string>();
  const sessionToBot = new Map<string, string>();

  for (const [chatId, botId] of Object.entries(snapshot.chatIndex)) {
    const bot = safeGet(snapshot.bots, botId);
    if (bot) {
      sessionToBot.set(chatId, bot.name);
    }
  }

  const parentAgentsByBot = new Map<string, RawObj[]>();
  const childAgentsByTerm = new Map<string, { wt: RawObj; agent: RawObj }>();

  for (const rawWt of asArray(res.worktrees)) {
    const wt = asObj(rawWt);
    if (!wt) continue;
    const worktreeId = asStr(wt.worktreeId);
    const wtBot = asStr(wt.bot);
    const botHome = asBool(wt.botHome);
    if (worktreeId && wtBot) {
      worktreeBot.set(worktreeId, wtBot);
    }

    for (const rawAgent of asArray(wt.agents)) {
      const agent = asObj(rawAgent);
      if (!agent) continue;

      if (botHome && isParentBotAgent(agent)) {
        if (wtBot) {
          const list = parentAgentsByBot.get(wtBot) ?? [];
          list.push(agent);
          parentAgentsByBot.set(wtBot, list);
          registerParentAgentLinks(agent, wtBot, paneToBot, sessionToBot);
        }
      } else if (isChildWorkerAgent(agent)) {
        const addr = asStr(agent.address);
        if (addr) {
          childAgentsByTerm.set(addr, { wt, agent });
        }
      } else if (botHome && wtBot) {
        const list = parentAgentsByBot.get(wtBot) ?? [];
        list.push(agent);
        parentAgentsByBot.set(wtBot, list);
        registerParentAgentLinks(agent, wtBot, paneToBot, sessionToBot);
      }
    }
  }

  for (const worker of Object.values(snapshot.workers)) {
    if (worker.parentBotName === null && worker.worktreeId !== null) {
      const bName = worktreeBot.get(worker.worktreeId);
      if (bName) worker.parentBotName = bName;
    }
    if (worker.terminalHandle !== null) {
      const childEntry = childAgentsByTerm.get(worker.terminalHandle);
      if (childEntry) {
        const { wt, agent } = childEntry;
        if (worker.parentBotName === null) {
          worker.parentBotName = resolveChildParentBot(wt, agent, paneToBot, sessionToBot);
        }
        const toolName = asStr(agent.toolName);
        if (toolName !== null) {
          worker.toolName = scrubAll(toolName);
        }
        const actObj = asObj(agent.activity);
        const title =
          asStr(agent.taskTitle) ??
          asStr(agent.displayName) ??
          (actObj ? asStr(actObj.title) : null) ??
          asStr(agent.conversationName);
        if (title !== null) {
          worker.taskTitle = scrubAll(title);
        }
        const agentState = asStr(agent.state);
        if (agentState && agentState.length > 0) {
          worker.activity = scrubAll(agentState);
        }
        const updatedAt = asNum(agent.updatedAt);
        if (updatedAt !== null) {
          worker.updatedAt = updatedAt;
        }
      }
    }
  }

  resolveWorkerParents(snapshot);
  recomputeBotStatuses(snapshot, parentAgentsByBot);
}

export function applyWorkerList(snapshot: WorldSnapshot, env: CliEnvelope<unknown>): void {
  applyRuntimeMeta(snapshot, env._meta?.runtimeId ?? null);
  const res = asObj(env.result);
  if (!res) return;

  for (const rawW of asArray(res.workers)) {
    const raw = asObj(rawW);
    if (!raw) continue;
    const dispatchId = asStr(raw.dispatchId);
    if (!dispatchId || !isSafeKey(dispatchId)) continue;

    const proj = asObj(raw.projection);
    const prov = proj ? asObj(proj.provider) : null;
    const ws = proj ? asObj(proj.workspace) : null;
    const stage = proj ? asObj(proj.stage) : null;
    const livenessObj = proj ? asObj(proj.liveness) : null;
    const evidence = proj ? asObj(proj.evidence) : null;
    const resource = asObj(raw.resource);

    const provider = prov && asStr(prov.id) ? scrubAll(String(prov.id)) : 'unknown';
    const modelRaw = prov ? asStr(prov.model) : null;
    const model = modelRaw ? scrubAll(modelRaw) : null;
    const worktreeId =
      (resource ? asStr(resource.worktreeId) : null) ?? (ws ? asStr(ws.id) : null);
    const terminalHandle =
      asStr(raw.agentTerminalHandle) ?? (resource ? asStr(resource.terminalHandle) : null);

    const verdict = livenessObj ? asStr(livenessObj.verdict) : null;
    const liveness: WorkerLiveness =
      verdict === 'live' ? 'Live' : verdict === 'exited' ? 'Exited' : 'Unverifiable';

    const workerState = asStr(raw.workerState) ?? '';
    const dispatchStatus = asStr(raw.dispatchStatus) ?? '';
    const actRaw = stage ? asStr(stage.activity) : null;
    const activity = actRaw ? scrubAll(actRaw) : scrubAll(workerState);
    const updatedAt =
      (evidence ? asNum(evidence.lastObservedAt) : null) ??
      (livenessObj ? asNum(livenessObj.observedAt) : null);

    const existing = safeGet(snapshot.workers, dispatchId);
    const state: WorkerState = {
      dispatchId,
      taskId: asStr(raw.taskId),
      runId: asStr(raw.runId),
      parentBotId: existing ? existing.parentBotId : null,
      parentBotName: existing ? existing.parentBotName : null,
      provider,
      model,
      workerState,
      dispatchStatus,
      terminalState: asStr(raw.terminalState),
      terminalHandle,
      worktreeId,
      liveness,
      activity,
      toolName: existing ? existing.toolName : null,
      taskTitle: existing ? existing.taskTitle : null,
      updatedAt,
    };
    safeSet(snapshot.workers, dispatchId, state);
  }

  resolveWorkerParents(snapshot);
  recomputeBotStatuses(snapshot, null);
}

export function applyRunList(snapshot: WorldSnapshot, env: CliEnvelope<unknown>): void {
  applyRuntimeMeta(snapshot, env._meta?.runtimeId ?? null);
  const res = asObj(env.result);
  if (!res) return;

  for (const rawR of asArray(res.runs)) {
    const run = asObj(rawR);
    if (!run) continue;
    const runId = asStr(run.id);
    const coord = asStr(run.coordinatorHandle);
    if (!runId || !coord || !isSafeKey(runId)) continue;
    const chatId = extractSessionIdFromRef(coord);
    if (!chatId) continue;
    const botId = safeGet(snapshot.chatIndex, chatId);
    if (botId) {
      safeSet(snapshot.runBotIndex, runId, botId);
    }
  }

  resolveWorkerParents(snapshot);
}

export function applyInbox(snapshot: WorldSnapshot, env: CliEnvelope<unknown>): void {
  applyInboxWithMode(snapshot, env, false);
}

export function applyInboxBackfill(snapshot: WorldSnapshot, env: CliEnvelope<unknown>): void {
  applyInboxWithMode(snapshot, env, true);
}

function recordSeenId(snapshot: WorldSnapshot, id: string): void {
  if (!snapshot.inboxCursor.seenIds.includes(id)) {
    while (snapshot.inboxCursor.seenIds.length >= MAX_SEEN_IDS) {
      snapshot.inboxCursor.seenIds.shift();
    }
    snapshot.inboxCursor.seenIds.push(id);
  }
}

function applyInboxWithMode(
  snapshot: WorldSnapshot,
  env: CliEnvelope<unknown>,
  isBackfill: boolean
): void {
  applyRuntimeMeta(snapshot, env._meta?.runtimeId ?? null);
  const res = asObj(env.result);
  if (!res) return;

  const msgs: RawObj[] = [];
  for (const item of asArray(res.messages)) {
    const obj = asObj(item);
    if (obj && asStr(obj.id)) msgs.push(obj);
  }
  msgs.sort((a, b) => (asNum(a.sequence) ?? 0) - (asNum(b.sequence) ?? 0));

  const prevSeq = snapshot.inboxCursor.lastSequence;
  let minSeq: number | null = null;
  let maxSeq = 0;
  for (const m of msgs) {
    const s = asNum(m.sequence);
    if (s !== null) {
      if (minSeq === null || s < minSeq) minSeq = s;
      if (s > maxSeq) maxSeq = s;
    }
  }

  const hasGap = prevSeq > 0 && minSeq !== null && minSeq > prevSeq + 1;
  const holdCursorOnGap = !isBackfill && hasGap;
  snapshot.inboxCursor.needsBackfill = holdCursorOnGap;

  const termToBot = new Map<string, string>();
  const dispatchToBot = new Map<string, string>();

  for (const m of msgs) {
    const msgId = String(m.id);
    const fromRaw = asStr(m.from_handle) ?? asStr(m.fromHandle) ?? '';
    const toRaw = asStr(m.to_handle) ?? asStr(m.toHandle) ?? '';
    const runId = asStr(m.run_id) ?? asStr(m.runId);

    const fromSid = extractSessionIdFromRef(fromRaw);
    const fromBot = fromSid ? (safeGet(snapshot.chatIndex, fromSid) ?? null) : null;
    const toSid = extractSessionIdFromRef(toRaw);
    const toBot = toSid ? (safeGet(snapshot.chatIndex, toSid) ?? null) : null;

    if (runId && runId.length > 0 && runId !== 'run_unbound') {
      const bId = fromBot ?? toBot;
      if (bId && isSafeKey(runId) && !safeGet(snapshot.runBotIndex, runId)) {
        safeSet(snapshot.runBotIndex, runId, bId);
      }
    }

    if (toBot) {
      if (fromRaw.startsWith('term_')) {
        termToBot.set(fromRaw, toBot);
      } else if (fromRaw.startsWith('dispatch:')) {
        dispatchToBot.set(fromRaw.slice('dispatch:'.length), toBot);
      }
    }
    if (fromBot) {
      if (toRaw.startsWith('term_')) {
        termToBot.set(toRaw, fromBot);
      } else if (toRaw.startsWith('dispatch:')) {
        dispatchToBot.set(toRaw.slice('dispatch:'.length), fromBot);
      }
    }

    const seq = asNum(m.sequence) ?? 0;
    if (seq < prevSeq || snapshot.inboxCursor.seenIds.includes(msgId)) {
      continue;
    }

    recordSeenId(snapshot, msgId);
    if (!holdCursorOnGap && seq > snapshot.inboxCursor.lastSequence) {
      snapshot.inboxCursor.lastSequence = seq;
    }

    const payloadStr = asStr(m.payload);
    const msg: InboxMessage = {
      id: msgId,
      sequence: seq,
      msgType: asStr(m.type) ?? asStr(m.msgType) ?? '',
      fromHandle: scrubAll(fromRaw),
      toHandle: scrubAll(toRaw),
      runId,
      subject: scrubAll(asStr(m.subject) ?? ''),
      body: scrubAll(asStr(m.body) ?? ''),
      createdAt: asStr(m.created_at) ?? asStr(m.createdAt),
      threadId: asStr(m.thread_id) ?? asStr(m.threadId),
      payload: payloadStr !== null ? scrubAll(payloadStr) : null,
    };
    snapshot.recentMessages.push(msg);
  }

  if (!holdCursorOnGap && maxSeq > snapshot.inboxCursor.lastSequence) {
    snapshot.inboxCursor.lastSequence = maxSeq;
  }

  snapshot.recentMessages.sort((a, b) => a.sequence - b.sequence);
  const MAX_RECENT_MESSAGES = 60;
  if (snapshot.recentMessages.length > MAX_RECENT_MESSAGES) {
    snapshot.recentMessages.splice(0, snapshot.recentMessages.length - MAX_RECENT_MESSAGES);
  }

  let parentUpdated = false;
  for (const worker of Object.values(snapshot.workers)) {
    if (worker.parentBotId === null) {
      const byDispatch = dispatchToBot.get(worker.dispatchId);
      if (byDispatch) {
        worker.parentBotId = byDispatch;
        parentUpdated = true;
      } else if (worker.terminalHandle) {
        const byTerm = termToBot.get(worker.terminalHandle);
        if (byTerm) {
          worker.parentBotId = byTerm;
          parentUpdated = true;
        }
      }
    }
  }

  if (parentUpdated || Object.keys(snapshot.runBotIndex).length > 0) {
    resolveWorkerParents(snapshot);
    recomputeBotStatuses(snapshot, null);
  }
}

export function applyAutomations(
  snapshot: WorldSnapshot,
  listEnv: CliEnvelope<unknown> | null,
  runsEnv: CliEnvelope<unknown> | null
): void {
  if (listEnv) {
    applyRuntimeMeta(snapshot, listEnv._meta?.runtimeId ?? null);
    const res = asObj(listEnv.result);
    if (res && Array.isArray(res.automations)) {
      const seenIds = new Set<string>();
      for (const rawA of res.automations) {
        const auto = asObj(rawA);
        if (!auto) continue;
        const id = asStr(auto.id);
        if (!id || !isSafeKey(id)) continue;
        seenIds.add(id);

        const botObj = asObj(auto.bot);
        const botId = botObj ? asStr(botObj.botId) : null;
        const name = scrubAll(asStr(auto.name) ?? id);
        const enabled = asBool(auto.enabled);
        const lastRunAt = asNum(auto.lastRunAt);

        let entry = safeGet(snapshot.automations, id);
        if (!entry) {
          entry = {
            id,
            name,
            botId,
            enabled,
            lastRunStatus: null,
            lastRunAt,
            lastError: null,
            lastRunId: null,
            lastRunNoReply: false,
          };
          safeSet(snapshot.automations, id, entry);
        } else {
          entry.name = name;
          entry.enabled = enabled;
          if (botObj) entry.botId = botId;
          if (lastRunAt !== null) entry.lastRunAt = lastRunAt;
        }
      }
      if (listEnv.ok) {
        for (const existingId of Object.keys(snapshot.automations)) {
          if (!seenIds.has(existingId)) {
            safeDelete(snapshot.automations, existingId);
          }
        }
      }
    }
  }

  if (runsEnv) {
    applyRuntimeMeta(snapshot, runsEnv._meta?.runtimeId ?? null);
    const res = asObj(runsEnv.result);
    if (res) {
      const newestStartedByAuto = new Map<string, number>();
      for (const rawR of asArray(res.runs)) {
        const run = asObj(rawR);
        if (!run) continue;
        const autoId = asStr(run.automationId);
        const runId = asStr(run.id);
        if (!autoId || !runId) continue;

        const auto = safeGet(snapshot.automations, autoId);
        if (!auto) continue;

        const startedAt = asNum(run.startedAt);
        const runTs = startedAt ?? 0;
        const prevSeen = newestStartedByAuto.get(autoId);
        const isNewer = prevSeen === undefined || runTs >= prevSeen;
        if (isNewer) {
          newestStartedByAuto.set(autoId, runTs);
          auto.lastRunStatus = asStr(run.status);
          if (startedAt !== null) auto.lastRunAt = startedAt;
          const errStr = asStr(run.error);
          auto.lastError = errStr !== null ? scrubAll(errStr) : null;
          auto.lastRunId = runId;
          const outputSnap = asObj(run.outputSnapshot);
          const content = outputSnap ? asStr(outputSnap.content) : null;
          auto.lastRunNoReply = content !== null && content.trim() === 'NO_REPLY';
        }
      }
    }
  }
}

export function resolveWorkerParents(snapshot: WorldSnapshot): void {
  const nameToId = new Map<string, string>();
  const idToName = new Map<string, string>();
  for (const bot of Object.values(snapshot.bots)) {
    nameToId.set(bot.name, bot.id);
    idToName.set(bot.id, bot.name);
  }

  const runToBot = new Map<string, [string, string]>();

  for (const worker of Object.values(snapshot.workers)) {
    if (worker.parentBotId === null && worker.runId && worker.runId !== 'run_unbound') {
      const bid = safeGet(snapshot.runBotIndex, worker.runId);
      if (bid) worker.parentBotId = bid;
    }
    if (worker.parentBotId === null && worker.parentBotName !== null) {
      const bid = nameToId.get(worker.parentBotName);
      if (bid) worker.parentBotId = bid;
    }
    if (worker.parentBotName === null && worker.parentBotId !== null) {
      const bname = idToName.get(worker.parentBotId);
      if (bname) worker.parentBotName = bname;
    }
    if (
      worker.runId &&
      worker.runId !== 'run_unbound' &&
      worker.parentBotId &&
      worker.parentBotName &&
      !runToBot.has(worker.runId)
    ) {
      runToBot.set(worker.runId, [worker.parentBotId, worker.parentBotName]);
    }
  }

  for (const worker of Object.values(snapshot.workers)) {
    if (worker.parentBotId === null && worker.runId) {
      const pair = runToBot.get(worker.runId);
      if (pair) {
        worker.parentBotId = pair[0];
        worker.parentBotName = pair[1];
      }
    }
  }
}

export function recomputeBotStatuses(
  snapshot: WorldSnapshot,
  parentAgentsByBot: Map<string, RawObj[]> | null
): void {
  const workerCounts = new Map<string, number>();
  for (const worker of Object.values(snapshot.workers)) {
    if (isWorkerActive(worker) && worker.parentBotId !== null) {
      workerCounts.set(worker.parentBotId, (workerCounts.get(worker.parentBotId) ?? 0) + 1);
    }
  }

  const needsYouByBot = new Map<
    string,
    { count: number; prompt: string | null; title: string | null; optionsCount: number }
  >();
  const inProgressTitleByBot = new Map<string, { number: number; title: string }>();

  for (const item of Object.values(snapshot.items)) {
    if (item.status === 'needs_you') {
      const existing = needsYouByBot.get(item.ownerBotId) ?? {
        count: 0,
        prompt: null,
        title: null,
        optionsCount: 0,
      };
      existing.count += 1;
      if (existing.prompt === null) {
        existing.prompt = item.questionPrompt ?? item.title;
        existing.title = scrubAll(`#${item.number} ${item.title}`);
        existing.optionsCount = item.optionsCount;
      } else if (existing.optionsCount === 0 && item.optionsCount > 0) {
        existing.optionsCount = item.optionsCount;
      }
      needsYouByBot.set(item.ownerBotId, existing);
    } else if (item.status === 'in_progress' && isUsableTaskTitle(item.title)) {
      const prev = inProgressTitleByBot.get(item.ownerBotId);
      if (!prev || item.number < prev.number) {
        inProgressTitleByBot.set(item.ownerBotId, { number: item.number, title: item.title });
      }
    }
  }

  for (const bot of Object.values(snapshot.bots)) {
    bot.activeWorkerCount = workerCounts.get(bot.id) ?? 0;
    const ny = needsYouByBot.get(bot.id) ?? {
      count: 0,
      prompt: null,
      title: null,
      optionsCount: 0,
    };
    bot.needsYouCount = ny.count;

    if (bot.currentTaskTitle !== null && !isUsableTaskTitle(bot.currentTaskTitle)) {
      bot.currentTaskTitle = null;
    }

    if (bot.paused) {
      bot.status = { kind: 'Paused' };
      continue;
    }

    if (parentAgentsByBot) {
      const agents = parentAgentsByBot.get(bot.name);
      if (agents) {
        const sortedAgents = [...agents].sort(
          (a, b) => (asNum(b.updatedAt) ?? 0) - (asNum(a.updatedAt) ?? 0)
        );
        let bestStatus: BotActivityStatus = { kind: 'Idle' };
        let bestTool: string | null = null;
        let bestTitle: string | null = null;
        let bestUpdated: number | null = bot.lastActivityAt;

        for (const agent of sortedAgents) {
          const ts = asNum(agent.updatedAt);
          if (ts !== null && (bestUpdated === null || ts > bestUpdated)) {
            bestUpdated = ts;
          }
          const actObj = asObj(agent.activity);
          const t = asStr(agent.taskTitle) ?? (actObj ? asStr(actObj.title) : null);
          if (bestTitle === null && t && isUsableTaskTitle(t)) {
            bestTitle = scrubAll(t);
          }
          const state = asStr(agent.state) ?? '';
          if (state === 'blocked' && bestStatus.kind !== 'Blocked') {
            bestStatus = { kind: 'Blocked', reason: null };
          } else if (
            state === 'working' &&
            bestStatus.kind !== 'Blocked' &&
            bestStatus.kind !== 'Working'
          ) {
            const rawTool = asStr(agent.toolName);
            bestTool = rawTool !== null ? scrubAll(rawTool) : null;
            bestStatus = { kind: 'Working', tool: bestTool };
          } else if (state === 'waiting' && bestStatus.kind === 'Idle') {
            bestStatus = { kind: 'WaitingAnswer' };
          }
        }

        if (bestStatus.kind === 'Idle' && sortedAgents[0] && asBool(sortedAgents[0].interrupted)) {
          bestStatus = { kind: 'Error', message: 'Interrupted' };
        }

        bot.lastActivityAt = bestUpdated;
        bot.currentTool = bestTool;
        if (bestTitle !== null) {
          bot.currentTaskTitle = bestTitle;
        }
        bot.status = bestStatus;
      }
    }

    if (ny.count > 0) {
      bot.status = {
        kind: 'NeedsOwner',
        count: ny.count,
        prompt: ny.prompt,
        optionsCount: ny.optionsCount,
      };
      if (ny.title !== null) {
        bot.currentTaskTitle = ny.title;
      }
    } else {
      if (bot.status.kind === 'NeedsOwner') {
        bot.status = { kind: 'Idle' };
      }
      const ip = inProgressTitleByBot.get(bot.id);
      if (ip) {
        bot.currentTaskTitle = ip.title;
      }
    }
  }
}

export function pruneSnapshotState(snapshot: WorldSnapshot, nowMs: number = Date.now()): void {
  const hasBots = Object.keys(snapshot.bots).length > 0;

  // 1. Prune chatIndex (remove deleted bots & cap size)
  const chatEntries = Object.entries(snapshot.chatIndex).filter(
    ([chatId, botId]) => isSafeKey(chatId) && (!hasBots || Object.hasOwn(snapshot.bots, botId))
  );
  if (chatEntries.length > MAX_CHAT_INDEX || chatEntries.length !== Object.keys(snapshot.chatIndex).length) {
    const kept = chatEntries.slice(-MAX_CHAT_INDEX);
    const nextChatIndex: Record<string, string> = {};
    for (const [k, v] of kept) safeSet(nextChatIndex, k, v);
    snapshot.chatIndex = nextChatIndex;
  }

  // 2. Prune runBotIndex (remove deleted bots & cap size)
  const runEntries = Object.entries(snapshot.runBotIndex).filter(
    ([runId, botId]) => isSafeKey(runId) && (!hasBots || Object.hasOwn(snapshot.bots, botId))
  );
  if (runEntries.length > MAX_RUN_BOT_INDEX || runEntries.length !== Object.keys(snapshot.runBotIndex).length) {
    const kept = runEntries.slice(-MAX_RUN_BOT_INDEX);
    const nextRunIndex: Record<string, string> = {};
    for (const [k, v] of kept) safeSet(nextRunIndex, k, v);
    snapshot.runBotIndex = nextRunIndex;
  }

  // 3. Prune terminated/released workers beyond retention or cap
  const terminated: Array<[string, WorkerState]> = [];
  for (const [id, w] of Object.entries(snapshot.workers)) {
    if (!isWorkerVisibleOnStage(w)) {
      if (w.updatedAt !== null && nowMs - w.updatedAt > WORKER_RETENTION_MS) {
        safeDelete(snapshot.workers, id);
      } else {
        terminated.push([id, w]);
      }
    }
  }
  if (terminated.length > MAX_TERMINATED_WORKERS) {
    terminated.sort((a, b) => (b[1].updatedAt ?? nowMs) - (a[1].updatedAt ?? nowMs));
    for (let i = MAX_TERMINATED_WORKERS; i < terminated.length; i++) {
      safeDelete(snapshot.workers, terminated[i][0]);
    }
  }

  // 4. Prune closed items beyond retention or cap
  const closedItems: Array<[string, BotItemState]> = [];
  for (const [uid, it] of Object.entries(snapshot.items)) {
    if (isClosedItemStatus(it.status)) {
      if (it.updatedAt !== null && nowMs - it.updatedAt > CLOSED_ITEM_RETENTION_MS) {
        safeDelete(snapshot.items, uid);
      } else {
        closedItems.push([uid, it]);
      }
    }
  }
  if (closedItems.length > MAX_CLOSED_ITEMS) {
    closedItems.sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0) || b[1].number - a[1].number);
    for (let i = MAX_CLOSED_ITEMS; i < closedItems.length; i++) {
      safeDelete(snapshot.items, closedItems[i][0]);
    }
  }

  // 5. Ensure seenIds stays capped
  if (snapshot.inboxCursor.seenIds.length > MAX_SEEN_IDS) {
    snapshot.inboxCursor.seenIds.splice(0, snapshot.inboxCursor.seenIds.length - MAX_SEEN_IDS);
  }
}
