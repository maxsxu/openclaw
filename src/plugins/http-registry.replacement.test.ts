import { afterEach, describe, expect, it, vi } from "vitest";
import { findRegisteredPluginHttpRoute } from "../gateway/server/plugins-http/route-match.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createPluginRuntimeCapabilityLease } from "./capability-lease.js";
import { registerPluginHttpRoute, withPluginHttpRouteRegistry } from "./http-registry.js";
import { PluginInstance } from "./plugin-instance.js";
import { projectPluginContributions } from "./registry-contributions.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { markPluginRegistryActive, markPluginRegistryRetired } from "./registry-lifecycle.js";
import { disposePluginRegistryInstances } from "./runtime.js";
import { createPluginRecord } from "./status.test-helpers.js";

const instances = new Set<PluginInstance>();

function createWebhookOwner() {
  const initial = createEmptyPluginRegistry();
  const record = createPluginRecord({ id: "webhook", enabled: true, status: "loaded" });
  initial.plugins.push(record);
  const instance = new PluginInstance(record.id, { record, registry: initial });
  instances.add(instance);
  markPluginRegistryActive(initial);
  let current = initial;
  const prepare = () => {
    const next = createEmptyPluginRegistry();
    next.plugins.push(record);
    projectPluginContributions(current, record, next);
    return next;
  };
  const publish = (next: typeof initial) => {
    markPluginRegistryActive(next);
    markPluginRegistryRetired(current);
    current = next;
  };
  const register = (params: Partial<Parameters<typeof registerPluginHttpRoute>[0]> = {}) =>
    withPluginHttpRouteRegistry(initial, () =>
      instance.run(() =>
        registerPluginHttpRoute({
          path: "/webhook",
          pluginId: record.id,
          source: "webhook-account",
          auth: "plugin",
          handler: vi.fn(),
          throwOnFailure: true,
          ...params,
        }),
      ),
    );
  return { initial, instance, prepare, publish, register };
}

afterEach(async () => {
  await Promise.all([...instances].map((instance) => instance.dispose()));
  instances.clear();
});

