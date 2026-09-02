import type { PluginInstanceAdmission } from "./plugin-instance.types.js";

/** Host resources share their instance's admission and disposal authority. */
export class PluginInstanceResources {
  private readonly resources = new WeakSet<object>();
  private readonly builtins = new Map<string, unknown>();
  private readonly timerCleanups = new Map<object, () => void>();
  private readonly emitters = new WeakMap<object, object>();

  constructor(
    private readonly instance: PluginInstanceAdmission,
    private readonly bindCallback: (callback: Function) => (...args: unknown[]) => unknown,
  ) {}

  wrapEmitter<T extends object>(target: T, overrides: Record<string, unknown> = {}): T {
    const cached = this.emitters.get(target);
    if (cached) {
      // SAFETY: Emitter views are cached only under their original object or that same view.
      return cached as T;
    }
    type Listener = {
      event: string | symbol;
      original: Function;
      wrapped: Function;
      release: () => void;
    };
    const listeners: Listener[] = [];
    const remove = (entry: Listener) => {
      const index = listeners.indexOf(entry);
      if (index >= 0) {
        listeners.splice(index, 1);
      }
      Reflect.apply(
        // SAFETY: These Node EventEmitter views preserve the callable removeListener contract.
        Reflect.get(target, "removeListener") as Function,
        target,
        [entry.event, entry.wrapped],
      );
      entry.release();
    };
    const facade = new Proxy(target, {
      get: (resource, key) => {
        if (typeof key === "string" && Object.hasOwn(overrides, key)) {
          return overrides[key];
        }
        const value = Reflect.get(resource, key, resource);
        if (typeof value !== "function") {
          return value;
        }
        if (
          ["on", "once", "addListener", "prependListener", "prependOnceListener"].includes(
            String(key),
          )
        ) {
          return (event: string | symbol, listener: Function) =>
            this.instance.run(() => {
              const callback = this.bindCallback(listener);
              const entry: Listener = {
                event,
                original: listener,
                wrapped: callback,
                release: () => {},
              };
              if (key === "once" || key === "prependOnceListener") {
                entry.wrapped = function (this: unknown, ...args: unknown[]) {
                  remove(entry);
                  return Reflect.apply(callback, this, args);
                };
              }
              entry.release = this.instance.lifecycle.onDispose(() => remove(entry));
              listeners.push(entry);
              Reflect.apply(value, resource, [event, entry.wrapped]);
              return facade;
            });
        }
        if (key === "off" || key === "removeListener") {
          return (event: string | symbol, listener: Function) => {
            const entry = listeners.findLast(
              (candidate) => candidate.event === event && candidate.original === listener,
            );
            if (entry) {
              remove(entry);
            }
            return facade;
          };
        }
        if (key === "removeAllListeners") {
          return (event?: string | symbol) => {
            for (const entry of listeners.filter(
              (candidate) => event === undefined || event === candidate.event,
            )) {
              remove(entry);
            }
            return facade;
          };
        }
        if (key === "listeners") {
          return (event: string | symbol) => {
            const registered: Function[] = Reflect.apply(value, resource, [event]);
            return registered.map(
              (listener) =>
                listeners.find((entry) => entry.wrapped === listener)?.original ?? listener,
            );
          };
        }
        return value.bind(resource);
      },
    });
    this.emitters.set(target, facade);
    this.emitters.set(facade, facade);
    return facade;
  }

