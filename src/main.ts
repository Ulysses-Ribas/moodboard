import './style.css';
import type { BoardItem, Board, Profile } from './types';
import { loadState, saveState, createBoard } from './state';
import { initCanvas, screenToBoard, boardToScreen, isSpaceHeld } from './canvas';
import { createItem, duplicateItem } from './items';
import { compressImage } from './image';
import { pushSnapshot, undo, redo, clearHistory, canUndo, canRedo } from './history';
import {
  renderToolbar,
  renderSidebar,
  renderAllItems,
  renderHome,
  renderStatusBar,
  updateZoomLabel,
  updateItemPosition,
  updateItemSize,
  syncSelectionVisual,
  showContextMenu,
  closeContextMenu,
  isHtml,
  plainTextToHtml,
  updateUndoRedoButtons,
} from './render';
import { createMinimap } from './minimap';
import { calcSnap, initGuideLayer, drawGuides, clearGuides } from './snap';
import { createConnectionLayer, getCenter, getAnchor } from './connections';
import { generateId } from './items';
import { saveImage, migrateInlineImages, isIdbRef, getImage } from './imageStore';
import { supabase } from './supabase';
import { initAuth, getAuth, signOut } from './auth';
import { renderLogin } from './loginView';
import { renderAdmin } from './adminView';
import {
  loadBoardsFromSupabase,
  saveBoardToSupabase,
  debouncedSave,
  migrateLocalBoards,
  resyncIdbContent,
  subscribeToBoardChanges,
  getBoardRole,
  type BoardRole,
} from './boardStore';
import {
  joinBoard,
  leaveBoard,
  broadcastCursor,
  broadcastCursorPos,
  broadcastViewport,
  onPresenceChange,
  onRemoteCursor,
  startFollowing,
  stopFollowing,
  getFollowingUserId,
  checkFollowUpdate,
  getOnlineUsers,
  type PresenceState,
  type FollowTarget,
} from './presence';
import {
  loadCommentCounts,
  loadComments,
  addComment,
  deleteComment,
  subscribeToComments,
  unsubscribeComments,
  getCommentCount,
  type CommentWithAuthor,
} from './comments';
import {
  saveSnapshot,
  getSnapshots,
  deleteSnapshot,
  restoreBoardFromSnapshot,
  startAutoSnapshot,
  stopAutoSnapshot,
} from './versionHistory';

const app = document.getElementById('app')!;
const state = loadState();
let currentProfile: Profile | null = null;
let currentBoardRole: BoardRole = 'owner';
let isPublicView = false;

function isReadOnly(): boolean {
  return currentBoardRole === 'viewer';
}

// --- Theme ---
function initTheme() {
  const saved = localStorage.getItem('moodboard-theme');
  if (saved === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
}
function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (isDark) {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('moodboard-theme', 'light');
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('moodboard-theme', 'dark');
  }
}
initTheme();

// Migrate inline base64 images to IndexedDB (runs once, transparent)
migrateInlineImages(state.boards).then(migrated => {
  if (migrated) {
    saveState(state);
    rerender();
  }
});

// --- View routing ---

let currentView: 'home' | 'board' = 'home';
const boardNavHistory: string[] = []; // stack of board IDs for back navigation

const homeScreen = document.createElement('div');
homeScreen.id = 'home-screen';

const boardView = document.createElement('div');
boardView.id = 'board-view';

// Both views are always in the DOM.  The home screen sits on top (z-index 200)
// and is hidden via CSS class toggle (opacity + visibility transition).
app.append(boardView, homeScreen);

// --- Selection state (multi-select) ---

const selectedIds = new Set<string>();

let dragging: {
  origins: Map<string, { x: number; y: number }>;
  anchorX: number;
  anchorY: number;
} | null = null;

let resizing: {
  id: string;
  corner: 'nw' | 'ne' | 'sw' | 'se';
  origX: number; origY: number; origW: number; origH: number;
  others: { id: string; origX: number; origY: number; origW: number; origH: number }[];
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
} | null = null;
let rotating: {
  id: string;
  centerX: number; centerY: number;  // item center in board coords
  startAngle: number;                // pointer angle at drag start (deg)
  origRotation: number;              // item.rotation at drag start (deg)
} | null = null;
let editingId: string | null = null;
let selectionToolbar: HTMLElement | null = null;
let selectionToolbarItemId: string | null = null;

// --- Connection state ---

let connectingFromId: string | null = null;
let selectedConnId: string | null = null;

// --- Tag filter state (declared early so rerender() can reference it at boot) ---

const activeTagFilters = new Set<string>();
let tagFilterBar: HTMLElement | null = null;

// --- Connection drag-to-reconnect state ---

let reconnecting: {
  connId: string;
  end: 'from' | 'to';   // which end is being dragged
  fixedId: string;       // the item that stays connected
} | null = null;

// --- Frame draw mode state ---

let frameDrawMode = false;
/** When set, the next click on the canvas places a frame with these fixed dimensions */
let framePlacePreset: { w: number; h: number } | null = null;
let frameDrawing: {
  startScreenX: number;
  startScreenY: number;
  el: HTMLElement;
  moved: boolean;
} | null = null;

// --- Freehand draw mode state ---

let freeDrawMode = false;
let freeDrawColor = '#1a1a1a';
let freeDrawWidth = 3;
let freeDrawing: {
  points: { x: number; y: number }[];
  svgEl: SVGSVGElement;
  pathEl: SVGPathElement;
} | null = null;

// --- Lasso state ---

let lasso: {
  startScreenX: number;
  startScreenY: number;
  el: HTMLElement;
  moved: boolean;
} | null = null;

const LASSO_THRESHOLD = 4;

// --- Helpers ---

function getActiveBoard() {
  return state.boards.find(b => b.id === state.activeBoardId)!;
}

function findItem(id: string): BoardItem | undefined {
  return getActiveBoard().items.find(i => i.id === id);
}

function snapshot() {
  pushSnapshot(getActiveBoard());
}

function save() {
  if (isReadOnly()) return;
  saveState(state);
  if (currentProfile) {
    const board = getActiveBoard();
    if (board) debouncedSave(board, currentProfile.id);
  }
}

function commit() {
  if (isReadOnly()) return;
  const board = getActiveBoard();
  board.updatedAt = Date.now();
  snapshot();
  save();
  updateUndoRedoButtons(canUndo(), canRedo());
}

let _onViewportChange: (() => void) | null = null;

let _presenceTimer: ReturnType<typeof setTimeout> | null = null;
function throttledPresenceUpdate(profile: Profile, viewport: { x: number; y: number; zoom: number }) {
  if (_presenceTimer) return;
  _presenceTimer = setTimeout(() => {
    _presenceTimer = null;
    broadcastCursor(null, profile, viewport);
  }, 3000);
}

function rerender() {
  removeSelectionToolbar();
  renderAllItems(state, layer, selectedIds);
  updateConnections();
  if (_onViewportChange) _onViewportChange();
  // Re-apply tag filter if active (DOM elements were recreated)
  if (activeTagFilters.size > 0) applyTagFilter();
  // Re-show selection toolbar if applicable (DOM was recreated)
  manageSelectionToolbar();
}

function syncSelection() {
  syncSelectionVisual(layer, selectedIds, findItem);
  manageSelectionToolbar();
}

function removeSelectionToolbar() {
  if (selectionToolbar) {
    if ((selectionToolbar as any).__cleanupSelChange) (selectionToolbar as any).__cleanupSelChange();
    selectionToolbar.remove();
    selectionToolbar = null;
    selectionToolbarItemId = null;
  }
}

function manageSelectionToolbar() {
  // Don't show selection toolbar while editing (startEditing manages its own toolbar)
  if (editingId) { removeSelectionToolbar(); return; }

  // Only show for exactly 1 selected text/note item
  if (selectedIds.size !== 1) { removeSelectionToolbar(); return; }

  const id = [...selectedIds][0];

  // If toolbar already showing for this item, just reposition
  if (selectionToolbar && selectionToolbarItemId === id) {
    const itemEl = layer.querySelector(`[data-item-id="${id}"]`) as HTMLElement | null;
    if (itemEl) positionToolbar(selectionToolbar, itemEl);
    return;
  }

  const item = findItem(id);
  if (!item || (item.type !== 'text' && item.type !== 'note')) { removeSelectionToolbar(); return; }

  const itemEl = layer.querySelector(`[data-item-id="${id}"]`) as HTMLElement | null;
  if (!itemEl) { removeSelectionToolbar(); return; }

  const contentDiv = itemEl.querySelector('.item-content') as HTMLElement | null;
  if (!contentDiv) { removeSelectionToolbar(); return; }

  // Remove any existing selection toolbar
  removeSelectionToolbar();

  // Create and position toolbar (without entering edit mode)
  selectionToolbar = createEditToolbar(contentDiv, item, itemEl);
  selectionToolbar.classList.add('selection-toolbar');
  selectionToolbarItemId = id;
  positionToolbar(selectionToolbar, itemEl);
}

function clearSelection() {
  selectedIds.clear();
  removeSelectionToolbar();
}

function selectOnly(id: string) {
  selectedIds.clear();
  selectedIds.add(id);
  expandSelectionToGroups();
}

/** Ensure that if any item in a group is selected, all members are selected */
function expandSelectionToGroups() {
  const board = getActiveBoard();
  const groupIds = new Set<string>();
  for (const sid of selectedIds) {
    const item = board.items.find(i => i.id === sid);
    if (item?.groupId) groupIds.add(item.groupId);
  }
  if (groupIds.size === 0) return;
  for (const item of board.items) {
    if (item.groupId && groupIds.has(item.groupId)) {
      selectedIds.add(item.id);
    }
  }
}

function groupSelected() {
  if (selectedIds.size < 2) return;
  const gid = generateId();
  for (const sid of selectedIds) {
    const item = findItem(sid);
    if (item) item.groupId = gid;
  }
  commit();
  rerender();
}

function ungroupSelected() {
  let changed = false;
  for (const sid of selectedIds) {
    const item = findItem(sid);
    if (item?.groupId) {
      item.groupId = undefined;
      changed = true;
    }
  }
  if (changed) {
    commit();
    rerender();
  }
}

function applyBoard(board: Board) {
  const idx = state.boards.findIndex(b => b.id === state.activeBoardId);
  if (idx >= 0) state.boards[idx] = board;
  save();
  rerender();
  updateUndoRedoButtons(canUndo(), canRedo());
}

function addTextAtCenter() {
  const vp = getViewport();
  const rect = getCanvasRect();
  const center = screenToBoard(rect.width / 2, rect.height / 2, vp);
  const item = createItem('text', { x: center.x - 110, y: center.y - 70 });
  getActiveBoard().items.push(item);
  selectOnly(item.id);
  commit();
  rerender();
}

// --- Color swatch defaults ---

const SWATCH_COLORS = [
  '#c0392b', '#e74c3c', '#e67e22', '#f1c40f',
  '#2ecc71', '#1abc9c', '#3498db', '#2980b9',
  '#9b59b6', '#8e44ad', '#34495e', '#1a1a1a',
];
let swatchIndex = 0;

function addColorAtCenter() {
  const vp = getViewport();
  const rect = getCanvasRect();
  const center = screenToBoard(rect.width / 2, rect.height / 2, vp);
  const color = SWATCH_COLORS[swatchIndex % SWATCH_COLORS.length];
  swatchIndex++;
  const item = createItem('color', { x: center.x - 50, y: center.y - 60 }, color);
  getActiveBoard().items.push(item);
  selectOnly(item.id);
  commit();
  rerender();
}

function addLinkAtCenter(url?: string) {
  const resolved = url || prompt('URL do link:');
  if (!resolved || !resolved.trim()) return;
  let finalUrl = resolved.trim();
  if (!/^https?:\/\//i.test(finalUrl)) {
    finalUrl = 'https://' + finalUrl;
  }
  const vp = getViewport();
  const rect = getCanvasRect();
  const center = screenToBoard(rect.width / 2, rect.height / 2, vp);
  const item = createItem('link', { x: center.x - 130, y: center.y - 36 }, finalUrl);
  getActiveBoard().items.push(item);
  selectOnly(item.id);
  commit();
  rerender();
}

function openColorPicker(item: BoardItem, itemEl: HTMLElement) {
  const input = document.createElement('input');
  input.type = 'color';
  input.value = item.content || '#cccccc';
  input.style.position = 'absolute';
  input.style.opacity = '0';
  input.style.pointerEvents = 'none';
  document.body.appendChild(input);

  input.addEventListener('input', () => {
    item.content = input.value;
    const swatch = itemEl.querySelector('.item-swatch') as HTMLElement | null;
    const label = itemEl.querySelector('.item-color-label') as HTMLElement | null;
    if (swatch) swatch.style.backgroundColor = input.value;
    if (label) label.textContent = input.value.toUpperCase();
  });

  input.addEventListener('change', () => {
    item.content = input.value;
    commit();
    rerender();
    input.remove();
  });

  // If the user cancels (blur without change on some browsers)
  input.addEventListener('blur', () => {
    setTimeout(() => input.remove(), 100);
  });

  input.click();
}

// --- Note (sticky) defaults ---

const NOTE_COLORS = [
  '#fff9c4', // yellow
  '#f8bbd0', // pink
  '#c8e6c9', // green
  '#bbdefb', // blue
  '#d1c4e9', // purple
  '#ffe0b2', // orange
];
let noteColorIndex = 0;

function addNoteAtCenter() {
  const vp = getViewport();
  const rect = getCanvasRect();
  const center = screenToBoard(rect.width / 2, rect.height / 2, vp);
  const color = NOTE_COLORS[noteColorIndex % NOTE_COLORS.length];
  noteColorIndex++;
  const item = createItem('note', { x: center.x - 90, y: center.y - 80 });
  item.color = color;
  getActiveBoard().items.push(item);
  selectOnly(item.id);
  commit();
  rerender();
}

function addSubBoardAtCenter() {
  const name = prompt('Nome do sub-board:', 'Sub-board');
  if (name === null) return;

  // Create the sub-board (hidden from home list)
  const sub = createBoard(name.trim() || 'Sub-board');
  sub.isSubBoard = true;
  state.boards.push(sub);

  // Create a board-type item whose content is the sub-board ID
  const vp = getViewport();
  const rect = getCanvasRect();
  const center = screenToBoard(rect.width / 2, rect.height / 2, vp);
  const item = createItem('board', { x: center.x - 100, y: center.y - 70 }, sub.id);
  getActiveBoard().items.push(item);

  selectOnly(item.id);
  commit();
  rerender();
}

const FRAME_PRESETS = [
  { label: '16:9 Paisagem', w: 960, h: 540 },
  { label: '9:16 Retrato', w: 540, h: 960 },
  { label: 'A4', w: 595, h: 842 },
  { label: 'Livre', w: 0, h: 0 },
];

function showFrameMenu() {
  // Exit other modes first
  if (isConnectMode()) exitConnectMode();

  const btn = document.querySelector('.sidebar-btn[data-tooltip*="Frame"]') as HTMLElement | null;
  if (!btn) return;

  // Remove existing menu if open
  const existing = document.querySelector('.frame-preset-menu');
  if (existing) { existing.remove(); return; }

  const menu = document.createElement('div');
  menu.className = 'frame-preset-menu';

  for (const preset of FRAME_PRESETS) {
    const item = document.createElement('button');
    item.className = 'frame-preset-item';
    item.textContent = preset.label;
    if (preset.w > 0) {
      const dim = document.createElement('span');
      dim.className = 'frame-preset-dim';
      dim.textContent = `${preset.w}×${preset.h}`;
      item.appendChild(dim);
    }
    item.addEventListener('click', () => {
      menu.remove();
      if (preset.w === 0) {
        // Free-draw mode
        startFrameDrawMode(null);
      } else {
        startFrameDrawMode({ w: preset.w, h: preset.h });
      }
    });
    menu.appendChild(item);
  }

  btn.appendChild(menu);

  // Close on outside click
  const onDocClick = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node) && ev.target !== btn) {
      menu.remove();
      document.removeEventListener('click', onDocClick);
    }
  };
  setTimeout(() => document.addEventListener('click', onDocClick), 0);
}

function startFrameDrawMode(preset: { w: number; h: number } | null) {
  if (isConnectMode()) exitConnectMode();
  if (freeDrawMode) exitFreeDrawMode();
  frameDrawMode = true;
  framePlacePreset = preset;
  canvasEl.classList.add('frame-draw-mode');
  document.querySelectorAll('#sidebar .sidebar-btn').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector('.sidebar-btn[data-tooltip*="Frame"]') as HTMLElement | null;
  btn?.classList.add('active');
}

function exitFrameDrawMode() {
  frameDrawMode = false;
  framePlacePreset = null;
  frameDrawing = null;
  canvasEl.classList.remove('frame-draw-mode');
  const btn = document.querySelector('.sidebar-btn[data-tooltip*="Frame"]') as HTMLElement | null;
  btn?.classList.remove('active');
  // Return to select tool
  document.getElementById('sidebar-select-btn')?.classList.add('active');
}

// --- Freehand draw tool ---

const DRAW_COLORS = ['#1a1a1a', '#c0392b', '#2980b9', '#27ae60', '#f39c12', '#8e44ad', '#e74c3c', '#ffffff'];
const DRAW_WIDTHS = [2, 4, 8];

// --- Select tool (pointer) ---

function activateSelectTool() {
  // Exit all special modes and return to default pointer
  if (freeDrawMode) exitFreeDrawMode();
  if (frameDrawMode) exitFrameDrawMode();
  if (isConnectMode()) exitConnectMode();
  // Close any open draw menu
  document.querySelector('.draw-menu')?.remove();
  // Highlight select button, unhighlight others
  document.querySelectorAll('#sidebar .sidebar-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('sidebar-select-btn')?.classList.add('active');
}

function showDrawMenu() {
  if (isConnectMode()) exitConnectMode();
  if (frameDrawMode) exitFrameDrawMode();

  const btn = document.querySelector('.sidebar-btn[data-tooltip*="Desenho"]') as HTMLElement | null;
  if (!btn) return;

  // If already in draw mode: toggle menu visibility
  if (freeDrawMode) {
    const existing = document.querySelector('.draw-menu');
    if (existing) {
      // Menu open → close menu but stay in draw mode
      existing.remove();
      return;
    }
    // Menu closed → fall through to re-open it
  } else {
    // Enter draw mode immediately
    startFreeDrawMode();
  }

  // Remove existing menu if any (safety)
  document.querySelector('.draw-menu')?.remove();

  const menu = document.createElement('div');
  menu.className = 'draw-menu';

  // Color row
  const colorLabel = document.createElement('div');
  colorLabel.className = 'draw-menu-label';
  colorLabel.textContent = 'Cor';
  menu.appendChild(colorLabel);

  const colorRow = document.createElement('div');
  colorRow.className = 'draw-menu-colors';
  for (const c of DRAW_COLORS) {
    const swatch = document.createElement('button');
    swatch.className = `draw-color-swatch${c === freeDrawColor ? ' active' : ''}`;
    swatch.style.backgroundColor = c;
    if (c === '#ffffff') swatch.style.border = '1px solid var(--line)';
    swatch.addEventListener('click', (ev) => {
      ev.stopPropagation();
      freeDrawColor = c;
      colorRow.querySelectorAll('.draw-color-swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
    });
    colorRow.appendChild(swatch);
  }
  menu.appendChild(colorRow);

  // Thickness row
  const widthLabel = document.createElement('div');
  widthLabel.className = 'draw-menu-label';
  widthLabel.textContent = 'Espessura';
  menu.appendChild(widthLabel);

  const widthRow = document.createElement('div');
  widthRow.className = 'draw-menu-widths';
  for (const w of DRAW_WIDTHS) {
    const wBtn = document.createElement('button');
    wBtn.className = `draw-width-btn${w === freeDrawWidth ? ' active' : ''}`;
    const line = document.createElement('span');
    line.className = 'draw-width-line';
    line.style.height = `${w}px`;
    wBtn.appendChild(line);
    wBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      freeDrawWidth = w;
      widthRow.querySelectorAll('.draw-width-btn').forEach(b => b.classList.remove('active'));
      wBtn.classList.add('active');
    });
    widthRow.appendChild(wBtn);
  }
  menu.appendChild(widthRow);

  btn.appendChild(menu);

  // Close menu on outside click (but keep draw mode active)
  const onDocClick = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node) && ev.target !== btn) {
      menu.remove();
      document.removeEventListener('click', onDocClick);
    }
  };
  setTimeout(() => document.addEventListener('click', onDocClick), 0);
}

function startFreeDrawMode() {
  if (isConnectMode()) exitConnectMode();
  if (frameDrawMode) exitFrameDrawMode();
  freeDrawMode = true;
  canvasEl.classList.add('free-draw-mode');
  // Update sidebar highlights
  document.querySelectorAll('#sidebar .sidebar-btn').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector('.sidebar-btn[data-tooltip*="Desenho"]') as HTMLElement | null;
  btn?.classList.add('active');
}

function exitFreeDrawMode() {
  freeDrawMode = false;
  freeDrawing = null;
  canvasEl.classList.remove('free-draw-mode');
  document.querySelector('.draw-menu')?.remove();
  const btn = document.querySelector('.sidebar-btn[data-tooltip*="Desenho"]') as HTMLElement | null;
  btn?.classList.remove('active');
  // Return to select tool
  document.getElementById('sidebar-select-btn')?.classList.add('active');
}

