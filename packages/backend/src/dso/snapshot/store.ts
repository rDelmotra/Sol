import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DSO_REGISTRY,
  type DsoId,
  type DsoRegistryEntry,
} from '../registry/index.js';
import type {
  DsoCatalog,
  DsoCatalogEntry,
  DsoFreshnessState,
  DsoManifest,
  DsoObjectStatus,
  DsoSnapshot,
} from './types.js';
import { atomicWriteJson } from '../../utils/atomic-write.js';

const SNAPSHOT_RETENTION_COUNT = 3;

export function getDsoCacheRoot(): string {
  return path.resolve(process.env.CACHE_DIR ?? './data', 'dso');
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

export function createBaseDsoManifest(
  entries: readonly DsoRegistryEntry[] = DSO_REGISTRY,
  workerLastRunAt: string | null = null,
): DsoManifest {
  return {
    generatedAt: new Date().toISOString(),
    workerLastRunAt,
    objects: Object.fromEntries(
      entries.map((entry) => [entry.dsoId, createUnavailableStatus(entry)]),
    ) as Record<DsoId, DsoObjectStatus>,
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

async function pruneSnapshotGenerations(dsoId: DsoId): Promise<void> {
  const snapshotDir = path.join(getDsoSnapshotsRoot(), dsoId);

  try {
    const files = await fs.readdir(snapshotDir);
    const snapshotFiles = files
      .filter((fileName) => fileName.endsWith('.json'))
      .sort((left, right) => right.localeCompare(left));

    const filesToDelete = snapshotFiles.slice(SNAPSHOT_RETENTION_COUNT);
    
    // Also prune any orphaned .tmp files left over from aborted atomic writes
    const tmpFiles = files.filter((fileName) => fileName.endsWith('.tmp'));
    filesToDelete.push(...tmpFiles);

    await Promise.all(filesToDelete.map((fileName) => fs.unlink(path.join(snapshotDir, fileName))));
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'ENOENT') {
      throw error;
    }
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
