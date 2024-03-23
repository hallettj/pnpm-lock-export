import { writeFile } from 'fs/promises';
import path from 'path';

import type { Lockfile, TarballResolution } from '@pnpm/lockfile-types';
import { nameVerFromPkgSnapshot, pkgSnapshotToResolution } from '@pnpm/lockfile-utils';
import semver from 'semver';

import type { Package, YarnLock } from './types';
import { depPathFromDependency, dedicatedLockfile, parseLockfile, workspaceProjectPaths } from '../../pnpm';

export async function convert(lockfileDir: string): Promise<YarnLock> {
  return parseLockfile(lockfileDir).then(convertLockfile);
}

export async function convertLockfile(lock: Lockfile): Promise<YarnLock> {
  const specifiers = Object.values(lock.importers).flatMap((importer) => Object.entries(importer.specifiers));

  return Object.fromEntries(
    Object.entries(lock.packages ?? {}).map(([depPath, snapshot]) => {
      const { name, version } = nameVerFromPkgSnapshot(depPath, snapshot);
      const resolution = pkgSnapshotToResolution(depPath, snapshot, { default: 'https://registry.npmjs.org/' });

      const pkg: Package = {
        version,
        resolved: (resolution as TarballResolution).tarball,
      };

      const integrity = (resolution as TarballResolution).integrity;
      if (integrity) pkg.integrity = integrity;

      if (snapshot.dependencies) {
        pkg.dependencies = Object.fromEntries(
          Object.entries(snapshot.dependencies ?? {}).map((entry) => {
            const { name, version } = depPathFromDependency(entry);
            return [name ?? entry[0], version ?? entry[1]];
          })
        );
      }

      const names = new Set(
        specifiers
          .filter(([pkg]) => pkg === name)
          .map((entry) => entry[1])
          .filter((specifier) => semver.satisfies(version, specifier))
          .concat(version)
          .map((v) => `"${name}@${v}"`)
      );

      return [Array.from(names).join(', '), pkg];
    })
  );
}

export function serialize(lock: YarnLock): string {
  const preamble = `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n`;
  const packages = Object.entries(lock)
    .map(([path, pkg]) => {
      let acc = `${path}:
  version "${pkg.version}"
  resolved "${pkg.resolved}"
  integrity "${pkg.integrity}"
`;

      if (pkg.dependencies && Object.keys(pkg.dependencies).length) {
        const deps = Object.entries(pkg.dependencies)
          .map(([k, v]) => `    "${k}" "${v.replace(/\(.*/, '')}"`)
          .join('\n');

        acc += `  dependencies:\n${deps}\n`;
      }

      return acc;
    })
    .join('\n');

  return `${preamble}\n\n${packages}`;
}

export async function write(lockfileDir: string): Promise<void> {
  await convert(lockfileDir)
    .then(serialize)
    .then((lock) => writeFile(path.join(lockfileDir, 'yarn.lock'), lock));
}

export async function writeRecursive(lockfileDir: string): Promise<void> {
  const packages = await workspaceProjectPaths(lockfileDir);

  // Make and convert lockfiles for workspace packages
  await Promise.all(
    Array.from(packages).map(async (pkgDir) => {
      await dedicatedLockfile(lockfileDir, pkgDir)
        .then(convertLockfile)
        .then(serialize)
        .then((lock) => writeFile(path.join(pkgDir, 'yarn.lock'), lock));
    })
  );

  // and root
  await write(lockfileDir);
}
