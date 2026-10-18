import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DSO_REGISTRY,
  type DsoRegistryEntry,
} from '../registry/index.js';
import type {
  DsoCatalog,
  DsoCatalogEntry,
  DsoFreshnessState,
  DsoId,
  DsoManifest,
  DsoObjectStatus,
  DsoSnapshot,
} from '@orbitwatch/contracts';
import { atomicWriteJson } from '../../utils/atomic-write.js';
import { dsoCacheRoot } from '../../utils/paths.js';
import { logger } from '../../utils/logger.js';

/** How many snapshot files per object are kept. Older ones are deleted: only the newest is served. */
export const SNAPSHOT_RETENTION_COUNT = 3;

export function getDsoCacheRoot(): string {
  return dsoCacheRoot();
}

export function getDsoCatalogPath(): string {
  return path.join(getDsoCacheRoot(), 'catalog.json');
}

export function getDsoManifestPath(): string {
  return path.join(getDsoCacheRoot(), 'manifest.json');
}

export function getDsoSnapshotsRoot(): string {
  return path.join(getDsoCacheRoot(), 'snapshots');
}

export function getDsoSnapshotRelativePath(dsoId: DsoId, snapshotVersion: string): string {
  return path.posix.join('snapshots', dsoId, `${snapshotVersion}.json`);
}