  loadBuiltin(specifier: string, load: (specifier: string) => unknown): unknown {
    const name = specifier.replace(/^node:/, "");
    if (this.builtins.has(name)) {
      return this.builtins.get(name);
    }
    // SAFETY: Callers resolve only Node builtin module namespace objects through this entry point.
    const loaded = load(specifier) as Record<string, unknown>;
    if (name === "process") {
      return this.processFacade(load);
    }
    const result = { ...loaded };
    if (name === "timers") {
      Object.assign(result, this.globals);
    } else if (name === "timers/promises") {
      for (const key of ["setTimeout", "setImmediate", "setInterval"]) {
        // SAFETY: These three Node timers/promises exports are functions with the indexed options argument.
        const method = loaded[key] as Function;
        result[key] = (...args: unknown[]) => {
          const index = key === "setImmediate" ? 1 : 2;
          // SAFETY: The facade preserves Node's public timer signature, including its optional signal.
          const options = args[index] as { signal?: AbortSignal } | undefined;
          args[index] = {
            ...options,
            signal: options?.signal
              ? AbortSignal.any([options.signal, this.instance.lifecycle.signal])
              : this.instance.lifecycle.signal,
          };
          return Reflect.apply(method, loaded, args);
        };
      }
    } else if (
      ["http", "https", "http2", "net", "tls", "fs", "child_process", "worker_threads"].includes(
        name,
      )
    ) {
      const factories = new Set([
        "createServer",
        "createConnection",
        "connect",
        "request",
        "get",
        "watch",
        "spawn",
        "fork",
        "exec",
        "execFile",
        "Worker",
        "Server",
        "Socket",
        "TLSSocket",
      ]);
      const retain = (resource: Record<PropertyKey, unknown>) => {
        if (!resource || this.resources.has(resource)) {
          return this.emitters.get(resource) ?? resource;
        }
        this.resources.add(resource);
        const remove = this.instance.lifecycle.onDispose(async () => {
          const asyncDispose = resource[Symbol.asyncDispose];
          if (typeof asyncDispose === "function") {
            await Reflect.apply(asyncDispose, resource, []);
            return;
          }
          for (const method of ["destroy", "terminate", "kill", "close"]) {
            const cleanup = resource[method];
            if (typeof cleanup === "function") {
              await Reflect.apply(cleanup, resource, []);
              return;
            }
          }
        });
        if (typeof resource.once === "function") {
          Reflect.apply(resource.once, resource, ["close", remove]);
        }
        return typeof resource.on === "function" ? this.wrapEmitter(resource) : resource;
      };
      for (const [key, value] of Object.entries(loaded)) {
        if (!factories.has(key) || typeof value !== "function") {
          continue;
        }
        const argsWithCallbacks = (args: unknown[]) =>
          args.map((arg) => (typeof arg === "function" ? this.bindCallback(arg) : arg));
        result[key] = new Proxy(value, {
          apply: (target, receiver, args) =>
            this.instance.run(() => {
              this.instance.lifecycle.signal.throwIfAborted();
              return retain(Reflect.apply(target, receiver, argsWithCallbacks(args)));
            }),
          construct: (target, args) =>
            this.instance.run(() => {
              this.instance.lifecycle.signal.throwIfAborted();
              return retain(Reflect.construct(target, argsWithCallbacks(args)));
            }),
        });
      }
    } else {
      return loaded;
    }
    this.builtins.set(name, result);
    return result;
  }

  private processFacade(load: (specifier: string) => unknown): NodeJS.Process {
    const cached = this.builtins.get("process");
    if (cached) {
      // SAFETY: Only processFacade writes the process cache key, always with this process view.
      return cached as NodeJS.Process;
    }
    const facade = this.wrapEmitter(process, {
      env: { ...process.env },
      getBuiltinModule: (name: string) =>
        this.loadBuiltin(`node:${name.replace(/^node:/, "")}`, load),
      nextTick: (callback: Function, ...args: unknown[]) =>
        this.instance.run(() => process.nextTick(this.bindCallback(callback), ...args)),
    });
    this.builtins.set("process", facade);
    return facade;
  }

  prepareGlobals(load: (specifier: string) => unknown): Record<string, unknown> {
    return { ...this.globals, process: this.processFacade(load) };
  }

  private retainTimer(handle: object, cancel: () => void): () => void {
    let remove: () => void;
    try {
      remove = this.instance.lifecycle.onDispose(() => {
        this.timerCleanups.delete(handle);
        cancel();
      });
    } catch (error) {
      cancel();
      throw error;
    }
    this.timerCleanups.set(handle, remove);
    return () => this.releaseTimer(handle);
  }

  private releaseTimer(handle: unknown): void {
    if (handle && typeof handle === "object") {
      this.timerCleanups.get(handle)?.();
      this.timerCleanups.delete(handle);
    }
  }

  readonly globals = {
    setTimeout: (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      this.instance.run(() => {
        const invoke = this.bindCallback(callback);
        const handle = setTimeout(() => {
          remove();
          invoke(...args);
        }, delay);
        const remove = this.retainTimer(handle, () => clearTimeout(handle));
        return handle;
      }),
    clearTimeout: (handle: Parameters<typeof clearTimeout>[0]) => {
      this.releaseTimer(handle);
      clearTimeout(handle);
    },
    setInterval: (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      this.instance.run(() => {
        const handle = setInterval(this.bindCallback(callback), delay, ...args);
        this.retainTimer(handle, () => clearInterval(handle));
        return handle;
      }),
    clearInterval: (handle: Parameters<typeof clearInterval>[0]) => {
      this.releaseTimer(handle);
      clearInterval(handle);
    },
    setImmediate: (callback: (...args: unknown[]) => void, ...args: unknown[]) =>
      this.instance.run(() => {
        const invoke = this.bindCallback(callback);
        const handle = setImmediate(() => {
          remove();
          invoke(...args);
        });
        const remove = this.retainTimer(handle, () => clearImmediate(handle));
        return handle;
      }),
    clearImmediate: (handle: Parameters<typeof clearImmediate>[0]) => {
      this.releaseTimer(handle);
      clearImmediate(handle);
    },
  };

  clear(): void {
    this.builtins.clear();
  }
}
