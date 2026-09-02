import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { PluginRuntimeCapabilityLease } from "./capability-lease.js";
import { normalizePluginHttpPath } from "./http-path.js";
import { findPluginHttpRouteRegistrationConflicts } from "./http-route-overlap.js";
import { getPluginHttpRouteViews, replacePluginHttpRoutes } from "./http-route-owner.js";
import {
  pluginInstanceState,
  resolvePluginInstanceOwner,
  wrapCurrentPluginInstance,
} from "./plugin-instance-scope.js";
import { isPluginRegistryRetired } from "./registry-lifecycle.js";
import type { PluginHttpRouteRegistration, PluginRegistry } from "./registry.js";
import { requireActivePluginRegistry } from "./runtime.js";

type PluginHttpRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean | void> | boolean | void;

type PluginHttpRouteRegistrationLease = Pick<PluginRuntimeCapabilityLease, "isActive" | "retain">;

// Native Gateway calls and transformed SDK helpers share lifecycle leases and route holders.
const pluginHttpRouteRegistryScope = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginHttpRouteRegistryScope"),
  () =>
    new AsyncLocalStorage<{
      registry: PluginRegistry;
      leases: readonly PluginHttpRouteRegistrationLease[];
    }>(),
);
const pluginHttpRouteHolders = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginHttpRouteHolders"),
  () =>
    new WeakMap<
      PluginHttpRouteRegistration,
      { holders: Set<() => void>; removeRoute: () => void }
    >(),
);
const noopUnregister = () => {};

// Same-owner reuse creates independent holders so one task cannot evict a route
// while another task still owns the shared registration.
function retainPluginHttpRoute(
  entry: PluginHttpRouteRegistration,
  leases: readonly PluginHttpRouteRegistrationLease[],
): () => void {
  const registration = pluginHttpRouteHolders.get(entry);
  // Static API routes belong to the registry; borrowing one cannot give a
  // dynamic caller authority to remove it on unregister or lease expiry.
  if (!registration) {
    return noopUnregister;
  }
  const { holders, removeRoute } = registration;
  const leaseReleases: Array<() => void> = [];
  const release = () => {
    if (!holders.delete(release)) {
      return;
    }
    for (const releaseLease of leaseReleases.splice(0)) {
      releaseLease();
    }
    if (holders.size === 0) {
      removeRoute();
    }
  };
  holders.add(release);
  for (const lease of leases) {
    leaseReleases.push(lease.retain(release));
  }
  return release;
}

export function withPluginHttpRouteRegistry<T>(
  registry: PluginRegistry,
  run: () => T,
  lease?: PluginHttpRouteRegistrationLease,
): T {
  const inherited = pluginHttpRouteRegistryScope.getStore()?.leases ?? [];
  const leases = lease && !inherited.includes(lease) ? [...inherited, lease] : inherited;
  return pluginHttpRouteRegistryScope.run({ registry, leases }, run);
}

