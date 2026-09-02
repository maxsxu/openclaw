// Loads plugin public runtime surfaces through documented entrypoints.
import path from "node:path";
import { isPathInside } from "../infra/path-guards.js";
import { resolveUserPath } from "../utils.js";
import { areBundledPluginsDisabled, resolveBundledPluginsDir } from "./bundled-dir.js";
import { pluginCacheExistsSync, pluginCacheRealpathSync } from "./plugin-cache-files.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { resolvePluginRuntimeRecord } from "./runtime-state.js";

export const PUBLIC_SURFACE_SOURCE_EXTENSIONS = [
  ".ts",
  ".mts",
  ".js",
  ".mjs",
  ".cts",
  ".cjs",
] as const;

/** Normalizes a bundled public artifact subpath and rejects traversal/absolute paths. */
function normalizeBundledPluginArtifactSubpath(artifactBasename: string): string {
  if (
    path.posix.isAbsolute(artifactBasename) ||
    path.win32.isAbsolute(artifactBasename) ||
    artifactBasename.includes("\\")
  ) {
    throw new Error(`Bundled plugin artifact path must stay plugin-local: ${artifactBasename}`);
  }

  const normalized = artifactBasename.replace(/^\.\//u, "");
  if (!normalized) {
    throw new Error("Bundled plugin artifact path must not be empty");
  }

  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === ".." || segment.includes(":"),
    )
  ) {
    throw new Error(`Bundled plugin artifact path must stay plugin-local: ${artifactBasename}`);
  }

  return normalized;
}

/** Normalizes a bundled plugin directory name and rejects path-like values. */
function normalizeBundledPluginDirName(dirName: string): string {
  const normalized = dirName.trim();
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    normalized.includes(":")
  ) {
    throw new Error(`Bundled plugin dirName must be a single directory: ${dirName}`);
  }
  return normalized;
}

/** Resolves a source-tree public surface artifact path for bundled plugin development. */
export function resolveBundledPluginSourcePublicSurfacePath(params: {
  sourceRoot: string;
  dirName: string;
  artifactBasename: string;
}): string | null {
  const artifactBasename = normalizeBundledPluginArtifactSubpath(params.artifactBasename);
  const dirName = normalizeBundledPluginDirName(params.dirName);
  const sourceBaseName = artifactBasename.replace(/\.js$/u, "");
  for (const ext of PUBLIC_SURFACE_SOURCE_EXTENSIONS) {
    const sourceCandidate = path.resolve(params.sourceRoot, dirName, `${sourceBaseName}${ext}`);
    if (pluginCacheExistsSync(sourceCandidate)) {
      return sourceCandidate;
    }
  }
  return null;
}

/** Resolves a public surface artifact within one installed plugin root. */
export function resolvePluginRootPublicSurfacePath(params: {
  pluginRoot: string;
  artifactBasename: string;
  pluginId?: string;
  entrySource?: string;
}): string | null {
  const artifactBasename = normalizeBundledPluginArtifactSubpath(params.artifactBasename);
  const pluginRoot = path.resolve(params.pluginRoot);
  const record = resolvePluginRuntimeRecord(params);
  const instance = record ? getPluginInstance(record) : undefined;
  const exists = (source: string) =>
    instance?.hasModuleSource(source) ?? pluginCacheExistsSync(source);
  const sourceBaseName = artifactBasename.replace(/\.js$/u, "");
  const entryDir = params.entrySource ? path.dirname(path.resolve(params.entrySource)) : undefined;
  if (entryDir && !isPathInside(pluginRoot, entryDir)) {
    throw new Error(
      `Plugin public surface entry must stay inside its plugin root: ${params.entrySource}`,
    );
  }
  // Sidecars adjacent to the registered entry precede root-level fallbacks.
  // Captured membership keeps that choice stable after source edits or removal.
  return (
    [
      ...(entryDir
        ? [
            path.join(entryDir, artifactBasename),
            ...PUBLIC_SURFACE_SOURCE_EXTENSIONS.map((ext) =>
              path.join(entryDir, `${sourceBaseName}${ext}`),
            ),
          ]
        : []),
      path.join(pluginRoot, artifactBasename),
      path.join(pluginRoot, "dist", artifactBasename),
      ...PUBLIC_SURFACE_SOURCE_EXTENSIONS.map((ext) =>
        path.join(pluginRoot, `${sourceBaseName}${ext}`),
      ),
    ].find(exists) ?? null
  );
}

