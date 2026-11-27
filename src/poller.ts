import {
  applyAutomations,
  applyBotChats,
  applyBotItemsScoped,
  applyBotList,
  applyInbox,
  applyInboxBackfill,
  applyRunList,
  applyStatus,
  applyWorkerList,
  applyWorktreePs,
  pruneSnapshotState,
  rebaselineSnapshot,
} from './normalize.ts';
import { MAX_CONCURRENT_CLI, type OrcaClient, OrcaCliError } from './orca-cli.ts';
import { scrubAll } from './redact.ts';
import { type WorldSnapshot, createEmptySnapshot } from './types.ts';

export const FAST_INTERVAL_MS = 2_000;
export const INACTIVE_FAST_INTERVAL_MS = 12_000;
const DEFAULT_MEDIUM_INTERVAL_MS = 5_000;
const SLOW_INTERVAL_MS = 25_000;
const MAX_BACKOFF_SECS = 30;

/**
 * Errors that mean the runtime itself is gone (or the poller was stopped). Only
 * these (plus a failed/unreachable `status`) may take the board Offline; any other
 * failure of a single fast/medium command (timeout, non_zero_exit, invalid_argument,
 * json_error, output_too_large) is tolerated and keeps that command's previous data.
 */
export function isRuntimeFatal(err: unknown): boolean {
  return (
    err instanceof OrcaCliError &&
    (err.code === 'stopped' || err.code === 'runtime_unavailable' || err.code === 'binary_not_found')
  );
}

export function computeSnapshotFingerprint(snapshot: WorldSnapshot): string {
  return JSON.stringify({
    runtime: snapshot.runtime,
    bots: snapshot.bots,
    botOrder: snapshot.botOrder,
    chatIndex: snapshot.chatIndex,
    runBotIndex: snapshot.runBotIndex,
    workers: snapshot.workers,
    items: snapshot.items,
    automations: snapshot.automations,
    inboxCursor: {
      lastSequence: snapshot.inboxCursor.lastSequence,
      needsBackfill: snapshot.inboxCursor.needsBackfill,
    },
    recentMessages: snapshot.recentMessages,
    rebaselineNeeded: snapshot.rebaselineNeeded,
    initialSyncComplete: snapshot.initialSyncComplete,
  });
}

