// Gateway control-plane handlers for cold plugin catalog and lifecycle operations.
import { buildCapabilityConsentErrorDetails } from "../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import {
  buildClawHubTrustErrorDetails,
  ErrorCodes,
  errorShape,
  isClawHubTrustErrorCode,
  validatePluginsInspectParams,
  validatePluginsInstallParams,
  validatePluginsListParams,
  validatePluginsRefreshParams,
  validatePluginsReloadParams,
  validatePluginsSearchParams,
  validatePluginsSetEnabledParams,
  validatePluginsUninstallParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED,
  readInstallPolicyWarningErrorDetails,
} from "../../../packages/gateway-protocol/src/install-policy-warning-error-details.js";
import type {
  PluginsInstallResult,
  PluginsUninstallResult,
} from "../../../packages/gateway-protocol/src/schema/plugins.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { searchInstallablePluginPackages } from "../../plugins/catalog-search.js";
import {
  capturePluginRuntimeApplications,
  getPluginRuntimeGeneration,
  projectPluginRuntimeFailure,
  type PluginRuntimeApplication,
} from "../../plugins/lifecycle.js";
import { ManagedPluginLifecycleError } from "../../plugins/management-lifecycle-error.js";
import {
  inspectManagedPlugin,
  installManagedPlugin,
  listManagedPlugins,
  refreshManagedPlugins,
  reloadManagedPlugin,
  setManagedPluginEnabled,
  uninstallManagedPlugin,
} from "../../plugins/management-service.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { listPluginServiceHealthFailures } from "../../plugins/service-health.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";
import { assertValidParams, type Validator } from "./validation.js";

function pluginLifecycleError(error: unknown, application?: PluginRuntimeApplication) {
  const failure = projectPluginRuntimeFailure(error, application);
  const lifecycleError = error instanceof ManagedPluginLifecycleError ? error : undefined;
  const trustCode =
    lifecycleError?.code && isClawHubTrustErrorCode(lifecycleError.code)
      ? lifecycleError.code
      : undefined;
  const details = lifecycleError?.capabilityConsent
    ? buildCapabilityConsentErrorDetails(lifecycleError.capabilityConsent)
    : lifecycleError?.installPolicyWarning
      ? readInstallPolicyWarningErrorDetails({
          installPolicyCode: INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED,
          ...lifecycleError.installPolicyWarning,
        })
      : lifecycleError
        ? buildClawHubTrustErrorDetails({
            ...(trustCode ? { code: trustCode } : {}),
            ...(lifecycleError.version ? { version: lifecycleError.version } : {}),
            ...(lifecycleError.warning ? { warning: lifecycleError.warning } : {}),
          })
        : undefined;
  const metadata =
    details ??
    (lifecycleError?.installRejected
      ? {
          pluginInstallRejected: true,
          ...(lifecycleError.code ? { pluginInstallCode: lifecycleError.code } : {}),
          ...(lifecycleError.installSource
            ? { pluginInstallSource: lifecycleError.installSource }
            : {}),
        }
      : undefined);
  return errorShape(
    lifecycleError?.kind === "invalid-request"
      ? ErrorCodes.INVALID_REQUEST
      : ErrorCodes.UNAVAILABLE,
    failure.message,
    failure.runtime
      ? {
          details: {
            ...metadata,
            runtime: failure.runtime,
            ...(failure.runtimeAttempt ? { runtimeAttempt: failure.runtimeAttempt } : {}),
          },
        }
      : metadata
        ? { details: metadata }
        : undefined,
  );
}

type PluginLifecycleResult = Partial<
  Pick<PluginsInstallResult, "plugin" | "warnings"> &
    Pick<PluginsUninstallResult, "pluginId" | "removed">
> & { application?: PluginRuntimeApplication };

type PluginLifecycleOptions = Required<
  Pick<Parameters<typeof installManagedPlugin>[0], "applyRuntime" | "beforePersistentApply">
> & { signal?: AbortSignal };

function lifecycleHandler<T>(
  method: string,
  validate: Validator<T>,
  run: (params: T, lifecycle: PluginLifecycleOptions) => Promise<PluginLifecycleResult>,
): GatewayRequestHandler {
  return async ({ params, respond, context, signal, sessionMutationCommitGuard }) => {
    if (!assertValidParams(params, validate, method, respond)) {
      return;
    }
    let captured: ReturnType<typeof capturePluginRuntimeApplications> | undefined;
    try {
      const applyRuntime = context.applyPluginLifecycleChange;
      if (!applyRuntime) {
        throw new Error("Plugin lifecycle changes require a running Gateway.");
      }
      const beforePersistentApply = () => {
        signal?.throwIfAborted();
        sessionMutationCommitGuard?.();
      };
      beforePersistentApply();
      captured = capturePluginRuntimeApplications((change) => {
        beforePersistentApply();
        return applyRuntime({
          ...change,
          assertInvokerOwned: () => {
            beforePersistentApply();
            change.assertInvokerOwned?.();
          },
        });
      });
      const { application, plugin, pluginId, removed, warnings } = await run(params, {
        applyRuntime: captured.applyRuntime,
        beforePersistentApply,
        ...(signal ? { signal } : {}),
      });
      if (!application) {
        throw new Error("Plugin lifecycle did not return a runtime application receipt.");
      }
      respond(
        true,
        {
          ok: true,
          restartRequired: false,
          runtime: application,
          ...(plugin ? { plugin } : {}),
          ...(pluginId ? { pluginId } : {}),
          ...(removed ? { removed } : {}),
          ...(warnings ? { warnings } : {}),
        },
        undefined,
      );
    } catch (error) {
      respond(false, undefined, pluginLifecycleError(error, captured?.application));
    }
  };
}