/** Convert points array to a smooth SVG path using midpoint quadratic curves */
function pointsToSvgPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M${points[0].x},${points[0].y}`;
  if (points.length === 2) return `M${points[0].x},${points[0].y}L${points[1].x},${points[1].y}`;

  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const mx = (p0.x + p1.x) / 2;
    const my = (p0.y + p1.y) / 2;
    d += `Q${p0.x},${p0.y},${mx},${my}`;
  }
  const last = points[points.length - 1];
  d += `L${last.x},${last.y}`;
  return d;
}

/** Find all non-frame items whose center is inside the given frame's bounds */
function getFrameChildren(frame: BoardItem): BoardItem[] {
  const board = getActiveBoard();
  const fx1 = frame.position.x;
  const fy1 = frame.position.y;
  const fx2 = fx1 + frame.size.w;
  const fy2 = fy1 + frame.size.h;
  return board.items.filter(item => {
    if (item.id === frame.id) return false;
    if (item.type === 'frame') return false;
    const cx = item.position.x + item.size.w / 2;
    const cy = item.position.y + item.size.h / 2;
    return cx >= fx1 && cx <= fx2 && cy >= fy1 && cy <= fy2;
  });
}

async function addImageFromFile(file: File, screenX?: number, screenY?: number) {
  const { dataUrl, width, height } = await compressImage(file);

  // Upload to Supabase Storage if logged in, fall back to IndexedDB
  let ref: string;
  if (currentProfile) {
    const { uploadImageToStorage } = await import('./storageUpload');
    const url = await uploadImageToStorage(dataUrl, currentProfile.id);
    ref = url || await saveImage(dataUrl);
  } else {
    ref = await saveImage(dataUrl);
  }

  // Fit item to a max board size of 320px on the longest side, keeping aspect ratio
  const ITEM_MAX = 320;
  let itemW = width;
  let itemH = height;
  if (itemW > ITEM_MAX || itemH > ITEM_MAX) {
    if (itemW >= itemH) {
      itemH = Math.round(itemH * (ITEM_MAX / itemW));
      itemW = ITEM_MAX;
    } else {
      itemW = Math.round(itemW * (ITEM_MAX / itemH));
      itemH = ITEM_MAX;
    }
  }

  const vp = getViewport();
  const rect = getCanvasRect();
  let pos: { x: number; y: number };
  if (screenX != null && screenY != null) {
    const bp = screenToBoard(screenX - rect.left, screenY - rect.top, vp);
    pos = { x: bp.x - itemW / 2, y: bp.y - itemH / 2 };
  } else {
    const center = screenToBoard(rect.width / 2, rect.height / 2, vp);
    pos = { x: center.x - itemW / 2, y: center.y - itemH / 2 };
  }

  const item = createItem('image', pos, ref);
  item.size = { w: itemW, h: itemH };
  getActiveBoard().items.push(item);
  selectOnly(item.id);
  commit();
  rerender();
}

async function addEmbedFromFile(file: File, screenX?: number, screenY?: number) {
  const html = await file.text();
  const ref = await saveImage(html);

  const vp = getViewport();
  const rect = getCanvasRect();
  const itemW = 800;
  const itemH = 500;
  let pos: { x: number; y: number };
  if (screenX != null && screenY != null) {
    const bp = screenToBoard(screenX - rect.left, screenY - rect.top, vp);
    pos = { x: bp.x - itemW / 2, y: bp.y - itemH / 2 };
  } else {
    const center = screenToBoard(rect.width / 2, rect.height / 2, vp);
    pos = { x: center.x - itemW / 2, y: center.y - itemH / 2 };
  }

  const item = createItem('embed', pos, ref);
  item.sourceUrl = file.name.replace(/\.\w+$/, '');
  item.size = { w: itemW, h: itemH };
  getActiveBoard().items.push(item);
  selectOnly(item.id);
  commit();
  rerender();
}

let embedFullscreenOverlay: HTMLElement | null = null;

function openEmbedFullscreen(itemId: string) {
  const item = findItem(itemId);
  if (!item || item.type !== 'embed') return;

  const overlay = document.createElement('div');
  overlay.className = 'embed-fullscreen-overlay';

  const topBar = document.createElement('div');
  topBar.className = 'embed-fullscreen-bar';

  const title = document.createElement('span');
  title.className = 'embed-fullscreen-title';
  title.textContent = item.sourceUrl || 'Embed HTML';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'embed-fullscreen-close';
  closeBtn.title = 'Fechar (Esc)';
  closeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M18 6L6 18M6 6l12 12"/></svg>';

  topBar.append(title, closeBtn);

  const iframe = document.createElement('iframe');
  iframe.className = 'embed-fullscreen-iframe';
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');

  if (isIdbRef(item.content)) {
    getImage(item.content).then(html => {
      if (html) iframe.srcdoc = html;
    });
  } else if (item.content.startsWith('http')) {
    iframe.src = item.content;
  } else {
    iframe.srcdoc = item.content;
  }

  // Click outside iframe (on the dark bar/overlay edges) refocuses the parent
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay || (e.target as HTMLElement).closest('.embed-fullscreen-bar')) {
      window.focus();
    }
  });

  overlay.append(topBar, iframe);
  document.body.appendChild(overlay);
  embedFullscreenOverlay = overlay;

  function closeFullscreen() {
    overlay.remove();
    embedFullscreenOverlay = null;
    document.removeEventListener('keydown', onEscKey, true);
    window.focus();
  }

  function onEscKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeFullscreen();
    }
  }

  document.addEventListener('keydown', onEscKey, true);
  closeBtn.addEventListener('click', closeFullscreen);
}

function zoomToFit() {
  const board = getActiveBoard();
  if (board.items.length === 0) { resetView(); return; }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const item of board.items) {
    minX = Math.min(minX, item.position.x);
    minY = Math.min(minY, item.position.y);
    maxX = Math.max(maxX, item.position.x + item.size.w);
    maxY = Math.max(maxY, item.position.y + item.size.h);
  }

  const padding = 60; // screen px margin
  const rect = getCanvasRect();
  const availW = rect.width - padding * 2;
  const availH = rect.height - padding * 2;
  const contentW = maxX - minX;
  const contentH = maxY - minY;

  if (contentW <= 0 || contentH <= 0) { resetView(); return; }

  const zoom = Math.min(1.5, Math.max(0.1, Math.min(availW / contentW, availH / contentH)));
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  const newVp = {
    x: rect.width / 2 - centerX * zoom,
    y: rect.height / 2 - centerY * zoom,
    zoom,
  };
  setViewport(newVp);
  getActiveBoard().viewport = newVp;
  updateZoomLabel(zoom);
  save();
  updateMinimap();
}

// --- Presentation mode ---

let presenting = false;

/** Return frames in presentation order (custom slideOrder or auto by position) */
function getPresentationFrames(): BoardItem[] {
  const board = getActiveBoard();
  const allFrames = board.items.filter(i => i.type === 'frame');
  if (allFrames.length === 0) return [];

  // If custom order exists, use it (filter out stale IDs, append new frames at end)
  if (board.slideOrder && board.slideOrder.length > 0) {
    const frameMap = new Map(allFrames.map(f => [f.id, f]));
    const ordered: BoardItem[] = [];
    for (const id of board.slideOrder) {
      const f = frameMap.get(id);
      if (f) { ordered.push(f); frameMap.delete(id); }
    }
    // Append any new frames not yet in the custom order
    const remaining = [...frameMap.values()].sort((a, b) => {
      const rowA = Math.round(a.position.y / 200);
      const rowB = Math.round(b.position.y / 200);
      if (rowA !== rowB) return rowA - rowB;
      return a.position.x - b.position.x;
    });
    ordered.push(...remaining);
    return ordered;
  }

  // Auto order: top-to-bottom, left-to-right
  return [...allFrames].sort((a, b) => {
    const rowA = Math.round(a.position.y / 200);
    const rowB = Math.round(b.position.y / 200);
    if (rowA !== rowB) return rowA - rowB;
    return a.position.x - b.position.x;
  });
}

function openSlideOrderEditor() {
  const board = getActiveBoard();
  const frames = getPresentationFrames();

  if (frames.length === 0) {
    alert('Nenhum frame encontrado. Crie frames para organizar os slides.');
    return;
  }

  // Close if already open
  const existing = document.querySelector('.slide-order-panel');
  if (existing) { existing.remove(); return; }

  const panel = document.createElement('div');
  panel.className = 'slide-order-panel';

  const header = document.createElement('div');
  header.className = 'slide-order-header';

  const title = document.createElement('span');
  title.textContent = 'Ordem dos slides';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'slide-order-close';
  closeBtn.innerHTML = '✕';
  closeBtn.addEventListener('click', () => panel.remove());

  header.append(title, closeBtn);
  panel.appendChild(header);

  const list = document.createElement('div');
  list.className = 'slide-order-list';

  let dragSrcIdx: number | null = null;

  function renderList() {
    list.innerHTML = '';
    const currentFrames = getPresentationFrames();

    currentFrames.forEach((frame, idx) => {
      const row = document.createElement('div');
      row.className = 'slide-order-row';
      row.draggable = true;

      const grip = document.createElement('span');
      grip.className = 'slide-order-grip';
      grip.innerHTML = '⠿';

      const num = document.createElement('span');
      num.className = 'slide-order-num';
      num.textContent = String(idx + 1);

      const name = document.createElement('span');
      name.className = 'slide-order-name';
      name.textContent = frame.content || 'Frame';

      row.append(grip, num, name);

      // Drag events
      row.addEventListener('dragstart', (e) => {
        dragSrcIdx = idx;
        row.classList.add('dragging');
        e.dataTransfer!.effectAllowed = 'move';
      });

      row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        dragSrcIdx = null;
        list.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
      });

      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'move';
        row.classList.add('drag-over');
      });

      row.addEventListener('dragleave', () => {
        row.classList.remove('drag-over');
      });

      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drag-over');
        if (dragSrcIdx === null || dragSrcIdx === idx) return;

        // Reorder
        const order = currentFrames.map(f => f.id);
        const [moved] = order.splice(dragSrcIdx, 1);
        order.splice(idx, 0, moved);
        board.slideOrder = order;
        commit();
        renderList();
      });

      list.appendChild(row);
    });
  }

  panel.appendChild(list);

  // Reset button
  const footer = document.createElement('div');
  footer.className = 'slide-order-footer';

  const resetBtn = document.createElement('button');
  resetBtn.className = 'slide-order-reset';
  resetBtn.textContent = 'Resetar ordem automática';
  resetBtn.addEventListener('click', () => {
    board.slideOrder = undefined;
    commit();
    renderList();
  });

  footer.appendChild(resetBtn);
  panel.appendChild(footer);

  const slideWrap = document.getElementById('slide-order-wrap');
  if (slideWrap) slideWrap.appendChild(panel);
  else document.body.appendChild(panel);
  renderList();
}

function startPresentation() {
  const frames = getPresentationFrames();

  if (frames.length === 0) {
    alert('Adicione pelo menos um frame para usar o modo apresentação.');
    return;
  }

  presenting = true;
  let slideIdx = 0;

  // Save viewport to restore later
  const savedVp = { ...getViewport() };

  // Create overlay
  const overlay = document.createElement('div');
  overlay.className = 'present-overlay';

  // HUD bar (bottom)
  const hud = document.createElement('div');
  hud.className = 'present-hud';

  const prevBtn = document.createElement('button');
  prevBtn.className = 'present-nav-btn';
  prevBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M15 18l-6-6 6-6"/></svg>';

  const info = document.createElement('span');
  info.className = 'present-info';

  const nextBtn = document.createElement('button');
  nextBtn.className = 'present-nav-btn';
  nextBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M9 6l6 6-6 6"/></svg>';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'present-close-btn';
  closeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M18 6L6 18M6 6l12 12"/></svg>';
  closeBtn.title = 'Sair (Esc)';

  hud.append(prevBtn, info, nextBtn, closeBtn);
  overlay.appendChild(hud);
  document.body.appendChild(overlay);

  // Hide UI
  const sidebar = document.getElementById('sidebar');
  const toolbar = document.getElementById('toolbar');
  const statusBar = document.getElementById('status-bar');
  const backBar = document.getElementById('back-bar');
  const minimap = document.querySelector('.minimap') as HTMLElement | null;
  sidebar?.classList.add('present-hidden');
  toolbar?.classList.add('present-hidden');
  statusBar?.classList.add('present-hidden');
  backBar?.classList.add('present-hidden');
  minimap?.classList.add('present-hidden');

  clearSelection();
  syncSelection();

  // Add dark mask that blocks interaction and dims everything outside frames
  const mask = document.createElement('div');
  mask.className = 'present-mask';
  canvasEl.appendChild(mask);

  // Hint that shows when iframe has focus
  const embedHint = document.createElement('div');
  embedHint.className = 'present-embed-hint';
  embedHint.textContent = 'Clique fora do embed para navegar · Esc para sair';
  document.body.appendChild(embedHint);

  let embedFocused = false;
  function setEmbedFocused(focused: boolean) {
    embedFocused = focused;
    embedHint.classList.toggle('visible', focused);
  }

  // Detect when focus goes to/from iframe
  const onWindowBlur = () => {
    if (presenting) setEmbedFocused(true);
  };
  const onWindowFocus = () => {
    setEmbedFocused(false);
  };
  window.addEventListener('blur', onWindowBlur);
  window.addEventListener('focus', onWindowFocus);

  // Block pan/zoom/drag during presentation (but allow embed + mask interaction)
  const blockWheel = (ev: WheelEvent) => { ev.preventDefault(); ev.stopPropagation(); };
  const blockMouse = (ev: MouseEvent) => {
    const target = ev.target as HTMLElement;
    if (target.closest('.item-embed')) return;
    if (target === mask || target.closest('.present-mask')) {
      window.focus();
      setEmbedFocused(false);
    }
    ev.preventDefault(); ev.stopPropagation();
  };
  canvasEl.addEventListener('wheel', blockWheel, { capture: true, passive: false });
  canvasEl.addEventListener('mousedown', blockMouse, { capture: true });

  function goToSlide(idx: number) {
    slideIdx = Math.max(0, Math.min(frames.length - 1, idx));
    const frame = frames[slideIdx];

    // Zoom viewport to fit frame with padding
    const rect = getCanvasRect();
    const padding = 40;
    const availW = rect.width - padding * 2;
    const availH = rect.height - padding * 2;

    const zoom = Math.min(2, Math.max(0.1, Math.min(availW / frame.size.w, availH / frame.size.h)));
    const cx = frame.position.x + frame.size.w / 2;
    const cy = frame.position.y + frame.size.h / 2;

    const vp = {
      x: rect.width / 2 - cx * zoom,
      y: rect.height / 2 - cy * zoom,
      zoom,
    };
    setViewport(vp);
    updateZoomLabel(zoom);

    // Position the cutout mask over the current frame (in viewport coords)
    const screenX = frame.position.x * zoom + vp.x + rect.left;
    const screenY = frame.position.y * zoom + vp.y + rect.top;
    const screenW = frame.size.w * zoom;
    const screenH = frame.size.h * zoom;
    mask.style.setProperty('--fx', `${screenX}px`);
    mask.style.setProperty('--fy', `${screenY}px`);
    mask.style.setProperty('--fw', `${screenW}px`);
    mask.style.setProperty('--fh', `${screenH}px`);

    // Enable pointer-events on all embed iframes during presentation
    for (const embedIframe of layer.querySelectorAll('.embed-iframe') as NodeListOf<HTMLElement>) {
      embedIframe.style.pointerEvents = 'auto';
    }

    // Update HUD
    const name = frame.content || 'Frame';
    info.textContent = `${name}  ·  ${slideIdx + 1} / ${frames.length}`;
    prevBtn.style.visibility = slideIdx === 0 ? 'hidden' : '';
    nextBtn.style.visibility = slideIdx === frames.length - 1 ? 'hidden' : '';
  }

  function exitPresentation() {
    presenting = false;
    overlay.remove();
    mask.remove();
    embedHint.remove();
    window.removeEventListener('blur', onWindowBlur);
    window.removeEventListener('focus', onWindowFocus);
    canvasEl.removeEventListener('wheel', blockWheel, { capture: true } as EventListenerOptions);
    canvasEl.removeEventListener('mousedown', blockMouse, { capture: true } as EventListenerOptions);
    sidebar?.classList.remove('present-hidden');
    toolbar?.classList.remove('present-hidden');
    statusBar?.classList.remove('present-hidden');
    backBar?.classList.remove('present-hidden');
    minimap?.classList.remove('present-hidden');
    document.removeEventListener('keydown', onKey, true);

    // Restore embed iframe pointer-events to default (none, since nothing is selected)
    for (const iframe of layer.querySelectorAll('.embed-iframe') as NodeListOf<HTMLElement>) {
      iframe.style.pointerEvents = 'none';
    }

    // Restore viewport
    setViewport(savedVp);
    updateZoomLabel(savedVp.zoom);
  }

  function onKey(e: KeyboardEvent) {
    if (embedFullscreenOverlay) return;
    // Block ALL keys except navigation and exit
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { exitPresentation(); return; }
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ') { goToSlide(slideIdx + 1); return; }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { goToSlide(slideIdx - 1); return; }
  }

  document.addEventListener('keydown', onKey, true);
  prevBtn.addEventListener('click', () => goToSlide(slideIdx - 1));
  nextBtn.addEventListener('click', () => goToSlide(slideIdx + 1));
  closeBtn.addEventListener('click', exitPresentation);

  // Click on overlay body advances slide
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) goToSlide(slideIdx + 1);
  });

  // Start on first slide
  goToSlide(0);
}

/** Compute bounding box + filtered & sorted items for a board export */
function computeExportBounds(board: Board, frameItem?: BoardItem) {
  let minX: number, minY: number, maxX: number, maxY: number;

  if (frameItem) {
    minX = frameItem.position.x;
    minY = frameItem.position.y;
    maxX = frameItem.position.x + frameItem.size.w;
    maxY = frameItem.position.y + frameItem.size.h;
  } else {
    minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
    for (const item of board.items) {
      minX = Math.min(minX, item.position.x);
      minY = Math.min(minY, item.position.y);
      maxX = Math.max(maxX, item.position.x + item.size.w);
      maxY = Math.max(maxY, item.position.y + item.size.h);
    }
  }

  const padding = 40;
  const w = maxX - minX + padding * 2;
  const h = maxY - minY + padding * 2;

  const exportItems = frameItem
    ? board.items.filter(i => {
        if (i.id === frameItem.id) return true;
        return i.position.x + i.size.w > minX && i.position.x < maxX &&
               i.position.y + i.size.h > minY && i.position.y < maxY;
      })
    : board.items;

  const sorted = [...exportItems].sort((a, b) => {
    const aFrame = a.type === 'frame' ? 0 : 1;
    const bFrame = b.type === 'frame' ? 0 : 1;
    if (aFrame !== bFrame) return aFrame - bFrame;
    return a.zIndex - b.zIndex;
  });

  return { minX, minY, maxX, maxY, padding, w, h, sorted };
}

/** Load all image items into an HTMLImageElement map */
async function loadExportImages(items: BoardItem[]): Promise<Map<string, HTMLImageElement>> {
  const imgMap = new Map<string, HTMLImageElement>();
  const promises: Promise<void>[] = [];
  for (const item of items) {
    if (item.type === 'image' && item.content) {
      promises.push((async () => {
        let src = item.content;
        if (isIdbRef(src)) {
          const dataUrl = await getImage(src);
          if (!dataUrl) return;
          src = dataUrl;
        }
        await new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = () => { imgMap.set(item.id, img); resolve(); };
          img.onerror = () => resolve();
          img.src = src;
        });
      })());
    }
  }
  await Promise.all(promises);
  return imgMap;
}

/** Draw all board items + connections onto a canvas 2d context */
function drawBoardToCanvas(
  ctx: CanvasRenderingContext2D,
  board: Board,
  sorted: BoardItem[],
  imgMap: Map<string, HTMLImageElement>,
  minX: number, minY: number, padding: number, w: number, h: number,
  opts?: { drawGrid?: boolean; bgColor?: string }
) {
  const bg = opts?.bgColor ?? '#f6f4ef';
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  if (opts?.drawGrid !== false) {
    ctx.fillStyle = '#d8d4cc';
    const gridSize = 24;
    for (let gx = padding % gridSize; gx < w; gx += gridSize) {
      for (let gy = padding % gridSize; gy < h; gy += gridSize) {
        ctx.beginPath();
        ctx.arc(gx, gy, 0.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  for (const item of sorted) {
    const x = item.position.x - minX + padding;
    const y = item.position.y - minY + padding;
    const iw = item.size.w;
    const ih = item.size.h;

    const rotated = !!item.rotation && item.type === 'image';
    if (rotated) {
      ctx.save();
      const rcx = x + iw / 2, rcy = y + ih / 2;
      ctx.translate(rcx, rcy);
      ctx.rotate(item.rotation! * Math.PI / 180);
      ctx.translate(-rcx, -rcy);
    }

    if (item.type === 'frame') {
      ctx.fillStyle = item.color || 'rgba(216, 212, 204, 0.25)';
      ctx.fillRect(x, y, iw, ih);
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#d8d4cc';
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, iw, ih);
      ctx.setLineDash([]);
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.fillStyle = '#8a8a8a';
      ctx.fillText(item.content || 'Frame', x + 6, y - 8);
    }

    if (item.type === 'image') {
      const img = imgMap.get(item.id);
      if (img) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(x, y, iw, ih, 2);
        ctx.clip();
        ctx.drawImage(img, x, y, iw, ih);
        ctx.restore();
        ctx.strokeStyle = '#d8d4cc';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(x, y, iw, ih, 2);
        ctx.stroke();
      }
    }

    if (item.type === 'text') {
      ctx.fillStyle = '#fbfaf6';
      ctx.strokeStyle = '#d8d4cc';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(x, y, iw, ih, 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#1a1a1a';
      ctx.font = '15px system-ui, sans-serif';
      const text = item.content ? item.content.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ') : '';
      const lines = text.split('\n');
      let ty = y + 24;
      for (const line of lines) {
        if (ty > y + ih - 8) break;
        ctx.fillText(line.substring(0, 40), x + 16, ty, iw - 32);
        ty += 22;
      }
    }

    if (item.type === 'note') {
      ctx.fillStyle = item.color || '#fff9c4';
      ctx.beginPath();
      ctx.roundRect(x, y, iw, ih, 2);
      ctx.fill();
      ctx.shadowColor = 'rgba(0,0,0,0.08)';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 2;
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
      ctx.font = '14px system-ui, sans-serif';
      const noteText = item.content ? item.content.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ') : '';
      const noteLines = noteText.split('\n');
      let ny = y + 22;
      for (const line of noteLines) {
        if (ny > y + ih - 8) break;
        ctx.fillText(line.substring(0, 40), x + 14, ny, iw - 28);
        ny += 20;
      }
    }

    if (item.type === 'draw') {
      // Render SVG path onto canvas
      if (item.content) {
        ctx.save();
        ctx.translate(x, y);
        ctx.strokeStyle = item.color || '#1a1a1a';
        ctx.lineWidth = item.strokeWidth || 3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        const p2d = new Path2D(item.content);
        ctx.stroke(p2d);
        ctx.restore();
      }
    }

    if (item.type === 'color') {
      ctx.fillStyle = item.content || '#cccccc';
      ctx.beginPath();
      ctx.roundRect(x, y, iw, ih - 28, [2, 2, 0, 0]);
      ctx.fill();
      ctx.fillStyle = '#fbfaf6';
      ctx.fillRect(x, y + ih - 28, iw, 28);
      ctx.strokeStyle = '#d8d4cc';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(x, y, iw, ih, 2);
      ctx.stroke();
      ctx.fillStyle = '#4a4a4a';
      ctx.font = '500 11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText((item.content || '#cccccc').toUpperCase(), x + iw / 2, y + ih - 10);
      ctx.textAlign = 'start';
    }

    if (item.type === 'link') {
      ctx.fillStyle = '#fbfaf6';
      ctx.strokeStyle = '#d8d4cc';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(x, y, iw, ih, 2);
      ctx.fill();
      ctx.stroke();
      let domain = '';
      try { domain = new URL(item.content).hostname.replace(/^www\./, ''); } catch { domain = item.content; }
      ctx.fillStyle = '#1a1a1a';
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.fillText(domain, x + 48, y + ih / 2 - 4, iw - 60);
      ctx.fillStyle = '#8a8a8a';
      ctx.font = '10px monospace';
      ctx.fillText(item.content.substring(0, 40), x + 48, y + ih / 2 + 12, iw - 60);
    }

    if (item.tags && item.tags.length > 0) {
      let tx = x + 4;
      const tagY = y + ih + 6;
      ctx.font = '9px monospace';
      for (const tag of item.tags) {
        const tw = ctx.measureText(tag).width + 14;
        ctx.fillStyle = '#fbfaf6';
        ctx.strokeStyle = '#d8d4cc';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(tx, tagY, tw, 18, 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#4a4a4a';
        ctx.fillText(tag, tx + 7, tagY + 13);
        tx += tw + 3;
      }
    }

    if (rotated) ctx.restore();
  }

  // Connections
  if (board.connections) {
    const itemMap = new Map<string, BoardItem>();
    for (const it of board.items) itemMap.set(it.id, it);
    ctx.strokeStyle = '#8a8a8a';
    ctx.lineWidth = 1.5;
    for (const conn of board.connections) {
      const from = itemMap.get(conn.fromId);
      const to = itemMap.get(conn.toId);
      if (!from || !to) continue;
      const p1x = from.position.x + from.size.w / 2 - minX + padding;
      const p1y = from.position.y + from.size.h / 2 - minY + padding;
      const p2x = to.position.x + to.size.w / 2 - minX + padding;
      const p2y = to.position.y + to.size.h / 2 - minY + padding;
      const mx = (p1x + p2x) / 2;
      const my = (p1y + p2y) / 2;
      ctx.beginPath();
      ctx.moveTo(p1x, p1y);
      ctx.quadraticCurveTo(mx, my, p2x, p2y);
      ctx.stroke();
      const angle = Math.atan2(p2y - my, p2x - mx);
      ctx.save();
      ctx.translate(p2x, p2y);
      ctx.rotate(angle);
      ctx.fillStyle = '#8a8a8a';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-8, -3);
      ctx.lineTo(-8, 3);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      if (conn.label) {
        ctx.fillStyle = '#8a8a8a';
        ctx.font = '11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(conn.label, mx, my - 8);
        ctx.textAlign = 'start';
      }
    }
  }
}

/** Render a board (or frame region) to a canvas element */
async function renderBoardToCanvas(board: Board, frameItem?: BoardItem, scale = 2): Promise<HTMLCanvasElement> {
  const { minX, minY, padding, w, h, sorted } = computeExportBounds(board, frameItem);
  const imgMap = await loadExportImages(sorted);
  const cvs = document.createElement('canvas');
  cvs.width = w * scale;
  cvs.height = h * scale;
  const ctx = cvs.getContext('2d')!;
  ctx.scale(scale, scale);
  drawBoardToCanvas(ctx, board, sorted, imgMap, minX, minY, padding, w, h);
  return cvs;
}

/** Download a blob as a file */
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function exportBoardAsPng(frameItem?: BoardItem) {
  const board = getActiveBoard();
  if (board.items.length === 0) return;
  const cvs = await renderBoardToCanvas(board, frameItem);
  cvs.toBlob(blob => {
    if (!blob) return;
    const name = frameItem ? (frameItem.content || 'frame') : (board.name || 'moodboard');
    downloadBlob(blob, `${name}.png`);
  }, 'image/png');
}

async function exportBoardAsJpeg(frameItem?: BoardItem) {
  const board = getActiveBoard();
  if (board.items.length === 0) return;
  const cvs = await renderBoardToCanvas(board, frameItem);
  cvs.toBlob(blob => {
    if (!blob) return;
    const name = frameItem ? (frameItem.content || 'frame') : (board.name || 'moodboard');
    downloadBlob(blob, `${name}.jpg`);
  }, 'image/jpeg', 0.92);
}

async function exportBoardAsSvg(frameItem?: BoardItem) {
  const board = getActiveBoard();
  if (board.items.length === 0) return;

  const { minX, minY, padding, w, h, sorted } = computeExportBounds(board, frameItem);
  const imgMap = await loadExportImages(sorted);

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n`;
  svg += `<rect width="${w}" height="${h}" fill="#f6f4ef"/>\n`;

  // Grid dots
  svg += `<g fill="#d8d4cc" opacity="0.6">\n`;
  const gridSize = 24;
  for (let gx = padding % gridSize; gx < w; gx += gridSize) {
    for (let gy = padding % gridSize; gy < h; gy += gridSize) {
      svg += `<circle cx="${gx}" cy="${gy}" r="0.8"/>\n`;
    }
  }
  svg += `</g>\n`;

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  for (const item of sorted) {
    const x = item.position.x - minX + padding;
    const y = item.position.y - minY + padding;
    const iw = item.size.w;
    const ih = item.size.h;
    const svgStart = svg.length;

    if (item.type === 'frame') {
      svg += `<rect x="${x}" y="${y}" width="${iw}" height="${ih}" fill="${item.color || 'rgba(216,212,204,0.25)'}" stroke="#d8d4cc" stroke-width="2" stroke-dasharray="6 4"/>\n`;
      svg += `<text x="${x + 6}" y="${y - 8}" fill="#8a8a8a" font-size="12" font-weight="600" font-family="system-ui,sans-serif">${esc(item.content || 'Frame')}</text>\n`;
    }

    if (item.type === 'image') {
      const img = imgMap.get(item.id);
      if (img) {
        // Draw image cropped to item size directly on canvas (avoids clipPath issues in Illustrator)
        const tmpCvs = document.createElement('canvas');
        tmpCvs.width = iw;
        tmpCvs.height = ih;
        const tmpCtx = tmpCvs.getContext('2d')!;
        // Cover-fit: scale image to fill, center and crop
        const imgRatio = img.naturalWidth / img.naturalHeight;
        const boxRatio = iw / ih;
        let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
        if (imgRatio > boxRatio) {
          sw = img.naturalHeight * boxRatio;
          sx = (img.naturalWidth - sw) / 2;
        } else {
          sh = img.naturalWidth / boxRatio;
          sy = (img.naturalHeight - sh) / 2;
        }
        tmpCtx.drawImage(img, sx, sy, sw, sh, 0, 0, iw, ih);
        const dataUrl = tmpCvs.toDataURL('image/png');
        svg += `<image x="${x}" y="${y}" width="${iw}" height="${ih}" xlink:href="${dataUrl}"/>\n`;
        svg += `<rect x="${x}" y="${y}" width="${iw}" height="${ih}" fill="none" stroke="#d8d4cc" stroke-width="1" rx="2"/>\n`;
      }
    }

    if (item.type === 'text') {
      svg += `<rect x="${x}" y="${y}" width="${iw}" height="${ih}" fill="#fbfaf6" stroke="#d8d4cc" stroke-width="1" rx="2"/>\n`;
      const text = item.content ? item.content.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ') : '';
      const lines = text.split('\n');
      let ty = y + 24;
      for (const line of lines) {
        if (ty > y + ih - 8) break;
        svg += `<text x="${x + 16}" y="${ty}" fill="#1a1a1a" font-size="15" font-family="system-ui,sans-serif">${esc(line.substring(0, 40))}</text>\n`;
        ty += 22;
      }
    }

    if (item.type === 'note') {
      svg += `<rect x="${x}" y="${y}" width="${iw}" height="${ih}" fill="${item.color || '#fff9c4'}" rx="2"/>\n`;
      const noteText = item.content ? item.content.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ') : '';
      const noteLines = noteText.split('\n');
      let ny = y + 22;
      for (const line of noteLines) {
        if (ny > y + ih - 8) break;
        svg += `<text x="${x + 14}" y="${ny}" fill="rgba(0,0,0,0.75)" font-size="14" font-family="system-ui,sans-serif">${esc(line.substring(0, 40))}</text>\n`;
        ny += 20;
      }
    }

    if (item.type === 'draw') {
      if (item.content) {
        svg += `<g transform="translate(${x},${y})"><path d="${esc(item.content)}" fill="none" stroke="${item.color || '#1a1a1a'}" stroke-width="${item.strokeWidth || 3}" stroke-linecap="round" stroke-linejoin="round"/></g>\n`;
      }
    }

    if (item.type === 'color') {
      svg += `<rect x="${x}" y="${y}" width="${iw}" height="${ih - 28}" fill="${item.content || '#cccccc'}" rx="2 2 0 0"/>\n`;
      svg += `<rect x="${x}" y="${y + ih - 28}" width="${iw}" height="28" fill="#fbfaf6"/>\n`;
      svg += `<rect x="${x}" y="${y}" width="${iw}" height="${ih}" fill="none" stroke="#d8d4cc" stroke-width="1" rx="2"/>\n`;
      svg += `<text x="${x + iw / 2}" y="${y + ih - 10}" fill="#4a4a4a" font-size="11" font-weight="500" font-family="monospace" text-anchor="middle">${esc((item.content || '#cccccc').toUpperCase())}</text>\n`;
    }

    if (item.type === 'link') {
      let domain = '';
      try { domain = new URL(item.content).hostname.replace(/^www\./, ''); } catch { domain = item.content; }
      svg += `<rect x="${x}" y="${y}" width="${iw}" height="${ih}" fill="#fbfaf6" stroke="#d8d4cc" stroke-width="1" rx="2"/>\n`;
      svg += `<text x="${x + 48}" y="${y + ih / 2 - 4}" fill="#1a1a1a" font-size="13" font-weight="600" font-family="system-ui,sans-serif">${esc(domain)}</text>\n`;
      svg += `<text x="${x + 48}" y="${y + ih / 2 + 12}" fill="#8a8a8a" font-size="10" font-family="monospace">${esc(item.content.substring(0, 40))}</text>\n`;
    }

    if (item.tags && item.tags.length > 0) {
      let tx = x + 4;
      const tagY = y + ih + 6;
      for (const tag of item.tags) {
        const tw = tag.length * 6.5 + 14;
        svg += `<rect x="${tx}" y="${tagY}" width="${tw}" height="18" fill="#fbfaf6" stroke="#d8d4cc" stroke-width="1" rx="2"/>\n`;
        svg += `<text x="${tx + 7}" y="${tagY + 13}" fill="#4a4a4a" font-size="9" font-family="monospace">${esc(tag)}</text>\n`;
        tx += tw + 3;
      }
    }

    // Wrap this item's markup in a rotation group around its center.
    if (item.rotation && item.type === 'image') {
      const body = svg.slice(svgStart);
      svg = svg.slice(0, svgStart) +
        `<g transform="rotate(${item.rotation} ${x + iw / 2} ${y + ih / 2})">\n${body}</g>\n`;
    }
  }

  svg += `</svg>`;
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const name = frameItem ? (frameItem.content || 'frame') : (board.name || 'moodboard');
  downloadBlob(blob, `${name}.svg`);
}

