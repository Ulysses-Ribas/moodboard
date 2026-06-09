import type { Board, BoardState } from './types';

const STORAGE_KEY = 'moodboard-state';
const DEFAULT_VIEWPORT = { x: 0, y: 0, zoom: 1 };

export function createBoard(name: string): Board {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name,
    items: [],
    connections: [],
    viewport: { ...DEFAULT_VIEWPORT },
    createdAt: now,
    updatedAt: now,
  };
}

function defaultState(): BoardState {
  const board = createBoard('Sem título');
  return {
    boards: [board],
    activeBoardId: board.id,
  };
}

/** Migrate v0 state (viewport at root) → v1 (viewport per board) */
function migrate(raw: any): BoardState {
  // If state has viewport at root level, move it into each board
  if (raw.viewport && raw.boards) {
    for (const board of raw.boards) {
      if (!board.viewport) {
        board.viewport = { ...raw.viewport };
      }
    }
    delete raw.viewport;
  }
  // Ensure every board has a viewport and updatedAt
  if (raw.boards) {
    for (const board of raw.boards) {
      if (!board.viewport) {
        board.viewport = { ...DEFAULT_VIEWPORT };
      }
      if (!board.updatedAt) {
        board.updatedAt = board.createdAt || Date.now();
      }
      if (!board.connections) {
        board.connections = [];
      }
    }
  }
  return raw as BoardState;
}

export function loadState(): BoardState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return migrate(JSON.parse(raw));
  } catch {
    // corrupted data — start fresh
  }
  return defaultState();
}

export function saveState(state: BoardState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    if (e instanceof DOMException && e.name === 'QuotaExceededError') {
      showStorageWarning();
    } else {
      throw e;
    }
  }
}

let storageWarningShown = false;

function showStorageWarning(): void {
  if (storageWarningShown) return;
  storageWarningShown = true;

  const bar = document.createElement('div');
  bar.className = 'storage-warning';
  bar.innerHTML = `
    <span>⚠ Armazenamento local cheio — algumas alterações podem não ser salvas. Exporte o board (Ctrl+S) para não perder dados.</span>
    <button class="storage-warning-close">✕</button>
  `;
  bar.querySelector('.storage-warning-close')!.addEventListener('click', () => {
    bar.remove();
    storageWarningShown = false;
  });
  document.body.appendChild(bar);
}
