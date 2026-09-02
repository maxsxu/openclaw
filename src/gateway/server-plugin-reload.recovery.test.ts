import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeSessions } from "../agents/tools/transcripts-tool-runtime.js";
import { createTranscriptsTool } from "../agents/tools/transcripts-tool.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { writePersistedInstalledPluginIndexSync } from "../plugins/installed-plugin-index-store-write.js";
import { loadInstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import { activatePluginRegistry } from "../plugins/loader-shared.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createPluginRegistry } from "../plugins/registry.js";
import {
  clearActivePluginRegistry,
  createPluginRegistryOwner,
  disposePluginRegistryInstances,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { startPluginServices, type PluginServicesHandle } from "../plugins/services.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";
import { writeManagedNpmPlugin } from "../plugins/test-helpers/managed-npm-plugin.js";
import type { OpenClawPluginApi } from "../plugins/types.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import type {
  TranscriptOccupancyWatchRequest,
  TranscriptSourceProvider,
  TranscriptStartRequest,
} from "../transcripts/provider-types.js";
import { TranscriptsStore } from "../transcripts/store.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { reloadGatewayPlugins } from "./server-plugin-reload.js";
import { startTranscriptReloadFixtureSidecars } from "./server-plugin-reload.transcripts.test-support.js";
import { createGatewayPluginRuntimeGeneration } from "./server-plugin-runtime-generation.js";
import { GatewayConfigReloadSupersededError } from "./server-reload-contracts.js";

const mocks = vi.hoisted(() => ({
  loadPluginMetadataSnapshot: vi.fn(),
  loadPluginLookUpTable: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
}));
vi.mock("../plugins/plugin-lookup-table.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-lookup-table.js")>()),
  loadPluginLookUpTable: mocks.loadPluginLookUpTable,
}));

// These independent startup tasks do not participate in plugin replacement.
vi.mock("./server-startup-context-cache-prewarm.js", () => ({
  scheduleContextCachePrewarm: () => ({ stop() {} }),
}));
vi.mock("./server-startup-handler-prewarm.js", () => ({
  scheduleGatewayHandlerPrewarm: () => ({ stop() {} }),
}));
vi.mock("../agents/main-session-recovery/main-session-restart-recovery.js", () => ({
  scheduleRestartAbortedMainSessionRecovery: () => undefined,
}));

const cleanups: Array<() => Promise<void>> = [];
const tempDirs: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadPluginMetadataSnapshot.mockReset();
  mocks.loadPluginLookUpTable.mockReset();
  resetPluginRuntimeStateForTest();
  resetGatewayWorkAdmission();
  mocks.loadPluginMetadataSnapshot.mockImplementation(() =>
    Object.assign(
      createPluginMetadataSnapshotFixture({ plugins: [{ id: "first" }, { id: "sibling" }] }),
      { discovery: { candidates: [], diagnostics: [] } },
    ),
  );
});

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
    await clearActivePluginRegistry();
  } finally {
    activeSessions.clear();
    closeOpenClawStateDatabaseForTest();
    clearRuntimeConfigSnapshot();
    resetGatewayWorkAdmission();
    clearPluginMetadataLifecycleCaches();
    cleanupTrackedTempDirs(tempDirs);
  }
});