async function exportFramesAsPdf() {
  const board = getActiveBoard();
  const frames = board.items.filter(i => i.type === 'frame');
  if (frames.length === 0) return;

  const ordered = board.slideOrder
    ? board.slideOrder.map(id => frames.find(f => f.id === id)).filter(Boolean) as BoardItem[]
    : [...frames].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);

  if (ordered.length === 0) return;

  // Render each frame to canvas
  const pages: { cvs: HTMLCanvasElement; w: number; h: number }[] = [];
  for (const frame of ordered) {
    const cvs = await renderBoardToCanvas(board, frame, 2);
    pages.push({ cvs, w: cvs.width / 2, h: cvs.height / 2 });
  }

  // Convert each page to JPEG blob
  const pageBuffers: ArrayBuffer[] = [];
  for (const page of pages) {
    const blob = await new Promise<Blob>((resolve) => {
      page.cvs.toBlob(b => resolve(b!), 'image/jpeg', 0.92);
    });
    pageBuffers.push(await blob.arrayBuffer());
  }

  // Minimal PDF generation
  const encoder = new TextEncoder();
  const parts: (Uint8Array | ArrayBuffer)[] = [];
  const offsets: number[] = [];
  let pos = 0;

  const addText = (s: string) => { const u = encoder.encode(s); parts.push(u); pos += u.byteLength; };
  const addBinary = (buf: ArrayBuffer) => { parts.push(buf); pos += buf.byteLength; };
  const markObj = () => { offsets.push(pos); };

  addText('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n');

  // Object 1: Catalog
  markObj();
  addText('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  // Object 2: Pages
  const objsPerPage = 3;
  const totalObjs = 2 + ordered.length * objsPerPage;

  markObj();
  let pagesKids = '';
  for (let i = 0; i < ordered.length; i++) {
    pagesKids += `${3 + i * objsPerPage} 0 R `;
  }
  addText(`2 0 obj\n<< /Type /Pages /Kids [${pagesKids.trim()}] /Count ${ordered.length} >>\nendobj\n`);

  for (let i = 0; i < ordered.length; i++) {
    const pageObjId = 3 + i * objsPerPage;
    const contentsObjId = pageObjId + 1;
    const imageObjId = pageObjId + 2;
    const pw = pages[i].w;
    const ph = pages[i].h;

    markObj();
    addText(`${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Contents ${contentsObjId} 0 R /Resources << /XObject << /Img${i} ${imageObjId} 0 R >> >> >>\nendobj\n`);

    const stream = `q ${pw} 0 0 ${ph} 0 0 cm /Img${i} Do Q`;
    markObj();
    addText(`${contentsObjId} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);

    const imgData = pageBuffers[i];
    const imgW = pages[i].cvs.width;
    const imgH = pages[i].cvs.height;
    markObj();
    addText(`${imageObjId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imgData.byteLength} >>\nstream\n`);
    addBinary(imgData);
    addText('\nendstream\nendobj\n');
  }

  const xrefPos = pos;
  addText(`xref\n0 ${totalObjs + 1}\n`);
  addText('0000000000 65535 f \n');
  for (const off of offsets) {
    addText(`${off.toString().padStart(10, '0')} 00000 n \n`);
  }
  addText(`trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

  const pdfBlob = new Blob(parts as BlobPart[], { type: 'application/pdf' });
  downloadBlob(pdfBlob, `${board.name || 'moodboard'}-frames.pdf`);
}

async function resolveImagesForExport(board: Board): Promise<void> {
  for (const item of board.items) {
    if ((item.type === 'image' || item.type === 'embed') && isIdbRef(item.content)) {
      const data = await getImage(item.content);
      if (data) item.content = data;
    }
  }
}

async function exportBoard() {
  const board = getActiveBoard();
  // Deep clone and resolve idb:// refs to inline data URLs for portability
  const exportData = JSON.parse(JSON.stringify(board)) as Board;
  await resolveImagesForExport(exportData);

  // Collect embedded sub-boards (recursive)
  const subBoards: Board[] = [];
  const collectSubs = async (b: Board) => {
    for (const item of b.items) {
      if (item.type === 'board' && item.content) {
        const sub = state.boards.find(s => s.id === item.content);
        if (sub) {
          const clone = JSON.parse(JSON.stringify(sub)) as Board;
          await resolveImagesForExport(clone);
          subBoards.push(clone);
          await collectSubs(clone);
        }
      }
    }
  };
  await collectSubs(exportData);

  const payload = subBoards.length > 0
    ? { board: exportData, subBoards }
    : exportData;

  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${board.name || 'moodboard'}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Parse an import file and return the board + sub-boards (or null) */
function parseImportData(raw: unknown): { board: Board; subBoards: Board[] } | null {
  if (!raw || typeof raw !== 'object') return null;
  let board: Board;
  let subBoards: Board[] = [];
  const r = raw as Record<string, unknown>;
  if (r.board && typeof r.board === 'object' && (r.board as Board).id && (r.board as Board).items) {
    board = r.board as Board;
    subBoards = (r.subBoards || []) as Board[];
  } else {
    board = raw as Board;
  }
  if (!board.id || !board.items) return null;
  return { board, subBoards };
}

/** Apply a parsed import (board + sub-boards) to state */
async function applyImport(board: Board, subBoards: Board[]) {
  await migrateInlineImages([board, ...subBoards]);
  for (const sub of subBoards) {
    sub.isSubBoard = true;
    const existIdx = state.boards.findIndex(b => b.id === sub.id);
    if (existIdx >= 0) state.boards[existIdx] = sub;
    else state.boards.push(sub);
  }
  const idx = state.boards.findIndex(b => b.id === state.activeBoardId);
  if (idx >= 0) state.boards[idx] = board;
  state.activeBoardId = board.id;
  clearSelection();
  commit();
  rerender();
  const nameEl = document.getElementById('board-name');
  if (nameEl) nameEl.textContent = board.name;
}

/** Show import preview modal */
function showImportPreview(board: Board, subBoards: Board[], onConfirm: () => void) {
  // Overlay
  const overlay = document.createElement('div');
  overlay.className = 'import-preview-overlay';

  const modal = document.createElement('div');
  modal.className = 'import-preview-modal';

  // Header
  const header = document.createElement('h2');
  header.className = 'import-preview-title';
  header.textContent = 'Preview de importação';
  modal.appendChild(header);

  // Board info
  const info = document.createElement('div');
  info.className = 'import-preview-info';

  const boardName = board.name || 'Sem título';
  const itemCount = board.items.length;
  const typeCounts: Record<string, number> = {};
  const allTags = new Set<string>();
  for (const item of board.items) {
    typeCounts[item.type] = (typeCounts[item.type] || 0) + 1;
    if (item.tags) item.tags.forEach(t => allTags.add(t));
  }

  const typeLabels: Record<string, string> = {
    image: 'Imagens', text: 'Textos', note: 'Notas', color: 'Cores',
    link: 'Links', frame: 'Frames', board: 'Sub-boards', embed: 'Embeds'
  };

  let infoHtml = `<div class="import-preview-name">${boardName}</div>`;
  infoHtml += `<div class="import-preview-count">${itemCount} ${itemCount === 1 ? 'item' : 'itens'}`;
  if (subBoards.length > 0) infoHtml += ` · ${subBoards.length} sub-board${subBoards.length > 1 ? 's' : ''}`;
  infoHtml += `</div>`;

  // Type breakdown
  infoHtml += `<div class="import-preview-types">`;
  for (const [type, count] of Object.entries(typeCounts)) {
    const label = typeLabels[type] || type;
    infoHtml += `<span class="import-preview-type-badge">${count} ${label}</span>`;
  }
  infoHtml += `</div>`;

  // Tags
  if (allTags.size > 0) {
    infoHtml += `<div class="import-preview-tags-label">Tags:</div>`;
    infoHtml += `<div class="import-preview-tags">`;
    for (const tag of allTags) {
      infoHtml += `<span class="import-preview-tag">${tag}</span>`;
    }
    infoHtml += `</div>`;
  }

  // Date
  if (board.createdAt) {
    const date = new Date(board.createdAt);
    infoHtml += `<div class="import-preview-date">Criado em ${date.toLocaleDateString('pt-BR')}</div>`;
  }

  info.innerHTML = infoHtml;
  modal.appendChild(info);

  // Canvas preview
  const previewContainer = document.createElement('div');
  previewContainer.className = 'import-preview-canvas';
  previewContainer.innerHTML = '<div class="import-preview-loading">Gerando preview…</div>';
  modal.appendChild(previewContainer);

  // Render preview (small scale)
  if (board.items.length > 0) {
    renderBoardToCanvas(board, undefined, 1).then(cvs => {
      // Scale down to fit in preview area
      const maxW = 560;
      const maxH = 300;
      const ratio = Math.min(maxW / (cvs.width || 1), maxH / (cvs.height || 1), 1);
      cvs.style.width = `${cvs.width * ratio}px`;
      cvs.style.height = `${cvs.height * ratio}px`;
      cvs.style.borderRadius = 'var(--radius)';
      previewContainer.innerHTML = '';
      previewContainer.appendChild(cvs);
    }).catch(() => {
      previewContainer.innerHTML = '<div class="import-preview-loading">Erro ao gerar preview</div>';
    });
  }

  // Buttons
  const buttons = document.createElement('div');
  buttons.className = 'import-preview-buttons';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'import-preview-btn import-preview-btn-cancel';
  cancelBtn.textContent = 'Cancelar';
  cancelBtn.addEventListener('click', () => overlay.remove());

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'import-preview-btn import-preview-btn-confirm';
  confirmBtn.textContent = 'Importar';
  confirmBtn.addEventListener('click', () => {
    overlay.remove();
    onConfirm();
  });

  buttons.append(cancelBtn, confirmBtn);
  modal.appendChild(buttons);

  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);
}

function importBoard() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const raw = JSON.parse(ev.target!.result as string);
        const parsed = parseImportData(raw);
        if (!parsed) return;
        const { board, subBoards } = parsed;

        showImportPreview(board, subBoards, () => {
          applyImport(board, subBoards);
        });
      } catch { /* invalid json */ }
    };
    reader.readAsText(file);
  });
  input.click();
}

// --- Canvas (inside boardView) ---

const { canvas: canvasEl, layer, getViewport, getCanvasRect, setZoom, resetView, setViewport } = initCanvas(
  boardView,
  getActiveBoard().viewport,
  (viewport) => {
    getActiveBoard().viewport = viewport;
    updateZoomLabel(viewport.zoom);
    save();
    if (_onViewportChange) _onViewportChange();
    // Reposition selection toolbar during pan/zoom
    if (selectionToolbar && selectionToolbarItemId) {
      const itemEl = layer.querySelector(`[data-item-id="${selectionToolbarItemId}"]`) as HTMLElement | null;
      if (itemEl) positionToolbar(selectionToolbar, itemEl);
    }
    // Broadcast viewport to other users (fast broadcast + throttled presence)
    if (currentProfile) {
      const rect = getCanvasRect();
      broadcastViewport(viewport, rect.width, rect.height);
      throttledPresenceUpdate(currentProfile, viewport);
    }
  }
);

// --- Snap guide layer ---

initGuideLayer(canvasEl);

// --- Connection layer ---

const connLayer = createConnectionLayer(layer);

function updateConnections() {
  const board = getActiveBoard();
  connLayer.update(board.items, board.connections || [], selectedConnId);
}

// --- Sidebar (inside boardView) ---

renderSidebar(boardView, {
  onAddText: addTextAtCenter,
  onAddImage: addImageFromFile,
  onAddColor: addColorAtCenter,
  onAddLink: () => addLinkAtCenter(),
  onAddNote: addNoteAtCenter,
  onDraw: () => showDrawMenu(),
  onAddFrame: () => showFrameMenu(),
  onAddBoard: addSubBoardAtCenter,
  onAddEmbed: addEmbedFromFile,
  onConnect: () => startConnectMode(),
  onSelect: () => activateSelectTool(),
});

// --- Toolbar (inside boardView) ---

renderToolbar(boardView, getActiveBoard().name, {
  onHome: () => showHomeScreen(),
  onZoomIn: () => setZoom(getViewport().zoom * 1.2),
  onZoomOut: () => setZoom(getViewport().zoom * 0.8),
  onZoomReset: () => resetView(),
  onZoomFit: () => zoomToFit(),
  onBoardNameChange: (name: string) => {
    getActiveBoard().name = name;
    getActiveBoard().updatedAt = Date.now();
    save();
  },
  onUndo: () => {
    const board = undo();
    if (board) { clearSelection(); applyBoard(board); }
  },
  onRedo: () => {
    const board = redo();
    if (board) { clearSelection(); applyBoard(board); }
  },
  onExport: exportBoard,
  onExportPng: () => exportBoardAsPng(),
  onExportJpeg: () => exportBoardAsJpeg(),
  onExportSvg: () => exportBoardAsSvg(),
  onExportPdf: exportFramesAsPdf,
  onImport: importBoard,
  onPresent: startPresentation,
  onSlideOrder: openSlideOrderEditor,
  onToggleTheme: toggleTheme,
  onHistory: () => toggleHistoryPanel(),
  onShare: () => toggleSharePanel(),
});

// --- Back navigation bar ---

const backBar = document.createElement('div');
backBar.id = 'back-bar';
backBar.className = 'back-bar hidden';
const backBtn = document.createElement('button');
backBtn.className = 'back-btn';
backBtn.addEventListener('click', () => {
  const prevId = boardNavHistory.pop();
  if (prevId && state.boards.some(b => b.id === prevId)) {
    showBoardView(prevId, true); // true = don't push to history
  }
  updateBackBar();
});
backBar.appendChild(backBtn);
// Insert after toolbar
const toolbarEl = document.getElementById('toolbar');
if (toolbarEl && toolbarEl.nextSibling) {
  boardView.insertBefore(backBar, toolbarEl.nextSibling);
} else {
  boardView.appendChild(backBar);
}

