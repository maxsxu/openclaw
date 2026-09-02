import { types } from "node:util";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { PluginInstanceResources } from "./plugin-instance-resources.js";
import {
  pluginInstanceState,
  resolvePluginInstanceOwner,
  type PluginInstanceHandle,
  type PluginInstanceOwner,
} from "./plugin-instance-scope.js";
import type { PluginInstanceLifecycle } from "./plugin-instance.types.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import {
  withPluginRuntimePluginScope,
  withPluginRuntimeRegistryScope,
} from "./runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "./runtime/generation-scope.js";

const { values: valueInstances, invocation } = pluginInstanceState;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const DATA_FIELDS = new Set([
  "parameters",
  "schema",
  "configSchema",
  "configJsonSchema",
  "inputSchema",
  "outputSchema",
]);

function isPluginData(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== "object") {
    return typeof value !== "function";
  }
  if (
    types.isAnyArrayBuffer(value) ||
    types.isArrayBufferView(value) ||
    types.isDate(value) ||
    types.isRegExp(value) ||
    types.isNativeError(value)
  ) {
    return true;
  }
  if (seen.has(value)) {
    return true;
  }
  seen.add(value);
  if (types.isMap(value)) {
    return [...value].every(([key, entry]) => isPluginData(key, seen) && isPluginData(entry, seen));
  }
  if (types.isSet(value)) {
    return [...value].every((entry) => isPluginData(entry, seen));
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== null && Object.getPrototypeOf(prototype) !== null) {
    return false;
  }
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return "value" in descriptor && isPluginData(descriptor.value, seen);
  });
}

function settlePluginCall<T>(
  pending: PromiseLike<T>,
  release: () => void | Promise<void>,
): Promise<T> {
  return Promise.resolve(pending).then(
    async (result) => {
      await release();
      return result;
    },
    async (error: unknown) => {
      // Preserve the call's failure; lifecycle observers still receive cleanup failures.
      await release()?.catch(() => {});
      throw error;
    },
  );
}

function readPluginMember(
  object: object,
  key: PropertyKey,
  invoke: (run: () => unknown) => unknown,
): unknown {
  let descriptor: PropertyDescriptor | undefined;
  for (
    let source: object | null = object;
    source && !descriptor;
    source = Object.getPrototypeOf(source)
  ) {
    descriptor = Object.getOwnPropertyDescriptor(source, key);
  }
  return descriptor?.get
    ? invoke(() => Reflect.get(object, key, object))
    : Reflect.get(object, key, object);
}

export class PluginInstance implements PluginInstanceHandle {
  readonly slots = new Map<string | symbol, { runtime: unknown }>();
  readonly controller = new AbortController();
  readonly lifecycle: PluginInstanceLifecycle;
  sourceDigest?: string;
  private moduleLoader?: (source: string) => unknown;
  private moduleSourceExists?: (source: string) => boolean;
  private accepting = true;
  private readonly calls = new Set<object>();
  private readonly cleanups = new Set<() => void | Promise<void>>();
  private readonly waiters = new Set<() => void>();
  private readonly wrapped = new WeakMap<object, unknown>();
  private disposal?: Promise<void>;
  private readonly resources = new PluginInstanceResources(this, (callback) =>
    this.bindCallback(callback),
  );
  readonly globals = this.resources.globals;
  readonly owner?: PluginInstanceOwner;

  constructor(
    readonly pluginId: string,
    owner?: { record: PluginRecord; registry: PluginRegistry },
  ) {
    if (owner) {
      this.owner = resolvePluginInstanceOwner(owner.record, owner.registry);
      if (this.owner.instance) {
        throw new Error(`Plugin ${pluginId} already owns a runtime instance`);
      }
      this.owner.instance = this;
    }
    this.lifecycle = Object.freeze({
      signal: this.controller.signal,
      onDispose: (cleanup: () => void | Promise<void>) => {
        const current = invocation.getStore();
        if (
          this.controller.signal.aborted ||
          ((!this.accepting || this.owner?.revoked) &&
            !(current?.instance === this && this.calls.has(current.token)))
        ) {
          throw new Error(`Plugin ${pluginId} is retiring`);
        }
        this.cleanups.add(cleanup);
        return () => {
          this.cleanups.delete(cleanup);
        };
      },
    });
  }