async function createRecoveryFixture(
  options: {
    config?: OpenClawConfig;
    register?: (api: OpenClawPluginApi, owner: "first" | "sibling") => void;
    abortOnCandidateStart?: boolean;
    prepareAttached?: () => Promise<void>;
    initialStop?: () => Promise<void>;
    beforePublish?: () => Promise<void>;
    afterPublish?: () => Promise<void>;
    assertInvokerOwned?: () => void;
    candidateStart?: () => void;
    candidateStop?: () => Promise<void>;
    recoveryStart?: () => Promise<void>;
    recoveryStop?: () => Promise<void>;
  } = {},
) {
  let config: OpenClawConfig = options.config ?? {
    plugins: { allow: ["first", "sibling"] },
  };
  setRuntimeConfigSnapshot(config);
  const log = { ...createSubsystemLogger("gateway/plugins"), ...mocks.log };
  const createBuilder = () =>
    createPluginRegistry({
      logger: log,
      runtime: {} as PluginRuntime,
      activateGlobalSideEffects: false,
    });
  const previous = createBuilder();
  let firstStarts = 0;
  let aborted = false;
  const firstStart = vi.fn(async () => {
    firstStarts += 1;
    if (firstStarts > 1) {
      await options.recoveryStart?.();
    }
  });
  const firstStop = vi.fn(async () => {
    if (firstStarts > 1) {
      await options.recoveryStop?.();
    } else {
      await options.initialStop?.();
    }
  });
  const firstRecord = createPluginRecord({ id: "first" });
  previous.registry.plugins.push(firstRecord);
  const firstApi = previous.createApi(firstRecord, { config });
  options.register?.(firstApi, "first");
  firstApi.registerService({
    id: "first",
    start: firstStart,
    stop: firstStop,
  });
  const siblingStart = vi.fn();
  const siblingStop = vi.fn();
  const siblingRecord = createPluginRecord({ id: "sibling" });
  previous.registry.plugins.push(siblingRecord);
  const siblingApi = previous.createApi(siblingRecord, { config });
  options.register?.(siblingApi, "sibling");
  siblingApi.registerService({
    id: "sibling",
    start: siblingStart,
    stop: siblingStop,
  });
  setActivePluginRegistry(previous.registry);
  const registryOwner = createPluginRegistryOwner(previous.registry);
  const initial = await startPluginServices({ registry: previous.registry, config });
  let currentServices: PluginServicesHandle | null = initial;
  const owner = createGatewayPluginRuntimeGeneration({
    getServices: () => currentServices,
    setServices: (handle) => {
      currentServices = handle;
    },
  });
  const candidateStop = vi.fn(async () => await options.candidateStop?.());
  const candidates: ReturnType<typeof createBuilder>[] = [];
  const preparePlugins = ({ cfg }: { cfg: OpenClawConfig }) => {
    const candidate = createBuilder();
    candidates.push(candidate);
    if (cfg.plugins?.entries?.first?.enabled !== false) {
      const record = createPluginRecord({ id: "first" });
      candidate.registry.plugins.push(record);
      const api = candidate.createApi(record, { config: cfg });
      options.register?.(api, "first");
      api.registerService({
        id: "first",
        start: () => {
          aborted = options.abortOnCandidateStart !== false;
          options.candidateStart?.();
        },
        stop: async () => await candidateStop(),
      });
    }
    candidate.registry.plugins.push(siblingRecord);
    candidate.registry.transcriptSourceProviders.push(
      ...previous.registry.transcriptSourceProviders.filter(
        (entry) => entry.pluginId === "sibling",
      ),
    );
    candidate.registry.services.push(
      ...previous.registry.services.filter((entry) => entry.pluginId === "sibling"),
    );
    return {
      pluginRegistry: candidate.registry,
      resolvedConfig: cfg,
      gatewayMethods: [],
      retireGatewayRuntimeBindings: vi.fn(),
    };
  };
  const runtime = {
    pluginRuntime: registryOwner,
    kernel: { pluginRuntimeGeneration: owner },
    runtimeState: { cronState: {}, gatewayLifetimeSidecars: [], postReadySidecars: [] },
    ambientEnvTriggers: "suppress",
    coreGatewayMethodNames: [],
    baseMethods: [],
    channelManager: {
      getPluginCommandCatalogAccounts: () => new Map(),
      setAmbientAutostartSuppressedChannelIds: vi.fn(),
    },
    clients: new Set(),
    broadcast: vi.fn(),
  } as unknown as Parameters<typeof reloadGatewayPlugins>[0]["runtime"];
  cleanups.push(async () => {
    await currentServices?.stop().catch(() => {});
    await initial.stop().catch(() => {});
    await registryOwner.close();
    for (const candidate of candidates) {
      await disposePluginRegistryInstances(candidate.registry, previous.registry);
    }
  });
  const reload = (nextConfig = config) => {
    aborted = false;
    return withPluginRuntimeRegistryScope(registryOwner.registry, () =>
      reloadGatewayPlugins(
        {
          runtime,
          port: 0,
          log,
          loadGatewayPluginBootstrapModule: async () => ({
            prepareGatewayPluginLoad: preparePlugins,
          }),
          prepareAttachedPluginRuntime: async (candidate) => {
            await options.prepareAttached?.();
            return {
              publish: () => {
                activatePluginRegistry(
                  candidate.pluginRegistry,
                  null,
                  "gateway-bindable",
                  undefined,
                  registryOwner.registry,
                );
                registryOwner.publish(candidate.pluginRegistry);
              },
              afterCommit: vi.fn(),
            };
          },
          refreshAttachedGatewayDiscovery: async () => {},
        },
        {
          nextConfig,
          sourceConfig: nextConfig,
          changedPaths: [],
          pluginLifecycle: {
            reason: "reload",
            operationId: "service-recovery",
            pluginIds: ["first"],
          },
          commitRuntime: async (publication) => {
            await options.beforePublish?.();
            publication?.publish();
            config = nextConfig;
            setRuntimeConfigSnapshot(config);
            publication?.afterCommit?.();
            await options.afterPublish?.();
          },
          env: {},
          isAborted: () => aborted,
          assertInvokerOwned: options.assertInvokerOwned,
        },
      ),
    );
  };
  return {
    runtime,
    getConfig: () => config,
    owner,
    registryOwner,
    previousRegistry: previous.registry,
    reload,
    firstStart,
    firstStop,
    siblingStart,
    siblingStop,
    candidateStop,
  };
}