function updateBackBar() {
  const sidebarEl = document.getElementById('sidebar');
  if (boardNavHistory.length === 0) {
    backBar.classList.add('hidden');
    if (sidebarEl) sidebarEl.style.top = '';
    return;
  }
  const prevBoardId = boardNavHistory[boardNavHistory.length - 1];
  const prevBoard = state.boards.find(b => b.id === prevBoardId);
  const name = prevBoard?.name || 'board anterior';
  backBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg> Retornar para ${name}`;
  backBar.classList.remove('hidden');
  // Push sidebar below the back-bar
  requestAnimationFrame(() => {
    if (sidebarEl) sidebarEl.style.top = `${backBar.offsetTop + backBar.offsetHeight + 10}px`;
  });
}

// --- Status Bar (inside boardView) ---

renderStatusBar(boardView);

// --- Minimap ---

const minimap = createMinimap(canvasEl, (boardX, boardY) => {
  const vp = getViewport();
  const rect = getCanvasRect();
  const newVp = {
    x: rect.width / 2 - boardX * vp.zoom,
    y: rect.height / 2 - boardY * vp.zoom,
    zoom: vp.zoom,
  };
  setViewport(newVp);
  getActiveBoard().viewport = newVp;
  save();
  updateMinimap();
});

function updateMinimap() {
  const board = getActiveBoard();
  minimap.update(board.items, getViewport(), getCanvasRect());
}

_onViewportChange = updateMinimap;

// --- View Routing ---

function showHomeScreen() {
  if (isPublicView) return;
  // Save current board's viewport
  if (state.activeBoardId) {
    const board = state.boards.find(b => b.id === state.activeBoardId);
    if (board) board.viewport = getViewport();
    save();
  }
  leaveBoard();
  try { closeCommentPopover(); } catch {}
  try { unsubscribeComments(); } catch {}
  stopAutoSnapshot();
  closeHistoryPanel();
  closeSharePanel();
  removeAllRemoteCursors();
  removeFollowBanner();
  currentBoardRole = 'owner';
  const badge = document.getElementById('readonly-badge');
  if (badge) badge.remove();
  currentView = 'home';
  boardNavHistory.length = 0; // clear navigation history
  updateBackBar();
  homeScreen.classList.remove('hidden');
  closeContextMenu();
  refreshHome();
}

function showBoardView(boardId: string, skipHistory = false) {
  // Save current board viewport before switching
  if (state.activeBoardId && state.activeBoardId !== boardId) {
    const prev = state.boards.find(b => b.id === state.activeBoardId);
    if (prev) prev.viewport = getViewport();
    // Push to navigation history (unless going back)
    if (!skipHistory && currentView === 'board') {
      boardNavHistory.push(state.activeBoardId);
    }
  }

  state.activeBoardId = boardId;
  currentView = 'board';
  clearSelection();
  clearHistory();
  clearTagFilter();
  closeContextMenu();

  // Load the board's saved viewport
  const board = getActiveBoard();
  setViewport(board.viewport);
  updateZoomLabel(board.viewport.zoom);

  // Update toolbar board name
  const nameEl = document.getElementById('board-name');
  if (nameEl) nameEl.textContent = board.name;

  // Render items and connections
  snapshot();
  rerender();
  updateUndoRedoButtons(canUndo(), canRedo());

  // Hide the home screen overlay
  homeScreen.classList.add('hidden');

  // Update back navigation bar
  updateBackBar();

  // Join presence channel and fetch role
  if (currentProfile) {
    joinBoard(boardId, currentProfile, board.viewport);
    getBoardRole(boardId, currentProfile.id).then(role => {
      currentBoardRole = role;
      applyRoleRestrictions();
    });
    // Load comment counts and subscribe to realtime
    loadCommentCounts(boardId).then(() => rerender());
    setupCommentSync(boardId);
  }

  // Start auto-snapshot for version history
  startAutoSnapshot(() => {
    const b = state.boards.find(x => x.id === boardId);
    return b || null;
  });
}

function applyRoleRestrictions() {
  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    sidebar.style.display = isReadOnly() ? 'none' : '';
  }
  const toolbar = document.getElementById('toolbar');
  if (toolbar) {
    const editBtns = toolbar.querySelectorAll('#btn-undo, #btn-redo');
    editBtns.forEach(btn => (btn as HTMLElement).style.display = isReadOnly() ? 'none' : '');
    const exportWrap = toolbar.querySelector('.export-dropdown-wrap');
    if (exportWrap) (exportWrap as HTMLElement).style.display = isReadOnly() ? 'none' : '';
    const importBtn = toolbar.querySelector('[title="Ctrl+O"]');
    if (importBtn) (importBtn as HTMLElement).style.display = isReadOnly() ? 'none' : '';
  }
  // Show read-only indicator
  let badge = document.getElementById('readonly-badge');
  if (isReadOnly() && !badge) {
    badge = document.createElement('div');
    badge.id = 'readonly-badge';
    badge.textContent = 'Somente leitura';
    document.body.append(badge);
  } else if (!isReadOnly() && badge) {
    badge.remove();
  }
}

// --- Favorites (localStorage) ---

const FAVORITES_KEY = 'moodboard-favorites';

function loadFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}

function saveFavorites(favs: Set<string>): void {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favs]));
}

const favorites = loadFavorites();

function toggleFavorite(boardId: string): void {
  if (favorites.has(boardId)) {
    favorites.delete(boardId);
  } else {
    favorites.add(boardId);
  }
  saveFavorites(favorites);
  refreshHome();
}

// --- Version History Panel ---

let historyPanel: HTMLElement | null = null;

function formatSnapshotDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function closeHistoryPanel(): void {
  if (historyPanel) {
    historyPanel.remove();
    historyPanel = null;
  }
}

async function renderHistoryList(list: HTMLElement, boardId: string): Promise<void> {
  const snapshots = await getSnapshots(boardId);
  list.innerHTML = '';

  if (snapshots.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'Nenhuma versão salva ainda';
    list.appendChild(empty);
    return;
  }

  for (const snap of snapshots) {
    const row = document.createElement('div');
    row.className = 'history-item';

    const info = document.createElement('div');
    info.className = 'history-item-info';

    const label = document.createElement('div');
    label.className = 'history-item-label';
    label.textContent = snap.label || 'Snapshot';

    const meta = document.createElement('div');
    meta.className = 'history-item-meta';
    meta.textContent = `${formatSnapshotDate(snap.createdAt)} · ${snap.itemCount} itens`;

    info.append(label, meta);

    const actions = document.createElement('div');
    actions.className = 'history-item-actions';

    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'history-btn-restore';
    restoreBtn.textContent = 'Restaurar';
    restoreBtn.title = 'Restaurar esta versão';
    restoreBtn.addEventListener('click', () => {
      if (!confirm('Restaurar esta versão? As alterações atuais serão substituídas.')) return;
      const restoredBoard = restoreBoardFromSnapshot(snap);
      const board = getActiveBoard();
      board.items = restoredBoard.items;
      board.connections = restoredBoard.connections || [];
      snapshot();
      rerender();
      save();
      closeHistoryPanel();
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'history-btn-delete';
    deleteBtn.textContent = '×';
    deleteBtn.title = 'Excluir versão';
    deleteBtn.addEventListener('click', async () => {
      await deleteSnapshot(snap.id);
      await renderHistoryList(list, boardId);
    });

    actions.append(restoreBtn, deleteBtn);
    row.append(info, actions);
    list.appendChild(row);
  }
}

async function toggleHistoryPanel(): Promise<void> {
  if (historyPanel) {
    closeHistoryPanel();
    return;
  }

  const boardId = state.activeBoardId;
  if (!boardId) return;

  historyPanel = document.createElement('div');
  historyPanel.className = 'history-panel';

  const header = document.createElement('div');
  header.className = 'history-panel-header';

  const title = document.createElement('span');
  title.textContent = 'Histórico de versões';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'history-panel-close';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', closeHistoryPanel);

  header.append(title, closeBtn);

  const saveBtn = document.createElement('button');
  saveBtn.className = 'history-save-btn';
  saveBtn.textContent = '+ Salvar versão atual';
  saveBtn.addEventListener('click', async () => {
    const board = getActiveBoard();
    await saveSnapshot(board, 'Manual');
    await renderHistoryList(list, boardId);
  });

  const list = document.createElement('div');
  list.className = 'history-list';

  historyPanel.append(header, saveBtn, list);
  document.body.appendChild(historyPanel);

  await renderHistoryList(list, boardId);
}

// --- Share Link Panel ---

let sharePanel: HTMLElement | null = null;

function closeSharePanel(): void {
  if (sharePanel) {
    sharePanel.remove();
    sharePanel = null;
  }
}

async function toggleSharePanel(): Promise<void> {
  if (sharePanel) {
    closeSharePanel();
    return;
  }

  const boardId = state.activeBoardId;
  if (!boardId || !currentProfile) return;

  sharePanel = document.createElement('div');
  sharePanel.className = 'share-panel';

  const header = document.createElement('div');
  header.className = 'share-panel-header';
  const title = document.createElement('span');
  title.textContent = 'Compartilhar board';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'history-panel-close';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', closeSharePanel);
  header.append(title, closeBtn);

  const content = document.createElement('div');
  content.className = 'share-panel-content';
  content.textContent = 'Carregando…';

  sharePanel.append(header, content);
  document.body.appendChild(sharePanel);

  // Fetch current public_token
  const { data: board } = await supabase
    .from('boards')
    .select('public_token')
    .eq('id', boardId)
    .single();

  const currentToken = board?.public_token as string | null;

  function renderShareContent(token: string | null) {
    content.innerHTML = '';
    const desc = document.createElement('p');
    desc.className = 'share-desc';

    if (token) {
      desc.textContent = 'Link público ativo. Qualquer pessoa com o link pode visualizar este board (somente leitura).';
      content.appendChild(desc);

      const linkBox = document.createElement('div');
      linkBox.className = 'share-link-box';
      const url = `${window.location.origin}${window.location.pathname}?view=${token}`;
      const linkInput = document.createElement('input');
      linkInput.type = 'text';
      linkInput.readOnly = true;
      linkInput.value = url;
      linkInput.className = 'share-link-input';

      const copyBtn = document.createElement('button');
      copyBtn.className = 'share-copy-btn';
      copyBtn.textContent = 'Copiar';
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(url);
        copyBtn.textContent = 'Copiado!';
        setTimeout(() => { copyBtn.textContent = 'Copiar'; }, 2000);
      });
      linkBox.append(linkInput, copyBtn);
      content.appendChild(linkBox);

      const disableBtn = document.createElement('button');
      disableBtn.className = 'share-disable-btn';
      disableBtn.textContent = 'Desativar link público';
      disableBtn.addEventListener('click', async () => {
        await supabase.from('boards').update({ public_token: null }).eq('id', boardId);
        renderShareContent(null);
      });
      content.appendChild(disableBtn);
    } else {
      desc.textContent = 'Gere um link público para compartilhar este board em modo somente leitura. Não é necessário login para visualizar.';
      content.appendChild(desc);

      const enableBtn = document.createElement('button');
      enableBtn.className = 'share-enable-btn';
      enableBtn.textContent = 'Gerar link público';
      enableBtn.addEventListener('click', async () => {
        const newToken = crypto.randomUUID();
        await supabase.from('boards').update({ public_token: newToken }).eq('id', boardId);
        renderShareContent(newToken);
      });
      content.appendChild(enableBtn);
    }
  }

  renderShareContent(currentToken);
}

function refreshHome() {
  renderHome(homeScreen, state.boards, {
    onOpenBoard: (id) => showBoardView(id),
    onNewBoard: async () => {
      const board = createBoard(`Board ${state.boards.length + 1}`);
      state.boards.push(board);
      save();
      if (currentProfile) await saveBoardToSupabase(board, currentProfile.id);
      showBoardView(board.id);
    },
    onDeleteBoard: async (id) => {
      const idx = state.boards.findIndex(b => b.id === id);
      if (idx < 0) return;
      state.boards.splice(idx, 1);
      if (state.activeBoardId === id) {
        state.activeBoardId = state.boards[0]?.id || null;
      }
      save();
      const { deleteBoardFromSupabase } = await import('./boardStore');
      await deleteBoardFromSupabase(id);
      refreshHome();
    },
    onArchiveBoard: (id) => {
      const board = state.boards.find(b => b.id === id);
      if (board) {
        board.archived = !board.archived;
        board.updatedAt = Date.now();
        save();
        refreshHome();
      }
    },
    onDuplicateBoard: async (id) => {
      const original = state.boards.find(b => b.id === id);
      if (!original) return;
      const now = Date.now();
      const newId = crypto.randomUUID();
      const idMap = new Map<string, string>();
      const newItems = original.items.map(item => {
        const newItemId = generateId();
        idMap.set(item.id, newItemId);
        return { ...item, id: newItemId, createdAt: now };
      });
      // Remap groupIds so groups stay internal to the copy
      for (const item of newItems) {
        if (item.groupId && idMap.has(item.groupId)) {
          item.groupId = idMap.get(item.groupId);
        }
      }
      const newConns = (original.connections || []).map(c => ({
        ...c,
        id: generateId(),
        fromId: idMap.get(c.fromId) || c.fromId,
        toId: idMap.get(c.toId) || c.toId,
      }));
      const copy: Board = {
        id: newId,
        name: `Cópia de ${original.name}`,
        description: original.description,
        items: newItems,
        connections: newConns,
        viewport: { ...original.viewport },
        createdAt: now,
        updatedAt: now,
      };
      state.boards.unshift(copy);
      save();
      if (currentProfile) await saveBoardToSupabase(copy, currentProfile.id);
      refreshHome();
    },
    onToggleFavorite: (id) => toggleFavorite(id),
    isFavorite: (id) => favorites.has(id),
    onRenameBoard: (id, name) => {
      const board = state.boards.find(b => b.id === id);
      if (board) {
        board.name = name;
        board.updatedAt = Date.now();
        save();
      }
    },
    onUpdateDescription: (id, desc) => {
      const board = state.boards.find(b => b.id === id);
      if (board) {
        board.description = desc || undefined;
        board.updatedAt = Date.now();
        save();
      }
    },
    onToggleTheme: toggleTheme,
    onAdmin: () => showAdminView(),
    onLogout: async () => {
      await signOut();
      leaveBoard();
      currentProfile = null;
      showLoginScreen();
    },
    isAdmin: currentProfile?.is_admin ?? false,
    userName: currentProfile?.display_name,
    userColor: currentProfile?.color,
    userAvatar: currentProfile?.avatar_url,
  });
}

// --- Auth, Admin & Presence ---

const loginScreen = document.createElement('div');
loginScreen.id = 'login-screen';
loginScreen.style.display = 'none';
app.append(loginScreen);

function showLoginScreen() {
  loginScreen.style.display = 'block';
  renderLogin(loginScreen, async () => {
    const auth = getAuth();
    currentProfile = auth.profile;
    loginScreen.style.display = 'none';
    await loadRemoteBoards();
    refreshHome();
    setupPresence();
    setupBoardSync();
  });
}

async function loadRemoteBoards() {
  if (!currentProfile) return;
  try {
    const remoteBoards = await loadBoardsFromSupabase();
    if (remoteBoards.length > 0) {
      state.boards = remoteBoards;
      state.activeBoardId = remoteBoards[0].id;
      saveState(state);
      rerender();
      // Push locally-available idb content to Supabase for other users
      resyncIdbContent(remoteBoards, currentProfile!.id);
    } else if (state.boards.length > 0) {
      await migrateLocalBoards(state, currentProfile.id);
    }
  } catch {
    // Fallback to localStorage
  }
}

function showAdminView() {
  const adminContainer = document.createElement('div');
  adminContainer.id = 'admin-container';
  app.append(adminContainer);
  renderAdmin(adminContainer, {
    onClose: () => adminContainer.remove(),
    getBoards: () => state.boards,
  });
}

// --- Presence / Follow ---

let followBanner: HTMLElement | null = null;

function removeFollowBanner() {
  if (followBanner) {
    followBanner.remove();
    followBanner = null;
  }
  stopFollowing();
}

function updatePresenceAvatars(users: PresenceState[]) {
  const container = document.getElementById('presence-avatars');
  if (!container) return;
  container.innerHTML = '';

  for (const user of users) {
    const av = document.createElement('div');
    av.className = 'presence-avatar' + (getFollowingUserId() === user.id ? ' following' : '');
    av.style.background = user.profile.color;
    if (user.profile.avatar_url) {
      av.style.backgroundImage = `url(${user.profile.avatar_url})`;
      av.textContent = '';
    } else {
      av.textContent = (user.profile.display_name || 'U')[0].toUpperCase();
    }

    const tooltip = document.createElement('div');
    tooltip.className = 'presence-avatar-tooltip';
    tooltip.textContent = user.profile.display_name;
    av.append(tooltip);

    av.addEventListener('click', () => {
      if (getFollowingUserId() === user.id) {
        removeFollowBanner();
        updatePresenceAvatars(users);
        return;
      }
      removeFollowBanner();
      startFollowing(user.id, (target: FollowTarget) => {
        const rect = getCanvasRect();
        const vp = {
          x: rect.width / 2 - target.centerX * target.zoom,
          y: rect.height / 2 - target.centerY * target.zoom,
          zoom: target.zoom,
        };
        setViewport(vp);
        updateZoomLabel(vp.zoom);
      });
      followBanner = document.createElement('div');
      followBanner.className = 'follow-banner';
      followBanner.innerHTML = `Seguindo <strong>${user.profile.display_name}</strong>`;
      const stopBtn = document.createElement('button');
      stopBtn.textContent = 'Parar';
      stopBtn.addEventListener('click', () => {
        removeFollowBanner();
        updatePresenceAvatars(users);
      });
      followBanner.append(stopBtn);
      document.body.append(followBanner);
      updatePresenceAvatars(users);
    });

    container.append(av);
  }
}

function setupPresence() {
  onPresenceChange((users) => {
    updatePresenceAvatars(users);
    checkFollowUpdate();
  });
}

// --- Remote Cursors ---

const remoteCursors = new Map<string, { el: HTMLElement; timer: ReturnType<typeof setTimeout> }>();

function getOrCreateCursorEl(userId: string): HTMLElement {
  const existing = remoteCursors.get(userId);
  if (existing) {
    clearTimeout(existing.timer);
    return existing.el;
  }
  const users = getOnlineUsers();
  const user = users.find(u => u.id === userId);
  const color = user?.profile.color || '#888';
  const name = user?.profile.display_name || '?';

  const el = document.createElement('div');
  el.className = 'remote-cursor';
  el.innerHTML = `<svg width="16" height="20" viewBox="0 0 16 20" fill="${color}" stroke="#fff" stroke-width="1"><path d="M0 0 L16 12 L8 12 L6 20 Z"/></svg><span class="remote-cursor-label" style="background:${color}">${name}</span>`;
  document.getElementById('board-view')!.appendChild(el);
  remoteCursors.set(userId, { el, timer: setTimeout(() => {}, 0) });
  return el;
}

function updateRemoteCursor(userId: string, boardX: number, boardY: number): void {
  if (currentView !== 'board') return;
  const el = getOrCreateCursorEl(userId);
  const vp = getViewport();
  const rect = getCanvasRect();
  const sx = boardX * vp.zoom + vp.x + rect.left;
  const sy = boardY * vp.zoom + vp.y + rect.top;
  el.style.left = sx + 'px';
  el.style.top = sy + 'px';
  el.style.display = '';

  const entry = remoteCursors.get(userId)!;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => { el.style.display = 'none'; }, 5000);
}

function removeAllRemoteCursors(): void {
  for (const [, { el, timer }] of remoteCursors) {
    clearTimeout(timer);
    el.remove();
  }
  remoteCursors.clear();
}

onRemoteCursor((userId, x, y) => {
  updateRemoteCursor(userId, x, y);
});

// --- @Mention Autocomplete ---

function getMentionableUsers(): { id: string; name: string }[] {
  const byId = new Map<string, string>();
  if (currentProfile) {
    byId.set(currentProfile.id, currentProfile.display_name || currentProfile.email);
  }
  for (const u of getOnlineUsers()) {
    if (!byId.has(u.id)) byId.set(u.id, u.profile.display_name || '?');
  }
  return Array.from(byId, ([id, name]) => ({ id, name }));
}

/** Tracks a mention inserted into a comment textarea (user or board) */
type ComposeMention = { name: string; id: string; kind: 'user' | 'board' };

// ── Shared mention menu (used by comments AND text/note editing) ──
// Filters inline by the text typed after '@', supports ArrowUp/Down + Enter/Tab,
// and renders a single scroll container.

interface MentionCandidate { kind: 'user' | 'board'; id: string; name: string; sub: string; icon: string }

function getMentionCandidates(query: string): MentionCandidate[] {
  const ql = query.toLowerCase();
  const out: MentionCandidate[] = [];
  for (const u of getMentionableUsers()) {
    if (out.length >= 6) break;
    if (u.name.toLowerCase().includes(ql)) {
      out.push({ kind: 'user', id: u.id, name: u.name, sub: 'pessoa', icon: '@' });
    }
  }
  let boardCount = 0;
  for (const b of state.boards) {
    if (boardCount >= 8) break;
    if (b.id === state.activeBoardId || b.archived) continue;
    const name = b.name || 'Sem título';
    if (name.toLowerCase().includes(ql)) {
      out.push({ kind: 'board', id: b.id, name, sub: `${b.items.length} itens`, icon: '⊞' });
      boardCount++;
    }
  }
  return out;
}

let mentionMenu: {
  el: HTMLElement;
  list: HTMLElement;
  items: MentionCandidate[];
  index: number;
  onPick: (c: MentionCandidate) => void;
} | null = null;

function mentionMenuOpen(): boolean {
  return mentionMenu !== null;
}

function closeMentionMenu(): void {
  if (mentionMenu) {
    mentionMenu.el.remove();
    mentionMenu = null;
  }
}

/** Open (or refresh) the mention menu at a screen rect, filtered by `query`. */
function updateMentionMenu(rect: DOMRect, query: string, onPick: (c: MentionCandidate) => void): void {
  const items = getMentionCandidates(query);
  if (items.length === 0) { closeMentionMenu(); return; }

  if (!mentionMenu) {
    const el = document.createElement('div');
    el.className = 'mention-dropdown';
    const list = document.createElement('div');
    list.className = 'mention-list';
    el.appendChild(list);
    document.body.appendChild(el);
    mentionMenu = { el, list, items, index: 0, onPick };
  } else {
    mentionMenu.items = items;
    mentionMenu.onPick = onPick;
    if (mentionMenu.index >= items.length) mentionMenu.index = 0;
  }

  mentionMenu.el.style.left = `${rect.left}px`;
  mentionMenu.el.style.top = `${rect.bottom + 4}px`;
  renderMentionMenu();
}

function renderMentionMenu(): void {
  const m = mentionMenu;
  if (!m) return;
  m.list.innerHTML = '';
  m.items.forEach((c, i) => {
    const opt = document.createElement('div');
    opt.className = 'mention-option' + (i === m.index ? ' active' : '');
    const icon = document.createElement('span');
    icon.className = 'mention-option-icon';
    icon.textContent = c.icon;
    const name = document.createElement('span');
    name.className = 'mention-option-name';
    name.textContent = c.name;
    const sub = document.createElement('span');
    sub.className = 'mention-option-count';
    sub.textContent = c.sub;
    opt.append(icon, name, sub);
    opt.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); pickMention(i); });
    opt.addEventListener('mousemove', () => { if (m.index !== i) { m.index = i; highlightMention(); } });
    m.list.appendChild(opt);
  });
}

function highlightMention(): void {
  const m = mentionMenu;
  if (!m) return;
  const opts = m.list.querySelectorAll('.mention-option');
  opts.forEach((o, i) => o.classList.toggle('active', i === m.index));
  (opts[m.index] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
}

function pickMention(i: number): void {
  const m = mentionMenu;
  if (!m) return;
  const c = m.items[i];
  const cb = m.onPick;
  closeMentionMenu();
  cb(c);
}

/** Feed a keydown to the menu; returns true if the menu consumed the key. */
function mentionMenuKeydown(e: KeyboardEvent): boolean {
  const m = mentionMenu;
  if (!m) return false;
  switch (e.key) {
    case 'ArrowDown': m.index = (m.index + 1) % m.items.length; highlightMention(); e.preventDefault(); return true;
    case 'ArrowUp': m.index = (m.index - 1 + m.items.length) % m.items.length; highlightMention(); e.preventDefault(); return true;
    case 'Enter':
    case 'Tab': pickMention(m.index); e.preventDefault(); return true;
    case 'Escape': closeMentionMenu(); e.preventDefault(); return true;
  }
  return false;
}

/** Match a trailing "@query" token (no spaces) at the caret. */
function matchMentionToken(before: string): string | null {
  const match = before.match(/(?:^|\s)@([^\s@]*)$/);
  return match ? match[1] : null;
}

function handleMentionInput(input: HTMLTextAreaElement): void {
  const val = input.value;
  const cursor = input.selectionStart || 0;
  const before = val.slice(0, cursor);
  const query = matchMentionToken(before);
  if (query === null) { closeMentionMenu(); return; }

  updateMentionMenu(input.getBoundingClientRect(), query, (c) => {
    const atPos = cursor - query.length - 1; // index of the '@'
    const insert = '@' + c.name + ' ';
    input.value = val.slice(0, atPos) + insert + val.slice(cursor);
    const pos = atPos + insert.length;
    input.selectionStart = input.selectionEnd = pos;
    const tracked: ComposeMention[] = (input as any).__mentions || ((input as any).__mentions = []);
    if (!tracked.some(m => m.id === c.id && m.kind === c.kind)) tracked.push({ id: c.id, name: c.name, kind: c.kind });
    input.focus();
    input.dispatchEvent(new Event('input'));
  });
}

/** Route a comment-textarea keydown; returns true if the mention menu handled it. */
function handleMentionKeydown(e: KeyboardEvent): boolean {
  return mentionMenuKeydown(e);
}

function setupCommentSync(boardId: string) {
  unsubscribeComments();
  subscribeToComments(boardId, (type, itemId, comment) => {
    // Update badge on items
    if (currentView === 'board' && state.activeBoardId === boardId) {
      rerender();
    }
    // Forward to open popover if it has a handler
    const handler = (window as any).__commentPopoverHandler;
    if (handler) handler(type, itemId, comment);
  });
}

function setupBoardSync() {
  subscribeToBoardChanges((boardId, updatedBoard) => {
    const idx = state.boards.findIndex(b => b.id === boardId);
    if (idx < 0) return;

    // Merge: keep local viewport, update items/connections/name
    const local = state.boards[idx];
    local.items = updatedBoard.items;
    local.connections = updatedBoard.connections;
    local.name = updatedBoard.name;
    local.updatedAt = updatedBoard.updatedAt;

    saveState(state);

    // If this board is currently open, re-render
    if (currentView === 'board' && state.activeBoardId === boardId) {
      rerender();
      const nameEl = document.getElementById('board-name');
      if (nameEl) nameEl.textContent = local.name;
    }

    // If on home screen, refresh board list
    if (currentView === 'home') {
      refreshHome();
    }
  });
}

// --- Init ---

snapshot();
updateZoomLabel(getActiveBoard().viewport.zoom);
rerender();
showHomeScreen();

// --- Public View Mode ---

async function enterPublicView(token: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('boards')
    .select('id, name, data')
    .eq('public_token', token)
    .single();

  if (error) {
    console.error('[public-view] query error:', error.message, error.code);
    return false;
  }
  if (!data) return false;

  const board = (data as any).data as Board;
  board.id = (data as any).id;
  board.name = (data as any).name;

  // Compress inline images to IndexedDB for rendering
  const { compressToIdb } = await import('./boardStore');
  if (board.items) await compressToIdb(board.items);

  state.boards = [board];
  state.activeBoardId = board.id;
  currentBoardRole = 'viewer';
  isPublicView = true;
  currentView = 'board';

  loginScreen.style.display = 'none';
  homeScreen.classList.add('hidden');
  clearSelection();
  setViewport(board.viewport);
  updateZoomLabel(board.viewport.zoom);
  snapshot();
  rerender();

  // Update toolbar for public view
  const nameEl = document.getElementById('board-name');
  if (nameEl) nameEl.textContent = board.name;
  applyRoleRestrictions();

  // Hide toolbar elements for public viewer
  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.style.display = 'none';
  const toolbar = document.getElementById('toolbar');
  if (toolbar) {
    const hideIds = ['btn-home', 'btn-history', 'btn-share', 'btn-undo', 'btn-redo'];
    hideIds.forEach(id => {
      const el = toolbar.querySelector(`#${id}`);
      if (el) (el as HTMLElement).style.display = 'none';
    });
    const exportWrap = toolbar.querySelector('.export-dropdown-wrap');
    if (exportWrap) (exportWrap as HTMLElement).style.display = 'none';
    const importBtn = toolbar.querySelector('[title="Ctrl+O"]');
    if (importBtn) (importBtn as HTMLElement).style.display = 'none';
    const presenceAvatars = toolbar.querySelector('#presence-avatars');
    if (presenceAvatars) (presenceAvatars as HTMLElement).style.display = 'none';
  }

  return true;
}

(async () => {
  // Check for public view token in URL
  const params = new URLSearchParams(window.location.search);
  const viewToken = params.get('view');
  if (viewToken) {
    try {
      const ok = await enterPublicView(viewToken);
      if (ok) return;
    } catch (e) {
      console.warn('[public-view] failed:', e);
    }
  }

  try {
    const auth = await initAuth();
    if (auth.session && auth.profile) {
      currentProfile = auth.profile;
      loginScreen.style.display = 'none';
      await loadRemoteBoards();
      refreshHome();
      setupPresence();
      setupBoardSync();
    } else {
      showLoginScreen();
    }
  } catch (e) {
    console.warn('[init] Supabase unavailable, running offline:', e);
    showLoginScreen();
  }
})();

// --- Item interactions via event delegation on layer ---

layer.addEventListener('mousedown', (e: MouseEvent) => {
  if (e.button !== 0) return;
  if (isSpaceHeld()) return;

  // Stop following when user clicks on canvas
  if (getFollowingUserId()) {
    removeFollowBanner();
  }

  // In free-draw mode, let the canvas handler deal with it
  if (freeDrawMode) return;

  const target = e.target as HTMLElement;

  // If clicking a link in view mode, show preview popup instead of navigating
  const linkEl = target.closest('a') as HTMLAnchorElement | null;
  if (linkEl && !editingId) {
    e.preventDefault();
    e.stopPropagation();
    const parentItemEl = linkEl.closest('[data-item-id]') as HTMLElement | null;
    if (parentItemEl) showLinkPreview(linkEl, parentItemEl);
    return;
  }

  // Comment badge click
  const commentBadge = target.closest('.comment-badge') as HTMLElement | null;
  if (commentBadge) {
    e.stopPropagation();
    const itemEl = commentBadge.closest('[data-item-id]') as HTMLElement;
    const id = itemEl?.dataset.itemId;
    if (id && itemEl) showCommentPopover(itemEl, id);
    return;
  }

  // Image link button
  const imageLinkBtn = target.closest('.image-link-btn') as HTMLElement | null;
  if (imageLinkBtn) {
    e.stopPropagation();
    const itemEl = imageLinkBtn.closest('[data-item-id]') as HTMLElement;
    const id = itemEl?.dataset.itemId;
    if (id) {
      const item = findItem(id);
      if (item) {
        if (item.sourceUrl) {
          // Has link → show preview popup (like text links)
          showImageLinkPreview(imageLinkBtn, item);
        } else {
          // No link → prompt to add
          const url = prompt('URL do link da imagem:', '');
          if (url !== null && url.trim()) {
            item.sourceUrl = url.trim();
            commit();
            rerender();
          }
        }
      }
    }
    return;
  }

  const rotateEl = target.closest('.rotate-handle');
  const handleEl = target.closest('.resize-handle');
  const itemEl = target.closest('[data-item-id]') as HTMLElement | null;
  if (!itemEl) return;

  const id = itemEl.dataset.itemId!;
  const item = findItem(id);
  if (!item) return;

  // Rotation grip: start rotating around the item's center
  if (rotateEl && !isReadOnly() && !item.locked) {
    e.preventDefault();
    e.stopPropagation();
    if (!selectedIds.has(id)) selectOnly(id);
    const cx = item.position.x + item.size.w / 2;
    const cy = item.position.y + item.size.h / 2;
    const vp = getViewport();
    const rect = getCanvasRect();
    const bp = screenToBoard(e.clientX - rect.left, e.clientY - rect.top, vp);
    rotating = {
      id,
      centerX: cx, centerY: cy,
      startAngle: Math.atan2(bp.y - cy, bp.x - cx) * 180 / Math.PI,
      origRotation: item.rotation || 0,
    };
    syncSelection();
    return;
  }

  // Viewers can only select and view, not drag/resize/edit
  if (isReadOnly()) {
    selectOnly(id);
    syncSelection();
    return;
  }

  // Block interaction with dimmed items (tag filter active)
  if (activeTagFilters.size > 0) {
    const tags = item.tags || [];
    const matches = [...activeTagFilters].some(t => tags.includes(t));
    if (!matches) return; // dimmed — ignore click
  }

  // Connect mode: clicking items creates connections
  if (isConnectMode()) {
    e.stopPropagation();
    if (!connectingFromId) {
      connectingFromId = id;
      selectOnly(id);
      syncSelection();
    } else if (connectingFromId !== id) {
      // Create connection
      const board = getActiveBoard();
      if (!board.connections) board.connections = [];
      // Avoid duplicate connections
      const exists = board.connections.some(
        c => (c.fromId === connectingFromId && c.toId === id) ||
             (c.fromId === id && c.toId === connectingFromId)
      );
      if (!exists) {
        board.connections.push({ id: generateId(), fromId: connectingFromId!, toId: id });
        commit();
        rerender();
      }
      connectingFromId = null;
      connLayer.clearPreview();
    }
    return;
  }

  // Deselect any selected connection when clicking an item
  if (selectedConnId) {
    selectedConnId = null;
    updateConnections();
  }

  // Bring clicked item to front (unless locked or frame)
  if (!item.locked && item.type !== 'frame') item.zIndex = Date.now();

  if (handleEl) {
    if (item.locked) return;
    const corner = (handleEl as HTMLElement).dataset.corner as 'nw' | 'ne' | 'sw' | 'se' || 'se';
    const others: { id: string; origX: number; origY: number; origW: number; origH: number }[] = [];
    for (const sid of selectedIds) {
      if (sid === id) continue;
      const si = findItem(sid);
      if (si && !si.locked) {
        others.push({ id: sid, origX: si.position.x, origY: si.position.y, origW: si.size.w, origH: si.size.h });
      }
    }
    if (!selectedIds.has(id)) selectOnly(id);
    // Group anchor = bounding box of every item that will actually scale together
    // (dragged item + unlocked others), so multi-select resize pins the far edge
    // of the whole group instead of just the dragged item's own opposite corner.
    let bbox = {
      minX: item.position.x, minY: item.position.y,
      maxX: item.position.x + item.size.w, maxY: item.position.y + item.size.h,
    };
    for (const o of others) {
      bbox = {
        minX: Math.min(bbox.minX, o.origX), minY: Math.min(bbox.minY, o.origY),
        maxX: Math.max(bbox.maxX, o.origX + o.origW), maxY: Math.max(bbox.maxY, o.origY + o.origH),
      };
    }
    resizing = {
      id, corner,
      origX: item.position.x, origY: item.position.y,
      origW: item.size.w, origH: item.size.h,
      others,
      bbox,
    };
    for (const iframe of layer.querySelectorAll('.embed-iframe') as NodeListOf<HTMLElement>) {
      iframe.style.pointerEvents = 'none';
    }
    syncSelection();
    return;
  }

  // Embed: only the handle bar drags; clicking the iframe area does nothing (interaction goes to iframe)
  if (item.type === 'embed') {
    const embedHandle = (target as HTMLElement).closest('.embed-handle');
    if (!embedHandle) {
      if (!selectedIds.has(id)) { selectOnly(id); syncSelection(); }
      return;
    }
  }

  // Frame: only title bar drags the frame; clicking body starts lasso selection
  if (item.type === 'frame') {
    const titleEl = (target as HTMLElement).closest('.item-frame-title');
    if (!titleEl) {
      // Clicked frame body → start lasso for selecting items inside
      if (!e.shiftKey) clearSelection();
      syncSelection();
      const lassoEl = document.createElement('div');
      lassoEl.className = 'lasso-rect';
      lassoEl.style.display = 'none';
      canvasEl.appendChild(lassoEl);
      lasso = { startScreenX: e.clientX, startScreenY: e.clientY, el: lassoEl, moved: false };
      canvasEl.classList.add('lasso-active');
      return;
    }
  }

  // Selection logic
  let selectionChanged = false;

  if (e.shiftKey) {
    if (selectedIds.has(id)) {
      // Shift-click deselect: remove entire group
      const gid = item.groupId;
      if (gid) {
        for (const gi of getActiveBoard().items) {
          if (gi.groupId === gid) selectedIds.delete(gi.id);
        }
      } else {
        selectedIds.delete(id);
      }
    } else {
      selectedIds.add(id);
      expandSelectionToGroups();
    }
    selectionChanged = true;
  } else if (!selectedIds.has(id)) {
    selectOnly(id); // already expands groups
    selectionChanged = true;
  }

  // Don't start drag if the clicked item is locked
  if (item.locked) {
    if (selectionChanged) syncSelection();
    return;
  }

  // Start group drag
  const vp = getViewport();
  const rect = getCanvasRect();
  const boardPos = screenToBoard(e.clientX - rect.left, e.clientY - rect.top, vp);

  const origins = new Map<string, { x: number; y: number }>();
  for (const sid of selectedIds) {
    const si = findItem(sid);
    if (si && !si.locked) origins.set(sid, { x: si.position.x, y: si.position.y });
  }

  // If dragging a frame, also drag its children
  for (const sid of selectedIds) {
    const si = findItem(sid);
    if (si?.type === 'frame') {
      for (const child of getFrameChildren(si)) {
        if (!origins.has(child.id)) {
          origins.set(child.id, { x: child.position.x, y: child.position.y });
        }
      }
    }
  }

  dragging = { origins, anchorX: boardPos.x, anchorY: boardPos.y };

  // Disable iframe pointer-events during drag so they don't steal mousemove/mouseup
  for (const iframe of layer.querySelectorAll('.embed-iframe') as NodeListOf<HTMLElement>) {
    iframe.style.pointerEvents = 'none';
  }

  if (selectionChanged) syncSelection();
});

// --- Item context menu (right-click on items) ---