async function runWithConcurrency<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  maxConcurrency: number = MAX_CONCURRENT_CLI
): Promise<Array<PromiseSettledResult<T>>> {
  const results: Array<PromiseSettledResult<T>> = new Array(tasks.length);
  if (tasks.length === 0) return results;
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(maxConcurrency, tasks.length));
  const runners = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const idx = nextIndex++;
      if (idx >= tasks.length) break;
      try {
        const value = await tasks[idx]();
        results[idx] = { status: 'fulfilled', value };
      } catch (reason) {
        results[idx] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

export class PollerSession {
  snapshot: WorldSnapshot = createEmptySnapshot();
  backoffSecs = 2;
  mediumBotCursor = 0;
  slowItemCursor = 0;
  lastFastMs = 0;
  lastMediumMs = 0;
  lastSlowMs = 0;
  elapsedMs = 0;
  slowSynced = false;
  fastSynced = false;
  mediumSynced = false;
  rebaselineSuppressEmpty = false;
  mediumIntervalMs = DEFAULT_MEDIUM_INTERVAL_MS;
  fastIntervalMs = FAST_INTERVAL_MS;
  uiActive = true;
  private lastEmittedFingerprint: string | null = null;
  private hasEmittedInitial = false;

  setPollIntervalSec(sec: number): void {
    const clamped = Math.max(2, Math.min(60, Math.trunc(sec)));
    this.mediumIntervalMs = clamped * 1000;
  }

  setUiActive(active: boolean): void {
    this.uiActive = active;
    this.fastIntervalMs = active ? FAST_INTERVAL_MS : INACTIVE_FAST_INTERVAL_MS;
  }

  isUiActive(): boolean {
    return this.uiActive;
  }

  getFastIntervalMs(): number {
    return this.fastIntervalMs;
  }

  getLatestSnapshot(): WorldSnapshot {
    return this.snapshot;
  }

  prepareDue(): { runSlow: boolean; runFast: boolean; runMedium: boolean } {
    const runSlow = !this.slowSynced || this.elapsedMs - this.lastSlowMs >= SLOW_INTERVAL_MS;
    const runFast = !this.fastSynced || this.elapsedMs - this.lastFastMs >= this.fastIntervalMs;
    const effectiveMediumMs = Math.max(this.mediumIntervalMs, this.fastIntervalMs);
    const runMedium =
      !this.mediumSynced || this.elapsedMs - this.lastMediumMs >= effectiveMediumMs;
    return { runSlow, runFast, runMedium };
  }

  triggerRebaseline(): void {
    rebaselineSnapshot(this.snapshot);
    this.slowSynced = false;
    this.fastSynced = false;
    this.mediumSynced = false;
    this.rebaselineSuppressEmpty = true;
  }

  markRuntimeUnavailable(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.snapshot.runtime.connected = false;
    this.snapshot.runtime.reachable = false;
    this.snapshot.runtime.state = 'unavailable';
    this.snapshot.runtime.errorMessage = scrubAll(msg);
    this.snapshot.initialSyncComplete = false;
  }

  finishTick(
    runtimeUnavailable: boolean,
    anyChanged: boolean,
    nowMs: number = Date.now()
  ): { emitted: WorldSnapshot | null; sleepMs: number } {
    if (runtimeUnavailable) {
      this.snapshot.runtime.retryAfterSecs = this.backoffSecs;
      this.snapshot.initialSyncComplete = false;
      const sleepMs = this.backoffSecs * 1000;
      this.elapsedMs += sleepMs;
      this.backoffSecs = Math.min(MAX_BACKOFF_SECS, this.backoffSecs * 2);
      if (this.rebaselineSuppressEmpty && !this.fastSynced) {
        return { emitted: null, sleepMs };
      }
      this.snapshot.capturedAt = nowMs;
      this.lastEmittedFingerprint = computeSnapshotFingerprint(this.snapshot);
      return { emitted: structuredClone(this.snapshot), sleepMs };
    }

    this.backoffSecs = 2;
    if (this.fastSynced) {
      this.rebaselineSuppressEmpty = false;
    }
    this.snapshot.initialSyncComplete =
      this.slowSynced &&
      this.fastSynced &&
      this.mediumSynced &&
      !this.snapshot.rebaselineNeeded;

    const emitted =
      anyChanged && !(this.rebaselineSuppressEmpty && !this.fastSynced)
        ? (() => {
            this.snapshot.capturedAt = nowMs;
            pruneSnapshotState(this.snapshot, nowMs);
            this.lastEmittedFingerprint = computeSnapshotFingerprint(this.snapshot);
            this.hasEmittedInitial = true;
            return structuredClone(this.snapshot);
          })()
        : null;
    this.elapsedMs += this.fastIntervalMs;
    return { emitted, sleepMs: this.fastIntervalMs };
  }

  async step(
    cli: OrcaClient,
    options?: { forceFull?: boolean; forceFast?: boolean; nowMs?: number }
  ): Promise<{ snapshot: WorldSnapshot | null; sleepMs: number }> {
    const due = this.prepareDue();
    let runSlow = options?.forceFull ? true : due.runSlow;
    let runFast = options?.forceFull || options?.forceFast ? true : due.runFast;
    let runMedium = options?.forceFull ? true : due.runMedium;
    const prevConnected = this.snapshot.runtime.connected;
    const prevInitialSync = this.snapshot.initialSyncComplete;
    let runtimeUnavailable = false;

    if (runSlow) {
      this.lastSlowMs = this.elapsedMs;
      try {
        const rebaselined = await pollSlowTier(cli, this.snapshot, this.slowItemCursor);
        this.slowItemCursor = (this.slowItemCursor + 1) >>> 0;
        if (rebaselined || this.snapshot.rebaselineNeeded) {
          if (this.snapshot.rebaselineNeeded) {
            this.triggerRebaseline();
            try {
              await pollSlowTier(cli, this.snapshot, this.slowItemCursor);
              this.slowSynced = true;
            } catch (err) {
              if (err instanceof OrcaCliError && err.code === 'stopped') throw err;
              runtimeUnavailable = true;
              this.markRuntimeUnavailable(err);
            }
          } else {
            this.slowSynced = true;
            this.fastSynced = false;
            this.mediumSynced = false;
            this.rebaselineSuppressEmpty = true;
          }
          runFast = true;
          runMedium = true;
        } else {
          this.slowSynced = true;
        }
      } catch (err) {
        if (err instanceof OrcaCliError && err.code === 'stopped') throw err;
        runtimeUnavailable = true;
        this.markRuntimeUnavailable(err);
      }
    }

    if (!runtimeUnavailable && runFast) {
      this.lastFastMs = this.elapsedMs;
      try {
        await pollFastTier(cli, this.snapshot);
        if (this.snapshot.rebaselineNeeded) {
          this.triggerRebaseline();
          runMedium = true;
          try {
            await pollSlowTier(cli, this.snapshot, this.slowItemCursor);
            this.slowSynced = true;
            await pollFastTier(cli, this.snapshot);
            this.fastSynced = true;
          } catch (err) {
            if (err instanceof OrcaCliError && err.code === 'stopped') throw err;
            runtimeUnavailable = true;
            this.markRuntimeUnavailable(err);
          }
        } else {
          this.fastSynced = true;
        }
      } catch (err) {
        if (err instanceof OrcaCliError && err.code === 'stopped') throw err;
        runtimeUnavailable = true;
        this.markRuntimeUnavailable(err);
      }
    }

    if (!runtimeUnavailable && runMedium) {
      this.lastMediumMs = this.elapsedMs;
      const fetchAll = !this.mediumSynced;
      try {
        await pollMediumTier(cli, this.snapshot, this.mediumBotCursor, fetchAll);
        this.mediumBotCursor = (this.mediumBotCursor + 1) >>> 0;
        if (this.snapshot.rebaselineNeeded) {
          this.triggerRebaseline();
        } else if (this.slowSynced) {
          this.mediumSynced = true;
        }
      } catch (err) {
        if (err instanceof OrcaCliError && err.code === 'stopped') throw err;
        if (
          err instanceof OrcaCliError &&
          (err.code === 'runtime_unavailable' || err.code === 'binary_not_found')
        ) {
          runtimeUnavailable = true;
          this.markRuntimeUnavailable(err);
        }
      }
    }

    let anyChanged = false;
    if (!runtimeUnavailable) {
      const nextInitialSync =
        this.slowSynced &&
        this.fastSynced &&
        this.mediumSynced &&
        !this.snapshot.rebaselineNeeded;
      this.snapshot.initialSyncComplete = nextInitialSync;
      const nextFingerprint = computeSnapshotFingerprint(this.snapshot);
      anyChanged =
        !this.hasEmittedInitial ||
        Boolean(options?.forceFull) ||
        prevConnected !== this.snapshot.runtime.connected ||
        (!prevInitialSync && nextInitialSync) ||
        nextFingerprint !== this.lastEmittedFingerprint;
    }

    const { emitted, sleepMs } = this.finishTick(
      runtimeUnavailable,
      anyChanged,
      options?.nowMs ?? Date.now()
    );
    return { snapshot: emitted, sleepMs };
  }
}

async function pollSlowTier(
  cli: OrcaClient,
  snapshot: WorldSnapshot,
  botCursor: number
): Promise<boolean> {
  if (cli.isStopped()) throw new OrcaCliError('stopped', 'Poller stopped');
  const status = await cli.status();
  applyStatus(snapshot, status);
  if (!snapshot.runtime.reachable) {
    throw new OrcaCliError(
      'runtime_unavailable',
      snapshot.runtime.errorMessage ?? 'Orca runtime unreachable'
    );
  }

  let rebaselined = false;
  if (snapshot.rebaselineNeeded) {
    rebaselineSnapshot(snapshot);
    rebaselined = true;
  }

  if (cli.isStopped()) throw new OrcaCliError('stopped', 'Poller stopped');
  const [botsRes, runsRes, autoListRes, autoRunsRes] = await Promise.allSettled([
    cli.botList(),
    cli.orchestrationRunList(),
    cli.automationsList(),
    cli.automationsRuns(),
  ]);

  for (const res of [botsRes, runsRes, autoListRes, autoRunsRes]) {
    if (res.status === 'rejected') {
      const err = res.reason;
      if (err instanceof OrcaCliError && err.code === 'stopped') throw err;
    }
  }

  if (botsRes.status === 'fulfilled') {
    applyBotList(snapshot, botsRes.value);
  }
  if (runsRes.status === 'fulfilled') {
    applyRunList(snapshot, runsRes.value);
  }
  const autoList = autoListRes.status === 'fulfilled' ? autoListRes.value : null;
  const autoRuns = autoRunsRes.status === 'fulfilled' ? autoRunsRes.value : null;
  applyAutomations(snapshot, autoList, autoRuns);

  if (cli.isStopped()) throw new OrcaCliError('stopped', 'Poller stopped');
  if (snapshot.botOrder.length > 0) {
    const idx = botCursor % snapshot.botOrder.length;
    const botId = snapshot.botOrder[idx];
    const bot = botId && Object.hasOwn(snapshot.bots, botId) ? snapshot.bots[botId] : undefined;
    if (bot) {
      try {
        const items = await cli.botItemList(bot.name, true, bot.server ?? null);
        applyBotItemsScoped(snapshot, items, true);
      } catch (err) {
        if (err instanceof OrcaCliError && err.code === 'stopped') throw err;
      }
    }
  }

  return rebaselined;
}

async function pollFastTier(cli: OrcaClient, snapshot: WorldSnapshot): Promise<void> {
  if (cli.isStopped()) throw new OrcaCliError('stopped', 'Poller stopped');
  const [inboxRes, workersRes, worktreesRes] = await Promise.allSettled([
    cli.orchestrationInbox(30),
    cli.orchestrationWorkerList(100, null),
    cli.worktreePs('24h'),
  ]);

  // Runtime-level failures (and stop) still propagate; the rest are tolerated
  // per command (the CLI layer already logged them) and keep the previous data.
  for (const res of [inboxRes, workersRes, worktreesRes]) {
    if (res.status === 'rejected' && isRuntimeFatal(res.reason)) {
      throw res.reason;
    }
  }

  if (inboxRes.status === 'fulfilled') {
    applyInbox(snapshot, inboxRes.value);
    if (snapshot.inboxCursor.needsBackfill) {
      if (cli.isStopped()) throw new OrcaCliError('stopped', 'Poller stopped');
      try {
        const fullInbox = await cli.orchestrationInbox(100);
        applyInboxBackfill(snapshot, fullInbox);
      } catch (err) {
        if (isRuntimeFatal(err)) throw err;
      }
    }
  }

  if (workersRes.status === 'fulfilled') {
    const firstWorkers = workersRes.value;
    applyWorkerList(snapshot, firstWorkers);
    let cursor = extractNextWorkerCursor(firstWorkers);
    for (let page = 1; page < 5 && cursor !== null; page++) {
      if (cli.isStopped()) throw new OrcaCliError('stopped', 'Poller stopped');
      let workers: Awaited<ReturnType<OrcaClient['orchestrationWorkerList']>>;
      try {
        workers = await cli.orchestrationWorkerList(100, cursor);
      } catch (err) {
        if (isRuntimeFatal(err)) throw err;
        break;
      }
      applyWorkerList(snapshot, workers);
      cursor = extractNextWorkerCursor(workers);
    }
  }

  if (worktreesRes.status === 'fulfilled') {
    applyWorktreePs(snapshot, worktreesRes.value);
  }

  // Liveness comes from `status` (slow tier); a fast tier where every command
  // failed for non-runtime reasons leaves the runtime fields as they were.
  const anyOk = [inboxRes, workersRes, worktreesRes].some((r) => r.status === 'fulfilled');
  if (anyOk) {
    snapshot.runtime.connected = true;
    snapshot.runtime.reachable = true;
    snapshot.runtime.retryAfterSecs = null;
  }
}

function extractNextWorkerCursor(workers: Awaited<ReturnType<OrcaClient['orchestrationWorkerList']>>): string | null {
  const res =
    workers.result && typeof workers.result === 'object' && !Array.isArray(workers.result)
      ? (workers.result as Record<string, unknown>)
      : null;
  const pageObj =
    res?.page && typeof res.page === 'object' && !Array.isArray(res.page)
      ? (res.page as Record<string, unknown>)
      : null;
  const nextRaw =
    pageObj?.hasMore === true && typeof pageObj.nextCursor === 'string'
      ? pageObj.nextCursor.trim()
      : '';
  if (nextRaw.length === 0 || nextRaw.startsWith('-')) return null;
  return nextRaw;
}

async function pollMediumTier(
  cli: OrcaClient,
  snapshot: WorldSnapshot,
  botCursor: number,
  allOnBoot: boolean
): Promise<void> {
  if (snapshot.botOrder.length === 0) return;

  const targets: Array<{ id: string; name: string; server: string | null }> = [];
  if (allOnBoot) {
    for (const id of snapshot.botOrder) {
      const bot = Object.hasOwn(snapshot.bots, id) ? snapshot.bots[id] : undefined;
      if (bot) targets.push({ id: bot.id, name: bot.name, server: bot.server ?? null });
    }
  } else {
    const len = snapshot.botOrder.length;
    const count = Math.min(2, len);
    for (let offset = 0; offset < count; offset++) {
      const idx = (botCursor * 2 + offset) % len;
      const id = snapshot.botOrder[idx];
      const bot = id && Object.hasOwn(snapshot.bots, id) ? snapshot.bots[id] : undefined;
      if (bot) targets.push({ id: bot.id, name: bot.name, server: bot.server ?? null });
    }
  }

  if (targets.length === 0) return;
  if (cli.isStopped()) throw new OrcaCliError('stopped', 'Poller stopped');

  type BotFetchPair = {
    id: string;
    name: string;
    server: string | null;
    itemsRes: PromiseSettledResult<Awaited<ReturnType<OrcaClient['botItemList']>>>;
    chatsRes: PromiseSettledResult<Awaited<ReturnType<OrcaClient['botChats']>>>;
  };

  const tasks: Array<() => Promise<unknown>> = [];
  for (const t of targets) {
    tasks.push(() => cli.botItemList(t.name, false, t.server));
    tasks.push(() => cli.botChats(t.name, t.server));
  }
  const rawResults = await runWithConcurrency(tasks, MAX_CONCURRENT_CLI);

  const pairs: BotFetchPair[] = [];
  for (let i = 0; i < targets.length; i++) {
    pairs.push({
      id: targets[i].id,
      name: targets[i].name,
      server: targets[i].server,
      itemsRes: rawResults[i * 2] as PromiseSettledResult<Awaited<ReturnType<OrcaClient['botItemList']>>>,
      chatsRes: rawResults[i * 2 + 1] as PromiseSettledResult<Awaited<ReturnType<OrcaClient['botChats']>>>,
    });
  }

  for (const { id: botId, name: botName, server: botServer, itemsRes, chatsRes } of pairs) {
    if (itemsRes.status === 'fulfilled') {
      const items = itemsRes.value;
      const res =
        items.result && typeof items.result === 'object' && !Array.isArray(items.result)
          ? (items.result as Record<string, unknown>)
          : null;
      const rawItems = Array.isArray(res?.items) ? res.items : [];
      const returnedUids = new Set(
        rawItems
          .map((it) =>
            it && typeof it === 'object' && !Array.isArray(it)
              ? (it as Record<string, unknown>).uid
              : undefined
          )
          .filter((u): u is string => typeof u === 'string')
      );
      const hadDisappearedOpen =
        !allOnBoot &&
        Object.values(snapshot.items).some(
          (it) =>
            (it.ownerBotId === botId || it.ownerBotName === botName) &&
            it.status !== 'done' &&
            it.status !== 'canceled' &&
            it.status !== 'closed' &&
            !returnedUids.has(it.uid)
        );
      if (hadDisappearedOpen) {
        try {
          const allItems = await cli.botItemList(botName, true, botServer);
          applyBotItemsScoped(snapshot, allItems, true);
        } catch {
          applyBotItemsScoped(snapshot, items, false);
        }
      } else {
        applyBotItemsScoped(snapshot, items, false);
      }
    } else {
      // e.g. "No bot named X" (bot lives on a remote runtime) or a timeout:
      // keep this bot's previous items instead of failing the whole tier.
      if (isRuntimeFatal(itemsRes.reason)) {
        throw itemsRes.reason;
      }
    }

    if (chatsRes.status === 'fulfilled') {
      applyBotChats(snapshot, chatsRes.value);
    } else {
      if (isRuntimeFatal(chatsRes.reason)) {
        throw chatsRes.reason;
      }
    }
  }
}