function registerTranscriptFixture(api: OpenClawPluginApi, owner: "first" | "sibling") {
  const watches: TranscriptOccupancyWatchRequest[] = [];
  const captures: TranscriptStartRequest[] = [];
  const unwatch = vi.fn();
  const stop = vi.fn<NonNullable<TranscriptSourceProvider["stop"]>>(async ({ sessionId }) => ({
    ok: true,
    sessionId,
  }));
  api.registerTranscriptSourceProvider({
    id: `${owner}-capture`,
    aliases: [`${owner}-room`, ...(owner === "first" ? ["sibling-capture"] : [])],
    name: owner,
    sourceKinds: ["live-audio"],
    watchOccupancy: async (request) => {
      watches.push(request);
      request.onOccupied();
      return { ok: true, value: { stop: unwatch } };
    },
    start: async (request) => {
      captures.push(request);
      return { ok: true, session: request.session };
    },
    stop,
  });
  return { watches, captures, unwatch, stop };
}

it.each([
  "commit",
  "rollback",
  "after-commit error",
  "stop refused",
  "deferred startup",
  "stop timeout",
  "manual stop",
] as const)(
  "keeps startup transcript capture owned across plugin replacement: %s",
  async (outcome) => {
    const stateDir = makeTrackedTempDir("gateway-transcript-replacement-", tempDirs);
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const entry = (owner: string, channelId = "original-room") => ({
        providerId: owner === "sibling" ? "sibling-capture" : `${owner}-room`,
        guildId: "guild",
        channelId,
        whenOccupied: true,
      });
      const config: OpenClawConfig = {
        plugins: { allow: ["first", "sibling"] },
        transcripts: { autoStart: [entry("first"), entry("sibling")] },
      };
      const providers = {
        first: [] as ReturnType<typeof registerTranscriptFixture>[],
        sibling: [] as ReturnType<typeof registerTranscriptFixture>[],
      };
      const failure = new Error("fixture publication rejected");
      const reject = async () => {
        throw failure;
      };
      const fixture = await createRecoveryFixture({
        config,
        abortOnCandidateStart: false,
        register: (api, owner) => {
          providers[owner].push(registerTranscriptFixture(api, owner));
        },
        ...(outcome === "rollback" ? { beforePublish: reject } : {}),
        ...(outcome === "after-commit error" ? { afterPublish: reject } : {}),
      });
      const startupReady = outcome === "deferred startup" ? createDeferredCore() : undefined;
      const sidecars = await withPluginRuntimeRegistryScope(fixture.registryOwner.registry, () =>
        startTranscriptReloadFixtureSidecars(
          fixture,
          stateDir,
          mocks.log,
          cleanups,
          startupReady ? () => startupReady.promise : undefined,
        ),
      );
      const first = providers.first[0]!;
      const sibling = providers.sibling[0]!;
      const captured = async (
        provider: ReturnType<typeof registerTranscriptFixture>,
        count: number,
      ) => {
        await vi.waitFor(() => {
          expect(provider.captures).toHaveLength(count);
          expect(activeSessions.get(provider.captures[count - 1]!.session.sessionId)?.phase).toBe(
            "active",
          );
        });
        return provider.captures[count - 1]!;
      };
      const acceptedConfig = {
        ...config,
        transcripts: { autoStart: [entry("first", "replacement-room"), entry("sibling")] },
      };
      const stopEntered = createDeferredCore();
      const stopRelease = createDeferredCore();
      let manualStop: Promise<unknown> | undefined;
      let pendingReload: Promise<unknown> | undefined;
      try {
        if (outcome === "deferred startup") {
          expect(first.watches).toHaveLength(0);
          expect(sibling.watches).toHaveLength(0);
          const receipt = await fixture.reload(acceptedConfig);
          expect(receipt).toMatchObject({ runtime: { pluginIds: ["first"] } });
          startupReady!.resolve();
          const current = providers.first[1]!;
          await captured(current, 1);
          await captured(sibling, 1);
          expect(first.watches).toHaveLength(0);
          expect(first.captures).toHaveLength(0);
          expect(current.watches[0]?.cfg).toEqual(acceptedConfig);
          expect(current.watches[0]?.source.channelId).toBe("replacement-room");
          expect(sibling.watches).toHaveLength(1);
          await sidecars.stop();
          expect(activeSessions.size).toBe(0);
          expect(sibling.unwatch).toHaveBeenCalledOnce();
          return;
        }
        const oldCapture = await captured(first, 1);
        const siblingCapture = await captured(sibling, 1);
        const oldOwner = activeSessions.get(oldCapture.session.sessionId);
        const siblingOwner = activeSessions.get(siblingCapture.session.sessionId);
        if (outcome === "stop refused") {
          first.stop.mockResolvedValue({ ok: false, error: "fixture capture still active" });
        }
        const boundedStop = outcome === "stop timeout" || outcome === "manual stop";
        let result: unknown;
        if (boundedStop) {
          vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
          first.stop.mockImplementation(async ({ sessionId }) => {
            stopEntered.resolve();
            await stopRelease.promise;
            return { ok: true, sessionId };
          });
          if (outcome === "manual stop") {
            const tool = createTranscriptsTool({
              config,
              stateDir,
              logger: mocks.log,
              caller: { kind: "operator", source: "local" },
            });
            manualStop = withPluginRuntimeRegistryScope(fixture.registryOwner.registry, () =>
              tool.execute("manual-stop-before-reload", {
                action: "stop",
                sessionId: oldCapture.session.sessionId,
              }),
            ).catch((error: unknown) => error);
            await Promise.race([
              stopEntered.promise,
              manualStop.then(() => expect(first.stop).toHaveBeenCalledOnce()),
            ]);
          }
          let reloadSettled = false;
          pendingReload = fixture
            .reload(acceptedConfig)
            .catch((error: unknown) => error)
            .then((value) => {
              reloadSettled = true;
              return value;
            });
          // An old owner may return before it attempts provider cleanup. Race that
          // result as well as provider entry so the pre-fix test cannot deadlock.
          await Promise.race([
            stopEntered.promise,
            pendingReload.then(() => expect(first.stop).toHaveBeenCalledOnce()),
          ]);
          await vi.advanceTimersByTimeAsync(5_000);
          vi.useRealTimers();
          await vi.waitFor(() => expect(reloadSettled).toBe(true));
          expect(await pendingReload).toMatchObject({
            details: { phase: "drain", committed: false },
          });
          expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
          expect(fixture.firstStop).not.toHaveBeenCalled();
          expect(first.stop).toHaveBeenCalledOnce();
          expect(activeSessions.get(oldCapture.session.sessionId)).toBe(oldOwner);
          expect(oldOwner?.stopping).toBe(true);
          expect(first.watches).toHaveLength(1);
          expect(providers.first[1]!.watches).toHaveLength(0);
          expect(activeSessions.get(siblingCapture.session.sessionId)).toBe(siblingOwner);
          stopRelease.resolve();
          vi.useRealTimers();
          if (manualStop) {
            expect(await manualStop).toMatchObject({
              details: { sessionId: oldCapture.session.sessionId },
            });
          }
          await vi.waitFor(() =>
            expect(activeSessions.get(oldCapture.session.sessionId)).not.toBe(oldOwner),
          );
          result = await fixture.reload(acceptedConfig);
        } else {
          result = await fixture.reload(acceptedConfig).catch((error: unknown) => error);
        }
        if (outcome === "stop refused") {
          expect(result).toMatchObject({ details: { phase: "drain", committed: false } });
          expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
          expect(fixture.firstStop).not.toHaveBeenCalled();
          expect(first.stop).toHaveBeenCalledOnce();
          expect(activeSessions.get(oldCapture.session.sessionId)).toBe(oldOwner);
          expect(oldOwner?.cleanupPending).toBe(true);
          expect(first.watches).toHaveLength(1);
          expect(first.captures).toHaveLength(1);
          expect(providers.first[1]!.watches).toHaveLength(0);
          expect(providers.first[1]!.captures).toHaveLength(0);
          expect(sibling.watches).toHaveLength(1);
          expect(sibling.unwatch).not.toHaveBeenCalled();
          expect(activeSessions.get(siblingCapture.session.sessionId)).toBe(siblingOwner);
          // A new operator request can publish only after this same provider
          // confirms that the previously refused capture cleanup completed.
          first.stop.mockImplementation(async ({ sessionId }) => ({ ok: true, sessionId }));
          result = await fixture.reload(acceptedConfig);
        }
        if (outcome === "commit" || outcome === "stop refused" || boundedStop) {
          expect(result).toMatchObject({ runtime: { pluginIds: ["first"] } });
        } else {
          expect(result).toMatchObject({
            details: { committed: outcome !== "rollback" },
            cause: failure,
          });
        }
        // The returned watcher handle belongs to a real PluginInstance; invoking
        // it after quiescence cannot reach this provider's stop implementation.
        expect(first.unwatch).toHaveBeenCalledOnce();
        expect(first.unwatch.mock.invocationCallOrder[0]).toBeLessThan(
          fixture.firstStop.mock.invocationCallOrder[0]!,
        );
        expect(first.stop).toHaveBeenCalledTimes(outcome === "stop refused" ? 2 : 1);
        const current = outcome === "rollback" ? first : providers.first.at(-1)!;
        const currentCapture = await captured(current, outcome === "rollback" ? 2 : 1);
        expect(current.watches.at(-1)?.source.channelId).toBe(
          outcome === "rollback" ? "original-room" : "replacement-room",
        );
        expect(current.watches.at(-1)?.cfg).toEqual(
          outcome === "rollback" ? config : acceptedConfig,
        );
        expect(sibling.watches).toHaveLength(1);
        expect(sibling.captures).toHaveLength(1);
        expect(sibling.unwatch).not.toHaveBeenCalled();
        expect(sibling.stop).not.toHaveBeenCalled();
        expect(activeSessions.get(siblingCapture.session.sessionId)).toBe(siblingOwner);
        const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        });
        await oldCapture.onUtterance({ text: "stale capture", final: true });
        await currentCapture.onUtterance({ text: "current capture", final: true });
        await siblingCapture.onUtterance({ text: "retained sibling", final: true });
        expect(
          (await store.readUtterancesForSession(oldCapture.session)).map(
            (utterance) => utterance.text,
          ),
        ).not.toContain("stale capture");
        expect(
          (await store.readUtterancesForSession(currentCapture.session)).map(
            (utterance) => utterance.text,
          ),
        ).toEqual(["current capture"]);
        expect(
          (await store.readUtterancesForSession(siblingCapture.session)).map(
            (utterance) => utterance.text,
          ),
        ).toEqual(["retained sibling"]);
        if (outcome === "commit") {
          await fixture.reload({
            ...acceptedConfig,
            plugins: { ...config.plugins, entries: { first: { enabled: false } } },
          });
          expect(current.unwatch).toHaveBeenCalledOnce();
          expect(current.stop).toHaveBeenCalledOnce();
          expect(activeSessions.has(currentCapture.session.sessionId)).toBe(false);
          expect(providers.first).toHaveLength(2);
          expect(current.watches).toHaveLength(1);
          expect(sibling.watches).toHaveLength(1);
          await fixture.reload(acceptedConfig);
          const enabled = providers.first[2]!;
          await captured(enabled, 1);
          expect(enabled.watches[0]?.source.channelId).toBe("replacement-room");
          expect(sibling.watches).toHaveLength(1);
          expect(activeSessions.get(siblingCapture.session.sessionId)).toBe(siblingOwner);
        }
        await sidecars.stop();
        expect(activeSessions.size).toBe(0);
        expect(sibling.unwatch).toHaveBeenCalledOnce();
      } finally {
        stopRelease.resolve();
        startupReady?.resolve();
        vi.useRealTimers();
        await manualStop;
        await pendingReload;
        // Preserve the semantic failure on the old owner, whose stale handle can
        // reject shutdown; afterEach still closes registry and SQLite ownership.
        await sidecars.stop().catch(() => {});
      }
    });
  },
);