layer.addEventListener('contextmenu', (e: MouseEvent) => {
  e.preventDefault();
  const target = e.target as HTMLElement;
  const itemEl = target.closest('[data-item-id]') as HTMLElement | null;
  if (!itemEl) return;

  const id = itemEl.dataset.itemId!;
  const item = findItem(id);
  if (!item) return;

  // Viewers only get comment access via context menu
  if (isReadOnly()) {
    const count = getCommentCount(id);
    showContextMenu(e.clientX, e.clientY, [{
      label: count > 0 ? `Comentários (${count})` : 'Comentários',
      action: () => showCommentPopover(itemEl, id)
    }]);
    return;
  }

  if (!selectedIds.has(id)) {
    selectOnly(id);
    syncSelection();
  }

  const menuItems: { label: string; action: () => void; danger?: boolean }[] = [];

  if (item.type === 'image') {
    menuItems.push({
      label: item.sourceUrl ? 'Editar link' : 'Adicionar link',
      action: () => {
        const url = prompt(
          item.sourceUrl ? 'Editar ou limpar URL (vazio remove):' : 'URL do link da imagem:',
          item.sourceUrl || ''
        );
        if (url !== null) {
          item.sourceUrl = url.trim() || undefined;
          commit();
          rerender();
        }
      }
    });
    if (item.sourceUrl) {
      menuItems.push({
        label: 'Abrir link',
        action: () => window.open(item.sourceUrl!, '_blank', 'noopener,noreferrer')
      });
      menuItems.push({
        label: 'Remover link',
        action: () => {
          item.sourceUrl = undefined;
          commit();
          rerender();
        }
      });
    }
  }

  if (item.type === 'text') {
    menuItems.push({
      label: 'Editar',
      action: () => startEditing(id, itemEl)
    });
  }

  if (item.type === 'color') {
    menuItems.push({
      label: 'Mudar cor',
      action: () => openColorPicker(item, itemEl)
    });
    menuItems.push({
      label: 'Copiar HEX',
      action: () => {
        navigator.clipboard.writeText(item.content || '#cccccc');
      }
    });
  }

  if (item.type === 'link') {
    menuItems.push({
      label: 'Abrir link',
      action: () => window.open(item.content, '_blank', 'noopener,noreferrer')
    });
    menuItems.push({
      label: 'Editar URL',
      action: () => {
        const url = prompt('Nova URL:', item.content);
        if (url !== null && url.trim()) {
          item.content = url.trim();
          commit();
          rerender();
        }
      }
    });
    menuItems.push({
      label: 'Copiar URL',
      action: () => {
        navigator.clipboard.writeText(item.content);
      }
    });
  }

  if (item.type === 'note') {
    menuItems.push({
      label: 'Editar',
      action: () => startEditing(id, itemEl)
    });
    menuItems.push({
      label: 'Mudar cor',
      action: () => {
        const input = document.createElement('input');
        input.type = 'color';
        input.value = item.color || '#fff9c4';
        input.style.position = 'absolute';
        input.style.opacity = '0';
        input.style.pointerEvents = 'none';
        document.body.appendChild(input);

        input.addEventListener('input', () => {
          item.color = input.value;
          itemEl.style.backgroundColor = input.value;
        });
        input.addEventListener('change', () => {
          item.color = input.value;
          commit();
          rerender();
          input.remove();
        });
        input.addEventListener('blur', () => {
          setTimeout(() => input.remove(), 100);
        });
        input.click();
      }
    });
  }

  if (item.type === 'frame') {
    menuItems.push({
      label: 'Renomear',
      action: () => {
        const name = prompt('Nome do frame:', item.content || 'Frame');
        if (name !== null) {
          item.content = name.trim() || 'Frame';
          commit();
          rerender();
        }
      }
    });
    menuItems.push({
      label: 'Mudar cor',
      action: () => {
        const input = document.createElement('input');
        input.type = 'color';
        input.value = item.color || '#d8d4cc';
        input.style.position = 'absolute';
        input.style.opacity = '0';
        input.style.pointerEvents = 'none';
        document.body.appendChild(input);

        input.addEventListener('input', () => {
          item.color = input.value + '40';
          itemEl.style.backgroundColor = item.color;
        });
        input.addEventListener('change', () => {
          item.color = input.value + '40';
          commit();
          rerender();
          input.remove();
        });
        input.addEventListener('blur', () => {
          setTimeout(() => input.remove(), 100);
        });
        input.click();
      }
    });
    const children = getFrameChildren(item);
    if (children.length > 0) {
      menuItems.push({
        label: `Selecionar conteúdo (${children.length})`,
        action: () => {
          for (const child of children) selectedIds.add(child.id);
          syncSelection();
        }
      });
    }
    menuItems.push({
      label: 'Exportar como PNG',
      action: () => exportBoardAsPng(item)
    });
  }

  if (item.type === 'embed') {
    menuItems.push({
      label: 'Renomear',
      action: () => {
        const name = prompt('Título do embed:', item.sourceUrl || 'Embed HTML');
        if (name !== null) {
          item.sourceUrl = name.trim() || 'Embed HTML';
          commit();
          rerender();
        }
      }
    });
    menuItems.push({
      label: 'Substituir HTML',
      action: () => {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = '.html,.htm';
        inp.addEventListener('change', async () => {
          const file = inp.files?.[0];
          if (!file) return;
          const html = await file.text();
          const ref = await saveImage(html);
          item.content = ref;
          item.sourceUrl = file.name.replace(/\.\w+$/, '');
          commit();
          rerender();
        });
        inp.click();
      }
    });
  }

  if (item.type === 'board') {
    const subId = item.content;
    const sub = state.boards.find(b => b.id === subId);
    menuItems.push({
      label: 'Abrir sub-board',
      action: () => {
        if (subId && state.boards.some(b => b.id === subId)) {
          showBoardView(subId);
        }
      }
    });
    menuItems.push({
      label: 'Renomear',
      action: () => {
        const name = prompt('Nome do sub-board:', sub?.name || 'Sub-board');
        if (name !== null && sub) {
          sub.name = name.trim() || 'Sub-board';
          commit();
          rerender();
        }
      }
    });
  }

  // Layer order (z-index) — skip for frames (always background)
  if (item.type !== 'frame') {
    menuItems.push({
      label: 'Trazer para frente',
      action: () => {
        const maxZ = Math.max(...getActiveBoard().items.map(i => i.zIndex));
        for (const sid of selectedIds) {
          const si = findItem(sid);
          if (si && si.type !== 'frame') si.zIndex = maxZ + 1;
        }
        commit();
        rerender();
      }
    });
    menuItems.push({
      label: 'Enviar para trás',
      action: () => {
        const minZ = Math.min(...getActiveBoard().items.filter(i => i.type !== 'frame').map(i => i.zIndex));
        for (const sid of selectedIds) {
          const si = findItem(sid);
          if (si && si.type !== 'frame') si.zIndex = minZ - 1;
        }
        commit();
        rerender();
      }
    });
  }

  menuItems.push({
    label: 'Duplicar',
    action: () => duplicateSelected()
  });

  // Copy to another board
  const otherBoards = state.boards.filter(b => b.id !== state.activeBoardId && !b.archived);
  if (otherBoards.length > 0) {
    menuItems.push({
      label: 'Copiar para board →',
      action: () => {
        const boardMenu = otherBoards.map(b => ({
          label: b.name,
          action: () => {
            const itemsToCopy: BoardItem[] = [];
            for (const sid of selectedIds) {
              const src = findItem(sid);
              if (src) itemsToCopy.push(src);
            }
            if (itemsToCopy.length === 0) return;
            for (const src of itemsToCopy) {
              const clone = duplicateItem(src, 0);
              b.items.push(clone);
            }
            b.updatedAt = Date.now();
            save();
          }
        }));
        showContextMenu(e.clientX + 150, e.clientY, boardMenu);
      }
    });
  }

  // Alignment options when 2+ items selected
  if (selectedIds.size >= 2) {
    menuItems.push({
      label: 'Alinhar →',
      action: () => {
        const alignMenu: { label: string; action: () => void; separator?: boolean }[] = [
          // ── Alinhar ──
          { label: 'Alinhar à esquerda', action: () => alignItems('left') },
          { label: 'Alinhar à direita', action: () => alignItems('right') },
          { label: 'Alinhar ao topo', action: () => alignItems('top') },
          { label: 'Alinhar à base', action: () => alignItems('bottom') },
          // ── Centralizar ──
          { label: 'Centralizar horiz.', action: () => alignItems('center-h'), separator: true },
          { label: 'Centralizar vert.', action: () => alignItems('center-v') },
        ];
        // ── Distribuir (3+ itens) ──
        if (selectedIds.size >= 3) {
          alignMenu.push(
            { label: 'Distribuir horiz.', action: () => distributeItems('horizontal'), separator: true },
            { label: 'Distribuir vert.', action: () => distributeItems('vertical') },
          );
        }
        showContextMenu(e.clientX + 150, e.clientY, alignMenu);
      }
    });
  }

  // Auto-layout options when 2+ items selected
  if (selectedIds.size >= 2) {
    menuItems.push({
      label: 'Layout →',
      action: () => {
        const layoutMenu: { label: string; action: () => void; separator?: boolean }[] = [
          { label: 'Grid', action: () => layoutGrid() },
          { label: 'Empilhar horiz.', action: () => layoutStack('horizontal') },
          { label: 'Empilhar vert.', action: () => layoutStack('vertical') },
          { label: 'Quebrar em linhas', action: () => layoutWrap(), separator: true },
        ];
        showContextMenu(e.clientX + 150, e.clientY, layoutMenu);
      }
    });
  }

  // Group / Ungroup
  if (selectedIds.size >= 2) {
    const anyGrouped = [...selectedIds].some(sid => findItem(sid)?.groupId);
    if (anyGrouped) {
      menuItems.push({
        label: 'Desagrupar (Ctrl+Shift+G)',
        action: () => ungroupSelected()
      });
    }
    // Always offer group when 2+ selected (re-groups replace old groupId)
    menuItems.push({
      label: 'Agrupar (Ctrl+G)',
      action: () => groupSelected()
    });
  }

  menuItems.push({
    label: item.locked ? 'Desbloquear' : 'Bloquear',
    action: () => toggleLockSelected()
  });

  menuItems.push({
    label: 'Tags',
    action: () => openTagEditor()
  });

  {
    const count = getCommentCount(id);
    menuItems.push({
      label: count > 0 ? `Comentários (${count})` : 'Comentários',
      action: () => showCommentPopover(itemEl, id)
    });
  }

  menuItems.push({
    label: 'Excluir',
    action: () => {
      const board = getActiveBoard();
      // Clean up sub-boards owned by deleted board-type items
      for (const sid of selectedIds) {
        const it = findItem(sid);
        if (it?.type === 'board' && it.content) {
          const idx = state.boards.findIndex(b => b.id === it.content);
          if (idx >= 0) state.boards.splice(idx, 1);
        }
      }
      board.items = board.items.filter(i => !selectedIds.has(i.id));
      clearSelection();
      commit();
      rerender();
    },
    danger: true
  });

  showContextMenu(e.clientX, e.clientY, menuItems);
});

// --- Canvas background mousedown: lasso or deselect ---

const canvas = canvasEl;

canvas.addEventListener('contextmenu', (e: MouseEvent) => {
  e.preventDefault();
});

canvas.addEventListener('mousedown', (e: MouseEvent) => {
  const target = e.target as HTMLElement;
  // In free-draw mode, allow drawing over items (skip item check)
  if (e.button !== 0 || isSpaceHeld()) return;
  if (!freeDrawMode && target.closest('[data-item-id]')) return;

  // Freehand draw mode
  if (freeDrawMode) {
    const vp = getViewport();
    const rect = getCanvasRect();
    const boardPos = screenToBoard(e.clientX - rect.left, e.clientY - rect.top, vp);

    // Create a temporary SVG overlay on the canvas for live preview
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.style.position = 'absolute';
    svg.style.left = '0';
    svg.style.top = '0';
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.overflow = 'visible';
    svg.style.pointerEvents = 'none';
    svg.style.zIndex = '9999';
    canvas.appendChild(svg);

    const pathEl = document.createElementNS(svgNS, 'path');
    pathEl.setAttribute('fill', 'none');
    pathEl.setAttribute('stroke', freeDrawColor);
    pathEl.setAttribute('stroke-width', String(freeDrawWidth / vp.zoom));
    pathEl.setAttribute('stroke-linecap', 'round');
    pathEl.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(pathEl);

    freeDrawing = {
      points: [boardPos],
      svgEl: svg,
      pathEl,
    };

    // Build initial path in screen coords via transform
    const screenPt = boardToScreen(boardPos.x, boardPos.y, vp);
    pathEl.setAttribute('d', `M${screenPt.x},${screenPt.y}`);
    return;
  }

  // Frame draw mode
  if (frameDrawMode) {
    if (framePlacePreset) {
      // Preset mode: single click places a frame with fixed dimensions
      const vp = getViewport();
      const canvasRect = getCanvasRect();
      const sx = e.clientX - canvasRect.left;
      const sy = e.clientY - canvasRect.top;
      const boardPos = screenToBoard(sx, sy, vp);
      // Center the frame on the click point
      const fw = framePlacePreset.w;
      const fh = framePlacePreset.h;
      const item = createItem('frame', { x: boardPos.x - fw / 2, y: boardPos.y - fh / 2 }, 'Frame');
      item.size = { w: fw, h: fh };
      item.zIndex = 1;
      getActiveBoard().items.push(item);
      selectOnly(item.id);
      commit();
      rerender();
      exitFrameDrawMode();
      return;
    }
    // Free-draw mode: drag to define frame bounds
    const previewEl = document.createElement('div');
    previewEl.className = 'frame-draw-preview';
    previewEl.style.display = 'none';
    canvas.appendChild(previewEl);
    frameDrawing = {
      startScreenX: e.clientX,
      startScreenY: e.clientY,
      el: previewEl,
      moved: false,
    };
    return;
  }

  const lassoEl = document.createElement('div');
  lassoEl.className = 'lasso-rect';
  lassoEl.style.display = 'none';
  canvas.appendChild(lassoEl);

  lasso = {
    startScreenX: e.clientX,
    startScreenY: e.clientY,
    el: lassoEl,
    moved: false,
  };
});

// --- Connection preview on mousemove ---

layer.addEventListener('mousemove', (e: MouseEvent) => {
  // Broadcast cursor position to other users
  if (currentProfile) {
    const vp = getViewport();
    const rect = getCanvasRect();
    const bp = screenToBoard(e.clientX - rect.left, e.clientY - rect.top, vp);
    broadcastCursorPos(bp.x, bp.y);
  }

  if (isConnectMode() && connectingFromId) {
    const fromItem = findItem(connectingFromId);
    if (fromItem) {
      const vp = getViewport();
      const rect = getCanvasRect();
      const boardPos = screenToBoard(e.clientX - rect.left, e.clientY - rect.top, vp);
      connLayer.updatePreview(fromItem, boardPos);
    }
  }
});

// --- Drag, Resize & Lasso move ---

window.addEventListener('mousemove', (e: MouseEvent) => {
  if (dragging) {
    const vp = getViewport();
    const rect = getCanvasRect();
    const boardPos = screenToBoard(e.clientX - rect.left, e.clientY - rect.top, vp);
    let dx = boardPos.x - dragging.anchorX;
    let dy = boardPos.y - dragging.anchorY;

    // Find primary dragged item for snap calculation
    const primaryId = selectedIds.values().next().value as string;
    const primaryItem = findItem(primaryId);
    if (primaryItem) {
      const primaryOrigin = dragging.origins.get(primaryId);
      if (primaryOrigin) {
        const tentative = {
          x: primaryOrigin.x + dx,
          y: primaryOrigin.y + dy,
          w: primaryItem.size.w,
          h: primaryItem.size.h,
        };
        const snap = calcSnap(new Set(dragging.origins.keys()), getActiveBoard().items, tentative);
        dx += snap.dx;
        dy += snap.dy;
        drawGuides(snap.guides, vp, rect);
      }
    }

    for (const [sid, origin] of dragging.origins) {
      const si = findItem(sid);
      if (si) {
        si.position.x = origin.x + dx;
        si.position.y = origin.y + dy;
        updateItemPosition(layer, si.id, si.position.x, si.position.y);
      }
    }
    updateConnections();
    // Reposition selection toolbar while dragging
    if (selectionToolbar && selectionToolbarItemId) {
      const stItemEl = layer.querySelector(`[data-item-id="${selectionToolbarItemId}"]`) as HTMLElement | null;
      if (stItemEl) positionToolbar(selectionToolbar, stItemEl);
    }
  }

  if (rotating) {
    const vp = getViewport();
    const rect = getCanvasRect();
    const bp = screenToBoard(e.clientX - rect.left, e.clientY - rect.top, vp);
    const item = findItem(rotating.id);
    if (item) {
      const ang = Math.atan2(bp.y - rotating.centerY, bp.x - rotating.centerX) * 180 / Math.PI;
      let rot = rotating.origRotation + (ang - rotating.startAngle);
      // Shift snaps to 15° increments
      if (e.shiftKey) rot = Math.round(rot / 15) * 15;
      // Normalise to (-180, 180]
      rot = ((rot % 360) + 360) % 360;
      if (rot > 180) rot -= 360;
      item.rotation = rot;
      const el = layer.querySelector(`[data-item-id="${item.id}"]`) as HTMLElement | null;
      if (el) el.style.transform = rot ? `rotate(${rot}deg)` : '';
      if (selectionToolbar && selectionToolbarItemId === rotating.id) {
        const stItemEl = layer.querySelector(`[data-item-id="${selectionToolbarItemId}"]`) as HTMLElement | null;
        if (stItemEl) positionToolbar(selectionToolbar, stItemEl);
      }
    }
  }

  if (resizing) {
    const vp = getViewport();
    const rect = getCanvasRect();
    const bp = screenToBoard(e.clientX - rect.left, e.clientY - rect.top, vp);
    const item = findItem(resizing.id);
    if (item) {
      const { corner, origX, origY, origW, origH, bbox } = resizing;

      // ── Rotated single-item resize ──
      // When the item is rotated and resized on its own, work in the item's
      // local (unrotated) frame so the anchor corner stays pinned in world space.
      if (item.rotation && resizing.others.length === 0) {
        const rad = item.rotation * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const MIN_W1 = item.type === 'image' ? 60 : 80;
        const MIN_H1 = item.type === 'image' ? 40 : 50;
        const lock = item.type === 'image' && !e.shiftKey;
        // Signs of the anchor corner (opposite the dragged corner) in local space.
        const ax = (corner === 'se' || corner === 'ne') ? -1 : 1;
        const ay = (corner === 'se' || corner === 'sw') ? -1 : 1;
        // Fixed anchor corner in world coords (from the pre-drag geometry).
        const c0x = origX + origW / 2, c0y = origY + origH / 2;
        const alx = ax * origW / 2, aly = ay * origH / 2;
        const anchorWX = c0x + (alx * cos - aly * sin);
        const anchorWY = c0y + (alx * sin + aly * cos);
        // Pointer in local frame relative to the anchor corner.
        const dpx = bp.x - anchorWX, dpy = bp.y - anchorWY;
        let localX = dpx * cos + dpy * sin;   // R(-θ)
        let localY = -dpx * sin + dpy * cos;
        // Dragged corner lies at (-ax, -ay) direction from the anchor.
        let newW = Math.max(MIN_W1, localX * -ax);
        let newH = Math.max(MIN_H1, localY * -ay);
        if (lock) {
          const s = Math.max(newW / origW, newH / origH);
          newW = origW * s; newH = origH * s;
        }
        // New center keeps the anchor corner fixed.
        const nalx = ax * newW / 2, naly = ay * newH / 2;
        const ncx = anchorWX - (nalx * cos - naly * sin);
        const ncy = anchorWY - (nalx * sin + naly * cos);
        const newX = ncx - newW / 2;
        const newY = ncy - newH / 2;
        item.position.x = newX;
        item.position.y = newY;
        item.size.w = newW;
        item.size.h = newH;
        updateItemPosition(layer, item.id, newX, newY);
        updateItemSize(layer, item.id, newW, newH);
        if (selectionToolbar && selectionToolbarItemId === resizing.id) {
          const stItemEl = layer.querySelector(`[data-item-id="${selectionToolbarItemId}"]`) as HTMLElement | null;
          if (stItemEl) positionToolbar(selectionToolbar, stItemEl);
        }
        return;
      }
      const MIN_W = item.type === 'image' ? 60 : 80;
      const MIN_H = item.type === 'image' ? 40 : 50;
      const lockRatio = item.type === 'image' && !e.shiftKey;

      // Anchor = opposite corner of the WHOLE selected group's bounding box (not
      // just the dragged item's own corner), so the far edge of the group stays
      // pinned instead of drifting to the dragged item's edge when it isn't the
      // outermost item in the selection.
      const anchorX = (corner === 'se' || corner === 'ne') ? bbox.minX : bbox.maxX;
      const anchorY = (corner === 'se' || corner === 'sw') ? bbox.minY : bbox.maxY;

      // The dragged item's own corner (pre-drag) that the cursor is driving.
      const dragX0 = (corner === 'se' || corner === 'ne') ? origX + origW : origX;
      const dragY0 = (corner === 'se' || corner === 'sw') ? origY + origH : origY;

      let scaleX = dragX0 !== anchorX ? (bp.x - anchorX) / (dragX0 - anchorX) : 1;
      let scaleY = dragY0 !== anchorY ? (bp.y - anchorY) / (dragY0 - anchorY) : 1;

      if (lockRatio) {
        const s = Math.abs(scaleX - 1) >= Math.abs(scaleY - 1) ? scaleX : scaleY;
        scaleX = s; scaleY = s;
      }

      // Never let the dragged item shrink past its minimum size.
      const minScaleX = MIN_W / origW;
      const minScaleY = MIN_H / origH;
      if (scaleX < minScaleX) scaleX = minScaleX;
      if (scaleY < minScaleY) scaleY = minScaleY;
      if (lockRatio) {
        const s = Math.max(scaleX, scaleY);
        scaleX = s; scaleY = s;
      }

      const newX = anchorX + (origX - anchorX) * scaleX;
      const newY = anchorY + (origY - anchorY) * scaleY;
      const newW = origW * scaleX;
      const newH = origH * scaleY;

      item.position.x = newX;
      item.position.y = newY;
      item.size.w = newW;
      item.size.h = newH;
      updateItemPosition(layer, item.id, newX, newY);
      updateItemSize(layer, item.id, newW, newH);

      // Scale other selected items using the same group anchor + scale factors.
      if (resizing.others.length > 0) {
        for (const o of resizing.others) {
          const si = findItem(o.id);
          if (!si) continue;
          si.size.w = Math.max(20, o.origW * scaleX);
          si.size.h = Math.max(20, o.origH * scaleY);
          si.position.x = anchorX + (o.origX - anchorX) * scaleX;
          si.position.y = anchorY + (o.origY - anchorY) * scaleY;
          updateItemPosition(layer, si.id, si.position.x, si.position.y);
          updateItemSize(layer, si.id, si.size.w, si.size.h);
        }
      }

      // Reposition selection toolbar while resizing
      if (selectionToolbar && selectionToolbarItemId === resizing.id) {
        const stItemEl = layer.querySelector(`[data-item-id="${selectionToolbarItemId}"]`) as HTMLElement | null;
        if (stItemEl) positionToolbar(selectionToolbar, stItemEl);
      }
    }
  }

  // Freehand draw preview
  if (freeDrawing) {
    const vp = getViewport();
    const rect = getCanvasRect();
    const boardPos = screenToBoard(e.clientX - rect.left, e.clientY - rect.top, vp);
    freeDrawing.points.push(boardPos);

    // Rebuild path in screen coords for the overlay
    const screenPoints = freeDrawing.points.map(p => boardToScreen(p.x, p.y, vp));
    if (screenPoints.length >= 2) {
      let d = `M${screenPoints[0].x},${screenPoints[0].y}`;
      for (let i = 0; i < screenPoints.length - 1; i++) {
        const p0 = screenPoints[i];
        const p1 = screenPoints[i + 1];
        const mx = (p0.x + p1.x) / 2;
        const my = (p0.y + p1.y) / 2;
        d += `Q${p0.x},${p0.y},${mx},${my}`;
      }
      const last = screenPoints[screenPoints.length - 1];
      d += `L${last.x},${last.y}`;
      freeDrawing.pathEl.setAttribute('d', d);
    }
  }

  // Frame draw preview
  if (frameDrawing) {
    const dx = e.clientX - frameDrawing.startScreenX;
    const dy = e.clientY - frameDrawing.startScreenY;

    if (!frameDrawing.moved && (Math.abs(dx) > LASSO_THRESHOLD || Math.abs(dy) > LASSO_THRESHOLD)) {
      frameDrawing.moved = true;
      frameDrawing.el.style.display = 'block';
    }

    if (frameDrawing.moved) {
      const canvasRect = getCanvasRect();
      const x1 = frameDrawing.startScreenX - canvasRect.left;
      const y1 = frameDrawing.startScreenY - canvasRect.top;
      const x2 = e.clientX - canvasRect.left;
      const y2 = e.clientY - canvasRect.top;
      frameDrawing.el.style.left = `${Math.min(x1, x2)}px`;
      frameDrawing.el.style.top = `${Math.min(y1, y2)}px`;
      frameDrawing.el.style.width = `${Math.abs(x2 - x1)}px`;
      frameDrawing.el.style.height = `${Math.abs(y2 - y1)}px`;
    }
  }

  // Connection drag-to-reconnect preview
  if (reconnecting) {
    const vp = getViewport();
    const rect = getCanvasRect();
    const boardPos = screenToBoard(e.clientX - rect.left, e.clientY - rect.top, vp);
    const fixedItem = findItem(reconnecting.fixedId);
    if (fixedItem) {
      // Show preview line from fixed item to cursor
      if (reconnecting.end === 'to') {
        connLayer.updatePreview(fixedItem, boardPos);
      } else {
        // Dragging 'from' end: preview from cursor to fixed item
        // We create a temp preview using the fixed item as "from" (direction doesn't matter much for preview)
        connLayer.updatePreview(fixedItem, boardPos);
      }
    }
  }

  if (lasso) {
    const dx = e.clientX - lasso.startScreenX;
    const dy = e.clientY - lasso.startScreenY;

    if (!lasso.moved && (Math.abs(dx) > LASSO_THRESHOLD || Math.abs(dy) > LASSO_THRESHOLD)) {
      lasso.moved = true;
      lasso.el.style.display = 'block';
      canvas.classList.add('lasso-active');
    }

    if (lasso.moved) {
      const canvasRect = getCanvasRect();
      const x1 = lasso.startScreenX - canvasRect.left;
      const y1 = lasso.startScreenY - canvasRect.top;
      const x2 = e.clientX - canvasRect.left;
      const y2 = e.clientY - canvasRect.top;

      const left = Math.min(x1, x2);
      const top = Math.min(y1, y2);
      const width = Math.abs(x2 - x1);
      const height = Math.abs(y2 - y1);

      lasso.el.style.left = `${left}px`;
      lasso.el.style.top = `${top}px`;
      lasso.el.style.width = `${width}px`;
      lasso.el.style.height = `${height}px`;

      const vp = getViewport();
      const boardTL = screenToBoard(left, top, vp);
      const boardBR = screenToBoard(left + width, top + height, vp);

      const lassoRect = {
        x1: boardTL.x,
        y1: boardTL.y,
        x2: boardBR.x,
        y2: boardBR.y,
      };

      if (!e.shiftKey) clearSelection();

      const board = getActiveBoard();
      for (const item of board.items) {
        // Skip dimmed items (tag filter active)
        if (activeTagFilters.size > 0) {
          const tags = item.tags || [];
          const matches = [...activeTagFilters].some(t => tags.includes(t));
          if (!matches) continue;
        }

        const ix1 = item.position.x;
        const iy1 = item.position.y;
        const ix2 = item.position.x + item.size.w;
        const iy2 = item.position.y + item.size.h;

        const overlaps =
          ix1 < lassoRect.x2 &&
          ix2 > lassoRect.x1 &&
          iy1 < lassoRect.y2 &&
          iy2 > lassoRect.y1;

        if (overlaps) {
          selectedIds.add(item.id);
        } else if (!e.shiftKey) {
          selectedIds.delete(item.id);
        }
      }

      // If any item in a group was lassoed, select the full group
      expandSelectionToGroups();

      syncSelection();
    }
  }
});

