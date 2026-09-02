/** Caches plugin tool descriptors by plugin source, contract names, and runtime context. */
import type { AnyAgentTool } from "../agents/tools/common.js";
import { resolveRuntimeConfigCacheKey } from "../config/runtime-snapshot.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import type { JsonObject, ToolDescriptor } from "../tools/types.js";
import type { PluginLoadOptions } from "./loader.js";
import type { PluginManifestRecord } from "./manifest-registry.types.js";
import { getPluginCache, type PluginCache } from "./plugin-cache.js";
import type { PluginRegistry } from "./registry-types.js";
import type { OpenClawPluginToolContext } from "./types.js";

const PLUGIN_TOOL_DESCRIPTOR_CACHE_VERSION = 3;
const PLUGIN_TOOL_DESCRIPTOR_CACHE_LIMIT = 256;

/** A descriptor retains its producing registry; retired instances reject cached invocations. */
export type CachedPluginToolDescriptor = {
  descriptor: ToolDescriptor;
  registry: PluginRegistry;
  displaySummary?: string;
  hideFromChannelProgress?: AnyAgentTool["hideFromChannelProgress"];
  requiredClientCaps?: string[];
  resultContentSource?: AnyAgentTool["resultContentSource"];
  optional: boolean;
};

function createPluginToolDescriptorCacheState() {
  return {
    descriptors: new Map<string, CachedPluginToolDescriptor[]>(),
    objectIds: new WeakMap<object, number>(),
    nextObjectId: 1,
  };
}

const caches = new WeakMap<PluginCache, ReturnType<typeof createPluginToolDescriptorCacheState>>();

/** Reloaded code gets fresh descriptors; retained tools keep their exact generation's state. */
function getPluginToolDescriptorCacheState() {
  const cache = getPluginCache();
  let state = caches.get(cache);
  if (!state) {
    state = createPluginToolDescriptorCacheState();
    caches.set(cache, state);
  }
  return state;
}

export type PluginToolDescriptorConfigCacheKeyMemo = WeakMap<object, string | number | null>;

/** Creates a memo table for config cache keys reused across descriptor cache calls. */
export function createPluginToolDescriptorConfigCacheKeyMemo(): PluginToolDescriptorConfigCacheKeyMemo {
  return new WeakMap();
}

function getDescriptorCacheObjectId(value: object | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const state = getPluginToolDescriptorCacheState();
  const existing = state.objectIds.get(value);
  if (existing !== undefined) {
    return existing;
  }
  const next = state.nextObjectId++;
  state.objectIds.set(value, next);
  return next;
}

function stripDescriptorVolatileConfigFields(
  value: NonNullable<PluginLoadOptions["config"]>,
): NonNullable<PluginLoadOptions["config"]> {
  if (typeof value !== "object") {
    return value;
  }
  if (!("meta" in value) && !("wizard" in value)) {
    return value;
  }
  const { meta: _meta, wizard: _wizard, ...stableConfig } = value as Record<string, unknown>;
  return stableConfig as NonNullable<PluginLoadOptions["config"]>;
}

function getDescriptorConfigCacheKey(
  value: PluginLoadOptions["config"] | null | undefined,
  memo?: PluginToolDescriptorConfigCacheKeyMemo,
): string | number | null {
  if (!value) {
    return null;
  }
  const cached = memo?.get(value);
  if (cached !== undefined) {
    return cached;
  }
  let resolved: string | number | null;
  try {
    resolved = resolveRuntimeConfigCacheKey(stripDescriptorVolatileConfigFields(value));
  } catch {
    resolved = getDescriptorCacheObjectId(value);
  }
  memo?.set(value, resolved);
  return resolved;
}

