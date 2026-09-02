/** Registry handles expire at publication; unchanged plugin instances retain their own authority. */
import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { PluginLoaderCacheState } from "./loader-cache-state.js";
import { getPluginCache, type PluginCache } from "./plugin-cache.js";
import { pluginInstanceState, resolvePluginInstanceOwner } from "./plugin-instance-scope.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";

const {
  retiredRegistries,
  activatedRegistries,
  registryEpochs,
  preparation,
  loaderCaches,
  registryLoads,
} = resolveGlobalSingleton(Symbol.for("openclaw.pluginRegistryLifecycle"), () => ({
  retiredRegistries: new WeakSet<PluginRegistry>(),
  activatedRegistries: new WeakSet<PluginRegistry>(),
  registryEpochs: new WeakMap<PluginRegistry, object>(),
  preparation: new AsyncLocalStorage<{ registry: PluginRegistry; active: boolean }>(),
  loaderCaches: new WeakMap<PluginRegistry, Set<PluginLoaderCacheState<PluginRegistry>>>(),
  registryLoads: new WeakMap<PluginCache, PluginLoaderCacheState<PluginRegistry>>(),
}));

export function getPluginLoaderCacheState(cache = getPluginCache()) {
  const cached = registryLoads.get(cache);
  if (cached) {
    return cached;
  }
  const loads = new PluginLoaderCacheState<PluginRegistry>(128, (registry) => {
    let owners = loaderCaches.get(registry);
    if (!owners) {
      loaderCaches.set(registry, (owners = new Set()));
    }
    owners.add(loads);
  });
  registryLoads.set(cache, loads);
  // Metadata owns retirement without importing the registry's runtime contracts.
  cache.clearRegistryLoads = () => loads.clearCachedRegistries();
  return loads;
}

export type PluginRegistryLifecycleEpoch = object;

/** Transfer exact instances at publication without reviving a removed or failed instance. */
export function adoptPluginRegistryRecords(registry: PluginRegistry | null | undefined): void {
  if (!registry || retiredRegistries.has(registry)) {
    return;
  }
  for (const record of registry.plugins) {
    const owner = resolvePluginInstanceOwner(record, registry);
    if (!owner.revoked) {
      owner.registry = registry;
    }
  }
}

export function markPluginRegistryRetired(registry: PluginRegistry | null | undefined): void {
  if (!registry) {
    return;
  }
  retiredRegistries.add(registry);
  registryEpochs.delete(registry);
  for (const record of registry.plugins) {
    const owner = resolvePluginInstanceOwner(record, registry);
    if (owner.registry === registry) {
      owner.revoked = true;
    }
  }
  // Match the retired value across its birth caches; a reused key may already hold its successor.
  for (const cache of loaderCaches.get(registry) ?? []) {
    cache.deleteValue(registry);
  }
  loaderCaches.delete(registry);
}

export function markPluginRegistryActive(registry: PluginRegistry | null | undefined): void {
  if (!registry) {
    return;
  }
  activatedRegistries.add(registry);
  retiredRegistries.delete(registry);
  registryEpochs.set(registry, Object.freeze({}));
  adoptPluginRegistryRecords(registry);
}

export function capturePluginRegistryLifecycleEpoch(
  registry: PluginRegistry,
): PluginRegistryLifecycleEpoch | undefined {
  return retiredRegistries.has(registry) ? undefined : registryEpochs.get(registry);
}

export function isPluginRegistryLifecycleEpochActive(
  registry: PluginRegistry,
  epoch: PluginRegistryLifecycleEpoch,
): boolean {
  return !retiredRegistries.has(registry) && registryEpochs.get(registry) === epoch;
}

/** Resolve current contributions for a retained instance instead of its retired birth registry. */
export function getPluginRecordRegistry(
  registry: PluginRegistry,
  record: PluginRecord,
): PluginRegistry {
  return pluginInstanceState.records.get(record)?.registry ?? registry;
}

export function isPluginRecordActive(registry: PluginRegistry, record: PluginRecord): boolean {
  const owner = getPluginRecordRegistry(registry, record);
  return (
    !pluginInstanceState.records.get(record)?.revoked &&
    activatedRegistries.has(owner) &&
    !retiredRegistries.has(owner) &&
    owner.plugins.includes(record) &&
    record.enabled &&
    record.status === "loaded"
  );
}

function isPluginRecordPreparing(registry: PluginRegistry, record: PluginRecord): boolean {
  const scope = preparation.getStore();
  return (
    scope?.active === true &&
    scope.registry === registry &&
    !retiredRegistries.has(registry) &&
    !pluginInstanceState.records.get(record)?.revoked &&
    registry.plugins.includes(record) &&
    record.enabled &&
    record.status === "loaded"
  );
}

/** Candidate services may initialize only inside the owner's bounded preparation call. */
export async function withPluginRegistryPreparationScope<T>(
  registry: PluginRegistry,
  run: () => T | Promise<T>,
): Promise<T> {
  if (retiredRegistries.has(registry)) {
    throw new Error("Cannot prepare a retired plugin registry");
  }
  const scope = { registry, active: true };
  try {
    return await preparation.run(scope, run);
  } finally {
    scope.active = false;
  }
}

export function revokePluginRecord(registry: PluginRegistry, record: PluginRecord): void {
  resolvePluginInstanceOwner(record, registry).revoked = true;
}

export function isPluginRegistryRetired(registry: PluginRegistry): boolean {
  return retiredRegistries.has(registry);
}

export function capturePluginLifecycleAuthority(
  registry: PluginRegistry,
  record?: PluginRecord,
  options?: { scopedRuntime?: boolean },
): (() => boolean) | undefined {
  if (record) {
    const owner = resolvePluginInstanceOwner(record, registry);
    const usable = () =>
      !owner.revoked &&
      (isPluginRecordActive(registry, record) ||
        isPluginRecordPreparing(registry, record) ||
        (options?.scopedRuntime === true &&
          !activatedRegistries.has(registry) &&
          !retiredRegistries.has(registry) &&
          registry.plugins.includes(record) &&
          record.enabled &&
          record.status === "loaded"));
    // Exact record ownership never revives after removal, so another epoch is redundant.
    return usable() ? usable : undefined;
  }
  const epoch = registryEpochs.get(registry);
  if ((!epoch && !options?.scopedRuntime) || retiredRegistries.has(registry)) {
    return undefined;
  }
  return () => registryEpochs.get(registry) === epoch && !retiredRegistries.has(registry);
}