function resolvePackageFallbackForBundledDir(params: {
  rootDir: string;
  bundledPluginsDir: string;
  dirName: string;
  artifactBasename: string;
}): string | null {
  const normalizedBundledDir = path.resolve(params.bundledPluginsDir);
  const normalizedRootDir = path.resolve(params.rootDir);
  const packageBundledDirs = [
    path.join(normalizedRootDir, "dist", "extensions"),
    path.join(normalizedRootDir, "dist-runtime", "extensions"),
  ];
  if (!packageBundledDirs.includes(normalizedBundledDir)) {
    return null;
  }
  for (const packageBundledDir of packageBundledDirs) {
    if (packageBundledDir === normalizedBundledDir) {
      continue;
    }
    const builtCandidate = path.join(packageBundledDir, params.dirName, params.artifactBasename);
    if (pluginCacheExistsSync(builtCandidate)) {
      return builtCandidate;
    }
  }
  return (
    resolveRetainedConfigDoctorPath(params) ??
    resolveBundledPluginSourcePublicSurfacePath({
      sourceRoot: path.join(normalizedRootDir, "extensions"),
      dirName: params.dirName,
      artifactBasename: params.artifactBasename,
    })
  );
}

function resolveRetainedConfigDoctorPath(params: {
  rootDir: string;
  dirName: string;
  artifactBasename: string;
}): string | null {
  if (params.artifactBasename !== "config-doctor-api.js") {
    return null;
  }
  // Externalizing a channel removes its runtime entry, but shipped config still needs
  // its core-version migration before that plugin can be installed or granted capabilities.
  for (const dist of ["dist", "dist-runtime"]) {
    const candidate = path.resolve(params.rootDir, dist, "config-doctor", `${params.dirName}.js`);
    if (pluginCacheExistsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function sameExistingPath(left: string, right: string): boolean {
  const canonicalLeft = pluginCacheRealpathSync(left);
  return canonicalLeft !== null && canonicalLeft === pluginCacheRealpathSync(right);
}

function resolveExplicitEnvBundledPluginsDir(env: NodeJS.ProcessEnv): string | undefined {
  const envOverride = env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim();
  if (!envOverride) {
    return undefined;
  }
  const bundledPluginsDir = resolveBundledPluginsDir(env);
  if (!bundledPluginsDir) {
    return undefined;
  }
  const requestedDir = resolveUserPath(envOverride, env);
  return sameExistingPath(requestedDir, bundledPluginsDir) ? bundledPluginsDir : undefined;
}

function resolvePublicSurfaceFromBundledDir(params: {
  rootDir: string;
  bundledPluginsDir: string;
  dirName: string;
  artifactBasename: string;
}): string | null {
  return (
    resolvePluginRootPublicSurfacePath({
      pluginRoot: path.resolve(params.bundledPluginsDir, params.dirName),
      artifactBasename: params.artifactBasename,
    }) ?? resolvePackageFallbackForBundledDir(params)
  );
}

/** Resolves a bundled plugin public surface artifact across source, dist, and package layouts. */
export function resolveBundledPluginPublicSurfacePath(params: {
  rootDir: string;
  dirName: string;
  artifactBasename: string;
  env?: NodeJS.ProcessEnv;
  bundledPluginsDir?: string;
  bundledPluginsDirMode?: "explicit" | "auto";
}): string | null {
  const artifactBasename = normalizeBundledPluginArtifactSubpath(params.artifactBasename);
  const dirName = normalizeBundledPluginDirName(params.dirName);
  const env = params.env ?? process.env;

  const explicitBundledPluginsDir =
    params.bundledPluginsDirMode === "auto"
      ? resolveExplicitEnvBundledPluginsDir(env)
      : (params.bundledPluginsDir ?? resolveExplicitEnvBundledPluginsDir(env));
  if (explicitBundledPluginsDir) {
    return resolvePublicSurfaceFromBundledDir({
      rootDir: params.rootDir,
      bundledPluginsDir: explicitBundledPluginsDir,
      dirName,
      artifactBasename,
    });
  }

  if (areBundledPluginsDisabled(env)) {
    return null;
  }

  const sourceCandidate = resolveBundledPluginSourcePublicSurfacePath({
    sourceRoot: path.resolve(params.rootDir, "extensions"),
    dirName,
    artifactBasename,
  });
  if (sourceCandidate) {
    return sourceCandidate;
  }

  const bundledPluginsDir =
    params.bundledPluginsDirMode === "auto"
      ? params.bundledPluginsDir
      : resolveBundledPluginsDir(env);
  if (bundledPluginsDir) {
    const bundledCandidate = resolvePublicSurfaceFromBundledDir({
      rootDir: params.rootDir,
      bundledPluginsDir,
      dirName,
      artifactBasename,
    });
    if (bundledCandidate) {
      return bundledCandidate;
    }
  }

  for (const candidate of [
    path.resolve(params.rootDir, "dist", "extensions", dirName, artifactBasename),
    path.resolve(params.rootDir, "dist-runtime", "extensions", dirName, artifactBasename),
  ]) {
    if (pluginCacheExistsSync(candidate)) {
      return candidate;
    }
  }
  return resolveRetainedConfigDoctorPath({ ...params, dirName, artifactBasename });
}
