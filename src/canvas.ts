import type { Board } from './types';

export type Viewport = Board['viewport'];
type ViewportCallback = (viewport: Viewport) => void;

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 5;
const ZOOM_STEP = 0.05;
const GRID_SIZE = 24;

export function screenToBoard(sx: number, sy: number, vp: Viewport) {
  return {
    x: (sx - vp.x) / vp.zoom,
    y: (sy - vp.y) / vp.zoom,
  };
}

export function boardToScreen(bx: number, by: number, vp: Viewport) {
  return {
    x: bx * vp.zoom + vp.x,
    y: by * vp.zoom + vp.y,
  };
}

function applyTransform(layer: HTMLElement, vp: Viewport) {
  layer.style.transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;
  // Expose inverse zoom so resize handles can stay a constant screen size
  layer.style.setProperty('--inv-zoom', String(1 / vp.zoom));
}

function applyGrid(canvas: HTMLElement, vp: Viewport) {
  const size = GRID_SIZE * vp.zoom;
  canvas.style.backgroundSize = `${size}px ${size}px`;
  canvas.style.backgroundPosition = `${vp.x}px ${vp.y}px`;
}

let spaceHeld = false;

export function isSpaceHeld(): boolean {
  return spaceHeld;
}

export function initCanvas(
  container: HTMLElement,
  viewport: Viewport,
  onChange: ViewportCallback
) {
  const vp = { ...viewport };

  const canvas = document.createElement('div');
  canvas.id = 'canvas';

  const layer = document.createElement('div');
  layer.id = 'canvas-layer';
  layer.style.transformOrigin = '0 0';

  canvas.appendChild(layer);
  container.appendChild(canvas);

  applyTransform(layer, vp);
  applyGrid(canvas, vp);

  let isPanning = false;
  let panStartX = 0;
  let panStartY = 0;

  // --- Space key tracking for pan mode ---

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.code === 'Space' && !spaceHeld && !e.repeat) {
      const active = document.activeElement as HTMLElement | null;
      if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable)) return;
      e.preventDefault();
      // Blur focused button so spacebar doesn't trigger its click
      if (active && active.tagName === 'BUTTON') active.blur();
      spaceHeld = true;
      canvas.classList.add('space-held');
    }
  });

  window.addEventListener('keyup', (e: KeyboardEvent) => {
    if (e.code === 'Space' && spaceHeld) {
      spaceHeld = false;
      canvas.classList.remove('space-held');
    }
  });

  // Reset on blur (user switches window while Space is held)
  window.addEventListener('blur', () => {
    if (spaceHeld) {
      spaceHeld = false;
      canvas.classList.remove('space-held');
    }
  });

  function startPan(e: MouseEvent) {
    isPanning = true;
    panStartX = e.clientX - vp.x;
    panStartY = e.clientY - vp.y;
    canvas.classList.add('panning');
  }

  canvas.addEventListener('mousedown', (e: MouseEvent) => {
    // Middle mouse always pans
    if (e.button === 1) {
      startPan(e);
      return;
    }
    // Space + left click pans (anywhere, even on items)
    if (e.button === 0 && spaceHeld) {
      e.preventDefault();
      startPan(e);
    }
  });

  window.addEventListener('mousemove', (e: MouseEvent) => {
    if (!isPanning) return;
    vp.x = e.clientX - panStartX;
    vp.y = e.clientY - panStartY;
    applyTransform(layer, vp);
    applyGrid(canvas, vp);
  });

  window.addEventListener('mouseup', () => {
    if (!isPanning) return;
    isPanning = false;
    canvas.classList.remove('panning');
    onChange({ ...vp });
  });

  canvas.addEventListener('wheel', (e: WheelEvent) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const direction = e.deltaY > 0 ? -1 : 1;
    const factor = 1 + ZOOM_STEP * 3 * direction;
    const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, vp.zoom * factor));

    vp.x = mx - (mx - vp.x) * (newZoom / vp.zoom);
    vp.y = my - (my - vp.y) * (newZoom / vp.zoom);
    vp.zoom = newZoom;

    applyTransform(layer, vp);
    applyGrid(canvas, vp);
    onChange({ ...vp });
  }, { passive: false });

  function getViewport(): Viewport {
    return { ...vp };
  }

  function getCanvasRect() {
    return canvas.getBoundingClientRect();
  }

  function setZoom(newZoom: number) {
    const rect = canvas.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newZoom));
    vp.x = cx - (cx - vp.x) * (clamped / vp.zoom);
    vp.y = cy - (cy - vp.y) * (clamped / vp.zoom);
    vp.zoom = clamped;
    applyTransform(layer, vp);
    applyGrid(canvas, vp);
    onChange({ ...vp });
  }

  function resetView() {
    vp.x = 0;
    vp.y = 0;
    vp.zoom = 1;
    applyTransform(layer, vp);
    applyGrid(canvas, vp);
    onChange({ ...vp });
  }

  /** Set viewport directly (e.g. when switching boards) */
  function setViewport(newVp: Viewport) {
    vp.x = newVp.x;
    vp.y = newVp.y;
    vp.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newVp.zoom));
    applyTransform(layer, vp);
    applyGrid(canvas, vp);
  }

  return { canvas, layer, getViewport, getCanvasRect, setZoom, resetView, setViewport };
}
