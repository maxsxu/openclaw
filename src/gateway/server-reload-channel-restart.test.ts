import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import type { ChannelKind } from "./config-reload-plan.js";
import { createChannelManager, type ChannelManager } from "./server-channels.js";
import { restartGatewayChannels } from "./server-reload-channel-restart.js";

let manager: ChannelManager | undefined;
afterEach(async () => {
  await manager?.stopChannel("discord");
  manager = undefined;
  resetPluginRuntimeStateForTest();
  resetGatewayWorkAdmission();
});

it.each(
  (["channel", "accounts"] as const).flatMap((scope) =>
    (["idle", "stopped", "racing"] as const).map((state) => ({ scope, state })),
  ),
)(
  "$scope config reload preserves $state manual stops while explicit starts resume",
  async ({ scope, state }) => {
    const starts: string[] = [];
    const configuring = createDeferred();
    const releaseConfiguration = createDeferred();
    let blockConfiguration = state === "racing";
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "discord",
        config: {
          listAccountIds: () => ["manual", "running"],
          resolveAccount: (_cfg, accountId) => ({ accountId }),
          isConfigured: async (account) => {
            if (blockConfiguration && account.accountId === "manual") {
              configuring.resolve();
              await releaseConfiguration.promise;
            }
            return true;
          },
        },
      }),
      gateway: {
        startAccount: async ({ accountId, abortSignal }) => {
          starts.push(accountId);
          await new Promise<void>((resolve) => {
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "discord", plugin, source: "test" }]));
    manager = createChannelManager({
      getRuntimeConfig: () => ({}),
      channelLogs: {},
      channelRuntimeEnvs: {},
    });
    if (state === "stopped") {
      await manager.startChannel("discord", "manual");
      expect(starts).toEqual(["manual"]);
    }
    if (state !== "racing") {
      await manager.stopChannel("discord", "manual");
    }
    const channels = new Set<ChannelKind>(scope === "channel" ? ["discord"] : []);
    const accounts = new Map<ChannelKind, Set<string>>(
      scope === "accounts" ? [["discord", new Set(["manual", "running"])]] : [],
    );
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const scheduleRecoveryRestart = vi.fn();
    const reload = restartGatewayChannels({
      params: { startChannel: manager.startChannel, stopChannel: manager.stopChannel, logChannels },
      nextConfig: {},
      channelsToRestart: channels,
      restartChannelAccounts: accounts,
      activePluginChannelsAfterReload: null,
      shouldSkipChannelRestart: false,
      skipChannelRestartLogMessage: "",
      isLifecycleReloadAborted: () => false,
      getChannelAutostartSuppression: () => null,
      channelReloadTargets: () => channels,
      logSuppressedChannelRestart: vi.fn(),
      scheduleRecoveryRestart,
    });
    if (state === "racing") {
      await configuring.promise;
      await manager.stopChannel("discord", "manual");
      blockConfiguration = false;
      releaseConfiguration.resolve();
    }
    await reload;
    expect(scheduleRecoveryRestart).not.toHaveBeenCalled();
    expect(logChannels.error).not.toHaveBeenCalled();
    expect(manager.isManuallyStopped("discord", "manual")).toBe(true);
    expect(manager.getRuntimeSnapshot().channelAccounts.discord?.manual?.running).toBe(false);
    expect(starts).toEqual(state === "stopped" ? ["manual", "running"] : ["running"]);

    await manager.startChannel("discord", "manual", { manual: true });
    expect(manager.isManuallyStopped("discord", "manual")).toBe(false);
    expect(manager.getRuntimeSnapshot().channelAccounts.discord?.manual?.running).toBe(true);
    expect(starts.at(-1)).toBe("manual");
  },
);
