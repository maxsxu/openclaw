/**
 * Tests gateway plugin lifecycle loading, startup, and shutdown behavior.
 */
import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { markGatewaySigusr1RestartHandled } from "../infra/restart.js";
import { getGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { getFreePort } from "../test-utils/ports.js";
import {
  connectWebchatClient,
  installGatewayTestHooks,
  rpcReq,
  startTestGatewayServer,
} from "./test-helpers.server.js";

// Remove the shared helper's loader mock after its import so these fixtures register real plugins.
vi.doUnmock("../plugins/loader.js");

installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const probeSubscriptions: Array<() => void> = [];
const INSTANCE_BINDING_PROBE_METHOD = "instanceBinding.probe";

type InstanceBindingProbeResult = {
  registryId: number;
  sessionsId: number;
  placementId: number;
};

type InstanceBindingProbeCoordinator = {
  identify: (value: object) => number;
  nextRegistryId: number;
  runtimes: PluginRuntime[];
  serviceStarts: number;
  serviceStops: number;
  serviceStopFailure?: "rejection" | "timeout";
  onLifecycleEvent?: (event: { registryId: number; port: number; kind: "start" | "stop" }) => void;
};

function installInstanceBindingProbeCoordinator(options?: {
  serviceStopFailure?: InstanceBindingProbeCoordinator["serviceStopFailure"];
}) {
  const ids = new WeakMap<object, number>();
  let nextId = 1;
  const coordinator: InstanceBindingProbeCoordinator = {
    identify(value) {
      const existing = ids.get(value);
      if (existing !== undefined) {
        return existing;
      }
      const id = nextId++;
      ids.set(value, id);
      return id;
    },
    nextRegistryId: 1,
    runtimes: [],
    serviceStarts: 0,
    serviceStops: 0,
    ...(options?.serviceStopFailure ? { serviceStopFailure: options.serviceStopFailure } : {}),
  };
  const channelName = `openclaw.test.gatewayInstanceBindingProbe.${randomUUID()}`;
  const probeChannel = channel(channelName);
  const supplyCoordinator = (message: unknown) => {
    (message as { coordinator: InstanceBindingProbeCoordinator }).coordinator = coordinator;
  };
  // Native plugin modules and the test runner need not share a global object.
  probeChannel.subscribe(supplyCoordinator);
  probeSubscriptions.push(() => probeChannel.unsubscribe(supplyCoordinator));
  return { coordinator, channelName };
}

async function requireBoundRuntime(
  runtimes: readonly PluginRuntime[],
  label: string,
): Promise<{ runtime: PluginRuntime }> {
  for (const runtime of runtimes) {
    if (await runtime.gateway.isAvailable()) {
      // Plugin runtimes are proxies. Keep the async result non-thenable so
      // Promise assimilation does not materialize the broad runtime graph.
      return { runtime };
    }
  }
  throw new Error(`${label} Gateway did not register an instance-bound plugin runtime`);
}

function requestInstanceBindingProbe(runtime: PluginRuntime) {
  return runtime.gateway.request<InstanceBindingProbeResult>(
    INSTANCE_BINDING_PROBE_METHOD,
    {},
    { scopes: ["operator.read"] },
  );
}

async function writeInstanceBindingProbePlugin(
  channelName: string,
): Promise<{ bundledRoot: string }> {
  const bundledRoot = tempDirs.make("openclaw-instance-binding-");
  const pluginDir = path.join(bundledRoot, "instance-binding-probe");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    `${JSON.stringify({
      name: "instance-binding-probe",
      type: "commonjs",
      main: "index.js",
      openclaw: { extensions: ["./index.js"] },
      peerDependencies: { openclaw: ">=2026.1.1" },
    })}\n`,
  );
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify({
      id: "instance-binding-probe",
      name: "Startup plugin",
      activation: { onStartup: true },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    })}\n`,
  );
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    `module.exports = {
  id: "instance-binding-probe",
  register(api) {
    const request = {};
    require("node:diagnostics_channel").channel(${JSON.stringify(channelName)}).publish(request);
    const coordinator = request.coordinator;
    const registryId = coordinator.nextRegistryId++;
    coordinator.runtimes.push(api.runtime);
    if (coordinator.onLifecycleEvent) {
      api.on("gateway_start", (_event, context) => {
        coordinator.onLifecycleEvent({ registryId, port: context.port, kind: "start" });
      });
      api.on("gateway_stop", (_event, context) => {
        coordinator.onLifecycleEvent({ registryId, port: context.port, kind: "stop" });
      });
    }
    if (coordinator.serviceStopFailure) {
      api.registerService({
        id: "instance-binding-service",
        start() {
          coordinator.serviceStarts += 1;
        },
        stop() {
          coordinator.serviceStops += 1;
          if (coordinator.serviceStopFailure === "rejection") {
            return Promise.reject(new Error("instance-binding service cleanup rejected"));
          }
          if (coordinator.serviceStopFailure === "timeout") {
            return new Promise(() => {});
          }
        },
      });
    }
    api.registerGatewayMethod("${INSTANCE_BINDING_PROBE_METHOD}", ({ context, respond }) => {
      respond(true, {
        registryId,
        sessionsId: coordinator.identify(context.sessionCompanion),
        placementId: coordinator.identify(context.workerSessionPlacementService),
      });
    }, { scope: "operator.read" });
  },
};
`,
  );
  return { bundledRoot };
}

async function prepareInstanceBindingTest(options?: {
  serviceStopFailure?: InstanceBindingProbeCoordinator["serviceStopFailure"];
}) {
  const { coordinator, channelName } = installInstanceBindingProbeCoordinator(options);
  const plugin = await writeInstanceBindingProbePlugin(channelName);
  process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
  delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = plugin.bundledRoot;
  process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
  process.env.OPENCLAW_SKIP_CHANNELS = "1";
  process.env.OPENCLAW_SKIP_CRON = "1";
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("gateway test hooks did not install OPENCLAW_CONFIG_PATH");
  }
  const config = {
    plugins: {
      enabled: true,
      allow: ["instance-binding-probe"],
      entries: { "instance-binding-probe": { enabled: true } },
    },
  };
  const { loadPluginLookUpTable } = await import("../plugins/plugin-lookup-table.js");
  expect(loadPluginLookUpTable({ config, env: process.env }).startup.pluginIds).toContain(
    "instance-binding-probe",
  );
  await fs.writeFile(configPath, `${JSON.stringify(config)}\n`);
  return { coordinator, bundledRoot: plugin.bundledRoot };
}

describe("gateway plugin instance bindings", () => {
  const started: Array<Awaited<ReturnType<typeof startTestGatewayServer>>> = [];
  const sockets: Array<Awaited<ReturnType<typeof connectWebchatClient>>> = [];
  const configIoRestorers: Array<{ mockRestore: () => void }> = [];

  beforeEach(async () => {
    const actualIo = await vi.importActual<typeof import("../config/io.js")>("../config/io.js");
    const facades = await Promise.all([import("../config/io.js"), import("../config/config.js")]);
    // Cached mutation importers retain the shared mocks; delegate those same exports to real IO
    // so config receipts, preflight, source snapshots, and runtime defaults keep their real owner.
    for (const facade of facades) {
      configIoRestorers.push(
        vi.spyOn(facade, "createConfigIO").mockImplementation(actualIo.createConfigIO),
        vi.spyOn(facade, "getRuntimeConfig").mockImplementation(actualIo.getRuntimeConfig),
        vi
          .spyOn(facade, "readConfigFileSnapshot")
          .mockImplementation(actualIo.readConfigFileSnapshot),
        vi
          .spyOn(facade, "readConfigFileSnapshotWithPluginMetadata")
          .mockImplementation(actualIo.readConfigFileSnapshotWithPluginMetadata),
        vi
          .spyOn(facade, "readConfigFileSnapshotForWrite")
          .mockImplementation(actualIo.readConfigFileSnapshotForWrite),
        vi.spyOn(facade, "writeConfigFile").mockImplementation(actualIo.writeConfigFile),
      );
    }
  });

  afterEach(async () => {
    // Synthetic recovery emits no signal for a run loop to consume. Reopen admission
    // before teardown joins background work that may be waiting behind that fence.
    markGatewaySigusr1RestartHandled();
    try {
      for (const socket of sockets.splice(0)) {
        socket.close();
      }
      for (const server of started.splice(0).toReversed()) {
        await server.close({ reason: "instance binding cleanup" });
      }
    } finally {
      for (const unsubscribe of probeSubscriptions.splice(0)) {
        unsubscribe();
      }
      delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
      for (const restore of configIoRestorers.splice(0)) {
        restore.mockRestore();
      }
    }
  });

  it(
    "keeps unscoped plugin work bound to each real Gateway across reverse shutdown",
    { timeout: 600_000 },
    async () => {
      const { coordinator } = await prepareInstanceBindingTest();

      const first = await startTestGatewayServer(await getFreePort(), {
        auth: { mode: "none" },
        controlUiEnabled: false,
        sidecarStartup: "start",
      });
      started.push(first);
      await first.startupSettled;
      const sharedMetadata = getGatewayPluginMetadataSnapshot();
      expect(sharedMetadata).toBeDefined();

      await expect(
        startTestGatewayServer(await getFreePort(), {
          bind: "loopback",
          host: "0.0.0.0",
          auth: { mode: "none" },
          controlUiEnabled: false,
          sidecarStartup: "defer",
        }),
      ).rejects.toThrow("gateway bind=loopback resolved to non-loopback host");
      expect(getGatewayPluginMetadataSnapshot()).toBe(sharedMetadata);
      const firstRegistrationCount = coordinator.runtimes.length;
      expect(
        firstRegistrationCount,
        JSON.stringify(getActivePluginRegistry()?.diagnostics),
      ).toBeGreaterThan(0);
      const { runtime: firstRuntime } = await requireBoundRuntime(
        coordinator.runtimes.slice(0, firstRegistrationCount),
        "first",
      );

      const second = await startTestGatewayServer(await getFreePort(), {
        auth: { mode: "none" },
        controlUiEnabled: false,
        sidecarStartup: "start",
      });
      started.push(second);
      await second.startupSettled;
      expect(getGatewayPluginMetadataSnapshot()).toBe(sharedMetadata);
      expect(coordinator.runtimes.length).toBeGreaterThan(firstRegistrationCount);
      const { runtime: secondRuntime } = await requireBoundRuntime(
        coordinator.runtimes.slice(firstRegistrationCount),
        "second",
      );

      const firstProbe = await requestInstanceBindingProbe(firstRuntime);
      const secondProbe = await requestInstanceBindingProbe(secondRuntime);
      expect(firstProbe.registryId).not.toBe(secondProbe.registryId);
      expect(firstProbe.sessionsId).not.toBe(secondProbe.sessionsId);
      expect(firstProbe.placementId).not.toBe(secondProbe.placementId);
      await expect(
        firstRuntime.subagent.getSessionMessages({ sessionKey: "agent:main:main", limit: 1 }),
      ).resolves.toEqual({ messages: [] });
      await expect(
        secondRuntime.subagent.getSessionMessages({ sessionKey: "agent:main:main", limit: 1 }),
      ).resolves.toEqual({ messages: [] });

      await second.close({ reason: "close last-started Gateway first" });
      started.pop();
      clearPluginMetadataLifecycleCaches();
      expect(getGatewayPluginMetadataSnapshot()).toBe(sharedMetadata);
      await expect(requestInstanceBindingProbe(secondRuntime)).rejects.toThrow(
        'Plugin "instance-binding-probe" runtime is no longer active.',
      );
      await expect(requestInstanceBindingProbe(firstRuntime)).resolves.toEqual(firstProbe);
      await expect(
        firstRuntime.subagent.getSessionMessages({ sessionKey: "agent:main:main", limit: 1 }),
      ).resolves.toEqual({ messages: [] });
      await first.close({ reason: "close final Gateway metadata owner" });
      started.pop();
      expect(getGatewayPluginMetadataSnapshot()).toBeUndefined();
    },
  );

  it(
    "publishes startup plugins after another Gateway starts during its loader handoff",
    { timeout: 600_000 },
    async () => {
      const { coordinator } = await prepareInstanceBindingTest();
      const firstPort = await getFreePort();
      const firstStarted = createDeferred();
      const secondStarted = createDeferred();
      const startupSignals = new Map([[firstPort, firstStarted]]);
      const lifecycleEvents: Array<
        Parameters<NonNullable<InstanceBindingProbeCoordinator["onLifecycleEvent"]>>[0]
      > = [];
      coordinator.onLifecycleEvent = (event) => {
        lifecycleEvents.push(event);
        if (event.kind === "start") {
          startupSignals.get(event.port)?.resolve();
        }
      };
      const startupTrace = await import("./server-startup-trace.js");
      const createTrace = startupTrace.createGatewayStartupTrace;
      const pluginLoadFinished = createDeferred();
      const releaseAttachment = createDeferred();
      const traceSpy = vi
        .spyOn(startupTrace, "createGatewayStartupTrace")
        .mockImplementationOnce((...args) => {
          const trace = createTrace(...args);
          const measure = trace.measure.bind(trace);
          trace.measure = async (name, run, options) => {
            const result = await measure(name, run, options);
            if (name === "plugins.runtime-post-bind") {
              pluginLoadFinished.resolve();
              await releaseAttachment.promise;
            }
            return result;
          };
          return trace;
        });
      let firstStarting: ReturnType<typeof startTestGatewayServer> | undefined;
      try {
        firstStarting = startTestGatewayServer(firstPort, {
          auth: { mode: "none" },
          controlUiEnabled: false,
          sidecarStartup: "start",
        }).then((server) => {
          started.push(server);
          return server;
        });
        await Promise.race([
          pluginLoadFinished.promise,
          firstStarting.then(() => {
            throw new Error("First Gateway passed its plugin attachment barrier");
          }),
        ]);
        const firstRegistrationCount = coordinator.runtimes.length;
        expect(firstRegistrationCount).toBeGreaterThan(0);

        const secondPort = await getFreePort();
        startupSignals.set(secondPort, secondStarted);
        const second = await startTestGatewayServer(secondPort, {
          auth: { mode: "none" },
          controlUiEnabled: false,
          sidecarStartup: "start",
        });
        started.push(second);
        await second.startupSettled;
        await secondStarted.promise;
        expect(coordinator.runtimes.length).toBeGreaterThan(firstRegistrationCount);

        releaseAttachment.resolve();
        const first = await firstStarting;
        await first.startupSettled;
        await firstStarted.promise;
        const { runtime: firstRuntime } = await requireBoundRuntime(
          coordinator.runtimes.slice(0, firstRegistrationCount),
          "first concurrent startup",
        );
        const { runtime: secondRuntime } = await requireBoundRuntime(
          coordinator.runtimes.slice(firstRegistrationCount),
          "second concurrent startup",
        );
        const firstProbe = await requestInstanceBindingProbe(firstRuntime);
        const secondProbe = await requestInstanceBindingProbe(secondRuntime);
        expect(firstProbe.registryId).not.toBe(secondProbe.registryId);
        expect(firstProbe.sessionsId).not.toBe(secondProbe.sessionsId);
        expect(firstProbe.placementId).not.toBe(secondProbe.placementId);
        await expect(requestInstanceBindingProbe(firstRuntime)).resolves.toEqual(firstProbe);
        await expect(requestInstanceBindingProbe(secondRuntime)).resolves.toEqual(secondProbe);
        expect(lifecycleEvents).toEqual([
          { registryId: secondProbe.registryId, port: secondPort, kind: "start" },
          { registryId: firstProbe.registryId, port: firstPort, kind: "start" },
        ]);

        // A publishes last; closing B must dispatch B's hooks while A remains the default.
        await Promise.all([
          second.close({ reason: "close earlier-published Gateway" }),
          second.close({ reason: "join earlier-published Gateway close" }),
        ]);
        started.splice(started.indexOf(second), 1);
        expect(lifecycleEvents).toEqual([
          { registryId: secondProbe.registryId, port: secondPort, kind: "start" },
          { registryId: firstProbe.registryId, port: firstPort, kind: "start" },
          { registryId: secondProbe.registryId, port: secondPort, kind: "stop" },
        ]);
        await expect(requestInstanceBindingProbe(secondRuntime)).rejects.toThrow(
          'Plugin "instance-binding-probe" runtime is no longer active.',
        );
        await expect(requestInstanceBindingProbe(firstRuntime)).resolves.toEqual(firstProbe);
        await first.close({ reason: "close remaining concurrent Gateway" });
        started.splice(started.indexOf(first), 1);
        expect(lifecycleEvents).toEqual([
          { registryId: secondProbe.registryId, port: secondPort, kind: "start" },
          { registryId: firstProbe.registryId, port: firstPort, kind: "start" },
          { registryId: secondProbe.registryId, port: secondPort, kind: "stop" },
          { registryId: firstProbe.registryId, port: firstPort, kind: "stop" },
        ]);
      } finally {
        releaseAttachment.resolve();
        await Promise.allSettled([firstStarting]);
        traceSpy.mockRestore();
      }
    },
  );

  it(
    "discards a prepared startup candidate when Gateway close starts before publication",
    { timeout: 600_000 },
    async () => {
      const { coordinator } = await prepareInstanceBindingTest();
      const kernelModule = await import("./server-kernel.js");
      const createKernel = kernelModule.createGatewayKernel;
      const prepared = createDeferred();
      const release = createDeferred();
      const published = vi.fn();
      const kernelSpy = vi
        .spyOn(kernelModule, "createGatewayKernel")
        .mockImplementationOnce(async (...args) => {
          const kernel = await createKernel(...args);
          const prepare = kernel.prepareAttachedPluginRuntime;
          return {
            ...kernel,
            prepareAttachedPluginRuntime: async (loaded) => {
              const attachment = await prepare(loaded);
              prepared.resolve();
              await release.promise;
              return {
                ...attachment,
                publish: () => {
                  published();
                  attachment.publish();
                },
              };
            },
          };
        });
      try {
        const server = await startTestGatewayServer(await getFreePort(), {
          auth: { mode: "none" },
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        started.push(server);
        await prepared.promise;
        const closing = server.close({ reason: "close during startup preparation" });
        release.resolve();
        await Promise.all([closing, server.startupSettled]);
        expect(published).not.toHaveBeenCalled();
        for (const runtime of coordinator.runtimes) {
          expect(await runtime.gateway.isAvailable()).toBe(false);
        }
      } finally {
        release.resolve();
        kernelSpy.mockRestore();
      }
    },
  );

  it(
    "publishes manifest changes on hot reload while preserving Gateway instance bindings",
    { timeout: 600_000 },
    async () => {
      const { coordinator, bundledRoot } = await prepareInstanceBindingTest();

      const port = await getFreePort();
      const hotReloadRecovery = vi.fn(() => ({ status: "emitted" as const }));
      const server = await startTestGatewayServer(port, {
        auth: { mode: "none" },
        controlUiEnabled: false,
        hotReloadRecovery,
        sidecarStartup: "start",
      });
      started.push(server);
      await server.startupSettled;
      const startupMetadata = getGatewayPluginMetadataSnapshot();
      expect(startupMetadata?.byPluginId.get("instance-binding-probe")?.name).toBe(
        "Startup plugin",
      );
      const manifestPath = path.join(bundledRoot, "instance-binding-probe", "openclaw.plugin.json");
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, name: "Changed plugin" }));
      expect(getGatewayPluginMetadataSnapshot()).toBe(startupMetadata);
      const initialRegistrationCount = coordinator.runtimes.length;
      expect(
        initialRegistrationCount,
        JSON.stringify(getActivePluginRegistry()?.diagnostics),
      ).toBeGreaterThan(0);
      const { runtime: initialRuntime } = await requireBoundRuntime(
        coordinator.runtimes.slice(0, initialRegistrationCount),
        "initial",
      );
      const initialProbe = await requestInstanceBindingProbe(initialRuntime);

      const socket = await connectWebchatClient({ port, scopes: ["operator.admin"] });
      sockets.push(socket);
      const currentConfig = await rpcReq<{ hash?: string }>(socket, "config.get", {});
      expect(currentConfig.ok).toBe(true);
      expect(typeof currentConfig.payload?.hash).toBe("string");
      const reload = await rpcReq(socket, "config.patch", {
        raw: JSON.stringify({
          plugins: {
            entries: {
              "instance-binding-probe": {
                subagent: { allowModelOverride: true },
              },
            },
          },
        }),
        baseHash: currentConfig.payload?.hash,
      });
      expect(reload.ok, reload.error?.message).toBe(true);
      expect(reload.payload).toMatchObject({
        sentinel: { payload: { stats: { requiresRestart: false } } },
      });
      // Registration happens during staging; metadata changes only at publication.
      await expect
        .poll(() => getGatewayPluginMetadataSnapshot(), { timeout: 300_000 })
        .not.toBe(startupMetadata);
      expect(coordinator.runtimes.length).toBeGreaterThan(initialRegistrationCount);
      const { runtime: reloadedRuntime } = await requireBoundRuntime(
        coordinator.runtimes.slice(initialRegistrationCount),
        "hot-reloaded",
      );
      const reloadedProbe = await requestInstanceBindingProbe(reloadedRuntime);

      expect(reloadedProbe.registryId).not.toBe(initialProbe.registryId);
      expect(reloadedProbe.sessionsId).toBe(initialProbe.sessionsId);
      expect(reloadedProbe.placementId).toBe(initialProbe.placementId);
      expect(
        getGatewayPluginMetadataSnapshot()?.byPluginId.get("instance-binding-probe")?.name,
      ).toBe("Changed plugin");
      expect(hotReloadRecovery).not.toHaveBeenCalled();
      await expect(requestInstanceBindingProbe(initialRuntime)).rejects.toThrow(
        'Plugin "instance-binding-probe" runtime is no longer active.',
      );
      await expect(
        reloadedRuntime.subagent.getSessionMessages({
          sessionKey: "agent:main:main",
          limit: 1,
        }),
      ).resolves.toEqual({ messages: [] });

      socket.close();
      sockets.splice(sockets.indexOf(socket), 1);
      await server.close({ reason: "plugin metadata restart" });
      started.splice(started.indexOf(server), 1);
      const restarted = await startTestGatewayServer(port, {
        auth: { mode: "none" },
        controlUiEnabled: false,
        sidecarStartup: "start",
      });
      started.push(restarted);
      await restarted.startupSettled;
      expect(
        getGatewayPluginMetadataSnapshot()?.byPluginId.get("instance-binding-probe")?.name,
      ).toBe("Changed plugin");
    },
  );

  it.each(["rejection", "timeout"] as const)(
    "reports failed plugin cleanup by %s and fences its old instance while keeping the Gateway available",
    { timeout: 600_000 },
    async (serviceStopFailure) => {
      const { coordinator } = await prepareInstanceBindingTest({ serviceStopFailure });
      const hotReloadRecovery = vi.fn(() => {
        // No run loop consumes this synthetic emission, so release its signal-admission lease.
        markGatewaySigusr1RestartHandled();
        return { status: "emitted" as const };
      });
      const port = await getFreePort();
      const server = await startTestGatewayServer(port, {
        auth: { mode: "none" },
        controlUiEnabled: false,
        hotReloadRecovery,
        sidecarStartup: "start",
      });
      started.push(server);
      await server.startupSettled;

      const initialRegistry = getActivePluginRegistry();
      const initialMetadata = getGatewayPluginMetadataSnapshot();
      const initialRuntimeConfig = getActiveSecretsRuntimeConfigSnapshot()?.config;
      const initialRegistrationCount = coordinator.runtimes.length;
      const initialHandler = initialRegistry?.gatewayHandlers[INSTANCE_BINDING_PROBE_METHOD];
      expect(initialRegistry).toBeDefined();
      expect(initialMetadata).toBeDefined();
      expect(initialRuntimeConfig).toBeDefined();
      expect(initialHandler, JSON.stringify(initialRegistry?.diagnostics)).toBeTypeOf("function");
      expect(coordinator.serviceStarts).toBe(1);
      const { runtime: initialRuntime } = await requireBoundRuntime(
        coordinator.runtimes.slice(0, initialRegistrationCount),
        "initial",
      );
      await expect(requestInstanceBindingProbe(initialRuntime)).resolves.toMatchObject({
        registryId: expect.any(Number),
      });

      const socket = await connectWebchatClient({ port, scopes: ["operator.admin"] });
      sockets.push(socket);
      const currentConfig = await rpcReq<{ hash?: string }>(socket, "config.get", {});
      expect(currentConfig.ok).toBe(true);
      const reload = await rpcReq(socket, "plugins.reload", {
        pluginId: "instance-binding-probe",
      });
      expect(reload, reload.error?.message).toMatchObject({
        ok: false,
        error: {
          code: "UNAVAILABLE",
          details: { runtime: { phase: "drain", committed: false } },
        },
      });
      expect(hotReloadRecovery).not.toHaveBeenCalled();
      expect(coordinator.serviceStops).toBe(1);
      expect(coordinator.serviceStarts).toBe(1);
      expect(coordinator.runtimes.length).toBeGreaterThan(initialRegistrationCount);
      expect(getGatewayPluginMetadataSnapshot()).toBe(initialMetadata);
      expect(getActiveSecretsRuntimeConfigSnapshot()?.config).toBe(initialRuntimeConfig);
      expect(getActivePluginRegistry()).toBe(initialRegistry);
      expect(getActivePluginRegistry()?.gatewayHandlers[INSTANCE_BINDING_PROBE_METHOD]).toBe(
        initialHandler,
      );
      await expect(requestInstanceBindingProbe(initialRuntime)).rejects.toThrow(
        "was reloaded or disabled; use its current tools",
      );
      for (const candidate of coordinator.runtimes.slice(initialRegistrationCount)) {
        await expect(requestInstanceBindingProbe(candidate)).rejects.toThrow(
          'Plugin "instance-binding-probe" runtime is no longer active.',
        );
      }
      const afterFailure = await rpcReq<{ hash?: string }>(socket, "config.get", {});
      expect(afterFailure.ok).toBe(true);
      expect(afterFailure.payload?.hash).toBe(currentConfig.payload?.hash);
    },
  );
});
