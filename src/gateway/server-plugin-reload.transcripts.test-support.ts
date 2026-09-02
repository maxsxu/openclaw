import { vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createHookRunner } from "../plugins/hooks.js";
import type { createPluginRegistryOwner } from "../plugins/runtime.js";
import type { reloadGatewayPlugins } from "./server-plugin-reload.js";
import type { createGatewayPluginRuntimeGeneration } from "./server-plugin-runtime-generation.js";
import { createGatewaySidecarStopOwner } from "./server-sidecar-owners.js";
import { startGatewayPostAttachRuntime } from "./server-startup-post-attach.js";

export async function startTranscriptReloadFixtureSidecars(
  fixture: {
    runtime: Parameters<typeof reloadGatewayPlugins>[0]["runtime"];
    getConfig: () => OpenClawConfig;
    registryOwner: ReturnType<typeof createPluginRegistryOwner>;
    owner: ReturnType<typeof createGatewayPluginRuntimeGeneration>;
  },
  workspaceDir: string,
  log: Parameters<typeof startGatewayPostAttachRuntime>[0]["logHooks"],
  cleanups: Array<() => Promise<void>>,
  waitForPostReadyWork?: () => Promise<void>,
) {
  const { runtime } = fixture;
  const sidecars = createGatewaySidecarStopOwner({
    getRegistered: () => runtime.runtimeState.gatewayLifetimeSidecars,
    setRegistered: (handles) => {
      runtime.runtimeState.gatewayLifetimeSidecars = handles;
    },
  });
  cleanups.push(async () => {
    await sidecars.stop().catch(() => {});
  });
  const config = fixture.getConfig();
  const unusedRecovery = async (): Promise<never> => {
    throw new Error("unexpected main-session recovery");
  };
  const startup = await startGatewayPostAttachRuntime(
    {
      minimalTestGateway: false,
      cfgAtStart: config,
      getConfig: fixture.getConfig,
      bindHost: "127.0.0.1",
      bindHosts: ["127.0.0.1"],
      port: 0,
      tlsEnabled: false,
      log,
      isNixMode: false,
      broadcastToConnIds: vi.fn(),
      getClientConnIds: () => new Set(),
      controlUiBasePath: "/",
      gatewayPluginConfigAtStart: config,
      activationSourceConfig: config,
      pluginManifestRecords: [],
      pluginRegistry: fixture.registryOwner.registry,
      defaultWorkspaceDir: workspaceDir,
      deps: {},
      startChannels: async () => {},
      recoveryRuntime: {
        abortAgent: unusedRecovery,
        dispatchAgent: unusedRecovery,
        waitForAgent: unusedRecovery,
        sendRecoveryNotice: unusedRecovery,
      },
      resolveGatewayContext: () => undefined,
      logHooks: log,
      logChannels: log,
      unlockStartupMethods: () => {},
      providerAuthPrewarm: { enabled: false },
      waitForPostReadyWork,
      pluginRuntimeClaim: fixture.owner.currentClaim(),
      getCurrentPluginRegistry: () => fixture.registryOwner.registry,
      getCurrentPluginServices: () => fixture.owner.currentServices() ?? null,
      onGatewayLifetimeSidecars: sidecars.publish,
      unregisterGatewayLifetimeSidecar: (handle) => {
        runtime.runtimeState.gatewayLifetimeSidecars =
          runtime.runtimeState.gatewayLifetimeSidecars.filter((entry) => entry !== handle);
      },
      stopRegisteredPostReadySidecars: async () => {},
      stopRegisteredGatewayLifetimeSidecars: sidecars.stop,
    },
    {
      createHookRunner,
      logGatewayStartup: () => {},
      refreshLatestUpdateRestartSentinel: async () => null,
      createGatewayUpdateCheck: () => ({
        initialize: async () => ({
          root: null,
          status: { root: null, installKind: "unknown", packageManager: "unknown" },
          installReceipt: null,
        }),
        start: () => {},
        stop: async () => {},
      }),
      startGatewaySidecars: async () => ({
        pluginServices: fixture.owner.currentServices() ?? null,
        postReadySidecars: [],
      }),
      warmSystemCa: async () => {},
      loadSubagentRegistryActivation: () => () => {},
    },
  );
  cleanups.push(async () => {
    await startup.stopGatewayUpdateCheck();
  });
  return sidecars;
}
