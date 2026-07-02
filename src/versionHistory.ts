import type { Board } from './types';

const DB_NAME = 'moodboard-history';
const DB_VERSION = 1;
const STORE_NAME = 'snapshots';
const MAX_SNAPSHOTS = 30;

export interface BoardSnapshot {
  id: string;
  boardId: string;
  name: string;
  label?: string;
  itemCount: number;
  connectionCount: number;
  data: string; // JSON stringified board
  createdAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('boardId', 'boardId', { unique: false });
        store.createIndex('boardId_createdAt', ['boardId', 'createdAt'], { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function saveSnapshot(board: Board, label?: string): Promise<BoardSnapshot> {
  const snapshot: BoardSnapshot = {
    id: crypto.randomUUID(),
    boardId: board.id,
    name: board.name,
    label,
    itemCount: board.items.length,
    connectionCount: (board.connections || []).length,
    data: JSON.stringify(board),
    createdAt: Date.now(),
  };

  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(snapshot);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  await pruneSnapshots(board.id);
  return snapshot;
}

export async function getSnapshots(boardId: string): Promise<BoardSnapshot[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const index = tx.objectStore(STORE_NAME).index('boardId');
    const req = index.getAll(boardId);
    req.onsuccess = () => {
      const results = (req.result as BoardSnapshot[]).sort((a, b) => b.createdAt - a.createdAt);
      resolve(results);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getSnapshotById(id: string): Promise<BoardSnapshot | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteSnapshot(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function restoreBoardFromSnapshot(snapshot: BoardSnapshot): Board {
  return JSON.parse(snapshot.data) as Board;
}

async function pruneSnapshots(boardId: string): Promise<void> {
  const all = await getSnapshots(boardId);
  if (all.length <= MAX_SNAPSHOTS) return;

  const toDelete = all.slice(MAX_SNAPSHOTS);
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  for (const s of toDelete) {
    store.delete(s.id);
  }
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- Auto-snapshot timer ---

let autoTimer: ReturnType<typeof setInterval> | null = null;
let lastAutoSnapshotData: string | null = null;

export function startAutoSnapshot(
  getBoardFn: () => Board | null,
  intervalMs = 15 * 60 * 1000
): void {
  stopAutoSnapshot();
  autoTimer = setInterval(async () => {
    const board = getBoardFn();
    if (!board) return;
    const currentData = JSON.stringify({ items: board.items, connections: board.connections });
    if (currentData === lastAutoSnapshotData) return;
    lastAutoSnapshotData = currentData;
    await saveSnapshot(board, 'Auto');
  }, intervalMs);
}

export function stopAutoSnapshot(): void {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
  lastAutoSnapshotData = null;
}