/** Gateway handlers for plugin inventory, ClawHub search, install, and policy state. */
export const pluginsHandlers: GatewayRequestHandlers = {
  "plugins.refresh": lifecycleHandler(
    "plugins.refresh",
    validatePluginsRefreshParams,
    (_params, lifecycle) => refreshManagedPlugins(lifecycle),
  ),
  "plugins.reload": lifecycleHandler(
    "plugins.reload",
    validatePluginsReloadParams,
    (params, lifecycle) => reloadManagedPlugin({ ...params, ...lifecycle }),
  ),
  "plugins.list": async ({ params, respond }) => {
    if (!assertValidParams(params, validatePluginsListParams, "plugins.list", respond)) {
      return;
    }
    try {
      const catalog = await listManagedPlugins({});
      // Read runtime facts together after catalog I/O; a retained request scope may own an older registry.
      const registry = getActivePluginRegistry();
      const records = new Map(registry?.plugins.map((record) => [record.id, record]));
      const failures = new Map(
        registry
          ? listPluginServiceHealthFailures(registry).map((failure) => [failure.pluginId, failure])
          : [],
      );
      respond(
        true,
        {
          ...catalog,
          generation: getPluginRuntimeGeneration(),
          plugins: catalog.plugins.map((plugin) => {
            const record = records.get(plugin.id);
            const failure = failures.get(plugin.id);
            const error = failure ? `${failure.serviceId}: ${failure.error}` : record?.error;
            return Object.assign(plugin, {
              runtime: {
                state:
                  record?.status === "loaded"
                    ? failure
                      ? "service-failed"
                      : "active"
                    : record?.status === "disabled"
                      ? "disabled"
                      : "unloaded",
                ...(error ? { error: error.slice(0, 2000) } : {}),
              },
            });
          }),
        },
        undefined,
      );
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
  },
  "plugins.inspect": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validatePluginsInspectParams, "plugins.inspect", respond)) {
      return;
    }
    try {
      respond(
        true,
        await inspectManagedPlugin({
          config: context.getRuntimeConfig(),
          pluginId: params.pluginId,
        }),
        undefined,
      );
    } catch (error) {
      respond(false, undefined, pluginLifecycleError(error));
    }
  },
  "plugins.search": async ({ params, respond }) => {
    if (!assertValidParams(params, validatePluginsSearchParams, "plugins.search", respond)) {
      return;
    }
    try {
      const results = await searchInstallablePluginPackages({
        query: params.query,
        limit: params.limit,
      });
      respond(
        true,
        {
          results: results.flatMap((entry) => {
            if (
              entry.package.family !== "code-plugin" &&
              entry.package.family !== "bundle-plugin"
            ) {
              return [];
            }
            const downloads = entry.package.stats?.downloads;
            return [
              {
                score: entry.score,
                package: {
                  name: entry.package.name,
                  displayName: entry.package.displayName,
                  family: entry.package.family,
                  channel: entry.package.channel,
                  isOfficial: entry.package.isOfficial,
                  ...(entry.package.summary ? { summary: entry.package.summary } : {}),
                  ...(entry.package.latestVersion
                    ? { latestVersion: entry.package.latestVersion }
                    : {}),
                  ...(entry.package.runtimeId ? { runtimeId: entry.package.runtimeId } : {}),
                  ...(typeof downloads === "number" && Number.isFinite(downloads) && downloads >= 0
                    ? { downloads }
                    : {}),
                  ...(entry.package.verificationTier
                    ? { verificationTier: entry.package.verificationTier }
                    : {}),
                },
              },
            ];
          }),
        },
        undefined,
      );
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
  },
  "plugins.install": lifecycleHandler(
    "plugins.install",
    validatePluginsInstallParams,
    (params, lifecycle) => installManagedPlugin({ request: params, ...lifecycle }),
  ),
  "plugins.uninstall": lifecycleHandler(
    "plugins.uninstall",
    validatePluginsUninstallParams,
    (params, lifecycle) => uninstallManagedPlugin({ ...params, ...lifecycle }),
  ),
  "plugins.setEnabled": lifecycleHandler(
    "plugins.setEnabled",
    validatePluginsSetEnabledParams,
    (params, lifecycle) => setManagedPluginEnabled({ ...params, ...lifecycle }),
  ),
};