window.addEventListener('mouseup', (e: MouseEvent) => {
  if (dragging) {
    dragging = null;
    clearGuides();
    // Restore iframe pointer-events based on selection
    for (const el of layer.querySelectorAll('.item-embed') as NodeListOf<HTMLElement>) {
      const iframe = el.querySelector('.embed-iframe') as HTMLElement | null;
      if (iframe) iframe.style.pointerEvents = el.classList.contains('selected') ? 'auto' : 'none';
    }
    commit();
  }

  if (rotating) {
    rotating = null;
    commit();
    updateConnections();
  }

  if (resizing) {
    resizing = null;
    // Restore iframe pointer-events after resize too
    for (const el of layer.querySelectorAll('.item-embed') as NodeListOf<HTMLElement>) {
      const iframe = el.querySelector('.embed-iframe') as HTMLElement | null;
      if (iframe) iframe.style.pointerEvents = el.classList.contains('selected') ? 'auto' : 'none';
    }
    commit();
  }

  // Freehand draw completion
  if (freeDrawing) {
    freeDrawing.svgEl.remove();
    const pts = freeDrawing.points;
    freeDrawing = null;

    if (pts.length >= 2) {
      // Compute bounding box
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      // Add padding for stroke width
      const pad = freeDrawWidth / 2 + 2;
      minX -= pad; minY -= pad; maxX += pad; maxY += pad;
      const w = maxX - minX;
      const h = maxY - minY;

      if (w > 2 && h > 2) {
        // Normalize points relative to bounding box
        const relPts = pts.map(p => ({ x: p.x - minX, y: p.y - minY }));
        const pathD = pointsToSvgPath(relPts);

        const item = createItem('draw', { x: minX, y: minY });
        item.content = pathD;
        item.size = { w, h };
        item.color = freeDrawColor;
        item.strokeWidth = freeDrawWidth;
        getActiveBoard().items.push(item);
        selectOnly(item.id);
        commit();
        rerender();
      }
    }
    // Stay in draw mode for continuous drawing
    return;
  }

  // Frame draw completion
  if (frameDrawing) {
    const wasMoved = frameDrawing.moved;
    frameDrawing.el.remove();

    if (wasMoved) {
      const vp = getViewport();
      const canvasRect = getCanvasRect();
      const x1 = frameDrawing.startScreenX - canvasRect.left;
      const y1 = frameDrawing.startScreenY - canvasRect.top;
      const x2 = e.clientX - canvasRect.left;
      const y2 = e.clientY - canvasRect.top;

      const boardTL = screenToBoard(Math.min(x1, x2), Math.min(y1, y2), vp);
      const boardBR = screenToBoard(Math.max(x1, x2), Math.max(y1, y2), vp);
      const w = boardBR.x - boardTL.x;
      const h = boardBR.y - boardTL.y;

      if (w > 30 && h > 30) {
        const item = createItem('frame', { x: boardTL.x, y: boardTL.y }, 'Frame');
        item.size = { w, h };
        item.zIndex = 1; // Always behind
        getActiveBoard().items.push(item);
        selectOnly(item.id);
        commit();
        rerender();
      }
    }

    frameDrawing = null;
    exitFrameDrawMode();
  }

  // Connection drag-to-reconnect completion
  if (reconnecting) {
    // Use elementsFromPoint to find item under cursor (SVG might be on top)
    const elements = document.elementsFromPoint(e.clientX, e.clientY);
    let targetId: string | undefined;
    for (const el of elements) {
      const itemEl = (el as HTMLElement).closest?.('[data-item-id]') as HTMLElement | null;
      if (itemEl) {
        targetId = itemEl.dataset.itemId;
        break;
      }
    }

    const board = getActiveBoard();
    const conn = board.connections?.find(c => c.id === reconnecting!.connId);

    if (conn && targetId && targetId !== reconnecting.fixedId) {
      // Reconnect to new item
      if (reconnecting.end === 'from') {
        conn.fromId = targetId;
      } else {
        conn.toId = targetId;
      }
      selectedConnId = null;
      commit();
      rerender();
    } else if (conn && !targetId) {
      // Dropped on empty space — remove connection
      board.connections = board.connections.filter(c => c.id !== reconnecting!.connId);
      selectedConnId = null;
      commit();
      rerender();
    }

    connLayer.clearPreview();
    reconnecting = null;
  }

  if (lasso) {
    const wasMoved = lasso.moved;
    lasso.el.remove();
    canvas.classList.remove('lasso-active');
    lasso = null;

    if (!wasMoved) {
      if (selectedIds.size > 0 && !e.shiftKey) {
        clearSelection();
        syncSelection();
      }
    }
  }
});

// --- Rich text editing ---

const FONT_SIZES = [10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48];

function getCurrentFontSize(contentDiv: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 14;
  const node = sel.focusNode;
  const el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node as HTMLElement;
  if (!el || !contentDiv.contains(el)) return 14;
  return Math.round(parseFloat(getComputedStyle(el).fontSize));
}

function getCurrentTextColor(contentDiv: HTMLElement): string {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return '#1a1a1a';
  const node = sel.focusNode;
  const el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node as HTMLElement;
  if (!el || !contentDiv.contains(el)) return '#1a1a1a';
  return getComputedStyle(el).color;
}

function rgbToHex(rgb: string): string {
  if (rgb.startsWith('#')) return rgb;
  const match = rgb.match(/\d+/g);
  if (!match || match.length < 3) return '#1a1a1a';
  const r = parseInt(match[0]);
  const g = parseInt(match[1]);
  const b = parseInt(match[2]);
  return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
}

function applyFontSize(contentDiv: HTMLElement, size: number): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;

  document.execCommand('fontSize', false, '7');

  const fonts = contentDiv.querySelectorAll('font[size="7"]');
  const newSpans: HTMLElement[] = [];
  fonts.forEach(font => {
    const span = document.createElement('span');
    span.style.fontSize = `${size}px`;
    while (font.firstChild) span.appendChild(font.firstChild);
    font.replaceWith(span);
    newSpans.push(span);
  });

  if (newSpans.length > 0) {
    sel.removeAllRanges();
    const range = document.createRange();
    const first = newSpans[0];
    const last = newSpans[newSpans.length - 1];
    range.setStart(first, 0);
    range.setEnd(last, last.childNodes.length);
    sel.addRange(range);
  }
  return true;
}

function changeFontSize(contentDiv: HTMLElement, direction: number, sizeLabel: HTMLElement) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;

  const current = getCurrentFontSize(contentDiv);
  let idx = FONT_SIZES.findIndex(s => s >= current);
  if (idx === -1) idx = FONT_SIZES.length - 1;
  const newIdx = Math.max(0, Math.min(FONT_SIZES.length - 1, idx + direction));
  const newSize = FONT_SIZES[newIdx];
  if (applyFontSize(contentDiv, newSize)) {
    sizeLabel.textContent = String(newSize);
  }
}

function cleanContentHtml(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  const fonts = div.querySelectorAll('font');
  fonts.forEach(font => {
    const span = document.createElement('span');
    if (font.hasAttribute('size')) {
      const map: Record<string, string> = { '1':'10px','2':'13px','3':'16px','4':'18px','5':'24px','6':'32px','7':'48px' };
      span.style.fontSize = map[font.getAttribute('size')!] || '16px';
    } else if (font.style.fontSize) {
      // Preserve inline fontSize set by heading presets
      span.style.fontSize = font.style.fontSize;
    }
    if (font.hasAttribute('color')) span.style.color = font.getAttribute('color')!;
    else if (font.style.color) span.style.color = font.style.color;
    // Preserve other inline styles (font-weight, etc.)
    if (font.style.fontWeight) span.style.fontWeight = font.style.fontWeight;
    while (font.firstChild) span.appendChild(font.firstChild);
    font.replaceWith(span);
  });
  const links = div.querySelectorAll('a');
  links.forEach(a => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
  return div.innerHTML;
}

function svgIcon(paths: string): string {
  return `<svg viewBox="0 0 16 16" width="14" height="14"><path d="${paths}" /></svg>`;
}

function createEditToolbar(contentDiv: HTMLElement, editItem?: import('./types').BoardItem, itemEl?: HTMLElement): HTMLElement {
  const toolbar = document.createElement('div');
  toolbar.className = 'edit-toolbar';

  const preventBlur = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); };

  const createBtn = (html: string, title: string, extra: string, onClick: () => void) => {
    const btn = document.createElement('button');
    btn.className = `edit-toolbar-btn ${extra}`.trim();
    btn.innerHTML = html;
    btn.title = title;
    btn.addEventListener('mousedown', (e) => {
      preventBlur(e);
      onClick();
      updateToolbarState();
    });
    return btn;
  };

  const createSep = () => {
    const sep = document.createElement('span');
    sep.className = 'edit-toolbar-sep';
    return sep;
  };

  const sizeLabel = document.createElement('span');
  sizeLabel.className = 'edit-toolbar-size';
  sizeLabel.textContent = String(getCurrentFontSize(contentDiv));

  const sizeDown = createBtn('−', 'Diminuir fonte', '', () => changeFontSize(contentDiv, -1, sizeLabel));
  const sizeUp  = createBtn('+', 'Aumentar fonte', '', () => changeFontSize(contentDiv, 1, sizeLabel));

  toolbar.append(sizeDown, sizeLabel, sizeUp, createSep());

  const boldBtn = createBtn('<b>B</b>', 'Negrito (Ctrl+B)', '', () => document.execCommand('bold'));
  const italicBtn = createBtn('<i>I</i>', 'Itálico (Ctrl+I)', '', () => document.execCommand('italic'));

  const linkBtn = createBtn(
    svgIcon('M6.5 11.5l3-3 M8.5 13.5a3 3 0 0 1 0-4.24l1.42-1.42a3 3 0 0 1 4.24 4.24l-.7.7 M7.5 2.5a3 3 0 0 1 4.24 0l1.42 1.42a3 3 0 0 1 0 4.24l-.7.7 M9.5 4.5l-3 3'),
    'Link (Ctrl+K)', '', () => {
      const sel = window.getSelection();
      const hasLink = sel && !sel.isCollapsed && sel.focusNode
        && (sel.focusNode as HTMLElement).closest?.('a');
      if (hasLink) {
        document.execCommand('unlink');
      } else {
        const url = prompt('URL:');
        if (url) {
          document.execCommand('createLink', false, url);
          const links = contentDiv.querySelectorAll('a:not([target])');
          links.forEach(a => {
            a.setAttribute('target', '_blank');
            a.setAttribute('rel', 'noopener noreferrer');
          });
        }
      }
    }
  );

  // Text color button
  const colorBtn = document.createElement('button');
  colorBtn.className = 'edit-toolbar-btn edit-toolbar-color-btn';
  colorBtn.title = 'Cor do texto';
  colorBtn.innerHTML = svgIcon('M2 14h12 M4 2l4 10 M12 2l-4 10');
  const colorIndicator = document.createElement('span');
  colorIndicator.className = 'color-indicator';
  colorIndicator.style.backgroundColor = getCurrentTextColor(contentDiv);
  colorBtn.appendChild(colorIndicator);

  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = rgbToHex(getCurrentTextColor(contentDiv));
  colorInput.style.position = 'absolute';
  colorInput.style.opacity = '0';
  colorInput.style.width = '0';
  colorInput.style.height = '0';
  colorInput.style.pointerEvents = 'none';
  colorBtn.appendChild(colorInput);

  colorBtn.addEventListener('mousedown', (e) => {
    preventBlur(e);
    colorInput.click();
  });
  colorInput.addEventListener('input', () => {
    document.execCommand('foreColor', false, colorInput.value);
    colorIndicator.style.backgroundColor = colorInput.value;
  });
  colorInput.addEventListener('change', () => {
    document.execCommand('foreColor', false, colorInput.value);
    colorIndicator.style.backgroundColor = colorInput.value;
  });

  toolbar.append(boldBtn, italicBtn, linkBtn, colorBtn, createSep());

  const alignLeft   = createBtn(svgIcon('M1 2h14 M1 6h8 M1 10h12 M1 14h6'), 'Alinhar à esquerda', '', () => document.execCommand('justifyLeft'));
  const alignCenter = createBtn(svgIcon('M1 2h14 M4 6h8 M2 10h12 M5 14h6'), 'Centralizar', '', () => document.execCommand('justifyCenter'));
  const alignRight  = createBtn(svgIcon('M1 2h14 M7 6h8 M3 10h12 M9 14h6'), 'Alinhar à direita', '', () => document.execCommand('justifyRight'));

  toolbar.append(alignLeft, alignCenter, alignRight);

  // ── Background color & transparent (text items only) ──
  if (editItem && itemEl && editItem.type === 'text') {
    toolbar.appendChild(createSep());

    // Background color button
    const bgBtn = document.createElement('button');
    bgBtn.className = 'edit-toolbar-btn edit-toolbar-bg-btn';
    bgBtn.title = 'Cor do fundo';
    bgBtn.innerHTML = svgIcon('M1 1h14v14H1z M4 5h8 M4 8h8 M4 11h5');
    const bgIndicator = document.createElement('span');
    bgIndicator.className = 'bg-color-indicator';
    bgIndicator.style.backgroundColor = (editItem.color && editItem.color !== 'transparent') ? editItem.color : '#ffffff';
    bgBtn.appendChild(bgIndicator);

    const bgInput = document.createElement('input');
    bgInput.type = 'color';
    bgInput.value = (editItem.color && editItem.color !== 'transparent') ? rgbToHex(editItem.color) : '#ffffff';
    bgInput.style.position = 'absolute';
    bgInput.style.opacity = '0';
    bgInput.style.width = '0';
    bgInput.style.height = '0';
    bgInput.style.pointerEvents = 'none';
    bgBtn.appendChild(bgInput);

    bgBtn.addEventListener('mousedown', (e) => {
      preventBlur(e);
      bgInput.click();
    });

    const applyBg = (color: string) => {
      editItem.color = color;
      itemEl.style.background = '';
      itemEl.style.backgroundColor = color;
      itemEl.style.border = '';
      itemEl.style.boxShadow = '';
      bgIndicator.style.backgroundColor = color;
      transparentBtn.classList.remove('transparent-active');
      commit();
    };

    bgInput.addEventListener('input', () => applyBg(bgInput.value));
    bgInput.addEventListener('change', () => applyBg(bgInput.value));

    // Transparent background button
    const transparentBtn = document.createElement('button');
    transparentBtn.className = `edit-toolbar-btn${editItem.color === 'transparent' ? ' transparent-active' : ''}`;
    transparentBtn.title = 'Fundo transparente';
    transparentBtn.innerHTML = svgIcon('M1 1h14v14H1z M1 1l14 14 M15 1L1 15');
    transparentBtn.addEventListener('mousedown', (e) => {
      preventBlur(e);
      if (editItem.color === 'transparent') {
        // Restore to default
        editItem.color = undefined;
        itemEl.style.background = '';
        itemEl.style.backgroundColor = '';
        itemEl.style.border = '';
        itemEl.style.boxShadow = '';
        transparentBtn.classList.remove('transparent-active');
        bgIndicator.style.backgroundColor = '#ffffff';
        bgInput.value = '#ffffff';
      } else {
        editItem.color = 'transparent';
        itemEl.style.background = 'transparent';
        itemEl.style.border = 'none';
        itemEl.style.boxShadow = 'none';
        transparentBtn.classList.add('transparent-active');
      }
      commit();
    });

    toolbar.append(bgBtn, transparentBtn);
  }

  // ── Heading presets ──
  toolbar.appendChild(createSep());

  const headingWrap = document.createElement('div');
  headingWrap.className = 'heading-presets-wrap';
  headingWrap.style.display = 'inline-flex';

  const headingBtn = document.createElement('button');
  headingBtn.className = 'edit-toolbar-btn';
  headingBtn.title = 'Títulos';
  headingBtn.innerHTML = '<b style="font-size:13px;letter-spacing:-0.5px">H</b>';

  let headingDrop: HTMLElement | null = null;

  headingBtn.addEventListener('mousedown', (e) => {
    preventBlur(e);
    if (headingDrop) { headingDrop.remove(); headingDrop = null; return; }

    const drop = document.createElement('div');
    drop.className = 'heading-presets-dropdown';
    headingDrop = drop;

    const presets: { label: string; size: number; bold: boolean }[] = [
      { label: 'Título 1', size: 36, bold: true },
      { label: 'Título 2', size: 24, bold: true },
      { label: 'Título 3', size: 18, bold: true },
    ];

    for (const preset of presets) {
      const item = document.createElement('button');
      item.className = 'heading-preset-item';
      item.dataset.size = String(preset.size);
      item.textContent = preset.label;
      item.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        // Use current selection; fall back to all text if nothing selected
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !contentDiv.contains(sel.anchorNode)) {
          const range = document.createRange();
          range.selectNodeContents(contentDiv);
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
        // Apply font size and bold
        document.execCommand('fontSize', false, '7'); // dummy size
        // Replace the font size with our custom size
        const fontEls = contentDiv.querySelectorAll('font[size="7"]');
        fontEls.forEach(el => {
          (el as HTMLElement).removeAttribute('size');
          (el as HTMLElement).style.fontSize = `${preset.size}px`;
        });
        if (preset.bold && !document.queryCommandState('bold')) document.execCommand('bold');
        sizeLabel.textContent = String(preset.size);
        drop.remove();
        headingDrop = null;
      });
      drop.appendChild(item);
    }

    // Normal text option
    const sepEl = document.createElement('div');
    sepEl.className = 'heading-preset-sep';
    drop.appendChild(sepEl);

    const normalItem = document.createElement('button');
    normalItem.className = 'heading-preset-item normal';
    normalItem.textContent = 'Texto normal';
    normalItem.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      // Use current selection; fall back to all text if nothing selected
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !contentDiv.contains(sel.anchorNode)) {
        const range = document.createRange();
        range.selectNodeContents(contentDiv);
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      document.execCommand('removeFormat');
      // Reset font size to default
      document.execCommand('fontSize', false, '3');
      const fontEls = contentDiv.querySelectorAll('font[size="3"]');
      fontEls.forEach(el => {
        (el as HTMLElement).removeAttribute('size');
        (el as HTMLElement).style.fontSize = '15px';
      });
      sizeLabel.textContent = '15';
      drop.remove();
      headingDrop = null;
    });
    drop.appendChild(normalItem);

    headingWrap.appendChild(drop);

    const closeDrop = (ev: MouseEvent) => {
      if (!drop.contains(ev.target as Node) && ev.target !== headingBtn) {
        drop.remove();
        headingDrop = null;
        document.removeEventListener('mousedown', closeDrop, true);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', closeDrop, true), 0);
  });

  headingWrap.appendChild(headingBtn);
  toolbar.appendChild(headingWrap);

  // Wrap any leading loose (unwrapped) text nodes at the start of contentDiv into
  // a real line <div>, so the first line can be targeted like every other line
  // (browsers only wrap subsequent lines in <div> after pressing Enter).
  function ensureFirstLineWrapped() {
    const firstChild = contentDiv.firstChild;
    if (!firstChild) return;
    if (firstChild.nodeType === Node.ELEMENT_NODE && (firstChild as HTMLElement).tagName === 'DIV') return;
    const group: ChildNode[] = [];
    let node: ChildNode | null = firstChild;
    while (node && !(node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === 'DIV')) {
      const next: ChildNode | null = node.nextSibling;
      group.push(node);
      node = next;
    }
    if (group.length === 0) return;
    if (group.length === 1 && group[0].nodeType === Node.ELEMENT_NODE && (group[0] as HTMLElement).tagName === 'BR') return;
    const wrapper = document.createElement('div');
    contentDiv.insertBefore(wrapper, group[0]);
    group.forEach(n => wrapper.appendChild(n));
  }

  // Returns the top-level line <div> elements that the current selection spans,
  // so list-style toggles can apply to every selected line, not just one.
  function getSelectedLineEls(): HTMLElement[] {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !contentDiv.contains(sel.anchorNode)) return [];
    ensureFirstLineWrapped();
    const range = sel.getRangeAt(0);
    const lines: HTMLElement[] = [];
    for (const child of Array.from(contentDiv.children)) {
      if (child.tagName === 'DIV' && range.intersectsNode(child)) {
        lines.push(child as HTMLElement);
      }
    }
    if (lines.length === 0) {
      const line = (sel.anchorNode as any)?.parentElement?.closest('div');
      if (line && line !== contentDiv && contentDiv.contains(line)) lines.push(line as HTMLElement);
    }
    return lines;
  }

  // Checklist button
  const checklistBtn = createBtn(
    svgIcon('M1 3h3v3H1z M6 4.5h9 M1 8h3v3H1z M6 9.5h9 M1 13h3v3H1z M6 14.5h9'),
    'Lista de tarefas', '', () => {
      const lines = getSelectedLineEls();
      if (lines.length === 0) {
        document.execCommand('insertHTML', false,
          '<div class="checklist-item"><input type="checkbox" class="checklist-cb">');
        return;
      }
      const allChecked = lines.every(l => l.querySelector('.checklist-cb'));
      for (const line of lines) {
        const dot = line.querySelector('.bullet-dot');
        if (dot) { dot.remove(); line.classList.remove('bullet-item'); }
        const existingCb = line.querySelector('.checklist-cb');
        if (allChecked) {
          existingCb?.remove();
          line.classList.remove('checklist-item');
        } else if (!existingCb) {
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.className = 'checklist-cb';
          line.insertBefore(cb, line.firstChild);
          line.classList.add('checklist-item');
        }
      }
    }
  );
  toolbar.appendChild(createSep());
  toolbar.appendChild(checklistBtn);

  // Topic (bullet) button
  const bulletIconHtml = '<svg viewBox="0 0 16 16" width="14" height="14">'
    + '<circle cx="2.5" cy="4.5" r="1.5" fill="currentColor" stroke="none"/>'
    + '<circle cx="2.5" cy="9.5" r="1.5" fill="currentColor" stroke="none"/>'
    + '<circle cx="2.5" cy="14.5" r="1.5" fill="currentColor" stroke="none"/>'
    + '<path d="M6 4.5h9 M6 9.5h9 M6 14.5h9" /></svg>';
  const bulletBtn = createBtn(
    bulletIconHtml,
    'Tópicos', '', () => {
      const lines = getSelectedLineEls();
      if (lines.length === 0) {
        document.execCommand('insertHTML', false,
          '<div class="bullet-item"><span class="bullet-dot"></span></div>');
        return;
      }
      const allBulleted = lines.every(l => l.querySelector('.bullet-dot'));
      for (const line of lines) {
        const cb = line.querySelector('.checklist-cb');
        if (cb) { cb.remove(); line.classList.remove('checklist-item'); }
        const existingDot = line.querySelector('.bullet-dot');
        if (allBulleted) {
          existingDot?.remove();
          line.classList.remove('bullet-item');
        } else if (!existingDot) {
          const dot = document.createElement('span');
          dot.className = 'bullet-dot';
          line.insertBefore(dot, line.firstChild);
          line.classList.add('bullet-item');
        }
      }
    }
  );
  toolbar.appendChild(bulletBtn);

  function updateToolbarState() {
    boldBtn.classList.toggle('active', document.queryCommandState('bold'));
    italicBtn.classList.toggle('active', document.queryCommandState('italic'));
    alignLeft.classList.toggle('active', document.queryCommandState('justifyLeft'));
    alignCenter.classList.toggle('active', document.queryCommandState('justifyCenter'));
    alignRight.classList.toggle('active', document.queryCommandState('justifyRight'));
    sizeLabel.textContent = String(getCurrentFontSize(contentDiv));
    const curColor = getCurrentTextColor(contentDiv);
    colorIndicator.style.backgroundColor = curColor;
    colorInput.value = rgbToHex(curColor);
  }

  const onSelChange = () => updateToolbarState();
  document.addEventListener('selectionchange', onSelChange);
  (toolbar as any).__cleanupSelChange = () => document.removeEventListener('selectionchange', onSelChange);

  return toolbar;
}

function positionToolbar(toolbar: HTMLElement, itemEl: HTMLElement) {
  document.body.appendChild(toolbar);
  const itemRect = itemEl.getBoundingClientRect();
  const toolbarH = toolbar.offsetHeight;
  const top = Math.max(4, itemRect.top - toolbarH - 8);
  toolbar.style.left = `${itemRect.left}px`;
  toolbar.style.top = `${top}px`;
}

function startEditing(id: string, itemEl: HTMLElement) {
  if (editingId) return;
  const item = findItem(id);
  if (!item || (item.type !== 'text' && item.type !== 'note')) return;
  const editItem = item;

  // Remove selection toolbar before entering edit mode
  removeSelectionToolbar();

  editingId = id;
  selectOnly(id);
  syncSelection();

  const contentDiv = itemEl.querySelector('.item-content') as HTMLElement;

  if (editItem.content && !isHtml(editItem.content)) {
    editItem.content = plainTextToHtml(editItem.content);
  }
  contentDiv.innerHTML = editItem.content || '<br>';
  contentDiv.contentEditable = 'true';
  contentDiv.classList.add('editing');

  const toolbar = createEditToolbar(contentDiv, editItem, itemEl);
  positionToolbar(toolbar, itemEl);

  const stopDrag = (e: MouseEvent) => e.stopPropagation();
  contentDiv.addEventListener('mousedown', stopDrag);

  const onKeyDown = (ke: KeyboardEvent) => {
    // While the mention menu is open, let it take arrows / Enter / Tab / Escape
    if (mentionMenuOpen() && mentionMenuKeydown(ke)) { ke.stopPropagation(); return; }
    if (ke.key === 'Escape') { finishEditing(); return; }
    if ((ke.ctrlKey || ke.metaKey) && ke.key === 'k') {
      ke.preventDefault();
      const sel = window.getSelection();
      const hasLink = sel && !sel.isCollapsed && sel.focusNode
        && (sel.focusNode as HTMLElement).closest?.('a');
      if (hasLink) {
        document.execCommand('unlink');
      } else {
        const url = prompt('URL:');
        if (url) {
          document.execCommand('createLink', false, url);
          const links = contentDiv.querySelectorAll('a:not([target])');
          links.forEach(a => {
            a.setAttribute('target', '_blank');
            a.setAttribute('rel', 'noopener noreferrer');
          });
        }
      }
    }
    ke.stopPropagation();
  };
  contentDiv.addEventListener('keydown', onKeyDown);

  // --- @mention autocomplete (users + boards) ---
  let savedMentionRange: Range | null = null;

  function insertMention(c: MentionCandidate) {
    contentDiv.focus();
    const sel = window.getSelection();
    if (!sel) return;
    if (savedMentionRange) { sel.removeAllRanges(); sel.addRange(savedMentionRange); }
    if (sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);

    // Delete the "@query" text preceding the caret
    const textNode = range.startContainer;
    if (textNode.nodeType === Node.TEXT_NODE) {
      const text = textNode.textContent || '';
      const atIdx = text.lastIndexOf('@', range.startOffset - 1);
      if (atIdx >= 0) {
        (textNode as Text).deleteData(atIdx, range.startOffset - atIdx);
        range.setStart(textNode, atIdx);
        range.collapse(true);
      }
    }

    const chip = document.createElement('span');
    chip.className = c.kind === 'board' ? 'board-mention' : 'user-mention';
    if (c.kind === 'board') chip.dataset.boardId = c.id; else chip.dataset.userId = c.id;
    chip.contentEditable = 'false';
    chip.textContent = '@' + c.name;
    range.insertNode(chip);

    range.setStartAfter(chip);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertText', false, ' ');
    savedMentionRange = null;
  }

  const onInput = () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) { closeMentionMenu(); return; }
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) { closeMentionMenu(); return; }
    const before = (node.textContent || '').substring(0, range.startOffset);
    const query = matchMentionToken(before);
    if (query === null) { closeMentionMenu(); return; }
    savedMentionRange = range.cloneRange();
    updateMentionMenu(range.getBoundingClientRect(), query, insertMention);
  };
  contentDiv.addEventListener('input', onInput);

  let outsideListener: ((e: MouseEvent) => void) | null = null;
  setTimeout(() => {
    outsideListener = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (contentDiv.contains(target) || toolbar.contains(target)) return;
      if (mentionMenu && mentionMenu.el.contains(target)) return;
      finishEditing();
    };
    window.addEventListener('mousedown', outsideListener, true);
  }, 0);

  contentDiv.focus();

  const sel = window.getSelection();
  if (sel) {
    sel.selectAllChildren(contentDiv);
    sel.collapseToEnd();
  }

  function finishEditing() {
    if (outsideListener) window.removeEventListener('mousedown', outsideListener, true);
    contentDiv.removeEventListener('mousedown', stopDrag);
    contentDiv.removeEventListener('keydown', onKeyDown);
    contentDiv.removeEventListener('input', onInput);
    closeMentionMenu();
    if ((toolbar as any).__cleanupSelChange) (toolbar as any).__cleanupSelChange();

    contentDiv.contentEditable = 'false';
    contentDiv.classList.remove('editing');
    toolbar.remove();

    // Collect mentioned profile IDs from chips before serialising
    const mentionIds = Array.from(
      new Set(
        Array.from(contentDiv.querySelectorAll('.user-mention'))
          .map(el => (el as HTMLElement).dataset.userId)
          .filter((v): v is string => !!v)
      )
    );
    if (mentionIds.length > 0) editItem.mentions = mentionIds;
    else delete editItem.mentions;

    let html = contentDiv.innerHTML;
    html = cleanContentHtml(html);
    if (html === '<br>' || html.trim() === '') html = '';
    editItem.content = html;

    editingId = null;
    commit();
    rerender();
  }
}

