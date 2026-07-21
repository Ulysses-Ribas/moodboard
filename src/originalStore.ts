/**
 * Local store for full-quality ORIGINAL images ("master"), kept only on this
 * machine.  The compressed proxy that every user sees lives in `item.content`
 * (a Supabase Storage URL); the original is referenced separately by
 * `item.originalRef` so the sync layer never touches — let alone uploads — it.
 *
 * Two ways an original is held:
 *  - `handles` — a FileSystemFileHandle, a durable pointer to the real file on
 *    disk (Chromium only).  Survives IndexedDB being cleared, and if the file
 *    lives in a synced folder (Dropbox) it is backed up for free.  Reading it
 *    back needs a permission grant per session.
 *  - `blobs` — raw bytes, used when no handle is obtainable (e.g. pasting from
 *    the clipboard, or non-Chromium browsers).
 *
 * Uses its own database so `moodboard-images` (the proxy store) keeps its
 * schema version and needs no migration.
 */

const DB_NAME = 'moodboard-originals';
const DB_VERSION = 1;
const STORE_HANDLES = 'handles';
const STORE_BLOBS = 'blobs';

export const ORIGINAL_PREFIX = 'orig://';

export type OriginalStatus = 'ready' | 'needs-permission' | 'missing';

/** Permission methods exist on FileSystemHandle but aren't in the DOM lib typings. */
interface HandlePermissions {
  queryPermission?(desc?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(desc?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}
type FileHandle = FileSystemFileHandle & HandlePermissions;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_HANDLES)) db.createObjectStore(STORE_HANDLES);
      if (!db.objectStoreNames.contains(STORE_BLOBS)) db.createObjectStore(STORE_BLOBS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function put(store: string, key: string, value: unknown): Promise<void> {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function get<T>(store: string, key: string): Promise<T | null> {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve((req.result as T) ?? null);
    req.onerror = () => reject(req.error);
  }));
}

function del(store: string, key: string): Promise<void> {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

export function isOriginalRef(ref: string | undefined): ref is string {
  return !!ref && ref.startsWith(ORIGINAL_PREFIX);
}

/** True when this browser can hand out durable file handles (Chromium). */
export function supportsFileHandles(): boolean {
  return typeof (window as any).showOpenFilePicker === 'function';
}

function newRef(): string {
  return ORIGINAL_PREFIX + crypto.randomUUID();
}

export async function saveOriginalFromHandle(handle: FileSystemFileHandle): Promise<string> {
  const ref = newRef();
  await put(STORE_HANDLES, ref, handle);
  return ref;
}

export async function saveOriginalBlob(blob: Blob): Promise<string> {
  const ref = newRef();
  await put(STORE_BLOBS, ref, blob);
  return ref;
}

/** Replace what a ref points at, keeping the same ref (used when relinking). */
export async function replaceOriginal(ref: string, source: FileSystemFileHandle | Blob): Promise<void> {
  revokeOriginalUrl(ref);
  await del(STORE_HANDLES, ref);
  await del(STORE_BLOBS, ref);
  if (source instanceof Blob) await put(STORE_BLOBS, ref, source);
  else await put(STORE_HANDLES, ref, source);
}

export async function deleteOriginal(ref: string): Promise<void> {
  revokeOriginalUrl(ref);
  await del(STORE_HANDLES, ref);
  await del(STORE_BLOBS, ref);
}

/**
 * Whether the original behind `ref` can be read right now.
 * A stored handle whose permission has lapsed reports 'needs-permission'
 * rather than 'missing' — the file is still there, we just can't read it yet.
 */
export async function getOriginalStatus(ref: string): Promise<OriginalStatus> {
  if (!isOriginalRef(ref)) return 'missing';
  const handle = await get<FileHandle>(STORE_HANDLES, ref);
  if (handle) {
    if (!handle.queryPermission) return 'needs-permission';
    try {
      const state = await handle.queryPermission({ mode: 'read' });
      return state === 'granted' ? 'ready' : 'needs-permission';
    } catch {
      return 'needs-permission';
    }
  }
  const blob = await get<Blob>(STORE_BLOBS, ref);
  return blob ? 'ready' : 'missing';
}

/** Read the original's bytes, or null if unavailable / not yet permitted. */
export async function getOriginalFile(ref: string): Promise<Blob | null> {
  if (!isOriginalRef(ref)) return null;
  const handle = await get<FileHandle>(STORE_HANDLES, ref);
  if (handle) {
    try {
      const state = handle.queryPermission
        ? await handle.queryPermission({ mode: 'read' })
        : 'prompt';
      if (state !== 'granted') return null;
      return await handle.getFile();
    } catch {
      return null;   // file moved, deleted, or permission revoked
    }
  }
  return await get<Blob>(STORE_BLOBS, ref);
}

/**
 * Ask for read permission on the handles behind `refs`.
 * Must be called from a user gesture. Returns how many became readable.
 */
export async function requestOriginalPermission(refs: string[]): Promise<number> {
  let granted = 0;
  for (const ref of refs) {
    const handle = await get<FileHandle>(STORE_HANDLES, ref);
    if (!handle?.requestPermission) continue;
    try {
      const state = await handle.requestPermission({ mode: 'read' });
      if (state === 'granted') granted++;
    } catch {
      // user dismissed or the handle is stale — leave it pending
    }
  }
  return granted;
}

// ── Object URL cache ──
// renderAllItems() tears down and rebuilds every .board-item on each rerender,
// so object URLs must be created once per ref and reused — creating them per
// render would leak a blob URL on every repaint.

const urlCache = new Map<string, string>();

/** Object URL for the original, or null if it can't be read right now. */
export async function getOriginalUrl(ref: string): Promise<string | null> {
  const cached = urlCache.get(ref);
  if (cached) return cached;
  const blob = await getOriginalFile(ref);
  if (!blob) return null;
  // Another caller may have populated the cache while we awaited
  const raced = urlCache.get(ref);
  if (raced) return raced;
  const url = URL.createObjectURL(blob);
  urlCache.set(ref, url);
  return url;
}

/** Synchronous peek — lets render avoid a flash when the URL is already built. */
export function peekOriginalUrl(ref: string): string | null {
  return urlCache.get(ref) ?? null;
}

export function revokeOriginalUrl(ref: string): void {
  const url = urlCache.get(ref);
  if (url) {
    URL.revokeObjectURL(url);
    urlCache.delete(ref);
  }
}

/** Release every cached object URL (call when switching boards). */
export function revokeAllOriginalUrls(): void {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}

/**
 * Ask the browser to keep our local data out of its eviction pool.
 * Best-effort: the handles are the real safety net, this only reduces the odds
 * of losing pasted-image blobs under disk pressure.
 */
export async function requestPersistentStorage(): Promise<void> {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch {
    // not supported — nothing to do
  }
}
