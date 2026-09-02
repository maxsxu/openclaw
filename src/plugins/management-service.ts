// Structured plugin catalog and lifecycle operations shared by Gateway-facing surfaces.
import assert from "node:assert/strict";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { asSafeIntegerInRange } from "@openclaw/normalization-core/number-coercion";
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type {
  PluginCatalogEntry,
  PluginInspectSource,
  PluginsInstallParams,
  PluginsInspectResult,
  PluginsListResult,
} from "../../packages/gateway-protocol/src/schema/plugins.js";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import { collectChangedPaths } from "../config/config-change-paths.js";
import {
  assertConfigWriteAllowedInCurrentMode,
  readConfigFileSnapshotForWrite,
  replaceConfigFile,
} from "../config/config.js";
import { resolveConfigWidePluginMetadataSnapshot } from "../config/io.plugin-metadata.js";
import { resolveIsNixMode } from "../config/paths.js";
import { ensurePluginAllowlisted } from "../config/plugins-allowlist.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveArchiveKind } from "../infra/archive.js";
import { reportClawHubPluginInstallTelemetry } from "../infra/clawhub-packages.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { formatErrorMessage } from "../infra/errors.js";
import { buildNpmResolutionFields, type NpmSpecResolution } from "../infra/install-source-utils.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { normalizeUpdateChannel, resolveRegistryUpdateChannel } from "../infra/update-channels.js";
import { markClawPackageIndependentlyOwned } from "../state/claw-package-adoption.js";
import { withClawPackageLifecycleLease } from "../state/claw-package-lifecycle-lease.js";
import { VERSION } from "../version.js";
import { findBundledPluginSource, type BundledPluginSource } from "./bundled-sources.js";
import {
  prepareManagedPluginArtifactConsentHandler,
  resolvePendingPluginCapabilityReview,
  resolvePluginCapabilityConsent,
  type PluginCapabilityConsentAcknowledgment,
  type PluginCapabilityConsentHandler,
} from "./capability-consent.js";
import {
  buildPluginCapabilitySummary,
  computeDeclaredSurfaceHash,
  formatPluginCapabilityConsentRequired,
  resolveAcceptedSurfaceCurrent,
  resolvePluginInstallRecordIntegrity,
  resolvePluginInstallRecordTrust,
  resolvePluginPackageDeclaredSurface,
} from "./capability-summary.js";
import { CLAWHUB_INSTALL_ERROR_CODE, isUnavailableClawHubTarget } from "./clawhub-error-codes.js";
import {
  buildClawHubPluginInstallRecordFields,
  type ClawHubPluginInstallRecordFields,
} from "./clawhub-install-records.js";
import { installPluginFromClawHub } from "./clawhub.js";
import {
  appendPluginControlPlaneWorkspaceDiagnostic,
  resolvePluginControlPlaneWorkspace,
} from "./control-plane-workspace.js";
import { getProcessGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import { enableExplicitlySelectedPluginInConfig } from "./enable.js";
import { installPluginFromGitSpec } from "./git-install.js";
import {
  installWithSourceFallback,
  type PluginInstallSource,
  resolveClawHubInstallSpecsForUpdateChannel,
  resolveNpmInstallSpecsForUpdateChannel,
} from "./install-channel-specs.js";
import { loadConfigForInstall, PluginInstallConfigError } from "./install-config.js";
import { resolveDefaultPluginExtensionsDir } from "./install-paths.js";
import {
  selectInstallMutationWriteOptions,
  persistPluginInstall,
  type ConfigSnapshotForInstallPersist,
} from "./install-persistence.js";
import { resolveOpenClawTrustedNpmPackageInstall } from "./install-provenance.js";
import { commitPluginInstallRecordsWithConfig } from "./install-record-commit.js";
import { resolvePluginInstallRequestContext } from "./install-request-context.js";
import type { InstallSafetyOverrides } from "./install-security-scan.js";
import {
  requestDeferredPluginInstall,
  resolvePluginInstallTransaction,
} from "./install-transaction.js";
import {
  isUnavailableNpmTarget,
  PLUGIN_INSTALL_ERROR_CODE,
  type PluginInstallLogger,
  type InstallPluginResult,
} from "./install-types.js";
import {
  installPluginFromNpmPackArchive,
  installPluginFromNpmSpec,
  installPluginFromPath,
} from "./install.js";
import {
  loadInstalledPluginIndexInstallRecords,
  removePluginInstallRecordFromRecords,
  withPluginInstallRecords,
  withoutPluginInstallRecords,
} from "./installed-plugin-index-records.js";
import { createInstalledPluginIndexScopeLookup } from "./installed-plugin-index-scope-lookup.js";
import { isInstalledPluginEnabled } from "./installed-plugin-index.js";
import {
  resolveInstalledPluginLifecycleOwnership,
  resolveInstalledPluginPackageOwnership,
} from "./installed-plugin-package-ownership.js";
import type { PluginLifecycleRuntimeApply, PluginRuntimeApplication } from "./lifecycle.js";
import { ManagedPluginLifecycleError } from "./management-lifecycle-error.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import { installPluginFromMarketplace } from "./marketplace.js";
import {
  resolveTrustedOfficialClawHubPackageName,
  resolveTrustedSourceLinkedOfficialClawHubSpec,
  resolveTrustedSourceLinkedOfficialNpmSpec,
} from "./official-external-install-records.js";
import { resolveOfficialInstallSources } from "./official-external-install-trust.js";
import {
  getOfficialExternalPluginCatalogEntryForPackage,
  getOfficialExternalPluginCatalogManifest,
  listOfficialExternalPluginCatalogEntries,
  loadConfiguredHostedOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
  resolveOfficialExternalPluginInstallSources,
  resolveOfficialExternalPluginLabel,
  type HostedOfficialExternalPluginCatalogLoadResult,
  type OfficialExternalPluginCatalogEntry,
} from "./official-external-plugin-catalog.js";
import { tracksPluginDependencyStatus } from "./official-external-plugin-repair-hints.js";
import {
  createPluginCache,
  getPluginCache,
  getPluginMetadataSnapshotCache,
  getProcessPluginCache,
  getScopedPluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import {
  loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { resolveManifestProviderAuthChoices } from "./provider-auth-choices.js";
import { listRecommendedToolInstalls } from "./recommended-tool-installs.js";
import { refreshPluginRegistryAfterConfigMutation } from "./registry-refresh.js";
import { applySlotSelectionForPlugin } from "./slot-selection.js";
import {
  buildPluginDependencyStatus,
  projectPluginDependencyHealth,
} from "./status-dependencies-core.js";
import { setPluginEnabledInConfig } from "./toggle-config.js";
import { collectClawPluginUninstallWarnings } from "./uninstall-claw-references.js";
import {
  prepareConfigForDisabledPluginSet,
  recordPluginPackageUninstallPlan,
} from "./uninstall-package-plan.js";
import { resolvePluginUninstallId } from "./uninstall-selection.js";
import {
  applyPluginUninstallDirectoryRemoval,
  formatUninstallActionLabels,
  formatUninstallSlotResetPreview,
  planPluginUninstall,
  pluginUninstallTargetExists,
  resolveUninstallChannelConfigKeys,
  UNINSTALL_ACTION_LABELS,
} from "./uninstall.js";

type ManagedPluginCatalogEntry = PluginCatalogEntry;
type ManagedPluginCatalog = PluginsListResult;

export type ManagedPluginInspection = PluginsInspectResult;

type ManagedPluginInstallRequest = PluginsInstallParams;

type ManagedPluginMutationOptions = {
  applyRuntime?: PluginLifecycleRuntimeApply;
  beforePersistentApply?: () => void;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

type ResolvedRegistryInstallOptions = {
  /** Preserve the operator's selector when the install targets a release cohort. */
  recordSpec?: string;
  /** Host-validated provenance; never copied from the public install request. */
  trustedSourceLinkedOfficialInstall?: boolean;
};

type ManagedPluginSourceInstallRequest =
  | (Extract<PluginsInstallParams, { source: "local" }> & {
      recordSource: "archive" | "path";
      bundledOrigin?: true;
    })
  | Extract<PluginsInstallParams, { source: "npm-pack" | "git" | "marketplace" }>
  | (Extract<PluginsInstallParams, { source: "npm" }> & ResolvedRegistryInstallOptions)
  | (Omit<Extract<PluginsInstallParams, { source: "clawhub" }>, "packageName" | "version"> &
      ResolvedRegistryInstallOptions & {
        spec: string;
      })
  | (Extract<PluginsInstallParams, { source: "official" }> & {
      spec: string;
      installSources: PluginInstallSource[];
      expectedPluginId?: string;
    })
  | { source: "bundled"; bundledSource: BundledPluginSource };

type ManagedPluginSourceInstallResult =
  | {
      ok: true;
      pluginId: string;
      config: OpenClawConfig;
      warnings?: string[];
      targetDir?: string;
      version?: string;
      npmResolution?: NpmSpecResolution;
      clawhub?: ClawHubPluginInstallRecordFields;
      application?: PluginRuntimeApplication;
    }
  | SourceInstallFailure;

type SourceInstallFailure = Extract<
  Awaited<ReturnType<typeof installPluginFromClawHub>>,
  { ok: false }
> & { installSource?: PluginInstallSource };

type OfficialCatalogResult = Pick<HostedOfficialExternalPluginCatalogLoadResult, "entries"> & {
  error?: string;
  hostedFeaturedAuthoritative?: boolean;
};

function getManagedPluginCache(metadata?: PluginMetadataSnapshot) {
  if (metadata) {
    return getPluginMetadataSnapshotCache(metadata);
  }
  const scoped = getScopedPluginCache();
  if (scoped?.kind === "operation") {
    return scoped;
  }
  const candidate = getProcessPluginCache().desiredMetadata;
  if (candidate && candidate.boot === getProcessGatewayPluginMetadataSnapshot()) {
    return candidate.cache;
  }
  return getPluginCache();
}

function withManagedPluginCache<
  TParams extends { config?: OpenClawConfig; metadata?: PluginMetadataSnapshot },
  TResult,
>(run: (params: TParams) => Promise<TResult>): (params: TParams) => Promise<TResult> {
  return (params) => withPluginCache(getManagedPluginCache(params.metadata), () => run(params));
}

function resolveManagedPluginDiagnostics(
  snapshot: PluginMetadataSnapshot,
  config: OpenClawConfig,
): PluginDiagnostic[] {
  const dependencies = getManagedPluginCache().dependencyStatus;
  const { diagnostics } = projectPluginDependencyHealth({
    plugins: snapshot.index.plugins.map((record) => {
      const manifest = snapshot.byPluginId.get(record.pluginId);
      const enabled = isInstalledPluginEnabled(snapshot.index, record.pluginId, config);
      const tracksDependencies = tracksPluginDependencyStatus({
        origin: record.origin,
        pluginId: record.pluginId,
        packageName: record.packageName,
        packageBuild: record.packageBuild,
      });
      if (manifest && tracksDependencies && !dependencies.has(manifest)) {
        dependencies.set(
          manifest,
          buildPluginDependencyStatus({
            rootDir: record.rootDir,
            dependencies: manifest.packageDependencies,
            optionalDependencies: manifest.packageOptionalDependencies,
          }),
        );
      }
      return {
        id: record.pluginId,
        source: manifest?.source ?? record.source ?? record.manifestPath,
        enabled,
        status: enabled ? ("loaded" as const) : ("disabled" as const),
        dependencyStatus: manifest ? dependencies.get(manifest) : undefined,
      };
    }),
    diagnostics: [...snapshot.diagnostics],
  });
  return diagnostics;
}

/** Clear the process-stable hosted catalog snapshot after an explicit owner reload. */
export function clearManagedPluginOfficialCatalogCache(): void {
  getManagedPluginCache().officialCatalog = undefined;
}

function mergeCatalogMetadata(
  hosted: OfficialExternalPluginCatalogEntry,
  bundled: OfficialExternalPluginCatalogEntry,
  options: { hostedFeaturedAuthoritative: boolean },
): OfficialExternalPluginCatalogEntry {
  const hostedManifest = getOfficialExternalPluginCatalogManifest(hosted);
  const bundledManifest = getOfficialExternalPluginCatalogManifest(bundled);
  const bundledCatalog = bundledManifest?.catalog;
  const bundledPlugin = bundledManifest?.plugin;
  const bundledName = normalizeOptionalString(bundled.name);
  const bundledDescription = normalizeOptionalString(bundled.description);
  const bundledKind = normalizeOptionalString(bundled.kind);
  const bundledSource = normalizeOptionalString(bundled.source);
  const hostedFeatured = typeof hosted.featured === "boolean" ? hosted.featured : false;
  const mergedCatalog =
    bundledCatalog ||
    hostedManifest?.catalog ||
    (options.hostedFeaturedAuthoritative && hostedFeatured)
      ? {
          ...hostedManifest?.catalog,
          ...bundledCatalog,
          ...(options.hostedFeaturedAuthoritative ? { featured: hostedFeatured } : {}),
        }
      : undefined;
  if (!mergedCatalog && !bundledPlugin) {
    return hosted;
  }
  return {
    ...hosted,
    ...(!normalizeOptionalString(hosted.name) && bundledName ? { name: bundledName } : {}),
    ...(!normalizeOptionalString(hosted.description) && bundledDescription
      ? { description: bundledDescription }
      : {}),
    ...(!normalizeOptionalString(hosted.kind) && bundledKind ? { kind: bundledKind } : {}),
    ...(!normalizeOptionalString(hosted.source) && bundledSource ? { source: bundledSource } : {}),
    [MANIFEST_KEY]: {
      ...hostedManifest,
      ...(bundledPlugin ? { plugin: { ...hostedManifest?.plugin, ...bundledPlugin } } : {}),
      ...(mergedCatalog ? { catalog: mergedCatalog } : {}),
    },
  };
}

function prepareCatalogEntry(entry: OfficialExternalPluginCatalogEntry) {
  const install = resolveOfficialExternalPluginInstall(entry);
  const sources = resolveOfficialExternalPluginInstallSources(entry, { resolvedInstall: install });
  const clawhubSpec = sources.find((source) => source.source === "clawhub")?.spec;
  const npmSpec = sources.find((source) => source.source === "npm")?.spec;
  return {
    entry,
    install,
    selectedSource: sources[0],
    clawhub: clawhubSpec ? parseClawHubPluginSpec(clawhubSpec) : undefined,
    npmPackage: npmSpec ? parseRegistryNpmSpec(npmSpec)?.name : undefined,
  };
}

type PreparedCatalogEntry = ReturnType<typeof prepareCatalogEntry>;

function prepareCatalogEntries(entries: readonly OfficialExternalPluginCatalogEntry[]) {
  let prepared: PreparedCatalogEntry[] | undefined;
  // Unknown local installs never need package identities from the official catalog.
  // Resolve each collection only when provenance admits a lookup, then reuse its facts.
  return () => (prepared ??= entries.map(prepareCatalogEntry));
}

/**
 * Overlay local runtime identity and ordering after an exact package/source match.
 * Hosted curation wins; bundled Featured state survives only in fallback mode.
 */
function overlayBundledOfficialPluginCatalogMetadata(
  entries: readonly OfficialExternalPluginCatalogEntry[],
  bundledEntries: readonly OfficialExternalPluginCatalogEntry[] = listOfficialExternalPluginCatalogEntries(),
  options: { hostedFeaturedAuthoritative: boolean } = {
    hostedFeaturedAuthoritative: false,
  },
): OfficialExternalPluginCatalogEntry[] {
  const bundledFacts = entries.length > 0 ? bundledEntries.map(prepareCatalogEntry) : [];
  return entries.map((entry) => {
    const { clawhub, npmPackage } = prepareCatalogEntry(entry);
    const matches = bundledFacts.filter(
      (bundled) =>
        (clawhub && bundled.clawhub?.name === clawhub.name) ||
        (npmPackage && bundled.npmPackage === npmPackage),
    );
    const bundled = matches.length === 1 ? matches[0]?.entry : undefined;
    if (bundled) {
      return mergeCatalogMetadata(entry, bundled, options);
    }
    if (!options.hostedFeaturedAuthoritative) {
      return entry;
    }
    const hostedManifest = getOfficialExternalPluginCatalogManifest(entry);
    if (entry.featured !== true && !hostedManifest?.catalog) {
      return entry;
    }
    return {
      ...entry,
      [MANIFEST_KEY]: {
        ...hostedManifest,
        catalog: {
          ...hostedManifest?.catalog,
          featured: entry.featured === true,
        },
      },
    };
  });
}

async function loadOfficialCatalog(): Promise<OfficialCatalogResult> {
  const cache = getManagedPluginCache();
  if (!cache.officialCatalog) {
    const promise = Promise.resolve().then(() =>
      loadConfiguredHostedOfficialExternalPluginCatalogEntries(),
    );
    cache.officialCatalog = promise;
    void promise.catch(() => {
      if (cache.officialCatalog === promise) {
        cache.officialCatalog = undefined;
      }
    });
  }
  const result = await cache.officialCatalog;
  const hostedFeaturedAuthoritative =
    result.source === "hosted" || result.source === "hosted-snapshot";
  return {
    entries: overlayBundledOfficialPluginCatalogMetadata(result.entries, undefined, {
      hostedFeaturedAuthoritative,
    }),
    hostedFeaturedAuthoritative,
    ...("error" in result ? { error: result.error } : {}),
  };
}

function normalizeKinds(kind: string | readonly string[] | undefined): string[] | undefined {
  const values = (typeof kind === "string" ? [kind] : (kind ?? []))
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function normalizeCatalogMetadata(
  value: unknown,
): { featured?: boolean; order?: number } | undefined {
  const record = asNonArrayRecord(value);
  const featured = typeof record.featured === "boolean" ? record.featured : undefined;
  const order =
    typeof record.order === "number" && Number.isFinite(record.order) ? record.order : undefined;
  return featured === undefined && order === undefined
    ? undefined
    : {
        ...(featured !== undefined ? { featured } : {}),
        ...(order !== undefined ? { order } : {}),
      };
}

function normalizeFeaturedAt(value: unknown): number | undefined {
  return asSafeIntegerInRange(value, { min: 0 });
}

/** Coarse manifest-derived grouping so catalog UIs can shelve a large inventory. */
function derivePluginCategory(manifest: PluginManifestRecord | undefined): string | undefined {
  if (!manifest) {
    return undefined;
  }
  if (manifest.channels.length > 0 || Object.keys(manifest.channelConfigs ?? {}).length > 0) {
    return "channel";
  }
  const mediaProvider =
    Object.keys(manifest.imageGenerationProviderMetadata ?? {}).length > 0 ||
    Object.keys(manifest.videoGenerationProviderMetadata ?? {}).length > 0 ||
    Object.keys(manifest.musicGenerationProviderMetadata ?? {}).length > 0 ||
    Object.keys(manifest.mediaUnderstandingProviderMetadata ?? {}).length > 0;
  if (
    manifest.providers.length > 0 ||
    manifest.providerEndpoints?.length ||
    manifest.modelCatalog ||
    mediaProvider
  ) {
    return "provider";
  }
  const kinds = normalizeKinds(manifest.kind);
  if (kinds?.includes("memory")) {
    return "memory";
  }
  if (kinds?.includes("context-engine")) {
    return "context-engine";
  }
  if (
    manifest.contracts?.tools?.length ||
    Object.keys(manifest.toolMetadata ?? {}).length > 0 ||
    manifest.skills.length > 0
  ) {
    return "tool";
  }
  return undefined;
}

function compareCatalogEntries(
  left: ManagedPluginCatalogEntry,
  right: ManagedPluginCatalogEntry,
): number {
  const featured = Number(Boolean(right.featured)) - Number(Boolean(left.featured));
  if (featured !== 0) {
    return featured;
  }
  // Normalized timestamps are nonnegative; undated featured entries follow dated ones.
  const featuredAt =
    left.featured && right.featured ? (right.featuredAt ?? -1) - (left.featuredAt ?? -1) : 0;
  const order = (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER);
  return featuredAt || order || left.name.localeCompare(right.name);
}

function resolveInstalledOfficialCatalogEntry(params: {
  entries: ReturnType<typeof prepareCatalogEntries>;
  packageName?: string;
  source: "clawhub" | "npm";
}): PreparedCatalogEntry | undefined {
  if (!params.packageName) {
    return undefined;
  }
  const matches = params
    .entries()
    .filter(
      ({ clawhub, npmPackage }) =>
        (params.source === "clawhub" ? clawhub?.name : npmPackage) === params.packageName,
    );
  return matches.length === 1 ? matches[0] : undefined;
}

type PluginIndexRecord = PluginMetadataSnapshot["index"]["plugins"][number];

function resolveInstalledPluginPresentation(params: {
  record: PluginIndexRecord;
  manifest?: PluginManifestRecord;
  officialEntry?: OfficialExternalPluginCatalogEntry;
  hostedListingAuthoritative: boolean;
}): Pick<ManagedPluginCatalogEntry, "name" | "description" | "version"> {
  const { record, manifest, officialEntry, hostedListingAuthoritative } = params;
  // Registry names may be backfilled with npm specifiers, which are not display labels.
  const manifestName = manifest?.name !== record.packageName ? manifest?.name : undefined;
  const localName = manifestName ?? manifest?.channelCatalogMeta?.label ?? record.pluginId;
  const localDescription =
    manifest?.description ?? manifest?.channelCatalogMeta?.blurb ?? manifest?.packageDescription;
  const name =
    (hostedListingAuthoritative ? normalizeOptionalString(officialEntry?.title) : undefined) ??
    localName;
  const description =
    (hostedListingAuthoritative
      ? normalizeOptionalString(officialEntry?.description)
      : undefined) ?? localDescription;
  const version = record.packageVersion ?? manifest?.version;
  return {
    name,
    ...(description ? { description } : {}),
    ...(version ? { version } : {}),
  };
}

function resolveInstalledHostedOfficialEntry(params: {
  record: PluginIndexRecord;
  installOwner?: string;
  installRecord?: PluginInstallRecord;
  officialEntries: ReturnType<typeof prepareCatalogEntries>;
  bundledOfficialEntries: ReturnType<typeof prepareCatalogEntries>;
}): {
  entry?: OfficialExternalPluginCatalogEntry;
  clawhubPackage?: string;
} {
  const identityPluginId = params.installOwner ?? params.record.pluginId;
  const trustedOfficialClawHubSpec = params.installRecord
    ? resolveTrustedSourceLinkedOfficialClawHubSpec({
        pluginId: identityPluginId,
        record: params.installRecord,
      })
    : undefined;
  const trustedOfficialNpmSpec = params.installRecord
    ? resolveTrustedSourceLinkedOfficialNpmSpec({
        pluginId: identityPluginId,
        record: params.installRecord,
      })
    : undefined;
  const sourceLinkedOfficialClawHubPackage = trustedOfficialClawHubSpec
    ? parseClawHubPluginSpec(trustedOfficialClawHubSpec)?.name
    : undefined;
  const currentOfficialClawHubPackage = params.installRecord
    ? resolveTrustedOfficialClawHubPackageName(params.installRecord)
    : undefined;
  const trustedOfficialNpmPackage = trustedOfficialNpmSpec
    ? parseRegistryNpmSpec(trustedOfficialNpmSpec)?.name
    : undefined;
  const bundledPublishedEntry =
    params.record.origin === "bundled"
      ? resolveInstalledOfficialCatalogEntry({
          entries: params.bundledOfficialEntries,
          packageName: params.record.packageName,
          source: "npm",
        })
      : undefined;
  const installedOfficialIdentity = sourceLinkedOfficialClawHubPackage
    ? { source: "clawhub" as const, packageName: sourceLinkedOfficialClawHubPackage }
    : trustedOfficialNpmPackage
      ? { source: "npm" as const, packageName: trustedOfficialNpmPackage }
      : currentOfficialClawHubPackage &&
          (!params.record.packageName ||
            params.record.packageName === currentOfficialClawHubPackage)
        ? { source: "clawhub" as const, packageName: currentOfficialClawHubPackage }
        : bundledPublishedEntry && params.record.packageName
          ? { source: "npm" as const, packageName: params.record.packageName }
          : undefined;
  const hasInstalledOfficialProvenance = Boolean(
    installedOfficialIdentity &&
    (!params.record.packageName ||
      params.record.packageName === installedOfficialIdentity.packageName),
  );
  const bundledOfficialEntry =
    bundledPublishedEntry ??
    resolveInstalledOfficialCatalogEntry({
      entries: params.bundledOfficialEntries,
      packageName: hasInstalledOfficialProvenance
        ? installedOfficialIdentity?.packageName
        : undefined,
      source: installedOfficialIdentity?.source ?? "clawhub",
    });
  const hostedPackageName =
    installedOfficialIdentity?.source === "npm"
      ? bundledOfficialEntry?.clawhub?.name
      : installedOfficialIdentity?.packageName;
  return {
    entry: resolveInstalledOfficialCatalogEntry({
      entries: params.officialEntries,
      packageName: hasInstalledOfficialProvenance ? hostedPackageName : undefined,
      source: "clawhub",
    })?.entry,
    clawhubPackage: hasInstalledOfficialProvenance ? hostedPackageName : undefined,
  };
}

export type ManagedPluginIconSource = { kind: "file"; path: string; rootPath: string };

function resolvePluginIconSource(params: {
  metadata: PluginMetadataSnapshot;
  pluginId: string;
}): ManagedPluginIconSource | undefined {
  const normalizedPluginId = params.metadata.normalizePluginId(params.pluginId);
  const manifest = params.metadata.byPluginId.get(normalizedPluginId);
  const localIconPath = normalizeOptionalString(manifest?.iconPath);
  if (localIconPath && manifest) {
    return { kind: "file", path: localIconPath, rootPath: manifest.rootDir };
  }
  return undefined;
}
function resolveManagedPluginMetadataParams(config: OpenClawConfig, env: NodeJS.ProcessEnv) {
  const workspace = resolvePluginControlPlaneWorkspace({ config, env });
  return {
    config,
    env,
    ...(workspace.workspaceDir !== undefined ? { workspaceDir: workspace.workspaceDir } : {}),
  };
}

function resolveManagedPluginMetadata(config: OpenClawConfig, env: NodeJS.ProcessEnv) {
  const boot = getProcessGatewayPluginMetadataSnapshot();
  const candidate = getProcessPluginCache().desiredMetadata;
  return candidate && candidate.boot === boot
    ? candidate.snapshot
    : resolvePluginMetadataSnapshot(resolveManagedPluginMetadataParams(config, env));
}

function loadFreshManagedPluginMetadata(config: OpenClawConfig, env: NodeJS.ProcessEnv) {
  // Gateway actions must cover every workspace shown in its management inventory.
  return getProcessGatewayPluginMetadataSnapshot()
    ? resolveConfigWidePluginMetadataSnapshot({ config, env, allowCurrent: false })
    : loadPluginMetadataSnapshot({
        ...resolveManagedPluginMetadataParams(config, env),
        allowCurrent: false,
      });
}

/** Publish desired install state for management without replacing the Gateway's boot facts. */
function refreshManagedPluginMetadata(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): PluginMetadataSnapshot {
  const env = params.env ?? process.env;
  const boot = getProcessGatewayPluginMetadataSnapshot();
  // Install writes may have replaced package bytes already seen by the operation.
  // Publish only a completely prepared generation; retained readers keep their original facts.
  const cache = createPluginCache();
  const snapshot = withPluginCache(cache, () => loadFreshManagedPluginMetadata(params.config, env));
  if (boot) {
    getProcessPluginCache().desiredMetadata = { boot, cache, snapshot };
  }
  return snapshot;
}

/** Resolve the current package-local icon without accepting caller-provided input. */
export const resolveManagedPluginIconSource = withManagedPluginCache(
  async (params: {
    config: OpenClawConfig;
    pluginId: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<ManagedPluginIconSource | undefined> => {
    const env = params.env ?? process.env;
    const metadata = resolveManagedPluginMetadata(params.config, env);
    return resolvePluginIconSource({ metadata, pluginId: params.pluginId });
  },
);

function normalizeManagedCatalogIconUrl(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized || normalized.length > 2048) {
    return undefined;
  }
  try {
    const url = new URL(normalized);
    return url.protocol === "https:" && url.hostname && !url.username && !url.password && !url.hash
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve only URLs currently owned by a manifest or bundled presentation catalog. */
export function resolveManagedSetupCatalogIconUrl(params: {
  config: OpenClawConfig;
  iconUrl: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const requested = normalizeManagedCatalogIconUrl(params.iconUrl);
  if (!requested) {
    return undefined;
  }
  const env = params.env ?? process.env;
  const allowedUrls = [
    ...resolveManifestProviderAuthChoices({
      config: params.config,
      env,
      includeUntrustedWorkspacePlugins: false,
      includeWorkspacePlugins: false,
    }).map((choice) => choice.icon),
    ...listRecommendedToolInstalls().map((install) => install.icon),
  ];
  return allowedUrls.some((iconUrl) => normalizeManagedCatalogIconUrl(iconUrl) === requested)
    ? requested
    : undefined;
}

/** Build cold installed state merged with the hosted official catalog and bundled curation. */
export const listManagedPlugins = withManagedPluginCache(
  async (params: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    officialCatalog?: OfficialCatalogResult;
    metadata?: PluginMetadataSnapshot;
  }): Promise<ManagedPluginCatalog> => {
    const env = params.env ?? process.env;
    const config = params.config ?? (await readConfigFileSnapshotForWrite()).snapshot.sourceConfig;
    const workspace = resolvePluginControlPlaneWorkspace({ config, env });
    const metadata = params.metadata ?? resolveManagedPluginMetadata(config, env);
    const pluginDiagnostics = resolveManagedPluginDiagnostics(metadata, config);
    const officialCatalog = params.officialCatalog ?? (await loadOfficialCatalog());
    // Prepare the merged entry once; display names never add install identities.
    const officialEntries = prepareCatalogEntries(officialCatalog.entries);
    const bundledOfficialEntries = prepareCatalogEntries(
      listOfficialExternalPluginCatalogEntries(),
    );
    const installedIconsById = new Map<string, ManagedPluginIconSource | undefined>();
    const installedClawHubPackages = new Set<string>();
    const capabilityConsentDiagnostics: PluginDiagnostic[] = [];
    const plugins: ManagedPluginCatalogEntry[] = [];
    for (const record of metadata.index.plugins) {
      const enabled = isInstalledPluginEnabled(metadata.index, record.pluginId, config, env);
      const manifest = metadata.byPluginId.get(record.pluginId);
      const localCatalog = normalizeCatalogMetadata(manifest?.catalog);
      const ownership = resolveInstalledPluginPackageOwnership(metadata.index, record.pluginId);
      const installOwner = ownership.ok ? ownership.value.installOwner : undefined;
      const installRecord = installOwner ? metadata.index.installRecords[installOwner] : undefined;
      if (
        enabled &&
        record.origin !== "bundled" &&
        !manifest?.trustedOfficialInstall &&
        ownership.ok &&
        installRecord
      ) {
        const declared = resolvePluginPackageDeclaredSurface(ownership.value, metadata.byPluginId);
        if (!declared || !resolveAcceptedSurfaceCurrent(installRecord, declared)) {
          capabilityConsentDiagnostics.push({
            level: "warn",
            pluginId: record.pluginId,
            message: formatPluginCapabilityConsentRequired(record.pluginId),
          });
        }
      }
      const { entry: officialEntry, clawhubPackage } = resolveInstalledHostedOfficialEntry({
        record,
        ...(installOwner ? { installOwner } : {}),
        installRecord,
        officialEntries,
        bundledOfficialEntries,
      });
      // A declared counterpart suppresses the same ClawHub package, not an npm namesake.
      if (clawhubPackage) {
        installedClawHubPackages.add(clawhubPackage);
      }
      const officialCatalogMetadata = officialEntry
        ? normalizeCatalogMetadata(getOfficialExternalPluginCatalogManifest(officialEntry)?.catalog)
        : undefined;
      // Published plugin curation follows the live feed even after install, including
      // omission. Private bundled plugins without an exact package/source match stay local.
      const catalog =
        clawhubPackage && officialCatalog.hostedFeaturedAuthoritative
          ? {
              ...localCatalog,
              ...officialCatalogMetadata,
              featured: officialEntry?.featured === true,
            }
          : officialCatalogMetadata
            ? { ...localCatalog, ...officialCatalogMetadata }
            : localCatalog;
      const error = pluginDiagnostics.find(
        (diagnostic) => diagnostic.level === "error" && diagnostic.pluginId === record.pluginId,
      )?.message;
      const kind = normalizeKinds(manifest?.kind);
      const category = derivePluginCategory(manifest);
      // Only externally installed plugins (tracked install record, non-bundled) can be removed.
      const removable = record.origin !== "bundled" && Boolean(installOwner);
      const hostedListingAuthoritative =
        Boolean(clawhubPackage) && officialCatalog.hostedFeaturedAuthoritative === true;
      const featuredAt =
        hostedListingAuthoritative && catalog?.featured === true
          ? normalizeFeaturedAt(officialEntry?.featuredAt)
          : undefined;
      const presentation = resolveInstalledPluginPresentation({
        record,
        manifest,
        officialEntry,
        hostedListingAuthoritative,
      });
      const normalizedPluginId = metadata.normalizePluginId(record.pluginId);
      // Icon lookup uses the first normalized record, even when that record has no icon.
      if (!installedIconsById.has(normalizedPluginId)) {
        installedIconsById.set(
          normalizedPluginId,
          resolvePluginIconSource({ metadata, pluginId: record.pluginId }),
        );
      }
      plugins.push({
        id: record.pluginId,
        ...presentation,
        installed: true,
        enabled,
        state: error ? "error" : enabled ? "enabled" : "disabled",
        removable,
        ...(record.packageName ? { packageName: record.packageName } : {}),
        ...(kind ? { kind } : {}),
        ...(record.origin ? { origin: record.origin } : {}),
        ...catalog,
        ...(featuredAt !== undefined ? { featuredAt } : {}),
        ...(installedIconsById.get(normalizedPluginId) ? { hasIcon: true } : {}),
        ...(error ? { error } : {}),
        ...(category ? { category } : {}),
      });
    }
    const installedIds = new Set(plugins.map((plugin) => plugin.id));
    const installedPackageNames = new Set(
      plugins.flatMap((plugin) => (plugin.packageName ? [plugin.packageName] : [])),
    );
    // Hosted rows without a declared runtime id fall back to their package name,
    // so id matching alone would keep them visible after a successful install.
    for (const facts of officialEntries()) {
      const { entry, clawhub, npmPackage } = facts;
      const pluginId = resolveOfficialExternalPluginId(entry);
      const manifest = getOfficialExternalPluginCatalogManifest(entry);
      const manifestCatalog = normalizeCatalogMetadata(manifest?.catalog);
      const catalog =
        manifestCatalog || typeof entry.featured === "boolean"
          ? {
              ...manifestCatalog,
              ...(manifestCatalog?.featured === undefined && typeof entry.featured === "boolean"
                ? { featured: entry.featured }
                : {}),
            }
          : undefined;
      if (
        !pluginId ||
        !catalog ||
        installedIds.has(pluginId) ||
        (clawhub &&
          (installedPackageNames.has(clawhub.name) ||
            installedClawHubPackages.has(clawhub.name))) ||
        (npmPackage && installedPackageNames.has(npmPackage))
      ) {
        continue;
      }
      const kind = normalizeKinds(entry.kind);
      const install: ManagedPluginCatalogEntry["install"] =
        facts.selectedSource?.source === "clawhub" && clawhub && !clawhub.version
          ? { source: "clawhub", packageName: clawhub.name }
          : facts.install
            ? { source: "official", pluginId }
            : undefined;
      const packageName = npmPackage ?? clawhub?.name;
      const description = normalizeOptionalString(entry.description);
      const version = normalizeOptionalString(entry.version);
      const featuredAt =
        catalog.featured === true ? normalizeFeaturedAt(entry.featuredAt) : undefined;
      plugins.push({
        id: pluginId,
        name: resolveOfficialExternalPluginLabel(entry),
        ...(packageName ? { packageName } : {}),
        ...(description ? { description } : {}),
        ...(version ? { version } : {}),
        ...(kind ? { kind } : {}),
        origin: "official",
        installed: false,
        enabled: false,
        state: "not-installed",
        ...(catalog.featured !== undefined ? { featured: catalog.featured } : {}),
        ...(featuredAt !== undefined ? { featuredAt } : {}),
        ...(catalog.order !== undefined ? { order: catalog.order } : {}),
        ...(install ? { install } : {}),
      });
    }
    const diagnostics: unknown[] = getProcessGatewayPluginMetadataSnapshot()
      ? [...pluginDiagnostics, ...capabilityConsentDiagnostics]
      : appendPluginControlPlaneWorkspaceDiagnostic(
          [...pluginDiagnostics, ...capabilityConsentDiagnostics],
          workspace,
        );
    if (officialCatalog.error) {
      diagnostics.push({
        level: "warn",
        message: `Official plugin catalog fallback: ${officialCatalog.error}`,
      });
    }
    return {
      plugins: plugins.toSorted(compareCatalogEntries),
      diagnostics,
      mutationAllowed: !resolveIsNixMode(env),
    };
  },
);

/** Inspect one plugin's manifest, operator grants, and recorded install provenance. */
export const inspectManagedPlugin = withManagedPluginCache(
  async (params: {
    config: OpenClawConfig;
    pluginId: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<ManagedPluginInspection> => {
    const env = params.env ?? process.env;
    const metadata = resolveManagedPluginMetadata(params.config, env);
    const pluginId = metadata.normalizePluginId(params.pluginId);
    const record = metadata.index.plugins.find((candidate) => candidate.pluginId === pluginId);
    const enabled = isInstalledPluginEnabled(metadata.index, pluginId, params.config);
    const pendingReview = resolvePendingPluginCapabilityReview(pluginId);
    if (pendingReview) {
      return {
        ok: true,
        plugin: {
          id: pluginId,
          name: pendingReview.name,
          ...(pendingReview.version ? { version: pendingReview.version } : {}),
          ...(record?.origin ? { origin: record.origin } : {}),
          installed: Boolean(record),
          enabled,
        },
        declared: pendingReview.declared,
        grants: pendingReview.grants,
        reviewToken: pendingReview.reviewToken,
        ...(pendingReview.source ? { source: pendingReview.source } : {}),
        ...(pendingReview.trust ? { trust: pendingReview.trust } : {}),
      };
    }
    const officialCatalog = await loadOfficialCatalog();

    if (record) {
      const manifest = metadata.byPluginId.get(pluginId);
      const ownership = resolveInstalledPluginPackageOwnership(metadata.index, pluginId, env);
      const installOwner = ownership.ok ? ownership.value.installOwner : undefined;
      const installRecord = installOwner ? metadata.index.installRecords[installOwner] : undefined;
      const { entry: officialEntry, clawhubPackage } = resolveInstalledHostedOfficialEntry({
        record,
        ...(installOwner ? { installOwner } : {}),
        installRecord,
        officialEntries: prepareCatalogEntries(officialCatalog.entries),
        bundledOfficialEntries: prepareCatalogEntries(listOfficialExternalPluginCatalogEntries()),
      });
      const spec = installRecord?.resolvedSpec ?? installRecord?.spec;
      const packageName = installRecord?.clawhubPackage ?? record.packageName;
      const source: PluginInspectSource | undefined = installRecord
        ? {
            kind: installRecord.source,
            ...(spec ? { spec: redactSensitiveUrlLikeString(spec) } : {}),
            ...(packageName ? { packageName } : {}),
            ...resolvePluginInstallRecordIntegrity(installRecord),
          }
        : record.origin === "bundled"
          ? { kind: "bundled" }
          : undefined;
      const trust = resolvePluginInstallRecordTrust(installRecord);
      const summary = buildPluginCapabilitySummary({
        manifest: manifest ?? {},
        origin: record.origin,
        entryConfig: params.config.plugins?.entries?.[pluginId],
      });
      const declared = ownership.ok
        ? resolvePluginPackageDeclaredSurface(ownership.value, metadata.byPluginId)
        : summary.declared;
      if (!declared) {
        throw new ManagedPluginLifecycleError(
          `Plugin package "${installOwner}" has incomplete manifest metadata.`,
        );
      }
      return {
        ok: true,
        plugin: {
          id: pluginId,
          ...resolveInstalledPluginPresentation({
            record,
            manifest,
            officialEntry,
            hostedListingAuthoritative:
              Boolean(clawhubPackage) && officialCatalog.hostedFeaturedAuthoritative === true,
          }),
          origin: record.origin,
          installed: true,
          enabled,
        },
        ...(source ? { source } : {}),
        ...summary,
        declared,
        reviewToken: computeDeclaredSurfaceHash(declared),
        ...(trust ? { trust } : {}),
      };
    }

    const entry = resolveOfficialEntryById(officialCatalog.entries, pluginId);
    if (!entry) {
      throw new ManagedPluginLifecycleError(`Plugin "${pluginId}" not found.`, {
        kind: "invalid-request",
      });
    }
    const manifest = getOfficialExternalPluginCatalogManifest(entry);
    const { selectedSource, clawhub, npmPackage } = prepareCatalogEntry(entry);
    const packageName = npmPackage ?? clawhub?.name;
    const spec = selectedSource?.spec;
    const description = normalizeOptionalString(entry.description);
    const version = normalizeOptionalString(entry.version);
    const summary = buildPluginCapabilitySummary({
      manifest: manifest ?? {},
      origin: "official",
      entryConfig: params.config.plugins?.entries?.[pluginId],
    });
    return {
      ok: true,
      plugin: {
        id: pluginId,
        name: resolveOfficialExternalPluginLabel(entry),
        ...(version ? { version } : {}),
        ...(description ? { description } : {}),
        origin: "official",
        installed: false,
        enabled: false,
      },
      source: {
        kind: "official-catalog",
        ...(spec ? { spec: redactSensitiveUrlLikeString(spec) } : {}),
        ...(packageName ? { packageName } : {}),
        ...(selectedSource?.expectedIntegrity
          ? {
              integrity: selectedSource.expectedIntegrity,
              integrityKind: selectedSource.source === "clawhub" ? "sha256" : "ssri",
            }
          : {}),
      },
      ...summary,
      reviewToken: computeDeclaredSurfaceHash(summary.declared),
    };
  },
);

function withManagedPluginMutation<T>(
  params: ManagedPluginMutationOptions,
  run: (beforePersistentApply: () => void) => Promise<T>,
): Promise<T> {
  return withPluginLifecycleLease(
    { env: params.env ?? process.env, signal: params.signal },
    (lease) => {
      const beforePersistentApply = () => {
        params.signal?.throwIfAborted();
        lease.assertOwned();
        params.beforePersistentApply?.();
      };
      beforePersistentApply();
      return run(beforePersistentApply);
    },
  );
}

async function readPluginMutationSnapshot(
  env: NodeJS.ProcessEnv,
  beforePersistentApply: () => void,
): Promise<ConfigSnapshotForInstallPersist> {
  try {
    assertConfigWriteAllowedInCurrentMode({ env });
    const snapshot = await loadConfigForInstall();
    return {
      ...snapshot,
      writeOptions: selectInstallMutationWriteOptions(snapshot.writeOptions, beforePersistentApply),
    };
  } catch (error) {
    throw new ManagedPluginLifecycleError(formatErrorMessage(error), { cause: error });
  }
}

function resolveOfficialEntryById(
  entries: readonly OfficialExternalPluginCatalogEntry[],
  pluginId: string,
): OfficialExternalPluginCatalogEntry | undefined {
  return entries.find((entry) => resolveOfficialExternalPluginId(entry) === pluginId);
}

/** Explicitly declared runtime id, ignoring the entry-id fallback used for display. */
function resolveDeclaredOfficialPluginId(
  entry: OfficialExternalPluginCatalogEntry,
): string | undefined {
  const manifest = getOfficialExternalPluginCatalogManifest(entry);
  return (
    normalizeOptionalString(manifest?.plugin?.id) ??
    normalizeOptionalString(manifest?.channel?.id) ??
    normalizeOptionalString(manifest?.providers?.[0]?.id)
  );
}

function resolveOfficialEntryByClawHubPackage(
  entries: readonly OfficialExternalPluginCatalogEntry[],
  packageName: string,
): OfficialExternalPluginCatalogEntry | undefined {
  return entries.find((entry) => {
    return resolveOfficialExternalPluginInstallSources(entry).some(
      (source) =>
        source.source === "clawhub" && parseClawHubPluginSpec(source.spec)?.name === packageName,
    );
  });
}

function buildClawHubSpec(packageName: string, version?: string): string {
  const parsed = parseClawHubPluginSpec(`clawhub:${packageName}`);
  if (!parsed || parsed.version) {
    throw new ManagedPluginLifecycleError(`invalid ClawHub package name: ${packageName}`);
  }
  return `clawhub:${packageName}${version ? `@${version}` : ""}`;
}

function throwInstallFailure(result: SourceInstallFailure): never {
  const unavailable =
    !result.code ||
    result.code === CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_UNAVAILABLE ||
    result.code === CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_DOWNLOAD_UNAVAILABLE ||
    result.code === CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_SECURITY_UNAVAILABLE;
  throw new ManagedPluginLifecycleError(result.error, {
    ...result,
    kind: unavailable ? "unavailable" : "invalid-request",
    installRejected: true,
    cause: result,
  });
}

/**
 * Official plugin installs target the release stream the gateway is running,
 * the same target `openclaw doctor --fix` and `openclaw plugins update`
 * already resolve. Resolving here keeps every managed install path — CLI,
 * chat command, and any future caller — on one answer instead of letting the
 * registry default land a plugin the gateway then reports as drifted.
 *
 * Beta and extended-stable resolve here. Version-bound stable tracks key off a
 * per-plugin `versionBoundToOpenClaw` descriptor that a managed install request
 * does not carry, and answering for them from this boundary would pin plugins
 * the policy never opted in.
 */
function resolveOfficialManagedInstallSpec(params: {
  request: Extract<ManagedPluginSourceInstallRequest, { source: "npm" | "clawhub" }>;
  config: OpenClawConfig;
}): string | null {
  const { request } = params;
  const trustedSourceLinkedOfficialInstall = request.trustedSourceLinkedOfficialInstall === true;
  if (request.source === "npm" && !trustedSourceLinkedOfficialInstall) {
    return null;
  }
  // An integrity pin identifies one exact artifact, so it outranks the channel.
  if (request.expectedIntegrity) {
    return null;
  }
  const packageName =
    request.source === "clawhub"
      ? parseClawHubPluginSpec(request.spec)?.name
      : parseRegistryNpmSpec(request.spec)?.name;
  if (
    !packageName ||
    (!trustedSourceLinkedOfficialInstall &&
      !getOfficialExternalPluginCatalogEntryForPackage(packageName))
  ) {
    return null;
  }
  const updateChannel = resolveRegistryUpdateChannel({
    configChannel: normalizeUpdateChannel(params.config.update?.channel),
    currentVersion: VERSION,
  });
  if (updateChannel !== "beta" && updateChannel !== "extended-stable") {
    return null;
  }
  const specs =
    request.source === "clawhub"
      ? resolveClawHubInstallSpecsForUpdateChannel({
          spec: request.spec,
          updateChannel,
          officialPackageName: packageName,
          coreVersion: VERSION,
        })
      : resolveNpmInstallSpecsForUpdateChannel({
          spec: request.spec,
          updateChannel,
          officialPackageName: packageName,
          coreVersion: VERSION,
        });
  return specs.installSpec === request.spec ? null : specs.installSpec;
}

type ManagedPluginSourceInstallParams = Omit<
  Parameters<typeof installManagedPlugin>[0],
  "request"
> & {
  request: ManagedPluginSourceInstallRequest;
  snapshot: ConfigSnapshotForInstallPersist;
  acknowledgeCapabilities?: PluginCapabilityConsentAcknowledgment;
  clawManaged?: boolean;
};

/**
 * Installs official plugins from the release stream the gateway runs. When that
 * stream has no published artifact the install reports it instead of widening
 * back to the registry default: widening would resolve `latest` and land exactly
 * the cross-release plugin this boundary exists to prevent, and a fresh install
 * has nothing to preserve, so failing with the reason costs the operator only a
 * retry with an explicit version.
 */
async function installManagedPluginSource(
  params: ManagedPluginSourceInstallParams,
): Promise<ManagedPluginSourceInstallResult> {
  const { request } = params;
  if (request.source === "official") {
    const { attempt: installed } = await installWithSourceFallback({
      sources: request.installSources,
      install: async (source) =>
        await installManagedPluginSource({
          ...params,
          request: {
            source: source.source,
            spec: source.spec,
            mode: request.mode,
            expectedPluginId: request.expectedPluginId,
            trustedSourceLinkedOfficialInstall: true,
            ...(source.expectedIntegrity ? { expectedIntegrity: source.expectedIntegrity } : {}),
            ...(source.source === "npm" && request.pin ? { pin: true } : {}),
          },
        }),
      result: (attempt) => attempt,
      onFallback: (message) => params.logger?.warn?.(message),
    });
    return installed;
  }
  const registryRequest =
    request.source === "npm" || request.source === "clawhub" ? request : undefined;
  const installSpec =
    registryRequest &&
    resolveOfficialManagedInstallSpec({
      request: registryRequest,
      config: params.snapshot.config,
    });
  const install = async (): Promise<ManagedPluginSourceInstallResult> => {
    const result = await installResolvedManagedPluginSource({
      ...params,
      request:
        registryRequest && installSpec
          ? {
              ...registryRequest,
              spec: installSpec,
              recordSpec: registryRequest.recordSpec ?? registryRequest.spec,
            }
          : request,
    });
    if (!result.ok) {
      // Hook compatibility may inspect only the source that actually failed,
      // including its release cohort and the digest for that exact candidate.
      const failure: SourceInstallFailure = {
        ...result,
        ...(registryRequest
          ? {
              installSource: {
                source: registryRequest.source,
                spec: installSpec ?? registryRequest.spec,
                ...(registryRequest.expectedIntegrity
                  ? { expectedIntegrity: registryRequest.expectedIntegrity }
                  : {}),
              },
            }
          : {}),
      };
      if (
        registryRequest &&
        installSpec &&
        (registryRequest.source === "clawhub"
          ? isUnavailableClawHubTarget(result)
          : isUnavailableNpmTarget(result))
      ) {
        return {
          ...failure,
          code: PLUGIN_INSTALL_ERROR_CODE.RELEASE_COHORT_UNAVAILABLE,
          error: `No ${installSpec} release is published for this gateway. Installing ${registryRequest.spec} would resolve a build from another release; pass an explicit version to install one anyway.`,
        };
      }
      return failure;
    }
    if (request.source === "clawhub" && result.clawhub) {
      if (!params.clawManaged && result.clawhub.version) {
        markClawPackageIndependentlyOwned({
          kind: "plugin",
          source: "clawhub",
          ref: result.clawhub.clawhubPackage,
          version: result.clawhub.version,
        });
      }
      await reportClawHubPluginInstallTelemetry({
        baseUrl: result.clawhub.clawhubUrl,
        packageName: result.clawhub.clawhubPackage,
        version: result.clawhub.version,
      }).catch(() => undefined);
    }
    return result;
  };
  return request.source !== "clawhub" || params.clawManaged
    ? await install()
    : await withClawPackageLifecycleLease(
        {
          kind: "plugin",
          source: "clawhub",
          ref: parseClawHubPluginSpec(request.spec)?.name ?? request.spec,
        },
        install,
        { env: params.env, required: true },
      );
}

/** Execute one resolved plugin source through the shared install-and-persist pipeline. */
async function installResolvedManagedPluginSource(
  params: Omit<ManagedPluginSourceInstallParams, "request"> & {
    request: Exclude<ManagedPluginSourceInstallRequest, { source: "official" }>;
  },
): Promise<ManagedPluginSourceInstallResult> {
  const { request } = params;
  const env = params.env ?? process.env;
  const extensionsDir = resolveDefaultPluginExtensionsDir(env);
  if (request.source === "bundled") {
    const { pluginId, localPath } = request.bundledSource;
    return {
      ok: true,
      pluginId,
      ...(await persistPluginInstall({
        ...params,
        pluginId,
        install: { source: "path", spec: pluginId, sourcePath: localPath, installPath: localPath },
      })),
    };
  }

  const consentExemptSource = request.source === "local" && request.bundledOrigin === true;
  const source =
    request.source === "local"
      ? request.recordSource
      : request.source === "npm-pack"
        ? "npm"
        : request.source;
  const capabilityConsent = consentExemptSource
    ? undefined
    : await prepareManagedPluginArtifactConsentHandler({
        config: params.snapshot.config,
        env,
        source,
        spec:
          request.source === "marketplace"
            ? `${request.plugin}@${request.marketplace}`
            : "spec" in request
              ? request.spec
              : undefined,
        expectedIntegrity: "expectedIntegrity" in request ? request.expectedIntegrity : undefined,
        acknowledgeCapabilities: params.acknowledgeCapabilities,
        onCapabilityConsent: params.onCapabilityConsent,
      });

  const common = requestDeferredPluginInstall({
    ...params.safetyOverrides,
    config: params.snapshot.config,
    extensionsDir,
    logger: params.logger,
    mode: request.mode,
    beforePersistentApply: params.beforePersistentApply,
    onBeforePluginArtifactCommit: capabilityConsent?.onBeforePluginArtifactCommit,
  });
  const complete = async <T extends InstallPluginResult | SourceInstallFailure>(
    installResult: Promise<T>,
    createInstallRecord: (result: T & { ok: true }) => PluginInstallRecord,
    snapshot = params.snapshot,
  ): Promise<ManagedPluginSourceInstallResult> => {
    // Keep the result union visible so narrowing preserves each installer's metadata.
    const installed: T & (InstallPluginResult | SourceInstallFailure) = await installResult;
    if (!installed.ok) {
      return installed;
    }
    // Linking skips the installer's staging transaction but still grants durable authority.
    if (request.source === "local" && request.link) {
      await capabilityConsent?.onBeforePluginArtifactCommit({
        pluginId: installed.pluginId,
        stagedArtifactDir: request.path,
        mode: request.mode ?? "install",
      });
    }
    const transaction = resolvePluginInstallTransaction(installed);
    const expectedPluginId = "expectedPluginId" in request ? request.expectedPluginId : undefined;
    if (expectedPluginId && installed.pluginId !== expectedPluginId) {
      await transaction?.rollback();
      return {
        ok: false as const,
        error: `official catalog plugin id mismatch: expected ${expectedPluginId}, got ${installed.pluginId}`,
      };
    }
    const install = createInstallRecord(installed);
    const persisted = await persistPluginInstall({
      ...params,
      snapshot,
      pluginId: installed.pluginId,
      install: capabilityConsent
        ? capabilityConsent.applyAcceptedSurface(installed.pluginId, install)
        : install,
      transaction,
    });
    return {
      ...installed,
      config: persisted.config,
      ...(persisted.application ? { application: persisted.application } : {}),
      ...(persisted.warnings.length > 0 ? { warnings: [...new Set(persisted.warnings)] } : {}),
    };
  };

  if (request.source === "local") {
    const linkedSnapshot = request.link
      ? {
          ...params.snapshot,
          config: {
            ...params.snapshot.config,
            plugins: {
              ...params.snapshot.config.plugins,
              load: {
                ...params.snapshot.config.plugins?.load,
                paths: uniqueStrings([
                  ...(params.snapshot.config.plugins?.load?.paths ?? []),
                  request.path,
                ]),
              },
            },
          },
        }
      : params.snapshot;
    return await complete(
      installPluginFromPath({
        ...common,
        path: request.path,
        ...(request.link ? { dryRun: true, allowSourceTypeScriptEntries: true } : {}),
      }),
      (result) => ({
        source: request.recordSource,
        sourcePath: request.path,
        installPath: request.link ? request.path : result.targetDir,
        version: result.version,
      }),
      linkedSnapshot,
    );
  }

  if (request.source === "marketplace") {
    return await complete(
      installPluginFromMarketplace({
        ...common,
        marketplace: request.marketplace,
        plugin: request.plugin,
      }),
      (result) => ({
        source: "marketplace",
        installPath: result.targetDir,
        version: result.version,
        marketplaceName: result.marketplaceName,
        marketplaceSource: result.marketplaceSource,
        marketplacePlugin: result.marketplacePlugin,
      }),
    );
  }

  if (request.source === "npm-pack") {
    return await complete(
      installPluginFromNpmPackArchive({
        ...common,
        archivePath: request.archivePath,
      }),
      (result) => ({
        source: "npm",
        spec: result.npmResolution?.resolvedSpec ?? result.manifestName ?? result.pluginId,
        sourcePath: request.archivePath,
        installPath: result.targetDir,
        ...(result.version ? { version: result.version } : {}),
        ...buildNpmResolutionFields(result.npmResolution),
        artifactKind: "npm-pack",
        artifactFormat: "tgz",
        ...(result.npmResolution?.integrity
          ? { npmIntegrity: result.npmResolution.integrity }
          : {}),
        ...(result.npmResolution?.shasum ? { npmShasum: result.npmResolution.shasum } : {}),
        ...(result.npmTarballName ? { npmTarballName: result.npmTarballName } : {}),
      }),
    );
  }

  if (request.source === "git") {
    return await complete(
      installPluginFromGitSpec({ ...common, spec: request.spec }),
      (result) => ({
        source: "git",
        spec: request.spec,
        installPath: result.targetDir,
        version: result.version,
        resolvedAt: result.git.resolvedAt,
        gitUrl: result.git.url,
        gitRef: result.git.ref,
        gitCommit: result.git.commit,
      }),
    );
  }

  if (request.source === "clawhub") {
    return await complete(
      installPluginFromClawHub({
        ...common,
        spec: request.spec,
        ...(request.expectedPluginId ? { expectedPluginId: request.expectedPluginId } : {}),
        ...(request.expectedIntegrity ? { expectedIntegrity: request.expectedIntegrity } : {}),
        ...(params.confirmInstall ? { confirmInstall: params.confirmInstall } : {}),
      }),
      (result) => ({
        ...buildClawHubPluginInstallRecordFields(result.clawhub),
        spec: request.recordSpec ?? request.spec,
        installPath: result.targetDir,
      }),
    );
  }

  return await complete(
    installPluginFromNpmSpec({
      ...common,
      spec: request.spec,
      ...(request.trustedSourceLinkedOfficialInstall
        ? { trustedSourceLinkedOfficialInstall: true }
        : {}),
      ...(request.expectedPluginId ? { expectedPluginId: request.expectedPluginId } : {}),
      ...(request.expectedIntegrity ? { expectedIntegrity: request.expectedIntegrity } : {}),
    }),
    (result) => ({
      source: "npm",
      spec: request.pin
        ? (result.npmResolution?.resolvedSpec ?? request.spec)
        : (request.recordSpec ?? request.spec),
      installPath: result.targetDir,
      ...(result.version ? { version: result.version } : {}),
      ...buildNpmResolutionFields(result.npmResolution),
    }),
  );
}

function resolveManagedClawHubInstallRequest(params: {
  request: Extract<ManagedPluginInstallRequest, { source: "clawhub" }>;
  officialEntries: readonly OfficialExternalPluginCatalogEntry[];
  expectedIntegrity?: string;
}): Extract<ManagedPluginSourceInstallRequest, { source: "clawhub" }> {
  const packageName = params.request.packageName.trim();
  // Bundled identities remain the local trust anchor when a hosted feed omits
  // its ClawHub candidate; hosted install/version metadata is never copied back.
  const official = resolveOfficialEntryByClawHubPackage(
    [...listOfficialExternalPluginCatalogEntries(), ...params.officialEntries],
    packageName,
  );
  // Pin the runtime id only when the catalog entry declares one; the entry-id
  // fallback is just the package name and would reject legitimate installs.
  const expectedPluginId = official ? resolveDeclaredOfficialPluginId(official) : undefined;
  const hostedOfficial = resolveOfficialEntryByClawHubPackage(params.officialEntries, packageName);
  const hostedSource = hostedOfficial
    ? resolveOfficialExternalPluginInstallSources(hostedOfficial).find(
        (source) => source.source === "clawhub",
      )
    : undefined;
  const hostedClawHub = parseClawHubPluginSpec(hostedSource?.spec ?? "");
  const requestMatchesHostedCandidate =
    !params.request.version || params.request.version === hostedClawHub?.version;
  const version =
    params.request.version ?? (requestMatchesHostedCandidate ? hostedClawHub?.version : undefined);
  const expectedIntegrity =
    params.expectedIntegrity ??
    (requestMatchesHostedCandidate ? hostedSource?.expectedIntegrity : undefined);
  return {
    source: "clawhub",
    spec: buildClawHubSpec(packageName, version),
    ...(official ? { trustedSourceLinkedOfficialInstall: true } : {}),
    ...(expectedPluginId ? { expectedPluginId } : {}),
    ...(expectedIntegrity ? { expectedIntegrity } : {}),
  };
}

function resolveManagedOfficialInstallRequest(params: {
  request: Extract<ManagedPluginInstallRequest, { source: "official" }>;
  officialEntries: readonly OfficialExternalPluginCatalogEntry[];
}): Extract<ManagedPluginSourceInstallRequest, { source: "official" }> {
  // CLI-known official ids retain the local catalog authority when omitted by a
  // hosted feed. A present hosted row owns its refusal and is never replaced.
  const entry =
    resolveOfficialEntryById(params.officialEntries, params.request.pluginId) ??
    resolveOfficialEntryById(listOfficialExternalPluginCatalogEntries(), params.request.pluginId);
  if (!entry) {
    throw new ManagedPluginLifecycleError(
      `unknown official plugin catalog entry: ${params.request.pluginId}`,
    );
  }
  const pluginId = resolveOfficialExternalPluginId(entry);
  const install = resolveOfficialExternalPluginInstall(entry);
  if (!pluginId || !install) {
    throw new ManagedPluginLifecycleError(
      `official plugin catalog entry is not installable: ${params.request.pluginId}`,
    );
  }
  const installSources = resolveOfficialInstallSources(entry, params.request.version).filter(
    (source) => !params.request.pin || source.source === "npm",
  );
  const primary = installSources[0];
  if (!primary) {
    throw new ManagedPluginLifecycleError(
      `official plugin catalog entry has no supported install source: ${params.request.pluginId}`,
    );
  }
  return {
    source: "official",
    spec: primary.spec,
    installSources,
    pluginId,
    expectedPluginId: resolveDeclaredOfficialPluginId(entry),
    mode: "install",
    ...(params.request.pin ? { pin: true } : {}),
  };
}

/** Resolve public source requests without accepting caller-asserted official trust. */
function resolveManagedPluginInstallRequest(
  request: ManagedPluginInstallRequest,
  officialEntries: readonly OfficialExternalPluginCatalogEntry[],
): ManagedPluginSourceInstallRequest {
  const mode = request.mode ?? "install";
  switch (request.source) {
    case "clawhub":
      return {
        ...resolveManagedClawHubInstallRequest({
          request,
          officialEntries,
          expectedIntegrity: request.expectedIntegrity,
        }),
        mode,
        ...(request.expectedPluginId ? { expectedPluginId: request.expectedPluginId } : {}),
      };
    case "official":
      return { ...resolveManagedOfficialInstallRequest({ request, officialEntries }), mode };
    case "bundled": {
      const bundledSource = findBundledPluginSource({
        lookup: { kind: "pluginId", value: request.pluginId },
      });
      if (!bundledSource) {
        throw new ManagedPluginLifecycleError(`unknown bundled plugin: ${request.pluginId}`);
      }
      return { source: "bundled", bundledSource };
    }
    case "local": {
      const bundledSource = findBundledPluginSource({
        lookup: { kind: "localPath", value: request.path },
      });
      return {
        ...request,
        mode,
        ...(bundledSource ? { bundledOrigin: true } : {}),
        recordSource: resolveArchiveKind(request.path) ? "archive" : "path",
      };
    }
    case "npm": {
      const trusted = resolveOpenClawTrustedNpmPackageInstall(request.spec);
      return {
        ...request,
        mode,
        ...(trusted ? { trustedSourceLinkedOfficialInstall: true } : {}),
        expectedPluginId: request.expectedPluginId ?? trusted?.pluginId,
        expectedIntegrity: request.expectedIntegrity ?? trusted?.expectedIntegrity,
      };
    }
    case "git":
    case "npm-pack":
    case "marketplace":
      return { ...request, mode };
  }
  request satisfies never;
  return assert.fail("Unreachable plugin install source");
}

/** Install a reviewed source through the canonical artifact and runtime lifecycle. */
export async function installManagedPlugin(
  params: ManagedPluginMutationOptions & {
    request: ManagedPluginInstallRequest;
    onCapabilityConsent?: PluginCapabilityConsentHandler;
    safetyOverrides?: InstallSafetyOverrides;
    logger?: PluginInstallLogger;
    confirmInstall?: () => Promise<boolean>;
  },
): Promise<{
  plugin: ManagedPluginCatalogEntry;
  warnings?: string[];
  application?: PluginRuntimeApplication;
}> {
  const env = params.env ?? process.env;
  return await withManagedPluginMutation(params, async (beforePersistentApply) => {
    const officialCatalog = await loadOfficialCatalog();
    const warnings: string[] = [];
    const installLogger = {
      terminalLinks: false,
      info: params.logger?.info,
      warn: (message: string) => warnings.push(message),
    };
    const request = resolveManagedPluginInstallRequest(params.request, officialCatalog.entries);
    assertConfigWriteAllowedInCurrentMode({ env });
    const context = resolvePluginInstallRequestContext({
      rawSpec:
        request.source === "local"
          ? request.path
          : request.source === "bundled"
            ? request.bundledSource.localPath
            : request.source === "npm-pack"
              ? `npm-pack:${request.archivePath}`
              : request.source === "marketplace"
                ? request.plugin
                : request.spec,
      ...(request.source === "marketplace" ? { marketplace: request.marketplace } : {}),
      installKind: "plugin",
    });
    if (!context.ok) {
      throw new ManagedPluginLifecycleError(context.error);
    }
    const snapshot = await loadConfigForInstall(context.request).catch((error: unknown) => {
      const source = request.source === "official" ? request.installSources[0] : undefined;
      if (
        error instanceof PluginInstallConfigError &&
        error.blockedSnapshot?.hookMutation.mode === "allowed" &&
        source?.source === "npm"
      ) {
        // No plugin installer ran. Only this catalog-selected artifact is
        // eligible for a separate hook-only inspection.
        const spec = resolveOfficialManagedInstallSpec({
          request: { ...source, trustedSourceLinkedOfficialInstall: true },
          config: error.blockedSnapshot.config,
        });
        throwInstallFailure({
          ok: false,
          error: error.message,
          code: PLUGIN_INSTALL_ERROR_CODE.CONFIG_MUTATION_BLOCKED,
          installSource: { ...source, spec: spec ?? source.spec },
        });
      }
      throw error;
    });
    const installed = await installManagedPluginSource({
      request,
      snapshot,
      env,
      applyRuntime: params.applyRuntime,
      beforePersistentApply: () => {
        snapshot.writeOptions.assertConfigPathForWrite?.();
        beforePersistentApply();
      },
      clawManaged: params.request.clawManaged,
      logger: installLogger,
      onCapabilityConsent: params.onCapabilityConsent,
      confirmInstall: params.request.source === "clawhub" ? params.confirmInstall : undefined,
      safetyOverrides: params.safetyOverrides,
      ...(params.request.acknowledgeCapabilities
        ? { acknowledgeCapabilities: params.request.acknowledgeCapabilities }
        : {}),
      ...(params.request.acknowledgeInstallPolicyWarning
        ? {
            safetyOverrides: {
              onInstallPolicyWarning: async () => ({ status: "approved" as const }),
            },
          }
        : {}),
    });
    if (!installed.ok) {
      return throwInstallFailure(installed);
    }
    warnings.push(...(installed.warnings ?? []));
    if ("pin" in params.request && params.request.pin) {
      warnings.push(
        installed.npmResolution?.resolvedSpec
          ? `Pinned npm install record to ${installed.npmResolution.resolvedSpec}.`
          : "Could not resolve exact npm version for --pin; storing original npm spec.",
      );
    }
    const workspace = resolvePluginControlPlaneWorkspace({ config: installed.config, env });
    if (workspace.diagnostic && !getProcessGatewayPluginMetadataSnapshot()) {
      warnings.push(workspace.diagnostic.message);
    }
    // Management inspects the committed candidate; the Gateway keeps its boot inventory.
    const installedMetadata = refreshManagedPluginMetadata({ config: installed.config, env });
    const catalog = await listManagedPlugins({
      config: installed.config,
      env,
      officialCatalog,
      metadata: installedMetadata,
    });
    const installedOwnership = resolveInstalledPluginPackageOwnership(
      installedMetadata.index,
      installed.pluginId,
      env,
    );
    if (!installedOwnership.ok) {
      throw new ManagedPluginLifecycleError(installedOwnership.error);
    }
    const installedPluginIds = installedOwnership.value.pluginIds;
    const representativePluginId = installedPluginIds[0]!;
    const plugin = catalog.plugins.find((entry) => entry.id === representativePluginId);
    if (!plugin) {
      throw new ManagedPluginLifecycleError(
        `installed plugin missing from refreshed registry: ${installed.pluginId}`,
      );
    }
    const installedWarnings = [...new Set(warnings)];
    if (installedPluginIds.length > 1) {
      installedWarnings.unshift(
        `Installed package "${installed.pluginId}" with plugin entries: ${installedPluginIds.join(", ")}.`,
      );
    }
    return {
      plugin,
      ...(installed.application ? { application: installed.application } : {}),
      ...(installedWarnings.length > 0 ? { warnings: installedWarnings } : {}),
    };
  });
}

/** Persist desired plugin policy while preserving allow/deny, slot, include, and hash guards. */
export async function setManagedPluginEnabled(
  params: ManagedPluginMutationOptions & {
    pluginId: string;
    enabled: boolean;
    requestCapabilityConsent?: boolean;
    acknowledgeCapabilities?: PluginCapabilityConsentAcknowledgment;
    onCapabilityConsent?: PluginCapabilityConsentHandler;
  },
): Promise<{
  plugin: ManagedPluginCatalogEntry;
  changedPaths: string[];
  warnings?: string[];
  application?: PluginRuntimeApplication;
}> {
  const env = params.env ?? process.env;
  return await withManagedPluginMutation(params, async (beforePersistentApply) => {
    const snapshot = await readPluginMutationSnapshot(env, beforePersistentApply);
    const metadata = loadFreshManagedPluginMetadata(snapshot.config, env);
    const pluginId = metadata.normalizePluginId(params.pluginId.trim());
    const installedPlugin = metadata.index.plugins.find((plugin) => plugin.pluginId === pluginId);
    if (!installedPlugin) {
      throw new ManagedPluginLifecycleError(`plugin not installed: ${params.pluginId}`);
    }
    // The shipped CLI permits no-option enable of an already-enabled plugin. Offline
    // policy writes preserve that contract; applying runtime always verifies consent.
    if (
      params.enabled &&
      (params.applyRuntime ||
        !installedPlugin.enabled ||
        (params.requestCapabilityConsent ?? Boolean(params.onCapabilityConsent)) ||
        params.acknowledgeCapabilities)
    ) {
      await resolvePluginCapabilityConsent({
        config: snapshot.config,
        env,
        pluginId,
        acknowledge: params.acknowledgeCapabilities,
        onCapabilityConsent: params.onCapabilityConsent,
        beforePersistentApply,
        metadata,
      });
    }
    let next = snapshot.config;
    const warnings: string[] = [];
    let policyPluginId = pluginId;
    if (params.enabled) {
      // An explicit enable is a trust action. Preserve the
      // existing inventory while admitting only the selected installed plugin.
      if ((next.plugins?.allow?.length ?? 0) > 0) {
        next = ensurePluginAllowlisted(next, pluginId);
      }
      const enableResult = enableExplicitlySelectedPluginInConfig(next, pluginId, {
        updateChannelConfig: false,
      });
      if (!enableResult.enabled) {
        throw new ManagedPluginLifecycleError(
          `plugin "${pluginId}" could not be enabled (${enableResult.reason ?? "unknown reason"})`,
        );
      }
      next = enableResult.config;
      policyPluginId = enableResult.pluginId;
      beforePersistentApply();
      const slotResult = applySlotSelectionForPlugin(next, pluginId, metadata);
      next = slotResult.config;
      warnings.push(...slotResult.warnings);
    } else {
      next = setPluginEnabledInConfig(next, pluginId, false, { updateChannelConfig: false });
    }
    const changedPaths = new Set<string>();
    collectChangedPaths(snapshot.config, next, "", changedPaths);
    const write = await replaceConfigFile({
      nextConfig: next,
      baseHash: snapshot.baseHash,
      writeOptions: {
        ...snapshot.writeOptions,
        // Persist the merged canonical entry, including compatibility-only settings.
        explicitSetPaths: [["plugins", "entries", policyPluginId]],
        ...(params.applyRuntime
          ? { afterWrite: { mode: "none" as const, reason: "plugin lifecycle applies runtime" } }
          : {}),
      },
    });
    await refreshPluginRegistryAfterConfigMutation({
      config: next,
      env,
      reason: "policy-changed",
      invalidateRuntimeCache: false,
      policyPluginIds: [policyPluginId],
      logger: { warn: (message) => warnings.push(message) },
    });
    const updatedMetadata = refreshManagedPluginMetadata({ config: next, env });
    const application = await params.applyRuntime?.({
      config: next,
      write,
      pluginIds: [policyPluginId],
      reason: params.enabled ? "enable" : "disable",
      assertInvokerOwned: beforePersistentApply,
    });
    const catalog = await listManagedPlugins({ config: next, env, metadata: updatedMetadata });
    const plugin = catalog.plugins.find((entry) => entry.id === pluginId);
    if (!plugin) {
      throw new ManagedPluginLifecycleError(
        `updated plugin missing from refreshed registry: ${pluginId}`,
      );
    }
    return {
      plugin,
      changedPaths: [...changedPaths].filter(Boolean).toSorted(),
      ...(application ? { application } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  });
}

async function prepareManagedPluginUninstall(params: {
  pluginId: string;
  keepFiles?: boolean;
  env?: NodeJS.ProcessEnv;
}) {
  const env = params.env ?? process.env;
  // Uninstall also repairs stale plugin references in otherwise invalid config.
  // The final writer still validates the resulting config and include ownership.
  const prepared = await readConfigFileSnapshotForWrite();
  const snapshot: ConfigSnapshotForInstallPersist = {
    config: prepared.snapshot.sourceConfig,
    baseHash: prepared.snapshot.hash,
    writeOptions: selectInstallMutationWriteOptions(prepared.writeOptions),
  };
  const installRecords = await loadInstalledPluginIndexInstallRecords({ env });
  const configWithRecords = withPluginInstallRecords(snapshot.config, installRecords);
  const metadata = loadFreshManagedPluginMetadata(configWithRecords, env);
  const selected = resolvePluginUninstallId({
    rawId: params.pluginId,
    config: configWithRecords,
    plugins: metadata.manifestRegistry.plugins.map((entry) => ({
      id: entry.id,
      name: entry.name ?? entry.id,
    })),
  });
  if (!selected.ok) {
    throw new ManagedPluginLifecycleError(selected.error);
  }
  const { pluginId } = selected.value;
  const record = metadata.index.plugins.find((plugin) => plugin.pluginId === pluginId);
  if (record?.origin === "bundled") {
    throw new ManagedPluginLifecycleError(
      `bundled plugin cannot be uninstalled: ${pluginId}; disable it instead`,
    );
  }
  const ownership = resolveInstalledPluginLifecycleOwnership(metadata.index, pluginId, env);
  if (!ownership.ok) {
    throw new ManagedPluginLifecycleError(ownership.error);
  }
  const { installOwner, pluginIds: ownedPluginIds } = ownership.value;
  const policyPluginIds = ownedPluginIds.length > 0 ? ownedPluginIds : [installOwner];
  const ownedManifests = ownedPluginIds.flatMap((entryId) => {
    const manifest = metadata.byPluginId.get(entryId);
    return manifest ? [manifest] : [];
  });
  // An orphan install id cannot claim channel config owned by another discovered plugin.
  const channelIds =
    ownedManifests.length > 0
      ? uniqueStrings(ownedManifests.flatMap((manifest) => manifest.channels))
      : ownership.value.kind === "orphan" &&
          createInstalledPluginIndexScopeLookup(metadata.index).hasChannelContributionOwners([
            installOwner,
          ])
        ? []
        : undefined;
  const extensionsDir = resolveDefaultPluginExtensionsDir(env);
  // Package ownership stays under the lifecycle lease; config is reread after teardown.
  const planForConfig = (config: OpenClawConfig) => {
    const plan = planPluginUninstall(
      recordPluginPackageUninstallPlan(
        {
          config: withPluginInstallRecords(config, installRecords),
          pluginId: installOwner,
          ...(channelIds !== undefined ? { channelIds } : {}),
          deleteFiles: !params.keepFiles,
          extensionsDir,
        },
        {
          runtimePluginIds: policyPluginIds,
          runtimeLoadPaths: ownedPluginIds.flatMap(
            (entryId) => metadata.byPluginId.get(entryId)?.source ?? [],
          ),
        },
      ),
    );
    if (!plan.ok) {
      throw new ManagedPluginLifecycleError(plan.error);
    }
    return plan;
  };
  return {
    snapshot,
    installRecords,
    pluginId,
    installOwner,
    ownedPluginIds,
    policyPluginIds,
    channelIds,
    plan: planForConfig(snapshot.config),
    planForConfig,
    name: selected.value.plugin?.name ?? installOwner,
    warnings: collectClawPluginUninstallWarnings({
      pluginId: installOwner,
      installRecord: installRecords[installOwner],
      env,
    }),
  };
}

/** Preview the same package ownership and removal plan that the executor revalidates. */
export async function planManagedPluginUninstall(params: {
  pluginId: string;
  keepFiles?: boolean;
  env?: NodeJS.ProcessEnv;
}) {
  const prepared = await prepareManagedPluginUninstall(params);
  const { plan, installOwner, ownedPluginIds, pluginId, snapshot, channelIds } = prepared;
  const preview = formatUninstallActionLabels(plan.actions).filter(
    (label) =>
      label !== UNINSTALL_ACTION_LABELS.memorySlot &&
      label !== UNINSTALL_ACTION_LABELS.contextEngineSlot &&
      label !== UNINSTALL_ACTION_LABELS.channelConfig,
  );
  for (const key of ["memory", "contextEngine"] as const) {
    if (plan.actions[key === "memory" ? "memorySlot" : "contextEngineSlot"]) {
      preview.push(formatUninstallSlotResetPreview(key));
    }
  }
  if (plan.actions.channelConfig) {
    for (const key of resolveUninstallChannelConfigKeys(installOwner, { channelIds })) {
      if (Object.hasOwn(snapshot.config.channels ?? {}, key)) {
        preview.push(`${UNINSTALL_ACTION_LABELS.channelConfig} (channels.${key})`);
      }
    }
  }
  if (plan.directoryRemoval) {
    preview.push(`directory: ${plan.directoryRemoval.target}`);
  }
  return {
    pluginId: installOwner,
    requestedPluginId: pluginId,
    pluginIds: ownedPluginIds,
    name: prepared.name,
    preview,
    warnings: prepared.warnings,
  };
}

/** Remove one package through the same durable and runtime lifecycle for every caller. */
export async function uninstallManagedPlugin(
  params: ManagedPluginMutationOptions & {
    pluginId: string;
    keepFiles?: boolean;
    clawManaged?: boolean;
    invalidateRuntimeCache?: boolean;
  },
): Promise<{
  pluginId: string;
  removed: string[];
  warnings?: string[];
  application?: PluginRuntimeApplication;
}> {
  const env = params.env ?? process.env;
  assertConfigWriteAllowedInCurrentMode({ env });
  return await withManagedPluginMutation(params, async (beforePersistentApply) => {
    let prepared = await prepareManagedPluginUninstall(params);
    const { installOwner, ownedPluginIds, policyPluginIds, pluginId } = prepared;
    const uninstall = async () => {
      let { plan, snapshot } = prepared;
      const { installRecords } = prepared;
      let directoryResult = { directoryRemoved: false, warnings: [] as string[] };
      if (plan.directoryRemoval) {
        const disabledConfig = prepareConfigForDisabledPluginSet(snapshot.config, policyPluginIds);
        const write = await replaceConfigFile({
          nextConfig: disabledConfig,
          baseHash: snapshot.baseHash,
          writeOptions: {
            ...selectInstallMutationWriteOptions(snapshot.writeOptions, beforePersistentApply),
            afterWrite: params.applyRuntime
              ? { mode: "none", reason: "plugin lifecycle applies runtime" }
              : { mode: "auto" },
          },
        });
        // The runtime must release old imports and resources before their files disappear.
        await params.applyRuntime?.({
          config: disabledConfig,
          write,
          pluginIds: policyPluginIds,
          reason: "uninstall",
          assertInvokerOwned: beforePersistentApply,
        });
        // Runtime teardown yields; revalidate before removing the stopped plugin source.
        beforePersistentApply();
        directoryResult = await applyPluginUninstallDirectoryRemoval(
          plan.directoryRemoval,
          beforePersistentApply,
        );
        if (pluginUninstallTargetExists(plan.directoryRemoval.target)) {
          throw new ManagedPluginLifecycleError(
            `Failed to remove plugin directory ${plan.directoryRemoval.target}; the plugin remains disabled and tracked so uninstall can be retried.`,
            { kind: "unavailable" },
          );
        }
        const refreshed = await readConfigFileSnapshotForWrite();
        snapshot = {
          config: refreshed.snapshot.sourceConfig,
          baseHash: refreshed.snapshot.hash,
          writeOptions: selectInstallMutationWriteOptions(refreshed.writeOptions),
        };
        plan = prepared.planForConfig(snapshot.config);
      }
      const nextConfig = withoutPluginInstallRecords(plan.config);
      const nextInstallRecords = removePluginInstallRecordFromRecords(installRecords, installOwner);
      const write = await commitPluginInstallRecordsWithConfig({
        previousInstallRecords: installRecords,
        nextInstallRecords,
        nextConfig,
        baseHash: snapshot.baseHash,
        writeOptions: {
          ...selectInstallMutationWriteOptions(snapshot.writeOptions, beforePersistentApply),
          allowConfigSizeDrop: true,
          ...(params.applyRuntime
            ? { afterWrite: { mode: "none" as const, reason: "plugin lifecycle applies runtime" } }
            : {}),
        },
      });
      const warnings = [
        ...prepared.warnings,
        ...(pluginId !== installOwner || ownedPluginIds.length > 1
          ? [
              `Uninstalled package "${installOwner}" and all owned plugin entries: ${ownedPluginIds.join(", ")}.`,
            ]
          : []),
        ...directoryResult.warnings,
      ];
      await refreshPluginRegistryAfterConfigMutation({
        config: nextConfig,
        env,
        reason: "source-changed",
        installRecords: nextInstallRecords,
        invalidateRuntimeCache: params.invalidateRuntimeCache ?? false,
        logger: { warn: (message) => warnings.push(message) },
      });
      refreshManagedPluginMetadata({ config: nextConfig, env });
      const application = await params.applyRuntime?.({
        config: nextConfig,
        write,
        pluginIds: policyPluginIds,
        reason: "uninstall",
        assertInvokerOwned: beforePersistentApply,
      });
      const removed = formatUninstallActionLabels({
        ...plan.actions,
        directory: directoryResult.directoryRemoved,
      });
      return {
        pluginId: installOwner,
        removed,
        ...(application ? { application } : {}),
        ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
      };
    };
    const record = prepared.installRecords[installOwner];
    const clawhubPackage =
      record?.source === "clawhub"
        ? (record.clawhubPackage ?? parseClawHubPluginSpec(record.spec ?? "")?.name)
        : undefined;
    if (params.clawManaged || !clawhubPackage) {
      return await uninstall();
    }
    return await withClawPackageLifecycleLease(
      { kind: "plugin", source: "clawhub", ref: clawhubPackage },
      async () => {
        prepared = await prepareManagedPluginUninstall(params);
        return await uninstall();
      },
      { required: true },
    );
  });
}

/** Reload the selected installed package through the running Gateway's lifecycle owner. */
export async function reloadManagedPlugin(
  params: ManagedPluginMutationOptions & {
    pluginId: string;
    applyRuntime: PluginLifecycleRuntimeApply;
    acknowledgeCapabilities?: PluginCapabilityConsentAcknowledgment;
    onCapabilityConsent?: PluginCapabilityConsentHandler;
  },
): Promise<{ pluginId: string; application: PluginRuntimeApplication }> {
  const env = params.env ?? process.env;
  return await withManagedPluginMutation(params, async (beforePersistentApply) => {
    const snapshot = await readPluginMutationSnapshot(env, beforePersistentApply);
    const metadata = loadFreshManagedPluginMetadata(snapshot.config, env);
    const pluginId = metadata.normalizePluginId(params.pluginId.trim());
    if (!metadata.index.plugins.some((plugin) => plugin.pluginId === pluginId)) {
      throw new ManagedPluginLifecycleError(`plugin not installed: ${params.pluginId}`);
    }
    const ownership = resolveInstalledPluginLifecycleOwnership(metadata.index, pluginId, env);
    const pluginIds =
      ownership.ok && ownership.value.pluginIds.length > 0 ? ownership.value.pluginIds : [pluginId];
    await resolvePluginCapabilityConsent({
      config: snapshot.config,
      env,
      pluginId,
      metadata,
      acknowledge: params.acknowledgeCapabilities,
      onCapabilityConsent: params.onCapabilityConsent,
      beforePersistentApply,
    });
    return {
      pluginId,
      application: await params.applyRuntime({
        config: snapshot.config,
        pluginIds,
        reason: "reload",
        assertInvokerOwned: beforePersistentApply,
      }),
    };
  });
}

/** Apply an explicit metadata refresh under the same cross-process lifecycle lease. */
export async function refreshManagedPlugins(
  params: ManagedPluginMutationOptions & {
    applyRuntime: PluginLifecycleRuntimeApply;
  },
): Promise<{ application: PluginRuntimeApplication }> {
  const env = params.env ?? process.env;
  return await withManagedPluginMutation(params, async (beforePersistentApply) => {
    const snapshot = await readPluginMutationSnapshot(env, beforePersistentApply);
    const metadata = refreshManagedPluginMetadata({ config: snapshot.config, env });
    return {
      application: await params.applyRuntime({
        config: snapshot.config,
        pluginIds: metadata.index.plugins.map((plugin) => plugin.pluginId),
        reason: "metadata",
        assertInvokerOwned: beforePersistentApply,
      }),
    };
  });
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