// Double-click on @board mention chips → navigate to that board
layer.addEventListener('dblclick', (e: MouseEvent) => {
  const mention = (e.target as HTMLElement).closest('.board-mention') as HTMLElement | null;
  if (!mention) return;
  e.stopPropagation(); // prevent text editing from starting
  const boardId = mention.dataset.boardId;
  if (boardId && state.boards.some(b => b.id === boardId)) {
    showBoardView(boardId);
  }
});

layer.addEventListener('dblclick', (e: MouseEvent) => {
  if (isReadOnly()) return;
  if (editingId) return;
  const itemEl = (e.target as HTMLElement).closest('[data-item-id]') as HTMLElement | null;
  if (!itemEl) return;
  const id = itemEl.dataset.itemId!;
  const item = findItem(id);
  if (!item) return;
  if (item.type === 'image' && item.sourceUrl) {
    window.open(item.sourceUrl, '_blank', 'noopener,noreferrer');
    return;
  }
  if (item.type === 'color') {
    openColorPicker(item, itemEl);
    return;
  }
  if (item.type === 'link') {
    window.open(item.content, '_blank', 'noopener,noreferrer');
    return;
  }
  if (item.type === 'board') {
    // Navigate into the sub-board
    const subId = item.content;
    if (subId && state.boards.some(b => b.id === subId)) {
      showBoardView(subId);
    }
    return;
  }
  if (item.type === 'frame') {
    const name = prompt('Nome do frame:', item.content || 'Frame');
    if (name !== null) {
      item.content = name.trim() || 'Frame';
      commit();
      rerender();
    }
    return;
  }
  if (item.type === 'embed') return;
  startEditing(id, itemEl);
});

// --- Drop files from OS ---

canvas.addEventListener('dragover', (e: DragEvent) => {
  e.preventDefault();
  canvas.classList.add('drop-active');
});

canvas.addEventListener('dragleave', () => {
  canvas.classList.remove('drop-active');
});

canvas.addEventListener('drop', (e: DragEvent) => {
  e.preventDefault();
  canvas.classList.remove('drop-active');
  if (isReadOnly()) return;
  const files = e.dataTransfer?.files;
  if (!files) return;
  for (const file of Array.from(files)) {
    if (file.type.startsWith('image/')) {
      addImageFromFile(file, e.clientX, e.clientY);
    } else if (file.name.endsWith('.html') || file.name.endsWith('.htm')) {
      addEmbedFromFile(file, e.clientX, e.clientY);
    }
  }
});

// --- Paste from clipboard (system or internal) ---

document.addEventListener('paste', (e: ClipboardEvent) => {
  if (currentView !== 'board') return;
  if (isReadOnly()) return;
  if (editingId) return;
  const clipItems = e.clipboardData?.items;

  // 1. System clipboard images win (right-click "Copy image" in browser, etc.)
  if (clipItems) {
    for (const ci of Array.from(clipItems)) {
      if (ci.type.startsWith('image/')) {
        const file = ci.getAsFile();
        if (file) addImageFromFile(file);
        return;
      }
    }
  }

  // 2. Pasted URLs → create link card
  const text = e.clipboardData?.getData('text/plain')?.trim();
  if (text && /^https?:\/\//i.test(text)) {
    e.preventDefault();
    addLinkAtCenter(text);
    return;
  }

  // 3. Fallback: internal clipboard (Ctrl+C within the board)
  if (clipboard.length > 0) {
    pasteItems();
  }
});

// --- Tag editor ---

let tagEditorOpen = false;

function openTagEditor() {
  if (selectedIds.size === 0 || tagEditorOpen || editingId) return;
  tagEditorOpen = true;

  const firstId = selectedIds.values().next().value as string;
  const firstEl = layer.querySelector(`[data-item-id="${firstId}"]`) as HTMLElement;
  if (!firstEl) { tagEditorOpen = false; return; }

  const firstItem = findItem(firstId);
  const currentTags = [...(firstItem?.tags || [])];

  const popover = document.createElement('div');
  popover.className = 'tag-editor';

  const chipsDiv = document.createElement('div');
  chipsDiv.className = 'tag-editor-chips';

  function renderChips() {
    chipsDiv.innerHTML = '';
    for (const tag of currentTags) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip tag-chip-edit';
      chip.textContent = tag;
      const x = document.createElement('button');
      x.className = 'tag-chip-remove';
      x.textContent = '×';
      x.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const idx = currentTags.indexOf(tag);
        if (idx >= 0) currentTags.splice(idx, 1);
        renderChips();
      });
      chip.appendChild(x);
      chipsDiv.appendChild(chip);
    }
  }
  renderChips();

  // Collect all existing tags in the board for autocomplete
  const allBoardTags = new Set<string>();
  for (const bi of getActiveBoard().items) {
    if (bi.tags) for (const t of bi.tags) allBoardTags.add(t);
  }

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tag-editor-input';
  input.placeholder = 'Adicionar tag…';

  const suggestionsEl = document.createElement('div');
  suggestionsEl.className = 'tag-suggestions';

  let selectedSuggIdx = -1;

  function renderSuggestions() {
    suggestionsEl.innerHTML = '';
    selectedSuggIdx = -1;
    const q = input.value.trim().toLowerCase();
    // Show tags that exist in the board but are not already on this item
    const available = [...allBoardTags].filter(t => !currentTags.includes(t));
    const filtered = q ? available.filter(t => t.includes(q)) : available;
    if (filtered.length === 0) { suggestionsEl.style.display = 'none'; return; }
    suggestionsEl.style.display = 'block';
    for (const tag of filtered) {
      const opt = document.createElement('div');
      opt.className = 'tag-suggestion-item';
      opt.textContent = tag;
      opt.addEventListener('mousedown', (me) => {
        me.preventDefault(); // don't blur input
        if (!currentTags.includes(tag)) {
          currentTags.push(tag);
          allBoardTags.add(tag);
          renderChips();
        }
        input.value = '';
        renderSuggestions();
      });
      suggestionsEl.appendChild(opt);
    }
  }

  function addTag(val: string) {
    if (val && !currentTags.includes(val)) {
      currentTags.push(val);
      allBoardTags.add(val);
      renderChips();
    }
    input.value = '';
    renderSuggestions();
  }

  input.addEventListener('keydown', (ke) => {
    const items = suggestionsEl.querySelectorAll('.tag-suggestion-item');
    if (ke.key === 'ArrowDown' && items.length > 0) {
      ke.preventDefault();
      selectedSuggIdx = Math.min(selectedSuggIdx + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('active', i === selectedSuggIdx));
      return;
    }
    if (ke.key === 'ArrowUp' && items.length > 0) {
      ke.preventDefault();
      selectedSuggIdx = Math.max(selectedSuggIdx - 1, 0);
      items.forEach((el, i) => el.classList.toggle('active', i === selectedSuggIdx));
      return;
    }
    if (ke.key === 'Enter') {
      if (selectedSuggIdx >= 0 && items[selectedSuggIdx]) {
        addTag(items[selectedSuggIdx].textContent!.trim());
      } else {
        addTag(input.value.trim().toLowerCase());
      }
    }
    if (ke.key === 'Escape') closeTagEditor();
    ke.stopPropagation();
  });
  input.addEventListener('input', () => renderSuggestions());
  input.addEventListener('mousedown', (me) => me.stopPropagation());

  popover.append(chipsDiv, input, suggestionsEl);
  // Show initial suggestions (all available tags)
  setTimeout(() => renderSuggestions(), 0);
  document.body.appendChild(popover);

  const rect = firstEl.getBoundingClientRect();
  popover.style.left = `${rect.left}px`;
  popover.style.top = `${rect.bottom + 8}px`;
  input.focus();

  let outsideListener: ((e: MouseEvent) => void) | null = null;
  setTimeout(() => {
    outsideListener = (e: MouseEvent) => {
      if (popover.contains(e.target as HTMLElement)) return;
      closeTagEditor();
    };
    window.addEventListener('mousedown', outsideListener, true);
  }, 0);

  function closeTagEditor() {
    if (outsideListener) window.removeEventListener('mousedown', outsideListener, true);
    popover.remove();
    tagEditorOpen = false;
    for (const id of selectedIds) {
      const item = findItem(id);
      if (item) item.tags = currentTags.length > 0 ? [...currentTags] : undefined;
    }
    commit();
    rerender();
  }
}

// --- Comment popover ---

let _commentPopoverCleanup: (() => void) | null = null;

