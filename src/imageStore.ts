/**
 * Image storage using IndexedDB.
 *
 * Images are stored as data-URL strings keyed by a unique ID (idb://<uuid>).
 * Board items reference images via `content: "idb://<uuid>"` instead of
 * embedding the full base64 data URL.  This keeps localStorage small.
 */

const DB_NAME = 'moodboard-images';
const DB_VERSION = 1;
const STORE_NAME = 'images';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** Save an image data URL and return a reference key (`idb://<id>`) */
export async function saveImage(dataUrl: string): Promise<string> {
  const id = 'idb://' + crypto.randomUUID();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(dataUrl, id);
    tx.oncomplete = () => resolve(id);
    tx.onerror = () => reject(tx.error);
  });
}

/** Retrieve an image data URL by its reference key */
export async function getImage(id: string): Promise<string | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

/** Delete an image by its reference key */
export async function deleteImage(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Check if a string is an IndexedDB image reference */
export function isIdbRef(content: string): boolean {
  return content.startsWith('idb://');
}

/** Get all stored image keys */
export async function getAllImageKeys(): Promise<string[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAllKeys();
    req.onsuccess = () => resolve(req.result as string[]);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Migrate existing boards: move inline data URLs to IndexedDB
 * and replace content with idb:// references.
 * Returns true if any items were migrated.
 */
export async function migrateInlineImages(boards: { items: { type: string; content: string }[] }[]): Promise<boolean> {
  let migrated = false;
  for (const board of boards) {
    for (const item of board.items) {
      if (item.type === 'image' && item.content.startsWith('data:')) {
        const ref = await saveImage(item.content);
        item.content = ref;
        migrated = true;
      }
    }
  }
  return migrated;
}