  run<T>(run: () => T): T {
    const current = invocation.getStore();
    if (current?.instance === this && this.calls.has(current.token)) {
      return this.enter(current.token, run);
    }
    if (!this.accepting || this.owner?.revoked) {
      throw new Error(`Plugin ${this.pluginId} was reloaded or disabled; use its current tools.`);
    }
    return this.invoke(run);
  }

  /** Only lifecycle owners may admit teardown after ordinary calls have stopped. */
  runCleanup<T>(run: () => T): T {
    const current = invocation.getStore();
    if (current?.instance === this && this.calls.has(current.token)) {
      return this.enter(current.token, run);
    }
    this.controller.signal.throwIfAborted();
    return this.invoke(run);
  }

  private invoke<T>(run: () => T, joinDisposal = true): T {
    const { token, release } = this.lease(joinDisposal);
    try {
      const value = this.enter(token, run);
      if (isPromiseLike(value)) {
        // SAFETY: Promise-like calls retain their resolved value while joining owner cleanup.
        return settlePluginCall(value, release) as T;
      }
      void release();
      return value;
    } catch (error) {
      void release();
      throw error;
    }
  }

  private enter<T>(token: object, run: () => T): T {
    const invoke = () => invocation.run({ instance: this, token }, run);
    if (!this.owner) {
      return invoke();
    }
    const { record } = this.owner;
    const generation = getPluginRuntimeGenerationRegistry();
    // Prepared callers retain their catalog; detached work follows the same
    // instance when publication adopts it into a replacement registry.
    const registry = generation?.plugins.includes(record) ? generation : this.owner.registry;
    return withPluginRuntimeRegistryScope(registry, () =>
      withPluginRuntimePluginScope(
        {
          pluginId: record.id,
          pluginSource: record.source,
          pluginOrigin: record.origin,
          pluginTrustedOfficialInstall: record.trustedOfficialInstall,
        },
        invoke,
      ),
    );
  }

  private lease(joinDisposal = true) {
    const token = {};
    this.calls.add(token);
    return {
      token,
      release: () => {
        this.calls.delete(token);
        for (const wake of this.waiters) {
          wake();
        }
        // Earlier borrowers may feed other calls or hand off a stream. Only the
        // last borrower joins disposal; cleanup callbacks cannot await themselves.
        return joinDisposal && this.calls.size === 0 && !this.controller.signal.aborted
          ? this.disposal
          : undefined;
      },
    };
  }

  private wrapResult<T>(result: T): T {
    if (isPromiseLike(result)) {
      // SAFETY: Promise-like results retain their resolved type while callable values stay owned.
      return Promise.resolve(result).then((resolved) => this.wrap(resolved)) as T;
    }
    return this.wrap(result);
  }