describe("retained plugin HTTP ownership", () => {
  it("stops and restarts an unchanged webhook after another plugin reloads", () => {
    const owner = createWebhookOwner();
    const stop = owner.register();
    const next = owner.prepare();
    owner.publish(next);

    stop();
    expect(findRegisteredPluginHttpRoute(next, "/webhook")).toBeUndefined();
    owner.register();
    expect(findRegisteredPluginHttpRoute(next, "/webhook")).toBeDefined();
  });

  it("carries a channel stop and restart through an already prepared registry", () => {
    const owner = createWebhookOwner();
    const stop = owner.register();
    const next = owner.prepare();

    stop();
    expect(findRegisteredPluginHttpRoute(next, "/webhook")).toBeUndefined();
    owner.register({ path: "/restarted-webhook" });
    owner.publish(next);
    expect(findRegisteredPluginHttpRoute(next, "/webhook")).toBeUndefined();
    expect(findRegisteredPluginHttpRoute(next, "/restarted-webhook")).toBeDefined();
  });

  it("keeps a shared route until its last account releases every retained projection", () => {
    const owner = createWebhookOwner();
    const first = createPluginRuntimeCapabilityLease("first account");
    const second = createPluginRuntimeCapabilityLease("second account");
    try {
      withPluginHttpRouteRegistry(owner.initial, () => owner.register(), first);
      const published = owner.prepare();
      owner.publish(published);
      const staged = owner.prepare();
      withPluginHttpRouteRegistry(
        published,
        () => owner.register({ reuseExistingSameOwner: true }),
        second,
      );

      first.revoke();
      expect(findRegisteredPluginHttpRoute(published, "/webhook")).toBeDefined();
      expect(findRegisteredPluginHttpRoute(staged, "/webhook")).toBeDefined();
      second.revoke();
      expect(findRegisteredPluginHttpRoute(published, "/webhook")).toBeUndefined();
      expect(findRegisteredPluginHttpRoute(staged, "/webhook")).toBeUndefined();
    } finally {
      first.revoke();
      second.revoke();
    }
  });

  it("routes a retained startup continuation into its published owner", async () => {
    const owner = createWebhookOwner();
    const continuation = createDeferredCore();
    const startup = withPluginHttpRouteRegistry(owner.initial, () =>
      owner.instance.run(async () => {
        await continuation.promise;
        return registerPluginHttpRoute({
          path: "/late-webhook",
          pluginId: "webhook",
          auth: "plugin",
          handler: vi.fn(),
          throwOnFailure: true,
        });
      }),
    );
    const next = owner.prepare();
    owner.publish(next);
    continuation.resolve();
    const stop = await startup;

    expect(findRegisteredPluginHttpRoute(next, "/late-webhook")).toBeDefined();
    expect(findRegisteredPluginHttpRoute(owner.initial, "/late-webhook")).toBeUndefined();
    stop();
    expect(findRegisteredPluginHttpRoute(next, "/late-webhook")).toBeUndefined();
  });

  it("releases route reservations when an unpublished candidate is disposed", async () => {
    const owner = createWebhookOwner();
    const candidate = owner.prepare();
    registerPluginHttpRoute({
      registry: candidate,
      path: "/candidate-route",
      pluginId: "candidate-only",
      auth: "gateway",
      handler: vi.fn(),
    });
    await disposePluginRegistryInstances(candidate, owner.initial);

    expect(() => owner.register({ path: "/candidate-route" })).not.toThrow();
    expect(findRegisteredPluginHttpRoute(owner.initial, "/candidate-route")?.auth).toBe("plugin");
    expect(findRegisteredPluginHttpRoute(candidate, "/candidate-route")?.auth).toBe("gateway");
  });

  it("retains managed anonymous routes and their late startup registrations", async () => {
    const owner = createWebhookOwner();
    const stop = owner.register({ pluginId: undefined });
    const continuation = createDeferredCore();
    const startup = withPluginHttpRouteRegistry(owner.initial, () =>
      owner.instance.run(async () => {
        await continuation.promise;
        return registerPluginHttpRoute({
          path: "/late-anonymous",
          auth: "plugin",
          handler: vi.fn(),
          throwOnFailure: true,
        });
      }),
    );
    const next = owner.prepare();
    owner.publish(next);
    continuation.resolve();
    // Observe the continuation before assertions so a regression does not leak a rejected promise.
    const result = await startup.then(
      (cleanup) => ({ cleanup, error: undefined }),
      (error: unknown) => ({ cleanup: undefined, error }),
    );

    expect(findRegisteredPluginHttpRoute(next, "/webhook")).toBeDefined();
    expect(result.error).toBeUndefined();
    expect(findRegisteredPluginHttpRoute(next, "/late-anonymous")).toBeDefined();
    expect(next.httpRoutes.every((route) => route.pluginId === undefined)).toBe(true);
    stop();
    result.cleanup?.();
    expect(next.httpRoutes).toEqual([]);
  });

  it("releases the former anonymous owner's staged routes on permitted replacement", () => {
    const owner = createWebhookOwner();
    const stopOld = owner.register({ pluginId: undefined });
    const otherRecord = createPluginRecord({ id: "other-owner", enabled: true, status: "loaded" });
    owner.initial.plugins.push(otherRecord);
    const other = new PluginInstance(otherRecord.id, {
      record: otherRecord,
      registry: owner.initial,
    });
    instances.add(other);
    // The candidate retains only the first owner; the replacement belongs to the other instance.
    const candidate = owner.prepare();
    expect(findRegisteredPluginHttpRoute(candidate, "/webhook")).toBeDefined();
    const stopReplacement = withPluginHttpRouteRegistry(owner.initial, () =>
      other.run(() =>
        registerPluginHttpRoute({
          path: "/webhook",
          auth: "plugin",
          source: "another-anonymous-source",
          handler: vi.fn(),
          replaceExisting: true,
          throwOnFailure: true,
        }),
      ),
    );
    const replacement = findRegisteredPluginHttpRoute(owner.initial, "/webhook");

    expect(replacement?.source).toBe("another-anonymous-source");
    expect(replacement?.pluginId).toBeUndefined();
    expect(findRegisteredPluginHttpRoute(candidate, "/webhook")).toBeUndefined();
    stopOld();
    expect(findRegisteredPluginHttpRoute(owner.initial, "/webhook")).toBe(replacement);
    stopReplacement();
    expect(owner.initial.httpRoutes).toEqual([]);
  });

  it("rejects a detached retired instance using the active replacement registry", async () => {
    const previous = createWebhookOwner();
    const current = createWebhookOwner();
    const stopCurrent = current.register({ pluginId: undefined, source: "current-owner" });
    const currentRoute = findRegisteredPluginHttpRoute(current.initial, "/webhook");
    const continuation = createDeferredCore();
    // Return an object so the original invocation ends before this native Promise callback runs.
    const detached = withPluginHttpRouteRegistry(previous.initial, () =>
      previous.instance.run(() => ({
        registration: continuation.promise.then(() =>
          registerPluginHttpRoute({
            registry: current.initial,
            path: "/webhook",
            auth: "plugin",
            source: "retired-owner",
            handler: vi.fn(),
            replaceExisting: true,
            throwOnFailure: true,
          }),
        ),
      })),
    );
    previous.publish(current.initial);
    await previous.instance.dispose();
    continuation.resolve();
    const error = await detached.registration.then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(current.initial.httpRoutes).toEqual([currentRoute]);
    expect(error).toMatchObject({ message: "plugin HTTP route owner is no longer active" });
    stopCurrent();
  });

  it("keeps cleanup exact across replacement and another staged generation", () => {
    const owner = createWebhookOwner();
    const stopOld = owner.register();
    const next = owner.prepare();
    owner.publish(next);
    const stopCurrent = owner.register({ replaceExisting: true });
    const replacement = findRegisteredPluginHttpRoute(next, "/webhook");
    const staged = owner.prepare();

    stopOld();
    expect(findRegisteredPluginHttpRoute(next, "/webhook")).toBe(replacement);
    expect(findRegisteredPluginHttpRoute(staged, "/webhook")).toBe(replacement);
    stopCurrent();
    expect(findRegisteredPluginHttpRoute(next, "/webhook")).toBeUndefined();
    expect(findRegisteredPluginHttpRoute(staged, "/webhook")).toBeUndefined();
  });
});