describe("Gateway plugin service recovery ownership", () => {
  it.each(["prepare", "drain", "publish", "committed"] as const)(
    "preserves the committed owner when its invoker closes during %s",
    async (boundary) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const failure = new Error("plugin invoker closed");
      let invokerOpen = true;
      const pause = async () => {
        entered.resolve();
        await release.promise;
      };
      const candidateStart = vi.fn();
      const fixture = await createRecoveryFixture({
        abortOnCandidateStart: false,
        candidateStart,
        ...(boundary === "prepare" ? { prepareAttached: pause } : {}),
        ...(boundary === "drain" ? { initialStop: pause } : {}),
        ...(boundary === "publish" ? { beforePublish: pause } : {}),
        ...(boundary === "committed" ? { afterPublish: pause } : {}),
        assertInvokerOwned: () => {
          if (!invokerOpen) {
            throw failure;
          }
        },
      });
      const pending = fixture.reload().catch((error: unknown) => error);
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("plugin reload completed before its pause");
          }),
        ]);
        invokerOpen = false;
        release.resolve();
        const result = await pending;
        if (boundary === "committed") {
          expect(result).toMatchObject({
            runtime: { operationId: "service-recovery", pluginIds: ["first"] },
          });
          expect(fixture.registryOwner.registry).not.toBe(fixture.previousRegistry);
          const previousRecord = fixture.previousRegistry.plugins.find(
            (record) => record.id === "first",
          );
          assert.ok(previousRecord);
          expect(getPluginInstance(previousRecord)?.lifecycle.signal.aborted).toBe(true);
          expect(fixture.firstStart).toHaveBeenCalledOnce();
          expect(fixture.candidateStop).not.toHaveBeenCalled();
        } else {
          expect(result).toMatchObject({
            details: { phase: boundary === "publish" ? "activate" : boundary, committed: false },
            cause: failure,
          });
          expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
          expect(fixture.firstStart).toHaveBeenCalledTimes(boundary === "prepare" ? 1 : 2);
          expect(fixture.candidateStop).toHaveBeenCalledTimes(boundary === "publish" ? 1 : 0);
        }
        expect(candidateStart).toHaveBeenCalledTimes(
          boundary === "publish" || boundary === "committed" ? 1 : 0,
        );
        expect(fixture.siblingStart).toHaveBeenCalledOnce();
        expect(fixture.siblingStop).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await pending;
      }
    },
  );

  it("keeps retained and failed-recovery services owned after recovery startup rejects", async () => {
    const startFailure = new Error("previous service failed to restart");
    const stopFailure = new Error("previous service cleanup failed");
    const fixture = await createRecoveryFixture({
      recoveryStart: async () => {
        throw startFailure;
      },
      recoveryStop: async () => {
        throw stopFailure;
      },
    });
    const failure = await fixture.reload().catch((error: unknown) => error);
    expect(failure).toMatchObject({
      details: { phase: "activate", committed: false },
      cause: {
        errors: [
          expect.any(GatewayConfigReloadSupersededError),
          expect.objectContaining({ errors: expect.arrayContaining([startFailure]) }),
        ],
      },
    });
    expect(fixture.firstStart).toHaveBeenCalledTimes(2);
    expect(fixture.siblingStart).toHaveBeenCalledOnce();
    expect(fixture.siblingStop).not.toHaveBeenCalled();
    const shutdown = await fixture.owner
      .currentServices()!
      .stop({ strict: true, deadlineAtMs: Date.now() + 5_000 })
      .catch((error: unknown) => error);
    expect(shutdown).toMatchObject({
      errors: [expect.objectContaining({ cause: stopFailure })],
    });
    expect(fixture.siblingStop).toHaveBeenCalledOnce();
    expect(fixture.firstStop).toHaveBeenCalledTimes(2);
  });

  it("retains failed candidate cleanup without starting an overlapping old service on later reload", async () => {
    const stopFailure = new Error("candidate service cleanup failed");
    const fixture = await createRecoveryFixture({
      candidateStop: async () => {
        throw stopFailure;
      },
    });
    for (const phase of ["activate", "drain"]) {
      const failure = await fixture.reload().catch((error: unknown) => error);
      expect(fixture.firstStart).toHaveBeenCalledOnce();
      expect(failure).toMatchObject({
        details: { phase, committed: false },
        cause: {
          message: "Plugin replacement failed and its previous instance could not be restored.",
        },
      });
      expect(fixture.siblingStart).toHaveBeenCalledOnce();
      expect(fixture.siblingStop).not.toHaveBeenCalled();
    }
    const shutdown = await fixture.owner
      .currentServices()!
      .stop({ strict: true, deadlineAtMs: Date.now() + 5_000 })
      .catch((error: unknown) => error);
    expect(shutdown).toMatchObject({
      errors: [expect.objectContaining({ cause: stopFailure })],
    });
    expect(fixture.siblingStop).toHaveBeenCalledOnce();
    expect(fixture.candidateStop).toHaveBeenCalledOnce();
  });

  it("publishes retained services before awaited cleanup when admission closes and recovery is skipped", async () => {
    const cleanupEntered = createDeferredCore();
    const cleanupReleased = createDeferredCore();
    const fixture = await createRecoveryFixture({
      candidateStart: markGatewayRestartDraining,
      candidateStop: async () => {
        cleanupEntered.resolve();
        await cleanupReleased.promise;
      },
    });
    const reloading = fixture.reload().catch((error: unknown) => error);
    try {
      await Promise.race([
        cleanupEntered.promise,
        reloading.then((error) => {
          throw error;
        }),
      ]);
      const shuttingDown = fixture.owner.currentServices()!.stop();
      cleanupReleased.resolve();
      const failure = await reloading;
      await shuttingDown;
      expect(failure).toMatchObject({ details: { phase: "activate", committed: false } });
      expect(fixture.firstStart).toHaveBeenCalledOnce();
      expect(fixture.siblingStart).toHaveBeenCalledOnce();
      expect(fixture.siblingStop).toHaveBeenCalledOnce();
      expect(fixture.candidateStop).toHaveBeenCalledOnce();
    } finally {
      cleanupReleased.resolve();
      await reloading;
    }
  });
});