  /** Callables retain their instance; schemas remain data for host validators. */
  wrap<T>(value: T, field = ""): T {
    if ((!value || typeof value !== "object") && typeof value !== "function") {
      return value;
    }
    // Native APIs and structuredClone reject Proxy data, including byte views.
    if (DATA_FIELDS.has(field) || isPluginData(value)) {
      return value;
    }
    const object: object = value;
    const cached = this.wrapped.get(object);
    if (cached) {
      // SAFETY: The cache stores only the view created for this exact input value.
      return cached as T;
    }
    const methods = new Map<PropertyKey, { original: Function; wrapped: unknown }>();
    const read = (key: PropertyKey) => {
      const property = readPluginMember(object, key, (run) => this.run(run));
      // Constructor prototypes retain JavaScript identity and instanceof semantics.
      if (key === "prototype" && typeof value === "function") {
        return property;
      }
      if (typeof property !== "function" || key === "constructor") {
        return this.wrap(property, String(key));
      }
      const cachedMethod = methods.get(key);
      if (cachedMethod && cachedMethod.original === property) {
        return cachedMethod.wrapped;
      }
      const bound = this.wrap(Function.prototype.bind.call(property, object), String(key));
      methods.set(key, { original: property, wrapped: bound });
      return bound;
    };
    const descriptor = (key: PropertyKey): PropertyDescriptor | undefined => {
      const original = Object.getOwnPropertyDescriptor(object, key);
      if (!original) {
        return undefined;
      }
      const flags = {
        configurable: key !== "length" || !Array.isArray(value),
        enumerable: original.enumerable,
      };
      return "value" in original
        ? { ...flags, writable: original.writable, value: read(key) }
        : {
            ...flags,
            get: original.get ? () => read(key) : undefined,
            set: original.set
              ? (next: unknown) => this.run(() => Reflect.set(object, key, next, object))
              : undefined,
          };
    };
    if (typeof value === "function") {
      const invoke = (run: () => unknown) => this.run(() => this.wrapResult(run()));
      // A bound target has no fixed static properties, so frozen exports can
      // expose fenced members without violating Proxy descriptor invariants.
      const wrapped: Function = new Proxy(Function.prototype.bind.call(value, undefined), {
        get: (_target, key) => read(key),
        ownKeys: () => Reflect.ownKeys(object),
        getOwnPropertyDescriptor: (_target, key) => descriptor(key),
        apply: (_target, receiver, args) => invoke(() => Reflect.apply(value, receiver, args)),
        construct: (_target, args, newTarget): object => {
          const constructed = invoke(() =>
            Reflect.construct(value, args, newTarget === wrapped ? value : newTarget),
          );
          // SAFETY: Reflect.construct returns an object; wrapping preserves that result shape.
          return constructed as object;
        },
        set: (_target, key, next) => this.run(() => Reflect.set(object, key, next, object)),
        deleteProperty: (_target, key) => this.run(() => Reflect.deleteProperty(object, key)),
      });
      this.wrapped.set(object, wrapped);
      this.wrapped.set(wrapped, wrapped);
      valueInstances.set(wrapped, this);
      // SAFETY: This callable view preserves the original function's members and construct behavior.
      return wrapped as T;
    }
    if (
      typeof readPluginMember(object, Symbol.asyncIterator, (run) => this.run(run)) === "function"
    ) {
      // SAFETY: The iterator factory is verified above; its view preserves the original stream members.
      return this.wrapIterable(object as AsyncIterable<unknown>) as T;
    }
    // A view preserves class/private-field receivers and live properties. A plain
    // record copy loses both; proxying a frozen original forbids wrapped methods.
    const result = new Proxy(
      Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(object)),
      {
        get: (_target, key) => read(key),
        has: (_target, key) => Reflect.has(object, key),
        ownKeys: () => Reflect.ownKeys(object),
        getOwnPropertyDescriptor: (_target, key) => descriptor(key),
        set: (_target, key, next) => this.run(() => Reflect.set(object, key, next, object)),
        deleteProperty: (_target, key) => this.run(() => Reflect.deleteProperty(object, key)),
      },
    );
    this.wrapped.set(object, result);
    this.wrapped.set(result, result);
    valueInstances.set(result, this);
    // SAFETY: The view retains the input prototype and routes each member to the original object.
    return result as T;
  }

  private wrapIterable(source: AsyncIterable<unknown>): AsyncIterable<unknown> {
    const { token, release } = this.lease();
    let active = true;
    let iterating = 0;
    let consumerSettled = false;
    let terminalSettled = true;
    let completion: Promise<void> | undefined;
    const finish = () => {
      if (active) {
        active = false;
        completion = release();
      }
      return completion;
    };
    const invoke = <T>(run: () => T): T => {
      if (!active || !this.calls.has(token)) {
        throw new Error(`Plugin ${this.pluginId} stream is closed`);
      }
      return this.enter(token, run);
    };
    const finishWhenSettled = () => {
      if (consumerSettled && terminalSettled) {
        return finish();
      }
      return undefined;
    };
    // EventStream consumers commonly await result() after iteration has ended.
    // Capture that terminal promise while admitted; later reads execute no plugin code.
    let terminal: Promise<unknown> | undefined;
    try {
      const resultMethod = readPluginMember(source, "result", invoke);
      terminal =
        typeof resultMethod === "function"
          ? Promise.resolve(invoke(() => this.wrapResult(Reflect.apply(resultMethod, source, []))))
          : undefined;
    } catch (error) {
      void finish();
      throw error;
    }
    if (terminal) {
      terminalSettled = false;
      const settle = () => {
        terminalSettled = true;
        return finishWhenSettled();
      };
      terminal = settlePluginCall(terminal, settle);
      void terminal.catch(() => {});
    }
    const iterators = new WeakMap<object, object>();
    const wrapIterator = (iterator: AsyncIterator<unknown> | AsyncIterable<unknown>) => {
      const cached = iterators.get(iterator);
      if (cached) {
        return cached;
      }
      iterating += 1;
      let done = false;
      const settle = () => {
        if (!done) {
          done = true;
          if (--iterating === 0) {
            consumerSettled = true;
            return finishWhenSettled();
          }
        }
        return undefined;
      };
      const view: object = new Proxy(Object.create(Object.getPrototypeOf(iterator)), {
        get: (_item, method) => {
          if (method === Symbol.asyncIterator) {
            return () => view;
          }
          const value = readPluginMember(iterator, method, invoke);
          if (typeof value !== "function") {
            return this.wrap(value, String(method));
          }
          // Helper results keep their own return shape; only protocol methods finish iteration.
          if (method !== "next" && method !== "return" && method !== "throw") {
            return (...args: unknown[]) =>
              invoke(() => this.wrapResult(Reflect.apply(value, iterator, args)));
          }
          return async (...args: unknown[]) => {
            try {
              const next: IteratorResult<unknown> = await invoke(() =>
                this.wrapResult(Reflect.apply(value, iterator, args)),
              );
              if (invoke(() => next?.done)) {
                await settle();
              }
              return next;
            } catch (error) {
              await settle()?.catch(() => {});
              throw error;
            }
          };
        },
      });
      iterators.set(iterator, view);
      valueInstances.set(view, this);
      return view;
    };
    const result = new Proxy<AsyncIterable<unknown>>(Object.create(Object.getPrototypeOf(source)), {
      get: (_target, key) => {
        if (key === Symbol.asyncIterator) {
          return () => wrapIterator(invoke(() => source[Symbol.asyncIterator]()));
        }
        if (key === "result" && terminal) {
          return () =>
            settlePluginCall(terminal, () => {
              if (iterating === 0) {
                consumerSettled = true;
                return finishWhenSettled();
              }
              return undefined;
            });
        }
        const value = readPluginMember(source, key, invoke);
        if (typeof value !== "function") {
          return this.wrap(value, String(key));
        }
        if (key === "next" || key === "return" || key === "throw") {
          return Reflect.get(wrapIterator(source), key);
        }
        return (...args: unknown[]) =>
          invoke(() => this.wrapResult(Reflect.apply(value, source, args)));
      },
    });
    this.wrapped.set(source, result);
    this.wrapped.set(result, result);
    valueInstances.set(result, this);
    return result;
  }

  bindModuleLoader(
    load: (source: string) => unknown,
    hasSource?: (source: string) => boolean,
  ): void {
    if (this.moduleLoader) {
      throw new Error(`Plugin ${this.pluginId} already owns its module loader`);
    }
    this.moduleLoader = load;
    this.moduleSourceExists = hasSource;
  }

  loadModule(source: string): unknown {
    return this.run(() => {
      if (!this.moduleLoader) {
        throw new Error(`Plugin ${this.pluginId} has no captured module loader`);
      }
      return this.wrap(this.moduleLoader(source));
    });
  }

  hasModuleSource(source: string): boolean | undefined {
    return this.moduleSourceExists?.(source);
  }

  private bindCallback(callback: Function): (...args: unknown[]) => unknown {
    const admitted = invocation.getStore();
    const invoke = (receiver: unknown, args: unknown[]) => {
      const current = invocation.getStore();
      const active = [current, admitted].find(
        (scope) => scope?.instance === this && this.calls.has(scope.token),
      );
      if (!active && (this.controller.signal.aborted || !this.accepting || this.owner?.revoked)) {
        return undefined;
      }
      const scoped = (value: unknown) =>
        value && typeof value === "object" && typeof Reflect.get(value, "on") === "function"
          ? this.resources.wrapEmitter(value)
          : value;
      const call = () => Reflect.apply(callback, scoped(receiver), args.map(scoped));
      return active ? this.enter(active.token, call) : this.run(call);
    };
    return function (this: unknown, ...args: unknown[]) {
      return invoke(this, args);
    };
  }

  loadBuiltin(specifier: string, load: (specifier: string) => unknown): unknown {
    return this.resources.loadBuiltin(specifier, load);
  }

  prepareGlobals(load: (specifier: string) => unknown): Record<string, unknown> {
    return this.resources.prepareGlobals(load);
  }

  quiesce(): void {
    this.accepting = false;
  }

  drain(): Promise<void> {
    this.quiesce();
    const current = invocation.getStore();
    return this.waitForCalls(current?.instance === this ? current.token : undefined);
  }

  private async waitForCalls(ownToken?: object): Promise<void> {
    const settled = () => [...this.calls].every((token) => token === ownToken);
    if (settled()) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(wake);
        reject(
          new Error(
            `Plugin ${this.pluginId} still has active calls after ${SHUTDOWN_TIMEOUT_MS}ms`,
          ),
        );
      }, SHUTDOWN_TIMEOUT_MS);
      const wake = () => {
        if (settled()) {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        }
      };
      this.waiters.add(wake);
    });
  }

  resume(): void {
    if (!this.disposal && !this.controller.signal.aborted && !this.owner?.revoked) {
      this.accepting = true;
    }
  }

  dispose(beforeCleanup?: () => void | Promise<void>): Promise<void> {
    if (beforeCleanup && this.disposal) {
      return Promise.reject(new Error(`Plugin ${this.pluginId} disposal already started`));
    }
    if (!this.disposal) {
      this.quiesce();
      this.disposal = this.finishDisposal(beforeCleanup);
      // Self-retirement is joined by the last returning call or stream.
      void this.disposal.catch(() => {});
    }
    const current = invocation.getStore();
    return current?.instance === this && this.calls.has(current.token)
      ? Promise.resolve()
      : this.disposal;
  }

  private async finishDisposal(beforeCleanup?: () => void | Promise<void>): Promise<void> {
    if (this.owner) {
      this.owner.revoked = true;
    }
    const failures: unknown[] = [];
    let deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
    try {
      await this.waitForCalls();
    } catch (error) {
      failures.push(error);
    }
    // Retirement is final even when a borrower fails to drain. Revoke its
    // tokens before cleanup; only newly admitted cleanup callbacks may finish.
    this.calls.clear();
    if (beforeCleanup) {
      // Legacy host hooks own their individual bounds; resource cleanup must join
      // those hooks before applying its separate instance cleanup budget.
      try {
        // Their resources are still live; this internal lease cannot join the
        // disposal promise that is itself waiting for these hooks to finish.
        await this.invoke(beforeCleanup, false);
      } catch (error) {
        failures.push(error);
      }
      deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
    }
    this.controller.abort(new Error(`Plugin ${this.pluginId} is retiring`));
    for (const cleanup of Array.from(this.cleanups).toReversed()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.invoke(cleanup),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Plugin ${this.pluginId} cleanup did not settle`)),
              Math.max(0, deadline - Date.now()),
            );
          }),
        ]);
      } catch (error) {
        failures.push(error);
      } finally {
        clearTimeout(timer);
      }
    }
    this.cleanups.clear();
    this.calls.clear();
    for (const wake of this.waiters) {
      wake();
    }
    this.resources.clear();
    this.moduleLoader = undefined;
    this.slots.clear();
    if (failures.length) {
      throw new AggregateError(failures, `Plugin ${this.pluginId} cleanup failed`);
    }
  }
}