export function getDsoSnapshotPath(dsoId: DsoId, snapshotVersion: string): string {
  return path.join(getDsoCacheRoot(), getDsoSnapshotRelativePath(dsoId, snapshotVersion));
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function createUnavailableStatus(entry: DsoRegistryEntry): DsoObjectStatus {
  return {
    enabled: entry.enabled,
    provider: entry.provider,
    providerObjectId: entry.providerObjectId,
    currentSnapshotVersion: null,
    freshnessState: 'unavailable',
    validFrom: null,
    validTo: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    failureCount: 0,
    availability: false,
    snapshotPath: null,
  };
}

function coerceManifest(entries: readonly DsoRegistryEntry[], manifest: DsoManifest | null): DsoManifest {
  const objects: Record<DsoId, DsoObjectStatus> = {};

  for (const entry of entries) {
    const existing = manifest?.objects[entry.dsoId];
    objects[entry.dsoId] = existing
      ? {
          ...existing,
          enabled: entry.enabled,
          provider: entry.provider,
          providerObjectId: entry.providerObjectId,
        }
      : createUnavailableStatus(entry);
  }

  return {
    generatedAt: manifest?.generatedAt ?? new Date().toISOString(),
    workerLastRunAt: manifest?.workerLastRunAt ?? null,
    objects,
  };
}

export function deriveDsoFreshnessState(
  status: Pick<DsoObjectStatus, 'currentSnapshotVersion' | 'lastSuccessAt' | 'validTo'>,
  refreshIntervalSec: number,
  now: Date = new Date(),
): DsoFreshnessState {
  if (!status.currentSnapshotVersion || !status.lastSuccessAt) {
    return 'unavailable';
  }

  const nowMs = now.getTime();
  const lastSuccessMs = Date.parse(status.lastSuccessAt);
  const validToMs = status.validTo ? Date.parse(status.validTo) : Number.NaN;

  if (!Number.isFinite(lastSuccessMs)) {
    return 'unavailable';
  }

  if (nowMs - lastSuccessMs <= refreshIntervalSec * 1000) {
    return 'fresh';
  }

  if (Number.isFinite(validToMs) && nowMs <= validToMs) {
    return 'stale';
  }

  return 'degraded';
}

export function buildDsoCatalog(
  entries: readonly DsoRegistryEntry[],
  manifest: DsoManifest,
): DsoCatalog {
  const objects: DsoCatalogEntry[] = entries.map((entry) => {
    const status = manifest.objects[entry.dsoId] ?? createUnavailableStatus(entry);

    return {
      dsoId: entry.dsoId,
      slug: entry.slug,
      displayName: entry.displayName,
      mission: entry.mission,
      targetBody: entry.targetBody,
      regime: entry.regime,
      provider: entry.provider,
      availability: status.availability,
      freshnessState: status.freshnessState,
      currentSnapshotVersion: status.currentSnapshotVersion,
      validFrom: status.validFrom,
      validTo: status.validTo,
      searchAliases: entry.searchAliases,
    };
  });

  return {
    catalogVersion: manifest.generatedAt,
    generatedAt: manifest.generatedAt,
    objects,
  };
}

/**
 * Keep the newest SNAPSHOT_RETENTION_COUNT snapshot files of one object in
 * `snapshots/<id>/` and DELETE the older ones. Orphaned `.tmp` files left by an
 * aborted atomic write are deleted too.
 *
 * Old versions have no value: readers serve only the manifest's current snapshot, and
 * a newer snapshot replaces the older values for the same times. The version the
 * manifest points to (`keepVersion`) is never deleted, whatever its name sorts like.
 *
 * Call it only AFTER the manifest points at the new snapshot (see publishDsoSnapshot).
 *
 * Housekeeping only: a failure here is logged and the file is retried on the next
 * publish. It must never turn a published snapshot into a recorded refresh failure,
 * so this function does not throw.
 */
export async function pruneSnapshotGenerations(dsoId: DsoId, keepVersion: string | null = null): Promise<void> {
  const snapshotDir = path.join(getDsoSnapshotsRoot(), dsoId);

  let files: string[];
  try {
    files = await fs.readdir(snapshotDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    logger.warn(`DSO snapshot housekeeping could not list ${dsoId} (${(error as Error).message})`);
    return;
  }

  const keepFile = keepVersion ? `${keepVersion}.json` : null;
  const olderSnapshots = files
    .filter((fileName) => fileName.endsWith('.json'))
    .sort((left, right) => right.localeCompare(left))
    .slice(SNAPSHOT_RETENTION_COUNT)
    .filter((fileName) => fileName !== keepFile);
  const tmpFiles = files.filter((fileName) => fileName.endsWith('.tmp'));

  let failed = 0;
  for (const fileName of [...olderSnapshots, ...tmpFiles]) {
    try {
      await fs.unlink(path.join(snapshotDir, fileName));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      failed += 1;
      logger.warn(`DSO snapshot housekeeping could not delete ${dsoId}/${fileName} (${(error as Error).message})`);
    }
  }
  if (failed > 0) {
    logger.warn(`DSO snapshot housekeeping left ${failed} file(s) for ${dsoId}; retried on the next publish`);
  }
}

export async function readDsoCatalog(): Promise<DsoCatalog | null> {
  return readJsonFile<DsoCatalog>(getDsoCatalogPath());
}

export async function readDsoManifest(): Promise<DsoManifest | null> {
  return readJsonFile<DsoManifest>(getDsoManifestPath());
}

export async function readDsoSnapshot(
  dsoId: DsoId,
  snapshotVersion: string,
): Promise<DsoSnapshot | null> {
  return readJsonFile<DsoSnapshot>(getDsoSnapshotPath(dsoId, snapshotVersion));
}

export async function readCurrentDsoSnapshot(
  dsoId: DsoId,
  manifest: DsoManifest | null = null,
): Promise<DsoSnapshot | null> {
  const resolvedManifest = manifest ?? (await readDsoManifest());
  const status = resolvedManifest?.objects[dsoId];

  if (!status?.currentSnapshotVersion) {
    return null;
  }

  return readDsoSnapshot(dsoId, status.currentSnapshotVersion);
}

export interface PublishDsoSnapshotResult {
  manifest: DsoManifest;
  catalog: DsoCatalog;
  snapshotPath: string;
}

export async function publishDsoWorkerHeartbeat(
  currentManifest: DsoManifest | null = null,
  workerLastRunAt: string = new Date().toISOString(),
): Promise<{ manifest: DsoManifest; catalog: DsoCatalog }> {
  const manifest = coerceManifest(DSO_REGISTRY, currentManifest);
  manifest.generatedAt = workerLastRunAt;
  manifest.workerLastRunAt = workerLastRunAt;

  const catalog = buildDsoCatalog(DSO_REGISTRY, manifest);
  await atomicWriteJson(getDsoCatalogPath(), catalog);
  await atomicWriteJson(getDsoManifestPath(), manifest);

  return { manifest, catalog };
}

export async function publishDsoSnapshot(
  entry: DsoRegistryEntry,
  snapshot: DsoSnapshot,
  currentManifest: DsoManifest | null = null,
  workerLastRunAt: string | null = null,
): Promise<PublishDsoSnapshotResult> {
  const snapshotPath = getDsoSnapshotPath(entry.dsoId, snapshot.snapshotVersion);
  const snapshotRelativePath = getDsoSnapshotRelativePath(entry.dsoId, snapshot.snapshotVersion);

  await atomicWriteJson(snapshotPath, snapshot);

  const generatedAt = new Date().toISOString();
  const manifest = coerceManifest(DSO_REGISTRY, currentManifest);
  const previousStatus = manifest.objects[entry.dsoId] ?? createUnavailableStatus(entry);
  manifest.generatedAt = generatedAt;
  manifest.workerLastRunAt = workerLastRunAt;
  manifest.objects[entry.dsoId] = {
    enabled: entry.enabled,
    provider: entry.provider,
    providerObjectId: entry.providerObjectId,
    currentSnapshotVersion: snapshot.snapshotVersion,
    freshnessState: 'fresh',
    validFrom: snapshot.validFrom,
    validTo: snapshot.validTo,
    lastSuccessAt: snapshot.fetchedAt,
    lastFailureAt: previousStatus.lastFailureAt,
    failureCount: 0,
    availability: true,
    snapshotPath: snapshotRelativePath,
  };

  const catalog = buildDsoCatalog(DSO_REGISTRY, manifest);

  await atomicWriteJson(getDsoCatalogPath(), catalog);
  await atomicWriteJson(getDsoManifestPath(), manifest);
  // Only now, with the manifest already pointing at the new snapshot, are older files deleted.
  await pruneSnapshotGenerations(entry.dsoId, snapshot.snapshotVersion);

  return {
    manifest,
    catalog,
    snapshotPath: snapshotRelativePath,
  };
}

export async function publishDsoFailureState(
  entry: DsoRegistryEntry,
  currentManifest: DsoManifest | null = null,
  failureAt: string = new Date().toISOString(),
  workerLastRunAt: string | null = null,
): Promise<{ manifest: DsoManifest; catalog: DsoCatalog }> {
  const manifest = coerceManifest(DSO_REGISTRY, currentManifest);
  const existingStatus = manifest.objects[entry.dsoId] ?? createUnavailableStatus(entry);
  const nextStatus: DsoObjectStatus = {
    ...existingStatus,
    enabled: entry.enabled,
    provider: entry.provider,
    providerObjectId: entry.providerObjectId,
    lastFailureAt: failureAt,
    failureCount: existingStatus.failureCount + 1,
  };

  nextStatus.freshnessState = deriveDsoFreshnessState(
    nextStatus,
    entry.refreshIntervalSec,
    new Date(failureAt),
  );
  nextStatus.availability = nextStatus.currentSnapshotVersion !== null;

  manifest.generatedAt = failureAt;
  manifest.workerLastRunAt = workerLastRunAt;
  manifest.objects[entry.dsoId] = nextStatus;

  const catalog = buildDsoCatalog(DSO_REGISTRY, manifest);
  await atomicWriteJson(getDsoCatalogPath(), catalog);
  await atomicWriteJson(getDsoManifestPath(), manifest);

  return { manifest, catalog };
}