export function registerPluginHttpRoute(params: {
  path?: string | null;
  fallbackPath?: string | null;
  handler: PluginHttpRouteHandler;
  auth: PluginHttpRouteRegistration["auth"];
  match?: PluginHttpRouteRegistration["match"];
  gatewayRuntimeScopeSurface?: PluginHttpRouteRegistration["gatewayRuntimeScopeSurface"];
  /** Replace an existing canonical route owned by the same plugin and compatible route source. */
  replaceExisting?: boolean;
  /** Reuse an existing canonical route only when its nonempty plugin and source owners match. */
  reuseExistingSameOwner?: boolean;
  /** Throw when the route cannot be registered instead of returning a no-op cleanup. */
  throwOnFailure?: boolean;
  pluginId?: string;
  /** Stable same-plugin sub-owner for replacement; omit consistently for legacy behavior. */
  source?: string;
  accountId?: string;
  log?: (message: string) => void;
  registry?: PluginRegistry;
}): () => void {
  const scope = pluginHttpRouteRegistryScope.getStore();
  let registry = params.registry ?? scope?.registry ?? requireActivePluginRegistry();
  const instance =
    pluginInstanceState.invocation.getStore()?.instance ??
    pluginInstanceState.values.get(params.handler);
  // A supplied registry cannot replace a retained callback's original lifetime.
  const record = instance
    ? instance.owner?.record
    : registry.plugins.find((entry) => entry.id === params.pluginId);
  const owner = record ? resolvePluginInstanceOwner(record, registry) : undefined;
  if (owner) {
    registry = owner.registry;
  }
  const suffix = params.accountId ? ` for account "${params.accountId}"` : "";
  const rejectRegistration = (message: string): (() => void) => {
    params.log?.(message);
    if (params.throwOnFailure) {
      throw new Error(message);
    }
    return noopUnregister;
  };
  // AsyncLocalStorage survives timed-out lifecycle callbacks; expired continuations must not
  // regain route authority, even when they retained an explicit registry reference.
  if (scope?.leases.some((lease) => !lease.isActive())) {
    return rejectRegistration("plugin runtime HTTP route lease is no longer active");
  }

  if (owner?.revoked || isPluginRegistryRetired(registry)) {
    return rejectRegistration("plugin HTTP route owner is no longer active");
  }
  const routes = [
    ...new Set(
      getPluginHttpRouteViews(registry, params.pluginId, instance).flatMap(
        (view) => view.httpRoutes,
      ),
    ),
  ];
  const normalizedPath = normalizePluginHttpPath(params.path, params.fallbackPath);
  if (!normalizedPath) {
    return rejectRegistration(`plugin: webhook path missing${suffix}`);
  }
  const routeMatch = params.match ?? "exact";
  const candidate = {
    path: normalizedPath,
    match: routeMatch,
    auth: params.auth,
  };
  const { authOverlap, canonicalMatches } = findPluginHttpRouteRegistrationConflicts(
    routes,
    candidate,
  );
  if (authOverlap) {
    return rejectRegistration(
      `plugin: route overlap denied at ${normalizedPath} (${routeMatch}, ${params.auth})${suffix}; ` +
        `overlaps ${authOverlap.path} (${authOverlap.match}, ${authOverlap.auth}) ` +
        `owned by ${authOverlap.pluginId ?? "unknown-plugin"} (${authOverlap.source ?? "unknown-source"})`,
    );
  }
  // Canonical aliases occupy one Gateway route even when their configured
  // bytes differ. Nested same-auth prefix chains remain separate routes.
  const existing = canonicalMatches[0];
  if (existing) {
    const requestedOwner = normalizeOptionalString(params.pluginId);
    const requestedSource = normalizeOptionalString(params.source);
    const mismatchedOwner = canonicalMatches.find(
      (route) =>
        normalizeOptionalString(route.pluginId) !== requestedOwner ||
        normalizeOptionalString(route.source) !== requestedSource,
    );
    if (!params.replaceExisting && params.reuseExistingSameOwner) {
      if (requestedOwner !== undefined && requestedSource !== undefined && !mismatchedOwner) {
        params.log?.(
          `plugin: reusing existing webhook path ${normalizedPath} (${routeMatch}) (${requestedOwner}/${requestedSource})`,
        );
        return retainPluginHttpRoute(existing, scope?.leases ?? []);
      }
      const conflictingOwner = mismatchedOwner ?? existing;
      return rejectRegistration(
        `plugin: route reuse denied for ${normalizedPath} (${routeMatch})${suffix}; owned by ${conflictingOwner.pluginId ?? "unknown-plugin"} (${conflictingOwner.source ?? "unknown-source"})`,
      );
    }
    if (!params.replaceExisting) {
      return rejectRegistration(
        `plugin: route conflict at ${normalizedPath} (${routeMatch})${suffix}; owned by ${existing.pluginId ?? "unknown-plugin"} (${existing.source ?? "unknown-source"})`,
      );
    }
    // Source-less same-plugin replacement shipped before route-source ownership.
    // Preserve it only when both sides omit source; otherwise require an exact source match.
    const incompatibleReplacement = canonicalMatches.find(
      (route) =>
        normalizeOptionalString(route.pluginId) !== requestedOwner ||
        (requestedOwner !== undefined && normalizeOptionalString(route.source) !== requestedSource),
    );
    if (incompatibleReplacement) {
      return rejectRegistration(
        `plugin: route replacement denied for ${normalizedPath} (${routeMatch})${suffix}; owned by ${incompatibleReplacement.pluginId ?? "unknown-plugin"} (${incompatibleReplacement.source ?? "unknown-source"})`,
      );
    }
    const pluginHint = params.pluginId ? ` (${params.pluginId})` : "";
    params.log?.(
      `plugin: replacing stale webhook path ${normalizedPath} (${routeMatch})${suffix}${pluginHint}`,
    );
  }

  const entry: PluginHttpRouteRegistration = {
    path: normalizedPath,
    handler: wrapCurrentPluginInstance(params.handler),
    auth: params.auth,
    match: routeMatch,
    ...(params.gatewayRuntimeScopeSurface
      ? { gatewayRuntimeScopeSurface: params.gatewayRuntimeScopeSurface }
      : {}),
    pluginId: params.pluginId,
    source: params.source,
  };
  pluginHttpRouteHolders.set(entry, {
    holders: new Set(),
    removeRoute: replacePluginHttpRoutes(registry, entry, canonicalMatches),
  });
  return retainPluginHttpRoute(entry, scope?.leases ?? []);
}
