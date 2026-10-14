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

/** How many snapshot files per object stay in the live folder. Older ones are archived, not deleted. */
export const SNAPSHOT_RETENTION_COUNT = 3;
/** Sub-folder of `snapshots/<id>/` that receives older snapshots. Readers never look inside it. */
export const SNAPSHOT_ARCHIVE_DIR = 'archive';

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

/** A file name that is free in `dir`: `x.json`, then `x.1.json`, `x.2.json` ... Never an existing name. */
async function freeArchiveName(dir: string, fileName: string): Promise<string> {
  const ext = path.extname(fileName);
  const stem = ext ? fileName.slice(0, -ext.length) : fileName;
  for (let n = 0; n < 10_000; n++) {
    const candidate = n === 0 ? fileName : `${stem}.${n}${ext}`;
    try {
      await fs.lstat(path.join(dir, candidate));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate;
      throw error;
    }
  }
  throw new Error(`no free archive name for ${fileName}`);
}

/**
 * Keep the newest SNAPSHOT_RETENTION_COUNT snapshot files of one object in
 * `snapshots/<id>/` and MOVE the older ones to `snapshots/<id>/archive/` (a rename
 * on the same volume). Nothing is deleted, and an existing archive file is never
 * overwritten (a clash gets a numeric suffix). The archive is never pruned and no
 * reader looks inside it.
 *
 * Orphaned `.tmp` files from an aborted atomic write are incomplete, so they are
 * still removed.
 *
 * Housekeeping only: a failure here is logged and leaves the file where it is (it
 * is retried on the next publish). It must never turn a published snapshot into
 * a recorded refresh failure.
 */
export async function pruneSnapshotGenerations(dsoId: DsoId): Promise<void> {
  const snapshotDir = path.join(getDsoSnapshotsRoot(), dsoId);

  let files: string[];
  try {
    files = await fs.readdir(snapshotDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    logger.warn(`DSO snapshot housekeeping could not list ${dsoId} (${(error as Error).message})`);
    return;
  }

  for (const fileName of files.filter((name) => name.endsWith('.tmp'))) {
    try {
      await fs.unlink(path.join(snapshotDir, fileName));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(`DSO snapshot housekeeping could not remove ${dsoId}/${fileName} (${(error as Error).message})`);
      }
    }
  }

  const older = files
    .filter((name) => name.endsWith('.json'))
    .sort((left, right) => right.localeCompare(left))
    .slice(SNAPSHOT_RETENTION_COUNT);
  if (older.length === 0) return;

  const archiveDir = path.join(snapshotDir, SNAPSHOT_ARCHIVE_DIR);
  let archived = 0;
  try {
    await fs.mkdir(archiveDir, { recursive: true });
    for (const fileName of older) {
      const target = await freeArchiveName(archiveDir, fileName);
      await fs.rename(path.join(snapshotDir, fileName), path.join(archiveDir, target));
      archived += 1;
    }
  } catch (error) {
    logger.warn(
      `DSO snapshot housekeeping stopped for ${dsoId} (${(error as Error).message}); ` +
        `${older.length - archived} older file(s) stay in place and are retried next publish`,
    );
  }
  if (archived > 0) {
    logger.info(`DSO snapshots archived: dsoId=${dsoId} moved=${archived} (kept in ${SNAPSHOT_ARCHIVE_DIR}/, never pruned)`);
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
  await pruneSnapshotGenerations(entry.dsoId);

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