function buildDescriptorContextCacheKey(params: {
  ctx: OpenClawPluginToolContext;
  currentRuntimeConfig?: PluginLoadOptions["config"] | null;
  configCacheKeyMemo?: PluginToolDescriptorConfigCacheKeyMemo;
}): string {
  const { ctx } = params;
  return JSON.stringify({
    config: getDescriptorConfigCacheKey(ctx.config, params.configCacheKeyMemo),
    runtimeConfig: getDescriptorConfigCacheKey(ctx.runtimeConfig, params.configCacheKeyMemo),
    currentRuntimeConfig: getDescriptorConfigCacheKey(
      params.currentRuntimeConfig,
      params.configCacheKeyMemo,
    ),
    fsPolicy: ctx.fsPolicy ?? null,
    workspaceDir: ctx.workspaceDir ?? null,
    agentDir: ctx.agentDir ?? null,
    agentId: ctx.agentId ?? null,
    activeModel: ctx.activeModel ?? null,
    browser: ctx.browser ?? null,
    messageChannel: ctx.messageChannel ?? null,
    agentAccountId: ctx.agentAccountId ?? null,
    nativeChannelId: ctx.nativeChannelId ?? null,
    deliveryContext: ctx.deliveryContext ?? null,
    deliveryAvailable: ctx.delivery !== undefined,
    requesterSenderId: ctx.requesterSenderId ?? null,
    senderIsOwner: ctx.senderIsOwner ?? null,
    sandboxed: ctx.sandboxed ?? null,
  });
}

export function buildPluginToolDescriptorCacheKey(params: {
  plugin: Pick<PluginManifestRecord, "id" | "source" | "rootDir" | "contracts">;
  ctx: OpenClawPluginToolContext;
  currentRuntimeConfig?: PluginLoadOptions["config"] | null;
  configCacheKeyMemo?: PluginToolDescriptorConfigCacheKeyMemo;
  clientCaps?: ReadonlySet<string> | readonly string[];
}): string {
  return JSON.stringify({
    version: PLUGIN_TOOL_DESCRIPTOR_CACHE_VERSION,
    pluginId: params.plugin.id,
    source: params.plugin.source,
    rootDir: params.plugin.rootDir,
    contractToolNames: [...(params.plugin.contracts?.tools ?? [])].toSorted(),
    clientCaps: [...(params.clientCaps ?? [])].toSorted(),
    context: buildDescriptorContextCacheKey({
      ctx: params.ctx,
      currentRuntimeConfig: params.currentRuntimeConfig,
      configCacheKeyMemo: params.configCacheKeyMemo,
    }),
  });
}

function asJsonObject(value: unknown): JsonObject {
  return value as JsonObject;
}

export function capturePluginToolDescriptor(params: {
  pluginId: string;
  registry: PluginRegistry;
  tool: AnyAgentTool;
  optional: boolean;
}): CachedPluginToolDescriptor {
  const label = (params.tool as { label?: unknown }).label;
  const title = typeof label === "string" && label.trim() ? label.trim() : undefined;
  return {
    registry: params.registry,
    ...(params.tool.displaySummary ? { displaySummary: params.tool.displaySummary } : {}),
    ...(params.tool.hideFromChannelProgress === true ? { hideFromChannelProgress: true } : {}),
    ...(params.tool.requiredClientCaps
      ? { requiredClientCaps: [...params.tool.requiredClientCaps] }
      : {}),
    ...(params.tool.resultContentSource
      ? { resultContentSource: params.tool.resultContentSource }
      : {}),
    optional: params.optional,
    descriptor: {
      name: params.tool.name,
      ...(title ? { title } : {}),
      description: params.tool.description,
      inputSchema: asJsonObject(params.tool.parameters),
      ...(params.tool.outputSchema ? { outputSchema: asJsonObject(params.tool.outputSchema) } : {}),
      owner: { kind: "plugin", pluginId: params.pluginId },
      executor: { kind: "plugin", pluginId: params.pluginId, toolName: params.tool.name },
    },
  };
}

export function readCachedPluginToolDescriptors(
  cacheKey: string,
): readonly CachedPluginToolDescriptor[] | undefined {
  return getPluginToolDescriptorCacheState().descriptors.get(cacheKey);
}

export function writeCachedPluginToolDescriptors(params: {
  cacheKey: string;
  descriptors: readonly CachedPluginToolDescriptor[];
}): void {
  const { descriptors } = getPluginToolDescriptorCacheState();
  if (!descriptors.has(params.cacheKey) && descriptors.size >= PLUGIN_TOOL_DESCRIPTOR_CACHE_LIMIT) {
    pruneMapToMaxSize(descriptors, PLUGIN_TOOL_DESCRIPTOR_CACHE_LIMIT - 1);
  }
  descriptors.set(params.cacheKey, [...params.descriptors]);
}
