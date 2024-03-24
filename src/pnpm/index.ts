import { getLockfileImporterId, Lockfile, PackageSnapshot, ProjectSnapshot, readWantedLockfile } from '@pnpm/lockfile-file';
import { DEPENDENCIES_FIELDS } from '@pnpm/types';
import { pruneSharedLockfile } from '@pnpm/prune-lockfile';
import { getPackages } from '@manypkg/get-packages';
import { indexOfPeersSuffix } from '@pnpm/dependency-path';

const LATEST_SUPPORTED_PNPM_LOCK_VERSION = 6.0;

export async function parseLockfile(pkgPath: string): Promise<Lockfile> {
  const lock = await readWantedLockfile(pkgPath, { ignoreIncompatible: true });
  if (lock == null) throw new Error('pnpm lockfile not found');

  if (lock.lockfileVersion > LATEST_SUPPORTED_PNPM_LOCK_VERSION)
    console.warn(
      `Your lockfile version (${lock.lockfileVersion}) is higher than the supported version of pnpm-lock-export (${LATEST_SUPPORTED_PNPM_LOCK_VERSION}).`
    );

  return lock;
}

/**
 * Package matched up with the declared dependencies that resolve to that
 * package.
 */
export interface PackageWithSpecifiers {
  pkg: PackageSnapshot,
  depPath: string,
  matchingDependencies: DeclaredDependency[],
}

/**
 * A lock file includes required package names and specifiers.
 *
 * Specifiers are what is written in package.json. They may be semver
 * expressions, URIs, shorthand references to Github repos. Some examples are:
 *
 * - 2.1.0
 * - ^2.1.0
 * - npm:safe-execa@2.1.0
 * - github:tauri-apps/tauri-plugin-log#v1
 *
 * The package key is the key used to get the resolved dependency from the lock
 * files `packages` map.
 */
export interface DeclaredDependency {
  name: string,
  specifier: string,
  depPath: string,
}

/**
 * Traverse a lock file match up its packages with the names and specifiers that
 * resolve to those packages.
 */
export function packagesWithSpecifiers(lock: Lockfile): PackageWithSpecifiers[] {

  // Top-level dependencies are listed in the `importers` portion of the parsed
  // lock file. A lock file can have multiple importers. Each has
  // `dependencies`, `devDependencies`, and `optionalDependencies` which map dependency names to keys in the lock file
  // `packages` map, and a `specifiers` map that maps dependency names to the
  // specifiers given in `package.json`.
  const rootDependencies: DeclaredDependency[] = Object.values(lock.importers).flatMap((importer) =>
    entries(importer.specifiers).map(([name, specifier]) => {
      const resolvedVersion = DEPENDENCIES_FIELDS
        .map(field => importer[field]?.[name])
        .filter(v => !!v)[0];

      if (!resolvedVersion) {
        throw new Error(`could not find dep path for dependency: ${name}`);
      }
      const depPath = depPathFromDependency(name, resolvedVersion);
      const dependency: DeclaredDependency = {
        name,
        specifier,
        depPath,
      };
      return dependency;
    })
  );

  // The `importers` section only covers top-level dependencies. We also need to
  // get packages pulled in as transitive dependencies. These are found by
  // traversing the `dependencies` and `optionalDependencies` properties of each
  // entry in `packages`. These sections use exact versions, not specifiers.
  // (`peerDependencies` does use specifiers, but we can ignore those.)
  const transitiveDependencies: DeclaredDependency[] = values(lock.packages).flatMap(pkg =>
    entries(pkg.dependencies).concat(entries(pkg.optionalDependencies))
  ).map(([name, version]) => {
    const dependency: DeclaredDependency = {
      name,
      specifier: versionWithoutPeersSuffix(version),
      depPath: depPathFromDependency(name, version),
    };
    return dependency;
  });

  const dependencies = rootDependencies.concat(transitiveDependencies);

  return entries(lock.packages).map((([key, pkg]) => {
    const withSpecifiers: PackageWithSpecifiers = {
      pkg: pkg,
      depPath: key,
      matchingDependencies: dependencies.filter(dep => dep.depPath == key),
    };
    return withSpecifiers;
  }))
}

/**
 * pnpm dependencies in lock files are either:
 *   - a dep path (from npm:)
 *   - a dep path (from git:)
 *   - a version (from regular dependency) with optional peer suffixes
 *
 * This function normalizes them all to dep paths. dep paths can be used to
 * look up a package snapshot in the lock file's `packages` map.
 */
export function depPathFromDependency(name: string, resolvedVersion: string): string {
  // Either it's a version number with optional peer suffixes...
  if (resolvedVersion.match(/^\d/)) {
    // in which case there is a formula for constructing a key
    return `/${name}/${resolvedVersion}`

    // or it's something else
  } else {
    // in which case it's already a dep path
    return resolvedVersion
  }
}

export function versionWithoutPeersSuffix(version: string): string {
  const index = indexOfPeersSuffix(version);
  return index >= 0
    ? version.slice(0, index)
    : version;
}

export async function workspaceProjectPaths(lockfileDir: string): Promise<Set<string>> {
  return new Set<string>(
    await getPackages(lockfileDir).then(({ root, packages }) => {
      return packages.map(({ dir }) => dir).filter((pkg) => pkg !== root.dir);
    })
  );
}

// From https://github.com/pnpm/pnpm/blob/main/packages/make-dedicated-lockfile/src/index.ts
export async function dedicatedLockfile(lockfileDir: string, projectDir: string): Promise<Lockfile> {
  const lockfile = await parseLockfile(lockfileDir);

  const allImporters = lockfile.importers;
  lockfile.importers = {};
  const baseImporterId = getLockfileImporterId(lockfileDir, projectDir);
  for (const [importerId, importer] of Object.entries(allImporters)) {
    if (importerId.startsWith(`${baseImporterId}/`)) {
      const newImporterId = importerId.slice(baseImporterId.length + 1);
      lockfile.importers[newImporterId] = projectSnapshotWithoutLinkedDeps(importer);
      continue;
    }
    if (importerId === baseImporterId) {
      lockfile.importers['.'] = projectSnapshotWithoutLinkedDeps(importer);
    }
  }

  return pruneSharedLockfile(lockfile);
}

// From https://github.com/pnpm/pnpm/blob/main/packages/make-dedicated-lockfile/src/index.ts
function projectSnapshotWithoutLinkedDeps(projectSnapshot: ProjectSnapshot) {
  const newProjectSnapshot: ProjectSnapshot = {
    specifiers: projectSnapshot.specifiers,
  };
  for (const depField of DEPENDENCIES_FIELDS) {
    if (projectSnapshot[depField] == null) continue;
    newProjectSnapshot[depField] = Object.fromEntries(
      Object.entries(projectSnapshot[depField] ?? {}).filter((entry) => !entry[1].startsWith('link:'))
    );
  }
  return newProjectSnapshot;
}

/**
 * Get a list of values from an object, or an empty list if a nullish input is
 * given
 */
function values<T>(o: { [key: string]: T } | null | undefined): T[] {
  return o ? Object.values(o) : []
}

/**
 * Get a list of entries from an object, or an empty list if a nullish input is
 * given
 */
function entries<T>(o: { [key: string]: T } | null | undefined): [string, T][] {
  return o ? Object.entries(o) : []
}
