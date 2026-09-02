import path from "node:path";
import { isPathInside } from "../infra/path-guards.js";
import { getPluginCacheRoot } from "./plugin-cache.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { PLUGIN_REGISTRY_STATE } from "./runtime-state-key.js";
// Stores plugin runtime registry state for the current process lifecycle.
import { getActivePluginRegistryWorkspaceDirFromStateCore } from "./runtime-workspace-state.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";

export { PLUGIN_REGISTRY_STATE };

type PluginRegistry = import("./registry-types.js").PluginRegistry;
type MemoryCapabilityRegistrar = import("./types.js").OpenClawPluginApi["registerMemoryCapability"];

export type RegistryState = {
  activeRegistry: PluginRegistry | null;
  activeVersion: number;
  agentEventBridgeUnsubscribe?: (() => void) | undefined;
  key: string | null;
  workspaceDir: string | null;
  runtimeSubagentMode: "default" | "explicit" | "gateway-bindable";
  importedPluginIds: Set<string>;
  registrationContext?: {
    registry: PluginRegistry;
    pluginId: string;
    registerMemoryCapability?: MemoryCapabilityRegistrar;
  };
  commandRegistryClearTail?: Promise<void>;
  commandRegistryClearRegistries?: Map<PluginRegistry, number>;
};

type GlobalRegistryState = typeof globalThis & {
  [PLUGIN_REGISTRY_STATE]?: RegistryState;
};

export function getPluginRegistryState(): RegistryState | undefined {
  return (globalThis as GlobalRegistryState)[PLUGIN_REGISTRY_STATE];
}

/** Reads registration/request/active ownership without initializing a cold plugin runtime. */
export function getPluginRegistryForContext(): PluginRegistry | null {
  const state = getPluginRegistryState();
  return (
    state?.registrationContext?.registry ??
    getPluginRuntimeGatewayRequestScope()?.pluginRegistry ??
    state?.activeRegistry ??
    null
  );
}

/** Exact context identity disambiguates package siblings; a unique root works for host callers. */
export function resolvePluginRuntimeRecord(
  params: { pluginId?: string } & (
    | { pluginRoot: string; modulePath?: never }
    | { modulePath: string; pluginRoot?: never }
  ),
) {
  const root = params.pluginRoot ? getPluginCacheRoot(params.pluginRoot).rootDir : undefined;
  const source = params.modulePath ? path.resolve(params.modulePath) : undefined;
  const owners =
    getPluginRegistryForContext()?.plugins.filter(
      (record) =>
        record.rootDir &&
        (root
          ? getPluginCacheRoot(record.rootDir).rootDir === root
          : isPathInside(record.rootDir, source!) ||
            getPluginInstance(record)?.hasModuleSource(source!) === true),
    ) ?? [];
  const pluginId =
    params.pluginId ??
    getPluginRegistryState()?.registrationContext?.pluginId ??
    getPluginRuntimeGatewayRequestScope()?.pluginId;
  const owner = owners.find((record) => record.id === pluginId);
  if (!owner && (owners.length > 1 || (params.pluginId && owners.length))) {
    throw new Error(
      `Plugin public surface ${root ?? source} has ambiguous runtime ownership; specify its plugin id.`,
    );
  }
  return owner ?? owners[0];
}

/** Policy reads the process-active registry, independently of request or registration scopes. */
export function getActivePluginGatewayNodePolicyRegistry(): PluginRegistry | null {
  return getPluginRegistryState()?.activeRegistry ?? null;
}

export function getActivePluginRegistryWorkspaceDirFromState(): string | undefined {
  return getActivePluginRegistryWorkspaceDirFromStateCore();
}