function closeCommentPopover() {
  if (_commentPopoverCleanup) {
    _commentPopoverCleanup();
    _commentPopoverCleanup = null;
  }
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'agora';
  if (mins < 60) return `${mins}min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** Convert visible "@Name" tokens into stored markers. Users become
 *  "@[Name](id)"; boards become "@[Name](b:id)" so they can be told apart. */
function serializeMentions(text: string, mentions: ComposeMention[]): string {
  let out = text;
  // Longest names first so "@Ana" doesn't clobber "@Ana Paula"
  for (const m of [...mentions].sort((a, b) => b.name.length - a.name.length)) {
    const ref = m.kind === 'board' ? `b:${m.id}` : m.id;
    out = out.split('@' + m.name).join(`@[${m.name}](${ref})`);
  }
  return out;
}

/** Render stored comment text, turning "@[Name](id)" markers into chips.
 *  A "b:" prefix on the id marks a board mention (navigable). */
function appendMentionText(container: HTMLElement, text: string): void {
  const re = /@\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      container.appendChild(document.createTextNode(text.slice(last, match.index)));
    }
    const name = match[1];
    const ref = match[2];
    if (ref.startsWith('b:')) {
      const boardId = ref.slice(2);
      const chip = document.createElement('span');
      chip.className = 'board-mention';
      chip.dataset.boardId = boardId;
      chip.textContent = '@' + name;
      if (state.boards.some(b => b.id === boardId)) {
        chip.addEventListener('click', (e) => { e.stopPropagation(); showBoardView(boardId); });
      }
      container.appendChild(chip);
    } else {
      const chip = document.createElement('span');
      chip.className = 'user-mention';
      chip.dataset.userId = ref;
      if (currentProfile && ref === currentProfile.id) chip.classList.add('is-me');
      chip.textContent = '@' + name;
      container.appendChild(chip);
    }
    last = re.lastIndex;
  }
  if (last < text.length) {
    container.appendChild(document.createTextNode(text.slice(last)));
  }
}

function renderCommentEl(c: CommentWithAuthor, canDelete: boolean, onDelete: () => void): HTMLElement {
  const item = document.createElement('div');
  item.className = 'comment-item';
  item.dataset.commentId = c.id;

  const avatar = document.createElement('div');
  avatar.className = 'comment-avatar';
  avatar.style.background = c.author.color || '#888';
  avatar.textContent = (c.author.display_name || c.author.email || '?')[0].toUpperCase();
  if (c.author.avatar_url) {
    const img = document.createElement('img');
    img.src = c.author.avatar_url;
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.borderRadius = '50%';
    avatar.textContent = '';
    avatar.appendChild(img);
  }

  const body = document.createElement('div');
  body.className = 'comment-body';

  const meta = document.createElement('div');
  meta.className = 'comment-meta';
  const authorEl = document.createElement('span');
  authorEl.className = 'comment-author';
  authorEl.textContent = c.author.display_name || c.author.email;
  const timeEl = document.createElement('span');
  timeEl.className = 'comment-time';
  timeEl.textContent = timeAgo(c.created_at);
  meta.append(authorEl, timeEl);

  const text = document.createElement('div');
  text.className = 'comment-text';
  appendMentionText(text, c.content);

  body.append(meta, text);
  item.append(avatar, body);

  if (canDelete) {
    const del = document.createElement('button');
    del.className = 'comment-delete';
    del.title = 'Excluir';
    del.innerHTML = '×';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      onDelete();
    });
    item.appendChild(del);
  }

  return item;
}

async function showCommentPopover(itemEl: HTMLElement, itemId: string) {
  closeCommentPopover();
  closeLinkPreview();
  closeContextMenu();

  const boardId = state.activeBoardId;
  if (!boardId || !currentProfile) return;

  const popup = document.createElement('div');
  popup.className = 'comment-popover';

  // Header
  const header = document.createElement('div');
  header.className = 'comment-popover-header';
  const title = document.createElement('span');
  title.textContent = 'Comentários';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'comment-popover-close';
  closeBtn.innerHTML = '×';
  closeBtn.addEventListener('click', () => closeCommentPopover());
  header.append(title, closeBtn);

  // Comment list
  const list = document.createElement('div');
  list.className = 'comment-list';

  // Compose area
  const compose = document.createElement('div');
  compose.className = 'comment-compose';
  const input = document.createElement('textarea');
  input.className = 'comment-input';
  input.placeholder = 'Escreva um comentário...';
  input.rows = 1;
  const sendBtn = document.createElement('button');
  sendBtn.className = 'comment-send';
  sendBtn.disabled = true;
  sendBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/></svg>';

  input.addEventListener('input', () => {
    sendBtn.disabled = !input.value.trim();
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 80) + 'px';
    handleMentionInput(input);
  });

  const doSend = async () => {
    const raw = input.value.trim();
    if (!raw || !currentProfile) return;
    const tracked = ((input as any).__mentions as ComposeMention[] | undefined) || [];
    const text = serializeMentions(raw, tracked);
    sendBtn.disabled = true;
    input.value = '';
    input.style.height = '';
    (input as any).__mentions = [];

    const comment = await addComment(boardId, itemId, currentProfile.id, text);
    if (comment) {
      const canDel = comment.profile_id === currentProfile!.id || currentProfile!.is_admin;
      list.appendChild(renderCommentEl(comment, canDel, async () => {
        await deleteComment(comment.id, itemId);
        list.querySelector(`[data-comment-id="${comment.id}"]`)?.remove();
        updateBadge();
      }));
      list.scrollTop = list.scrollHeight;
      updateBadge();
    }
  };

  sendBtn.addEventListener('click', doSend);
  input.addEventListener('keydown', (e) => {
    // Let the mention menu take arrows / Enter / Tab / Escape while it's open
    if (handleMentionKeydown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  });

  compose.append(input, sendBtn);
  popup.append(header, list, compose);
  document.body.appendChild(popup);

  // Position relative to item
  const rect = itemEl.getBoundingClientRect();
  popup.style.left = `${rect.right + 8}px`;
  popup.style.top = `${rect.top}px`;

  requestAnimationFrame(() => {
    const popRect = popup.getBoundingClientRect();
    if (popRect.right > window.innerWidth) {
      popup.style.left = `${rect.left - popRect.width - 8}px`;
    }
    if (popRect.bottom > window.innerHeight) {
      popup.style.top = `${Math.max(8, window.innerHeight - popRect.height - 8)}px`;
    }
  });

  // Load existing comments
  const comments = await loadComments(boardId, itemId);
  for (const c of comments) {
    const canDel = c.profile_id === currentProfile.id || currentProfile.is_admin;
    list.appendChild(renderCommentEl(c, canDel, async () => {
      await deleteComment(c.id, itemId);
      list.querySelector(`[data-comment-id="${c.id}"]`)?.remove();
      updateBadge();
    }));
  }
  list.scrollTop = list.scrollHeight;

  function updateBadge() {
    const count = getCommentCount(itemId);
    const existingBadge = itemEl.querySelector('.comment-badge') as HTMLElement | null;
    if (count > 0) {
      if (existingBadge) {
        existingBadge.querySelector('span')!.textContent = String(count);
        existingBadge.title = `${count} comentário${count > 1 ? 's' : ''}`;
      } else {
        rerender();
      }
    } else if (existingBadge) {
      existingBadge.remove();
    }
    title.textContent = count > 0 ? `Comentários (${count})` : 'Comentários';
  }

  // Handle realtime updates for this popover
  const handleRealtimeInPopover = (type: string, changedItemId: string, comment?: CommentWithAuthor) => {
    if (changedItemId !== itemId) return;
    if (type === 'insert' && comment && !list.querySelector(`[data-comment-id="${comment.id}"]`)) {
      const canDel = comment.profile_id === currentProfile!.id || currentProfile!.is_admin;
      list.appendChild(renderCommentEl(comment, canDel, async () => {
        await deleteComment(comment.id, itemId);
        list.querySelector(`[data-comment-id="${comment.id}"]`)?.remove();
        updateBadge();
      }));
      list.scrollTop = list.scrollHeight;
      updateBadge();
    } else if (type === 'delete') {
      updateBadge();
    }
  };
  (window as any).__commentPopoverHandler = handleRealtimeInPopover;

  // Outside click to close
  let outsideListener: ((e: MouseEvent) => void) | null = null;
  setTimeout(() => {
    outsideListener = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Clicks inside the mention menu must not close the popover
      if (mentionMenu && mentionMenu.el.contains(target)) return;
      if (!popup.contains(target)) {
        closeCommentPopover();
      }
    };
    window.addEventListener('mousedown', outsideListener, true);
  }, 0);

  _commentPopoverCleanup = () => {
    popup.remove();
    closeMentionMenu();
    if (outsideListener) window.removeEventListener('mousedown', outsideListener, true);
    (window as any).__commentPopoverHandler = null;
  };

  input.focus();
}

// --- Link preview popup (Google Docs style) ---

let _linkPreviewCleanup: (() => void) | null = null;

function closeLinkPreview() {
  if (_linkPreviewCleanup) {
    _linkPreviewCleanup();
    _linkPreviewCleanup = null;
  }
}

function showLinkPreview(linkEl: HTMLAnchorElement, itemEl: HTMLElement) {
  closeLinkPreview();
  closeContextMenu();

  const url = linkEl.href;
  let domain = '';
  try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch { domain = url; }

  const popup = document.createElement('div');
  popup.className = 'link-preview-popup';

  // Favicon
  const favicon = document.createElement('img');
  favicon.className = 'link-preview-favicon';
  favicon.src = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  favicon.alt = '';

  // URL link (clicking opens the link)
  const urlLink = document.createElement('a');
  urlLink.className = 'link-preview-url';
  urlLink.href = url;
  urlLink.target = '_blank';
  urlLink.rel = 'noopener noreferrer';
  urlLink.textContent = url.length > 50 ? url.slice(0, 50) + '…' : url;
  urlLink.title = url;
  urlLink.addEventListener('click', () => closeLinkPreview());
  urlLink.addEventListener('mousedown', (me) => me.stopPropagation());

  const sep = document.createElement('span');
  sep.className = 'link-preview-sep';

  // Copy button
  const copyBtn = document.createElement('button');
  copyBtn.className = 'link-preview-btn';
  copyBtn.title = 'Copiar URL';
  copyBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M11 1H5a2 2 0 0 0-2 2v8h2V3h6V1z M7 4h5a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" /></svg>';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(url);
    copyBtn.title = 'Copiado!';
    setTimeout(() => closeLinkPreview(), 600);
  });
  copyBtn.addEventListener('mousedown', (me) => me.stopPropagation());

  // Edit button
  const editBtn = document.createElement('button');
  editBtn.className = 'link-preview-btn';
  editBtn.title = 'Editar URL';
  editBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M12.1 1.3a1.5 1.5 0 0 1 2.1 2.1L5.6 12 2 13l1-3.6z" /></svg>';
  editBtn.addEventListener('click', () => {
    const newUrl = prompt('Editar URL:', url);
    if (newUrl !== null && newUrl.trim()) {
      linkEl.href = newUrl.trim();
      // Update stored content
      const itemId = itemEl.dataset.itemId!;
      const item = findItem(itemId);
      if (item && (item.type === 'text' || item.type === 'note')) {
        const contentDiv = itemEl.querySelector('.item-content') as HTMLElement;
        if (contentDiv) {
          item.content = contentDiv.innerHTML;
          commit();
          rerender();
        }
      }
    }
    closeLinkPreview();
  });
  editBtn.addEventListener('mousedown', (me) => me.stopPropagation());

  // Remove link button
  const removeBtn = document.createElement('button');
  removeBtn.className = 'link-preview-btn link-preview-btn-danger';
  removeBtn.title = 'Remover link';
  removeBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 4l8 8 M12 4l-8 8" /></svg>';
  removeBtn.addEventListener('click', () => {
    const itemId = itemEl.dataset.itemId!;
    const item = findItem(itemId);
    if (item && (item.type === 'text' || item.type === 'note')) {
      // Replace <a> with its text content in stored HTML
      const tmp = document.createElement('div');
      tmp.innerHTML = item.content;
      const anchors = tmp.querySelectorAll('a');
      for (const a of Array.from(anchors)) {
        if (a.href === url || a.getAttribute('href') === linkEl.getAttribute('href')) {
          a.replaceWith(document.createTextNode(a.textContent || ''));
        }
      }
      item.content = tmp.innerHTML;
      commit();
      rerender();
    }
    closeLinkPreview();
  });
  removeBtn.addEventListener('mousedown', (me) => me.stopPropagation());

  popup.append(favicon, urlLink, sep, copyBtn, editBtn, removeBtn);
  document.body.appendChild(popup);

  // Position below the link
  const rect = linkEl.getBoundingClientRect();
  popup.style.left = `${rect.left}px`;
  popup.style.top = `${rect.bottom + 6}px`;

  // Adjust if off-screen
  requestAnimationFrame(() => {
    const popRect = popup.getBoundingClientRect();
    if (popRect.right > window.innerWidth) {
      popup.style.left = `${window.innerWidth - popRect.width - 8}px`;
    }
    if (popRect.bottom > window.innerHeight) {
      popup.style.top = `${rect.top - popRect.height - 6}px`;
    }
  });

  // Outside click to close
  let outsideListener: ((e: MouseEvent) => void) | null = null;
  setTimeout(() => {
    outsideListener = (e: MouseEvent) => {
      if (!popup.contains(e.target as HTMLElement)) {
        closeLinkPreview();
      }
    };
    window.addEventListener('mousedown', outsideListener, true);
  }, 0);

  _linkPreviewCleanup = () => {
    popup.remove();
    if (outsideListener) window.removeEventListener('mousedown', outsideListener, true);
  };
}

function showImageLinkPreview(btnEl: HTMLElement, item: BoardItem) {
  closeLinkPreview();
  closeContextMenu();

  const url = item.sourceUrl!;
  let domain = '';
  try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch { domain = url; }

  const popup = document.createElement('div');
  popup.className = 'link-preview-popup';

  // Favicon
  const favicon = document.createElement('img');
  favicon.className = 'link-preview-favicon';
  favicon.src = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  favicon.alt = '';

  // URL link (clicking opens the link)
  const urlLink = document.createElement('a');
  urlLink.className = 'link-preview-url';
  urlLink.href = url;
  urlLink.target = '_blank';
  urlLink.rel = 'noopener noreferrer';
  urlLink.textContent = url.length > 50 ? url.slice(0, 50) + '…' : url;
  urlLink.title = url;
  urlLink.addEventListener('click', () => closeLinkPreview());
  urlLink.addEventListener('mousedown', (me) => me.stopPropagation());

  const sep = document.createElement('span');
  sep.className = 'link-preview-sep';

  // Copy button
  const copyBtn = document.createElement('button');
  copyBtn.className = 'link-preview-btn';
  copyBtn.title = 'Copiar URL';
  copyBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M11 1H5a2 2 0 0 0-2 2v8h2V3h6V1z M7 4h5a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" /></svg>';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(url);
    copyBtn.title = 'Copiado!';
    setTimeout(() => closeLinkPreview(), 600);
  });
  copyBtn.addEventListener('mousedown', (me) => me.stopPropagation());

  // Edit button
  const editBtn = document.createElement('button');
  editBtn.className = 'link-preview-btn';
  editBtn.title = 'Editar URL';
  editBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M12.1 1.3a1.5 1.5 0 0 1 2.1 2.1L5.6 12 2 13l1-3.6z" /></svg>';
  editBtn.addEventListener('click', () => {
    const newUrl = prompt('Editar URL da imagem:', url);
    if (newUrl !== null && newUrl.trim()) {
      item.sourceUrl = newUrl.trim();
      commit();
      rerender();
    }
    closeLinkPreview();
  });
  editBtn.addEventListener('mousedown', (me) => me.stopPropagation());

  // Remove link button
  const removeBtn = document.createElement('button');
  removeBtn.className = 'link-preview-btn link-preview-btn-danger';
  removeBtn.title = 'Remover link';
  removeBtn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 4l8 8 M12 4l-8 8" /></svg>';
  removeBtn.addEventListener('click', () => {
    item.sourceUrl = undefined;
    commit();
    rerender();
    closeLinkPreview();
  });
  removeBtn.addEventListener('mousedown', (me) => me.stopPropagation());

  popup.append(favicon, urlLink, sep, copyBtn, editBtn, removeBtn);
  document.body.appendChild(popup);

  // Position below the button
  const rect = btnEl.getBoundingClientRect();
  popup.style.left = `${rect.left}px`;
  popup.style.top = `${rect.bottom + 6}px`;

  // Adjust if off-screen
  requestAnimationFrame(() => {
    const popRect = popup.getBoundingClientRect();
    if (popRect.right > window.innerWidth) {
      popup.style.left = `${window.innerWidth - popRect.width - 8}px`;
    }
    if (popRect.bottom > window.innerHeight) {
      popup.style.top = `${rect.top - popRect.height - 6}px`;
    }
  });

  // Outside click to close
  let outsideListener: ((e: MouseEvent) => void) | null = null;
  setTimeout(() => {
    outsideListener = (e: MouseEvent) => {
      if (!popup.contains(e.target as HTMLElement)) {
        closeLinkPreview();
      }
    };
    window.addEventListener('mousedown', outsideListener, true);
  }, 0);

  _linkPreviewCleanup = () => {
    popup.remove();
    if (outsideListener) window.removeEventListener('mousedown', outsideListener, true);
  };
}

// Also intercept click events on links to prevent default navigation
layer.addEventListener('click', (e: MouseEvent) => {
  if (editingId) return;
  const target = e.target as HTMLElement;
  const anchorEl = target.closest('a') as HTMLAnchorElement | null;
  if (anchorEl) {
    e.preventDefault();
  }
});

// --- Checklist checkbox toggle ---
layer.addEventListener('change', (e: Event) => {
  const target = e.target as HTMLElement;
  if (target instanceof HTMLInputElement && target.type === 'checkbox' && target.classList.contains('checklist-cb')) {
    const itemEl = target.closest('[data-item-id]') as HTMLElement;
    if (!itemEl) return;
    const id = itemEl.dataset.itemId!;
    const item = findItem(id);
    if (!item) return;
    const contentDiv = itemEl.querySelector('.item-content') as HTMLElement;
    if (contentDiv) {
      item.content = contentDiv.innerHTML;
      commit();
    }
  }
});

// --- Embed fullscreen button ---

layer.addEventListener('click', (e: MouseEvent) => {
  const btn = (e.target as HTMLElement).closest('[data-action="embed-fullscreen"]');
  if (!btn) return;
  e.stopPropagation();
  const itemEl = btn.closest('[data-item-id]') as HTMLElement | null;
  if (itemEl?.dataset.itemId) openEmbedFullscreen(itemEl.dataset.itemId);
});

// --- Board search (Ctrl+F) ---

let searchOpen = false;
let searchBar: HTMLElement | null = null;
let searchResults: BoardItem[] = [];
let searchIndex = -1;

function stripHtml(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent || '';
}

function searchItems(query: string): BoardItem[] {
  if (!query) return [];
  const q = query.toLowerCase();
  const board = getActiveBoard();
  return board.items.filter(item => {
    // Search content
    let text = item.content || '';
    if (isHtml(text)) text = stripHtml(text);
    if (text.toLowerCase().includes(q)) return true;
    // Search tags
    if (item.tags?.some(t => t.toLowerCase().includes(q))) return true;
    // Search sourceUrl
    if (item.sourceUrl?.toLowerCase().includes(q)) return true;
    return false;
  });
}

function navigateToItem(item: BoardItem) {
  const vp = getViewport();
  const rect = getCanvasRect();
  const centerX = item.position.x + item.size.w / 2;
  const centerY = item.position.y + item.size.h / 2;
  const newVp = {
    x: rect.width / 2 - centerX * vp.zoom,
    y: rect.height / 2 - centerY * vp.zoom,
    zoom: vp.zoom,
  };
  setViewport(newVp);
  getActiveBoard().viewport = newVp;
  save();
  updateMinimap();
}

function highlightSearchResults() {
  // Remove old highlights
  const old = layer.querySelectorAll('.search-highlight');
  for (const el of Array.from(old)) el.classList.remove('search-highlight');

  // Add new highlights
  for (const item of searchResults) {
    const el = layer.querySelector(`[data-item-id="${item.id}"]`) as HTMLElement | null;
    if (el) el.classList.add('search-highlight');
  }
}

function updateSearchUI(countEl: HTMLElement) {
  if (searchResults.length === 0) {
    countEl.textContent = '0';
  } else {
    countEl.textContent = `${searchIndex + 1}/${searchResults.length}`;
  }
  highlightSearchResults();
  if (searchResults.length > 0 && searchIndex >= 0) {
    const item = searchResults[searchIndex];
    selectOnly(item.id);
    syncSelection();
    navigateToItem(item);
  }
}

function openSearch() {
  if (searchOpen) return;
  searchOpen = true;

  const bar = document.createElement('div');
  bar.className = 'board-search';
  searchBar = bar;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'board-search-input';
  input.placeholder = 'Buscar no board…';

  const count = document.createElement('span');
  count.className = 'board-search-count';
  count.textContent = '0';

  const prevBtn = document.createElement('button');
  prevBtn.className = 'board-search-btn';
  prevBtn.textContent = '▲';
  prevBtn.title = 'Anterior';

  const nextBtn = document.createElement('button');
  nextBtn.className = 'board-search-btn';
  nextBtn.textContent = '▼';
  nextBtn.title = 'Próximo';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'board-search-btn';
  closeBtn.textContent = '×';
  closeBtn.title = 'Fechar (Esc)';

  const selectAllBtn = document.createElement('button');
  selectAllBtn.className = 'board-search-btn board-search-select-all';
  selectAllBtn.textContent = '☐ Selecionar todos';
  selectAllBtn.title = 'Selecionar todos os resultados';
  selectAllBtn.style.display = 'none';

  bar.append(input, count, prevBtn, nextBtn, selectAllBtn, closeBtn);
  canvasEl.appendChild(bar);
  input.focus();

  const doSearch = () => {
    searchResults = searchItems(input.value.trim());
    searchIndex = searchResults.length > 0 ? 0 : -1;
    selectAllBtn.style.display = searchResults.length > 0 ? '' : 'none';
    updateSearchUI(count);
  };

  const goNext = () => {
    if (searchResults.length === 0) return;
    searchIndex = (searchIndex + 1) % searchResults.length;
    updateSearchUI(count);
  };

  const goPrev = () => {
    if (searchResults.length === 0) return;
    searchIndex = (searchIndex - 1 + searchResults.length) % searchResults.length;
    updateSearchUI(count);
  };

  input.addEventListener('input', doSearch);
  input.addEventListener('keydown', (ke) => {
    if (ke.key === 'Enter') {
      ke.shiftKey ? goPrev() : goNext();
    }
    if (ke.key === 'Escape') {
      closeSearch();
    }
    ke.stopPropagation();
  });
  input.addEventListener('mousedown', (me) => me.stopPropagation());

  prevBtn.addEventListener('click', goPrev);
  nextBtn.addEventListener('click', goNext);
  closeBtn.addEventListener('click', closeSearch);

  selectAllBtn.addEventListener('click', () => {
    if (searchResults.length === 0) return;
    selectedIds.clear();
    for (const item of searchResults) {
      selectedIds.add(item.id);
    }
    expandSelectionToGroups();
    syncSelection();
    closeSearch();
  });
}

function closeSearch() {
  if (!searchOpen) return;
  searchOpen = false;
  if (searchBar) {
    searchBar.remove();
    searchBar = null;
  }
  searchResults = [];
  searchIndex = -1;
  // Remove highlights
  const old = layer.querySelectorAll('.search-highlight');
  for (const el of Array.from(old)) el.classList.remove('search-highlight');
}

// --- Tag filter ---

function toggleTagFilter(tag: string) {
  if (activeTagFilters.has(tag)) {
    activeTagFilters.delete(tag);
  } else {
    activeTagFilters.add(tag);
  }
  applyTagFilter();
}

function clearTagFilter() {
  activeTagFilters.clear();
  applyTagFilter();
}

function applyTagFilter() {
  const items = layer.querySelectorAll('[data-item-id]') as NodeListOf<HTMLElement>;

  if (activeTagFilters.size === 0) {
    // Remove all dimming
    for (const el of Array.from(items)) el.classList.remove('tag-dimmed');
    if (tagFilterBar) { tagFilterBar.remove(); tagFilterBar = null; }
    return;
  }

  const board = getActiveBoard();
  for (const el of Array.from(items)) {
    const id = el.dataset.itemId!;
    const item = board.items.find(i => i.id === id);
    const tags = item?.tags || [];
    const matches = [...activeTagFilters].some(t => tags.includes(t));
    el.classList.toggle('tag-dimmed', !matches);
  }

  renderTagFilterBar();
}

function renderTagFilterBar() {
  if (tagFilterBar) tagFilterBar.remove();

  tagFilterBar = document.createElement('div');
  tagFilterBar.className = 'tag-filter-bar';

  const label = document.createElement('span');
  label.className = 'tag-filter-label';
  label.textContent = 'Filtro:';
  tagFilterBar.appendChild(label);

  for (const tag of activeTagFilters) {
    const chip = document.createElement('span');
    chip.className = 'tag-filter-chip';
    chip.textContent = tag;
    chip.addEventListener('click', () => toggleTagFilter(tag));
    tagFilterBar.appendChild(chip);
  }

  const clearBtn = document.createElement('button');
  clearBtn.className = 'tag-filter-clear';
  clearBtn.textContent = '✕ Limpar';
  clearBtn.addEventListener('click', clearTagFilter);
  tagFilterBar.appendChild(clearBtn);

  boardView.appendChild(tagFilterBar);
}

// Click on tag chips to filter
layer.addEventListener('click', (e: MouseEvent) => {
  const chip = (e.target as HTMLElement).closest('.tag-chip[data-tag]') as HTMLElement | null;
  if (!chip) return;
  e.stopPropagation();
  const tag = chip.dataset.tag;
  if (tag) toggleTagFilter(tag);
});

// --- Connect mode ---

function startConnectMode() {
  if (freeDrawMode) exitFreeDrawMode();
  connectingFromId = null;
  const isActive = canvasEl.classList.contains('connect-mode');
  if (!isActive) {
    document.querySelectorAll('#sidebar .sidebar-btn').forEach(b => b.classList.remove('active'));
  }
  canvasEl.classList.toggle('connect-mode');
  const btn = document.getElementById('sidebar-connect-btn');
  btn?.classList.toggle('active');
  if (isActive) {
    // Exiting connect mode → restore select
    document.getElementById('sidebar-select-btn')?.classList.add('active');
  }
}

function exitConnectMode() {
  connectingFromId = null;
  connLayer.clearPreview();
  canvasEl.classList.remove('connect-mode');
  const btn = document.getElementById('sidebar-connect-btn');
  btn?.classList.remove('active');
  document.getElementById('sidebar-select-btn')?.classList.add('active');
}

function isConnectMode(): boolean {
  return canvasEl.classList.contains('connect-mode');
}

// Connection click handler — on connection hitbox SVG paths
layer.addEventListener('mousedown', (e: MouseEvent) => {
  const target = e.target as SVGElement;
  if (target.classList?.contains('conn-hit')) {
    e.stopPropagation();
    const connId = target.dataset.connId;
    if (!connId) return;

    const board = getActiveBoard();
    const conn = board.connections?.find(c => c.id === connId);
    if (!conn) return;

    const fromItem = findItem(conn.fromId);
    const toItem = findItem(conn.toId);

    // Check if click is near an endpoint (within 20px in board coords)
    if (fromItem && toItem) {
      const vp = getViewport();
      const rect = getCanvasRect();
      const clickBoard = screenToBoard(e.clientX - rect.left, e.clientY - rect.top, vp);

      const fromCenter = getCenter(fromItem);
      const toCenter = getCenter(toItem);
      const fromAnchor = getAnchor(fromItem, toCenter);
      const toAnchor = getAnchor(toItem, fromCenter);

      const ENDPOINT_THRESHOLD = 25 / vp.zoom; // 25px screen → board coords
      const distFrom = Math.hypot(clickBoard.x - fromAnchor.x, clickBoard.y - fromAnchor.y);
      const distTo = Math.hypot(clickBoard.x - toAnchor.x, clickBoard.y - toAnchor.y);

      if (distFrom < ENDPOINT_THRESHOLD && distFrom < distTo) {
        // Dragging the "from" end — the "to" item stays fixed
        reconnecting = { connId, end: 'from', fixedId: conn.toId };
        selectedConnId = connId;
        clearSelection();
        syncSelection();
        updateConnections();
        return;
      }
      if (distTo < ENDPOINT_THRESHOLD) {
        // Dragging the "to" end — the "from" item stays fixed
        reconnecting = { connId, end: 'to', fixedId: conn.fromId };
        selectedConnId = connId;
        clearSelection();
        syncSelection();
        updateConnections();
        return;
      }
    }

    // Regular click — just select
    selectedConnId = connId;
    clearSelection();
    syncSelection();
    updateConnections();
  }
}, true);

// Connection context menu
layer.addEventListener('contextmenu', (e: MouseEvent) => {
  if (isReadOnly()) return;
  const target = e.target as SVGElement;
  if (target.classList?.contains('conn-hit')) {
    e.preventDefault();
    e.stopPropagation();
    const connId = target.dataset.connId;
    if (!connId) return;
    const board = getActiveBoard();
    const conn = board.connections?.find(c => c.id === connId);
    if (!conn) return;

    selectedConnId = connId;
    updateConnections();

    showContextMenu(e.clientX, e.clientY, [
      {
        label: conn.label ? 'Editar rótulo' : 'Adicionar rótulo',
        action: () => {
          const label = prompt('Rótulo da conexão:', conn.label || '');
          if (label !== null) {
            conn.label = label.trim() || undefined;
            commit();
            rerender();
          }
        }
      },
      {
        label: 'Excluir conexão',
        action: () => {
          board.connections = board.connections.filter(c => c.id !== connId);
          selectedConnId = null;
          commit();
          rerender();
        },
        danger: true
      }
    ]);
  }
}, true);

// --- Duplicate, Copy/Paste items, Lock ---

let clipboard: BoardItem[] = [];

function duplicateSelected() {
  if (selectedIds.size === 0) return;
  const board = getActiveBoard();
  const newIds: string[] = [];
  for (const id of selectedIds) {
    const item = findItem(id);
    if (item) {
      const dup = duplicateItem(item);
      board.items.push(dup);
      newIds.push(dup.id);
    }
  }
  clearSelection();
  for (const id of newIds) selectedIds.add(id);
  commit();
  rerender();
}

function copySelected() {
  if (selectedIds.size === 0) return;
  clipboard = [];
  for (const id of selectedIds) {
    const item = findItem(id);
    if (item) clipboard.push(item);
  }
}

function pasteItems() {
  if (clipboard.length === 0) return;
  const board = getActiveBoard();
  const vp = getViewport();
  const rect = getCanvasRect();
  const center = screenToBoard(rect.width / 2, rect.height / 2, vp);

  // Calculate clipboard bounding box center
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const item of clipboard) {
    minX = Math.min(minX, item.position.x);
    minY = Math.min(minY, item.position.y);
    maxX = Math.max(maxX, item.position.x + item.size.w);
    maxY = Math.max(maxY, item.position.y + item.size.h);
  }
  const clipCenterX = (minX + maxX) / 2;
  const clipCenterY = (minY + maxY) / 2;
  const dx = center.x - clipCenterX;
  const dy = center.y - clipCenterY;

  const newIds: string[] = [];
  for (const item of clipboard) {
    const dup = duplicateItem(item, 0);
    dup.position.x = item.position.x + dx;
    dup.position.y = item.position.y + dy;
    board.items.push(dup);
    newIds.push(dup.id);
  }
  clearSelection();
  for (const id of newIds) selectedIds.add(id);
  commit();
  rerender();
}

// --- Alignment tools ---

function getSelectedItems(): BoardItem[] {
  const items: BoardItem[] = [];
  for (const id of selectedIds) {
    const item = findItem(id);
    if (item && !item.locked) items.push(item);
  }
  return items;
}

function alignItems(mode: 'left' | 'center-h' | 'right' | 'top' | 'center-v' | 'bottom') {
  const items = getSelectedItems();
  if (items.length < 2) return;

  let ref: number;
  switch (mode) {
    case 'left':
      ref = Math.min(...items.map(i => i.position.x));
      for (const i of items) i.position.x = ref;
      break;
    case 'right':
      ref = Math.max(...items.map(i => i.position.x + i.size.w));
      for (const i of items) i.position.x = ref - i.size.w;
      break;
    case 'center-h':
      ref = items.reduce((s, i) => s + i.position.x + i.size.w / 2, 0) / items.length;
      for (const i of items) i.position.x = ref - i.size.w / 2;
      break;
    case 'top':
      ref = Math.min(...items.map(i => i.position.y));
      for (const i of items) i.position.y = ref;
      break;
    case 'bottom':
      ref = Math.max(...items.map(i => i.position.y + i.size.h));
      for (const i of items) i.position.y = ref - i.size.h;
      break;
    case 'center-v':
      ref = items.reduce((s, i) => s + i.position.y + i.size.h / 2, 0) / items.length;
      for (const i of items) i.position.y = ref - i.size.h / 2;
      break;
  }
  commit();
  rerender();
}

function distributeItems(axis: 'horizontal' | 'vertical') {
  const items = getSelectedItems();
  if (items.length < 3) return;

  if (axis === 'horizontal') {
    const sorted = [...items].sort((a, b) => a.position.x - b.position.x);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const totalSpace = (last.position.x + last.size.w) - first.position.x;
    const totalItemW = sorted.reduce((s, i) => s + i.size.w, 0);
    const gap = (totalSpace - totalItemW) / (sorted.length - 1);
    let x = first.position.x + first.size.w + gap;
    for (let i = 1; i < sorted.length - 1; i++) {
      sorted[i].position.x = x;
      x += sorted[i].size.w + gap;
    }
  } else {
    const sorted = [...items].sort((a, b) => a.position.y - b.position.y);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const totalSpace = (last.position.y + last.size.h) - first.position.y;
    const totalItemH = sorted.reduce((s, i) => s + i.size.h, 0);
    const gap = (totalSpace - totalItemH) / (sorted.length - 1);
    let y = first.position.y + first.size.h + gap;
    for (let i = 1; i < sorted.length - 1; i++) {
      sorted[i].position.y = y;
      y += sorted[i].size.h + gap;
    }
  }
  commit();
  rerender();
}

// ── Auto-layout ──

const AUTO_LAYOUT_GAP = 24;

function layoutGrid() {
  const items = getSelectedItems();
  if (items.length < 2) return;

  // Sort items by their current position (top-left to bottom-right, row-major)
  const sorted = [...items].sort((a, b) => {
    const rowA = Math.round(a.position.y / 100);
    const rowB = Math.round(b.position.y / 100);
    if (rowA !== rowB) return rowA - rowB;
    return a.position.x - b.position.x;
  });

  // Compute optimal column count (~square grid, biased wider)
  const cols = Math.ceil(Math.sqrt(sorted.length));

  // Use the bounding box top-left of the selection as anchor
  const anchorX = Math.min(...sorted.map(i => i.position.x));
  const anchorY = Math.min(...sorted.map(i => i.position.y));

  // For each row, compute the max height; for each column, compute the max width
  const colWidths: number[] = [];
  const rowHeights: number[] = [];
  for (let idx = 0; idx < sorted.length; idx++) {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    colWidths[col] = Math.max(colWidths[col] || 0, sorted[idx].size.w);
    rowHeights[row] = Math.max(rowHeights[row] || 0, sorted[idx].size.h);
  }

  // Place each item in its grid cell (centered within the cell)
  let yOffset = 0;
  for (let idx = 0; idx < sorted.length; idx++) {
    const col = idx % cols;
    const row = Math.floor(idx / cols);

    if (col === 0 && row > 0) {
      yOffset += rowHeights[row - 1] + AUTO_LAYOUT_GAP;
    }

    let xOffset = 0;
    for (let c = 0; c < col; c++) {
      xOffset += colWidths[c] + AUTO_LAYOUT_GAP;
    }

    // Center item within its cell
    sorted[idx].position.x = anchorX + xOffset + (colWidths[col] - sorted[idx].size.w) / 2;
    sorted[idx].position.y = anchorY + yOffset + (rowHeights[row] - sorted[idx].size.h) / 2;
  }

  commit();
  rerender();
}

function layoutStack(direction: 'horizontal' | 'vertical') {
  const items = getSelectedItems();
  if (items.length < 2) return;

  // Sort by current position in the stacking direction
  const sorted = direction === 'horizontal'
    ? [...items].sort((a, b) => a.position.x - b.position.x)
    : [...items].sort((a, b) => a.position.y - b.position.y);

  const anchorX = sorted[0].position.x;
  const anchorY = sorted[0].position.y;

  if (direction === 'horizontal') {
    // Align centers vertically, stack left-to-right
    const centerY = items.reduce((s, i) => s + i.position.y + i.size.h / 2, 0) / items.length;
    let x = anchorX;
    for (const item of sorted) {
      item.position.x = x;
      item.position.y = centerY - item.size.h / 2;
      x += item.size.w + AUTO_LAYOUT_GAP;
    }
  } else {
    // Align centers horizontally, stack top-to-bottom
    const centerX = items.reduce((s, i) => s + i.position.x + i.size.w / 2, 0) / items.length;
    let y = anchorY;
    for (const item of sorted) {
      item.position.x = centerX - item.size.w / 2;
      item.position.y = y;
      y += item.size.h + AUTO_LAYOUT_GAP;
    }
  }

  commit();
  rerender();
}

function layoutWrap() {
  const items = getSelectedItems();
  if (items.length < 2) return;

  // Sort items by position (row-major)
  const sorted = [...items].sort((a, b) => {
    const rowA = Math.round(a.position.y / 100);
    const rowB = Math.round(b.position.y / 100);
    if (rowA !== rowB) return rowA - rowB;
    return a.position.x - b.position.x;
  });

  // Use the canvas visible width as the wrap boundary (approximate: 800px max row)
  const anchorX = Math.min(...sorted.map(i => i.position.x));
  const anchorY = Math.min(...sorted.map(i => i.position.y));
  const maxRowWidth = 800;

  let x = 0;
  let y = 0;
  let rowHeight = 0;

  for (const item of sorted) {
    // Wrap to next row if exceeding max width
    if (x > 0 && x + item.size.w > maxRowWidth) {
      x = 0;
      y += rowHeight + AUTO_LAYOUT_GAP;
      rowHeight = 0;
    }
    item.position.x = anchorX + x;
    item.position.y = anchorY + y;
    x += item.size.w + AUTO_LAYOUT_GAP;
    rowHeight = Math.max(rowHeight, item.size.h);
  }

  commit();
  rerender();
}

function toggleLockSelected() {
  if (selectedIds.size === 0) return;
  // If any selected is unlocked, lock all; otherwise unlock all
  let anyUnlocked = false;
  for (const id of selectedIds) {
    const item = findItem(id);
    if (item && !item.locked) { anyUnlocked = true; break; }
  }
  for (const id of selectedIds) {
    const item = findItem(id);
    if (item) item.locked = anyUnlocked ? true : undefined;
  }
  commit();
  rerender();
}

// --- Keyboard shortcuts ---

window.addEventListener('keydown', (e: KeyboardEvent) => {
  if (currentView !== 'board') return;
  if (editingId) return;
  if (presenting) return; // Presentation mode has its own key handler
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  const ctrl = e.ctrlKey || e.metaKey;

  // Search
  if (ctrl && e.key === 'f') {
    e.preventDefault();
    openSearch();
    return;
  }

  // Block editing shortcuts for viewers (allow search, zoom, copy)
  if (isReadOnly()) {
    if (ctrl && e.key === 'f') { e.preventDefault(); openSearch(); }
    if (ctrl && e.key === '0') { e.preventDefault(); zoomToFit(); }
    return;
  }

  // Undo
  if (ctrl && e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    const board = undo();
    if (board) {
      clearSelection();
      applyBoard(board);
    }
    return;
  }

  // Redo
  if (ctrl && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
    e.preventDefault();
    const board = redo();
    if (board) {
      clearSelection();
      applyBoard(board);
    }
    return;
  }

  // Zoom to fit
  if (ctrl && e.key === '0') {
    e.preventDefault();
    zoomToFit();
    return;
  }

  // Export
  if (ctrl && e.key === 's') {
    e.preventDefault();
    exportBoard();
    return;
  }

  // Import
  if (ctrl && e.key === 'o') {
    e.preventDefault();
    importBoard();
    return;
  }

  // Group / Ungroup
  if (ctrl && (e.key === 'g' || e.key === 'G')) {
    e.preventDefault();
    if (e.shiftKey) {
      ungroupSelected();
    } else {
      groupSelected();
    }
    return;
  }

  // Duplicate
  if (ctrl && e.key === 'd') {
    e.preventDefault();
    duplicateSelected();
    return;
  }

  // Copy items
  if (ctrl && e.key === 'c' && selectedIds.size > 0) {
    e.preventDefault();
    copySelected();
    return;
  }

  // Paste items (Ctrl+V)
  if (ctrl && e.key === 'v') {
    // If we have items in the internal clipboard, paste them immediately.
    // Otherwise let the native 'paste' event fire for system-clipboard
    // images / URLs.
    if (clipboard.length > 0) {
      e.preventDefault();
      pasteItems();
    }
    return;  // always return so 'v' tool shortcut doesn't fire
  }

  // --- Single-key shortcuts (only when Ctrl/Meta NOT held) ---
  if (!ctrl) {
    // Lock/unlock
    if ((e.key === 'l' || e.key === 'L') && selectedIds.size > 0) {
      toggleLockSelected();
      return;
    }

    // Add text
    if (e.key === 't' || e.key === 'T') {
      addTextAtCenter();
      return;
    }

    // Add sub-board
    if (e.key === 'b' || e.key === 'B') {
      addSubBoardAtCenter();
      return;
    }

    // Presentation mode
    if (e.key === 'p' || e.key === 'P') {
      if (!presenting) startPresentation();
      return;
    }

    // Select tool
    if (e.key === 'v' || e.key === 'V') {
      activateSelectTool();
      return;
    }

    // Freehand draw mode toggle
    if (e.key === 'd' || e.key === 'D') {
      showDrawMenu();
      return;
    }

    // Frame draw mode toggle
    if (e.key === 'f' || e.key === 'F') {
      if (frameDrawMode) exitFrameDrawMode();
      else showFrameMenu();
      return;
    }

    // Connect mode toggle
    if (e.key === 'c' || e.key === 'C') {
      startConnectMode();
      return;
    }
  }

  // Tag editor
  if ((e.key === 'g' || e.key === 'G') && selectedIds.size > 0) {
    openTagEditor();
    return;
  }

  // Delete all selected (items and/or connections)
  if ((e.key === 'Delete' || e.key === 'Backspace')) {
    if (selectedConnId) {
      const board = getActiveBoard();
      board.connections = board.connections.filter(c => c.id !== selectedConnId);
      selectedConnId = null;
      commit();
      rerender();
      return;
    }
    if (selectedIds.size > 0) {
      const board = getActiveBoard();
      // Clean up sub-boards owned by deleted board-type items
      for (const id of selectedIds) {
        const item = findItem(id);
        if (item?.type === 'board' && item.content) {
          const idx = state.boards.findIndex(b => b.id === item.content);
          if (idx >= 0) state.boards.splice(idx, 1);
        }
      }
      // Also remove connections involving deleted items
      board.connections = board.connections.filter(
        c => !selectedIds.has(c.fromId) && !selectedIds.has(c.toId)
      );
      board.items = board.items.filter(i => !selectedIds.has(i.id));
      clearSelection();
      commit();
      rerender();
      return;
    }
  }

  // Deselect / exit connect mode
  if (e.key === 'Escape') {
    if (freeDrawMode) {
      if (freeDrawing) {
        freeDrawing.svgEl.remove();
        freeDrawing = null;
      }
      exitFreeDrawMode();
      return;
    }
    if (frameDrawMode) {
      if (frameDrawing) {
        frameDrawing.el.remove();
        frameDrawing = null;
      }
      exitFrameDrawMode();
      return;
    }
    if (reconnecting) {
      reconnecting = null;
      connLayer.clearPreview();
      return;
    }
    if (isConnectMode()) {
      exitConnectMode();
      return;
    }
    if (selectedConnId) {
      selectedConnId = null;
      updateConnections();
      return;
    }
    if (selectedIds.size > 0) {
      clearSelection();
      syncSelection();
    }
  }

  // Arrow key nudge
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && selectedIds.size > 0) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    let dx = 0, dy = 0;
    if (e.key === 'ArrowLeft')  dx = -step;
    if (e.key === 'ArrowRight') dx = step;
    if (e.key === 'ArrowUp')    dy = -step;
    if (e.key === 'ArrowDown')  dy = step;

    for (const id of selectedIds) {
      const item = findItem(id);
      if (item && !item.locked) {
        item.position.x += dx;
        item.position.y += dy;
        updateItemPosition(layer, item.id, item.position.x, item.position.y);
      }
    }
    updateConnections();
    commit();
    return;
  }

  // Select all
  if (ctrl && e.key === 'a') {
    e.preventDefault();
    const board = getActiveBoard();
    for (const item of board.items) {
      selectedIds.add(item.id);
    }
    syncSelection();
  }
});