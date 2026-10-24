import fs from 'node:fs';
import path from 'node:path';
import { assertSafeKey, assertSafePrefix, type BlobInfo, type BlobStat, type BlobStore, type PutOptions } from './types.js';

// ============================================================
// File adapter: objects are plain files under `root`.
//
// This is exactly what the raw archive did before the port existed: mkdir -p, write
// `<final>.tmp`, rename over the final path. The default backend, so a deploy with no
// new env vars behaves as it always did.
// ============================================================

const TMP_SUFFIX = '.tmp';

export class FileBlobStore implements BlobStore {
  readonly kind = 'file' as const;

  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    assertSafeKey(key);
    return path.join(this.root, ...key.split('/'));
  }

  async put(key: string, data: Buffer, opts?: PutOptions): Promise<void> {
    const finalPath = this.resolve(key);
    // pid in the temp name: two processes (API and DSO worker) may hydrate the same file at once.
    const tmpPath = `${finalPath}.${process.pid}${TMP_SUFFIX}`;
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.promises.writeFile(tmpPath, data);
    if (opts?.mtimeMs !== undefined) {
      const when = new Date(opts.mtimeMs);
      await fs.promises.utimes(tmpPath, when, when);
    }
    await fs.promises.rename(tmpPath, finalPath);
  }

  async stat(key: string): Promise<BlobStat | null> {
    try {
      const st = await fs.promises.stat(this.resolve(key));
      return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await fs.promises.readFile(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async list(prefix = ''): Promise<BlobInfo[]> {
    assertSafePrefix(prefix);
    const out: BlobInfo[] = [];
    await this.walk('', out);
    return out.filter((o) => o.key.startsWith(prefix)).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.promises.unlink(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  private async walk(rel: string, out: BlobInfo[]): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(this.root, rel), { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        await this.walk(childRel, out);
      } else if (entry.isFile() && !entry.name.endsWith(TMP_SUFFIX)) {
        const stat = await fs.promises.stat(path.join(this.root, childRel));
        out.push({ key: childRel, size: stat.size });
      }
    }
  }
}