it("loads installed package roots from the durable ledger and refreshes their helpers without restarting siblings", async () => {
  const metadata = await vi.importActual<typeof import("../plugins/plugin-metadata-snapshot.js")>(
    "../plugins/plugin-metadata-snapshot.js",
  );
  const lookup = await vi.importActual<typeof import("../plugins/plugin-lookup-table.js")>(
    "../plugins/plugin-lookup-table.js",
  );
  mocks.loadPluginMetadataSnapshot.mockImplementation(metadata.loadPluginMetadataSnapshot);
  mocks.loadPluginLookUpTable.mockImplementation(lookup.loadPluginLookUpTable);
  const bootstrap = await import("./server-plugin-bootstrap.js");
  const root = makeTrackedTempDir("openclaw-gateway-plugin-ledger-reload", tempDirs);
  const stateDir = path.join(root, "state");
  const workspaceDir = path.join(root, "workspace");
  const env = {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
  };
  const writePackage = (id: string) => {
    const packageDir = writeManagedNpmPlugin({
      stateDir,
      packageName: id,
      pluginId: id,
      version: "1.0.0",
    });
    fs.writeFileSync(
      path.join(packageDir, "openclaw.plugin.json"),
      JSON.stringify({ id, activation: { onStartup: true }, configSchema: { type: "object" } }),
    );
    fs.writeFileSync(path.join(packageDir, "dist", "helper.cjs"), 'module.exports = "A";');
    fs.writeFileSync(
      path.join(packageDir, "dist", "index.js"),
      `const helper = require("./helper.cjs");
const instance = require("node:crypto").randomUUID();
let starts = 0, stops = 0;
module.exports = { id: ${JSON.stringify(id)}, register(api) {
  api.registerService({ id: ${JSON.stringify(id)}, start() { starts++; }, stop() { stops++; } });
  api.registerGatewayMethod(${JSON.stringify(`${id}.probe`)}, ({ respond }) => {
    respond(true, { helper, instance, starts, stops });
  });
} };`,
    );
    return packageDir;
  };
  await withEnvAsync(env, async () => {
    const siblingDir = writePackage("sibling");
    const initialConfig: OpenClawConfig = {
      plugins: {
        allow: ["sibling"],
        entries: { sibling: { enabled: true } },
        load: { paths: [siblingDir] },
        slots: { memory: "none" },
      },
    };
    setRuntimeConfigSnapshot(initialConfig);
    const log = { ...createSubsystemLogger("gateway/plugins"), ...mocks.log };
    const initial = bootstrap.prepareGatewayPluginLoad({
      cfg: initialConfig,
      workspaceDir,
      env,
      log,
      baseMethods: [],
      ambientEnvTriggers: "suppress",
    });
    let currentServices: PluginServicesHandle | null = await startPluginServices({
      registry: initial.pluginRegistry,
      config: initialConfig,
      workspaceDir,
    });
    const owner = createGatewayPluginRuntimeGeneration({
      getServices: () => currentServices,
      setServices: (handle) => {
        currentServices = handle;
      },
    });
    const registryOwner = createPluginRegistryOwner(initial.pluginRegistry, workspaceDir);
    const loaded = [initial];
    cleanups.push(async () => {
      try {
        await currentServices?.stop({ strict: true, deadlineAtMs: Date.now() + 5_000 });
      } finally {
        for (const generation of loaded) {
          generation.retireGatewayRuntimeBindings?.();
        }
        await registryOwner.close();
      }
    });
    const runtime = {
      pluginRuntime: registryOwner,
      pluginWorkspaceDir: workspaceDir,
      kernel: { pluginRuntimeGeneration: owner },
      runtimeState: { cronState: {}, gatewayLifetimeSidecars: [] },
      ambientEnvTriggers: "suppress",
      coreGatewayMethodNames: [],
      baseMethods: [],
      channelManager: {
        getPluginCommandCatalogAccounts: () => new Map(),
        setAmbientAutostartSuppressedChannelIds: vi.fn(),
      },
      clients: new Set(),
      broadcast: vi.fn(),
    } as unknown as Parameters<typeof reloadGatewayPlugins>[0]["runtime"];
    const probe = async (id: string) => {
      const method = `${id}.probe`;
      const respond = vi.fn();
      const handler = runtime.pluginRuntime.registry.gatewayHandlers[method];
      assert.ok(handler, `${method} must be registered`);
      await handler({
        req: { type: "req", id: "ledger-reload", method },
        params: {},
        client: null,
        isWebchatConnect: () => false,
        respond,
        context: {} as GatewayRequestHandlerOptions["context"],
      });
      expect(respond).toHaveBeenCalledExactlyOnceWith(
        true,
        {
          helper: expect.any(String),
          instance: expect.any(String),
          starts: 1,
          stops: 0,
        },
        undefined,
        undefined,
      );
      const response = respond.mock.calls[0];
      assert.ok(response);
      return response[1];
    };
    const sibling = await probe("sibling");
    const siblingRecord = initial.pluginRegistry.plugins.find((record) => record.id === "sibling");
    const siblingHandler = initial.pluginRegistry.gatewayHandlers["sibling.probe"];
    const packageDir = writePackage("installed-probe");
    const config: OpenClawConfig = {
      plugins: {
        ...initialConfig.plugins,
        allow: ["sibling", "installed-probe"],
        entries: { sibling: { enabled: true }, "installed-probe": { enabled: true } },
      },
    };
    // Managed npm roots live outside discovery directories and are owned by the persisted ledger.
    writePersistedInstalledPluginIndexSync(
      loadInstalledPluginIndex({
        config,
        env,
        workspaceDir,
        installRecords: {
          "installed-probe": {
            source: "npm",
            spec: "installed-probe@1.0.0",
            installPath: packageDir,
          },
        },
      }),
      { env },
    );
    const reload = async () =>
      await reloadGatewayPlugins(
        {
          runtime,
          port: 0,
          log,
          loadGatewayPluginBootstrapModule: async () => bootstrap,
          prepareAttachedPluginRuntime: async (candidate) => {
            loaded.push(candidate);
            return {
              publish: () => {
                activatePluginRegistry(
                  candidate.pluginRegistry,
                  null,
                  "gateway-bindable",
                  workspaceDir,
                  runtime.pluginRuntime.registry,
                );
                registryOwner.publish(candidate.pluginRegistry);
              },
              afterCommit: () => {},
            };
          },
          refreshAttachedGatewayDiscovery: async () => {},
        },
        {
          nextConfig: config,
          sourceConfig: config,
          changedPaths: [],
          pluginLifecycle: {
            reason: "reload",
            operationId: "installed-package-reload",
            pluginIds: ["installed-probe"],
          },
          commitRuntime: async (publication) => {
            publication?.publish();
            setRuntimeConfigSnapshot(config);
            publication?.afterCommit?.();
          },
          env,
        },
      );
    await reload();
    const first = await probe("installed-probe");
    expect(first.helper).toBe("A");
    fs.writeFileSync(path.join(packageDir, "dist", "helper.cjs"), 'module.exports = "B";');
    await reload();
    const second = await probe("installed-probe");
    expect(second.helper).toBe("B");
    expect(second.instance).not.toBe(first.instance);
    expect(runtime.pluginRuntime.registry.plugins.find((record) => record.id === "sibling")).toBe(
      siblingRecord,
    );
    expect(runtime.pluginRuntime.registry.gatewayHandlers["sibling.probe"]).toBe(siblingHandler);
    expect(await probe("sibling")).toEqual(sibling);
  });
});
