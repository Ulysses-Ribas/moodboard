import type { BoardItem } from './types';

const SNAP_THRESHOLD = 6; // pixels in board coordinates

export interface SnapGuide {
  axis: 'x' | 'y';
  position: number; // board coordinate
}

export interface SnapResult {
  dx: number; // correction to apply to position.x
  dy: number; // correction to apply to position.y
  guides: SnapGuide[];
}

/**
 * Calculate snap corrections for an item being dragged.
 * Compares edges and center of the dragged item against edges and centers
 * of all other items on the board.
 */
export function calcSnap(
  draggedIds: Set<string>,
  items: BoardItem[],
  /** The item whose position we're snapping (primary drag target) */
  target: { x: number; y: number; w: number; h: number }
): SnapResult {
  const others = items.filter(i => !draggedIds.has(i.id));
  if (others.length === 0) return { dx: 0, dy: 0, guides: [] };

  // Target edges & center
  const tLeft = target.x;
  const tRight = target.x + target.w;
  const tCenterX = target.x + target.w / 2;
  const tTop = target.y;
  const tBottom = target.y + target.h;
  const tCenterY = target.y + target.h / 2;

  let bestDx = Infinity;
  let bestDy = Infinity;
  const guides: SnapGuide[] = [];

  for (const other of others) {
    const oLeft = other.position.x;
    const oRight = other.position.x + other.size.w;
    const oCenterX = other.position.x + other.size.w / 2;
    const oTop = other.position.y;
    const oBottom = other.position.y + other.size.h;
    const oCenterY = other.position.y + other.size.h / 2;

    // X-axis snaps: left-left, right-right, left-right, right-left, center-center
    const xPairs: [number, number][] = [
      [tLeft, oLeft],
      [tRight, oRight],
      [tLeft, oRight],
      [tRight, oLeft],
      [tCenterX, oCenterX],
    ];

    for (const [tVal, oVal] of xPairs) {
      const diff = oVal - tVal;
      if (Math.abs(diff) < SNAP_THRESHOLD && Math.abs(diff) <= Math.abs(bestDx)) {
        if (Math.abs(diff) < Math.abs(bestDx)) {
          bestDx = diff;
        }
      }
    }

    // Y-axis snaps: top-top, bottom-bottom, top-bottom, bottom-top, center-center
    const yPairs: [number, number][] = [
      [tTop, oTop],
      [tBottom, oBottom],
      [tTop, oBottom],
      [tBottom, oTop],
      [tCenterY, oCenterY],
    ];

    for (const [tVal, oVal] of yPairs) {
      const diff = oVal - tVal;
      if (Math.abs(diff) < SNAP_THRESHOLD && Math.abs(diff) <= Math.abs(bestDy)) {
        if (Math.abs(diff) < Math.abs(bestDy)) {
          bestDy = diff;
        }
      }
    }
  }

  // Finalize: if no snap found, set to 0
  if (Math.abs(bestDx) >= SNAP_THRESHOLD) bestDx = 0;
  if (Math.abs(bestDy) >= SNAP_THRESHOLD) bestDy = 0;

  // Collect guides at the snapped positions
  if (bestDx !== 0) {
    // Re-check which snap lines match at this correction
    const snappedLeft = tLeft + bestDx;
    const snappedRight = tRight + bestDx;
    const snappedCX = tCenterX + bestDx;
    for (const other of others) {
      const oEdges = [other.position.x, other.position.x + other.size.w, other.position.x + other.size.w / 2];
      for (const oe of oEdges) {
        if (Math.abs(oe - snappedLeft) < 0.5 || Math.abs(oe - snappedRight) < 0.5 || Math.abs(oe - snappedCX) < 0.5) {
          guides.push({ axis: 'x', position: oe });
        }
      }
    }
  }
  if (bestDy !== 0) {
    const snappedTop = tTop + bestDy;
    const snappedBottom = tBottom + bestDy;
    const snappedCY = tCenterY + bestDy;
    for (const other of others) {
      const oEdges = [other.position.y, other.position.y + other.size.h, other.position.y + other.size.h / 2];
      for (const oe of oEdges) {
        if (Math.abs(oe - snappedTop) < 0.5 || Math.abs(oe - snappedBottom) < 0.5 || Math.abs(oe - snappedCY) < 0.5) {
          guides.push({ axis: 'y', position: oe });
        }
      }
    }
  }

  // Deduplicate guides
  const unique: SnapGuide[] = [];
  const seen = new Set<string>();
  for (const g of guides) {
    const key = `${g.axis}:${g.position}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(g);
    }
  }

  return { dx: bestDx, dy: bestDy, guides: unique };
}

// --- Guide rendering ---

let guideLayer: SVGSVGElement | null = null;

export function initGuideLayer(canvas: HTMLElement): void {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'snap-guides';
  svg.style.position = 'absolute';
  svg.style.inset = '0';
  svg.style.width = '100%';
  svg.style.height = '100%';
  svg.style.pointerEvents = 'none';
  svg.style.zIndex = '9998';
  svg.style.overflow = 'visible';
  canvas.appendChild(svg);
  guideLayer = svg;
}

export function drawGuides(
  guides: SnapGuide[],
  viewport: { x: number; y: number; zoom: number },
  canvasRect: DOMRect
): void {
  if (!guideLayer) return;
  guideLayer.innerHTML = '';

  for (const guide of guides) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('stroke', 'rgba(192, 57, 43, 0.5)');
    line.setAttribute('stroke-width', '1');
    line.setAttribute('stroke-dasharray', '4 3');

    if (guide.axis === 'x') {
      const sx = guide.position * viewport.zoom + viewport.x;
      line.setAttribute('x1', String(sx));
      line.setAttribute('y1', '0');
      line.setAttribute('x2', String(sx));
      line.setAttribute('y2', String(canvasRect.height));
    } else {
      const sy = guide.position * viewport.zoom + viewport.y;
      line.setAttribute('x1', '0');
      line.setAttribute('y1', String(sy));
      line.setAttribute('x2', String(canvasRect.width));
      line.setAttribute('y2', String(sy));
    }

    guideLayer.appendChild(line);
  }
}

export function clearGuides(): void {
  if (guideLayer) guideLayer.innerHTML = '';
}
