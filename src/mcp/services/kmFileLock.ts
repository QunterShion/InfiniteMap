import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { invalidateKmFileRevision } from './kmRevisionCache';

export const LOCK_EXPIRE_MS = 10_000;
export const LOCK_RETRY_INTERVAL_MS = 50;
// 总超时时间需严格大于 LOCK_EXPIRE_MS，保证陈旧锁被回收后本次请求仍有机会重试
export const LOCK_RETRY_LIMIT = Math.ceil((LOCK_EXPIRE_MS + 2_000) / LOCK_RETRY_INTERVAL_MS); // ~240

export function getLockPath(kmPath: string): string {
  return path.resolve(kmPath) + '.lock';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function atomicWriteJsonFile(filePath: string, content: string): Promise<void> {
  const resolved = path.resolve(filePath);
  const tmpPath = `${resolved}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  try {
    await fs.promises.writeFile(tmpPath, content, 'utf8');
    JSON.parse(await fs.promises.readFile(tmpPath, 'utf8'));
    await fs.promises.rename(tmpPath, resolved);
    invalidateKmFileRevision(resolved);
  } catch (error) {
    try {
      await fs.promises.unlink(tmpPath);
    } catch {
      // Cleanup failure does not hide the original write failure.
    }
    throw new Error(`文件写入失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function withKmFileLock<T>(
  kmPath: string,
  fn: () => T | Promise<T>
): Promise<T> {
  const lockPath = getLockPath(kmPath);
  // 每次获取锁时生成唯一 token，避免 finally 误删其他进程写入的锁
  const token = randomUUID();
  let acquired = false;

  for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt++) {
    try {
      await fs.promises.writeFile(lockPath, JSON.stringify({
        pid: process.pid,
        token,
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + LOCK_EXPIRE_MS).toISOString(),
      }), { flag: 'wx' });
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // 尝试回收过期锁或损坏锁
      let removed = false;
      try {
        const holder = JSON.parse(await fs.promises.readFile(lockPath, 'utf8'));
        if (holder && typeof holder.expiresAt === 'string' && Date.parse(holder.expiresAt) < Date.now()) {
          await fs.promises.unlink(lockPath);
          removed = true;
        }
      } catch {
        // JSON 解析失败 → 锁内容损坏，按 mtime 判断是否为陈旧锁
        try {
          const stat = await fs.promises.stat(lockPath);
          if (Date.now() - stat.mtimeMs > LOCK_EXPIRE_MS) {
            await fs.promises.unlink(lockPath);
            removed = true;
          }
        } catch {
          // 锁文件已被其他进程删除，忽略
        }
      }
      if (removed) continue;
      await delay(LOCK_RETRY_INTERVAL_MS);
    }
  }

  if (!acquired) {
    throw new Error(`获取 KM 文件锁超时，文件正被其他进程写入: ${lockPath}`);
  }

  try {
    return await fn();
  } finally {
    // 只删除当前进程持有的锁（token 一致），防止误删其他进程的锁
    try {
      const raw = await fs.promises.readFile(lockPath, 'utf8');
      const holder = JSON.parse(raw);
      if (holder?.token === token) {
        await fs.promises.unlink(lockPath);
      }
    } catch {
      // 锁已作为陈旧锁被其他进程回收，无需清理
    }
  }
}
