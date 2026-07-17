import type { BoardItem, Connection } from './types';

/** Get center of an item in board coordinates */
export function getCenter(item: BoardItem): { x: number; y: number } {
  return {
    x: item.position.x + item.size.w / 2,
    y: item.position.y + item.size.h / 2,
  };
}

/** Find the best anchor point on an item's edge facing toward a target point.
 *  Rotation-aware: the edge point is computed in the item's local (unrotated)
 *  frame, then rotated back into board space so it lands on the rotated edge. */
export function getAnchor(item: BoardItem, target: { x: number; y: number }): { x: number; y: number } {
  const cx = item.position.x + item.size.w / 2;
  const cy = item.position.y + item.size.h / 2;
  const hw = item.size.w / 2;
  const hh = item.size.h / 2;
  const rot = item.rotation || 0;

  // Target relative to center, mapped into the item's local frame.
  let dx = target.x - cx;
  let dy = target.y - cy;
  if (rot) {
    const rad = -rot * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;
    dx = lx; dy = ly;
  }

  // Local edge point.
  let ex: number, ey: number;
  if (Math.abs(dx) * hh > Math.abs(dy) * hw) {
    ex = dx > 0 ? hw : -hw;
    ey = 0;
  } else {
    ex = 0;
    ey = dy > 0 ? hh : -hh;
  }

  // Rotate the local edge point back into board space.
  if (rot) {
    const rad = rot * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    return { x: cx + ex * cos - ey * sin, y: cy + ex * sin + ey * cos };
  }
  return { x: cx + ex, y: cy + ey };
}

/** Build a quadratic bezier path between two items */
function buildPath(from: BoardItem, to: BoardItem): string {
  const fromCenter = getCenter(from);
  const toCenter = getCenter(to);
  const p1 = getAnchor(from, toCenter);
  const p2 = getAnchor(to, fromCenter);

  // Control point: perpendicular offset from midpoint
  const mx = (p1.x + p2.x) / 2;
  const my = (p1.y + p2.y) / 2;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const curvature = Math.min(40, dist * 0.15);
  // Perpendicular direction
  const nx = -dy / (dist || 1) * curvature;
  const ny = dx / (dist || 1) * curvature;
  const cpx = mx + nx;
  const cpy = my + ny;

  return `M ${p1.x} ${p1.y} Q ${cpx} ${cpy} ${p2.x} ${p2.y}`;
}

/** Label midpoint on the curve */
function getLabelPos(from: BoardItem, to: BoardItem): { x: number; y: number } {
  const fromCenter = getCenter(from);
  const toCenter = getCenter(to);
  const p1 = getAnchor(from, toCenter);
  const p2 = getAnchor(to, fromCenter);
  return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 - 12 };
}

export interface ConnectionLayerApi {
  update: (items: BoardItem[], connections: Connection[], selectedConnId: string | null) => void;
  updatePreview: (from: BoardItem, toPoint: { x: number; y: number }) => void;
  clearPreview: () => void;
  destroy: () => void;
  getElement: () => SVGSVGElement;
}

export function createConnectionLayer(layer: HTMLElement): ConnectionLayerApi {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'connection-layer';
  svg.style.position = 'absolute';
  svg.style.inset = '0';
  svg.style.width = '100%';
  svg.style.height = '100%';
  svg.style.pointerEvents = 'none';
  svg.style.overflow = 'visible';
  // Must have explicit z-index above all items so hit paths are reachable.
  // Without this, items with z-index (even z-index:1 on frames) paint above
  // the SVG because 'auto' z-index is lower than any explicit positive value.
  // NOTE: keep this reasonable — extreme values (like 2^31-1) cause Chrome
  // compositor issues when the stacking context overlaps other positioned
  // elements (e.g. the home-screen overlay).
  svg.style.zIndex = '10000';
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

  // Arrowhead marker
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  marker.setAttribute('id', 'arrowhead');
  marker.setAttribute('markerWidth', '8');
  marker.setAttribute('markerHeight', '6');
  marker.setAttribute('refX', '7');
  marker.setAttribute('refY', '3');
  marker.setAttribute('orient', 'auto');
  const arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arrowPath.setAttribute('d', 'M 0 0 L 8 3 L 0 6 Z');
  arrowPath.setAttribute('fill', '#8a8a8a');
  marker.appendChild(arrowPath);

  // Selected marker
  const markerSel = marker.cloneNode(true) as SVGMarkerElement;
  markerSel.setAttribute('id', 'arrowhead-sel');
  const selPath = markerSel.querySelector('path')!;
  selPath.setAttribute('fill', '#c0392b');

  defs.append(marker, markerSel);
  svg.appendChild(defs);

  // Preview line
  const preview = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  preview.setAttribute('stroke', '#c0392b');
  preview.setAttribute('stroke-width', '2');
  preview.setAttribute('stroke-dasharray', '6 4');
  preview.setAttribute('fill', 'none');
  preview.setAttribute('marker-end', 'url(#arrowhead-sel)');
  preview.style.display = 'none';

  // Insert SVG as last child so connection hitboxes are on top of items.
  // The SVG itself has pointer-events:none so item clicks pass through,
  // but .conn-hit paths use pointer-events:stroke to catch connection clicks.
  layer.appendChild(svg);

  function update(items: BoardItem[], connections: Connection[], selectedConnId: string | null) {
    // Remove old connection elements (keep defs + preview)
    const old = svg.querySelectorAll('.conn-line, .conn-label, .conn-hit');
    for (const el of Array.from(old)) el.remove();

    const itemMap = new Map<string, BoardItem>();
    for (const item of items) itemMap.set(item.id, item);

    for (const conn of connections) {
      const from = itemMap.get(conn.fromId);
      const to = itemMap.get(conn.toId);
      if (!from || !to) continue;

      const isSel = conn.id === selectedConnId;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.classList.add('conn-line');
      path.dataset.connId = conn.id;
      path.setAttribute('d', buildPath(from, to));
      path.setAttribute('stroke', isSel ? '#c0392b' : '#8a8a8a');
      path.setAttribute('stroke-width', isSel ? '2.5' : '1.5');
      path.setAttribute('fill', 'none');
      path.setAttribute('marker-end', isSel ? 'url(#arrowhead-sel)' : 'url(#arrowhead)');
      svg.appendChild(path);

      // Invisible fat hitbox for click detection
      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      hit.classList.add('conn-hit');
      hit.dataset.connId = conn.id;
      hit.setAttribute('d', buildPath(from, to));
      hit.setAttribute('stroke', 'transparent');
      hit.setAttribute('stroke-width', '14');
      hit.setAttribute('fill', 'none');
      hit.style.pointerEvents = 'stroke';
      hit.style.cursor = 'pointer';
      svg.appendChild(hit);

      // Label
      if (conn.label) {
        const pos = getLabelPos(from, to);
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.classList.add('conn-label');
        text.dataset.connId = conn.id;
        text.setAttribute('x', String(pos.x));
        text.setAttribute('y', String(pos.y));
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('font-family', 'var(--font-sans)');
        text.setAttribute('font-size', '11');
        text.setAttribute('fill', isSel ? '#c0392b' : '#8a8a8a');
        text.textContent = conn.label;
        text.style.pointerEvents = 'none';
        svg.appendChild(text);
      }
    }

    // Ensure preview is last so it renders on top
    if (preview.parentNode === svg) svg.removeChild(preview);
    svg.appendChild(preview);
  }

  function updatePreview(from: BoardItem, toPoint: { x: number; y: number }) {
    const p1 = getAnchor(from, toPoint);
    const mx = (p1.x + toPoint.x) / 2;
    const my = (p1.y + toPoint.y) / 2;
    const d = `M ${p1.x} ${p1.y} Q ${mx} ${my} ${toPoint.x} ${toPoint.y}`;
    preview.setAttribute('d', d);
    preview.style.display = '';
  }

  function clearPreview() {
    preview.style.display = 'none';
  }

  function destroy() {
    svg.remove();
  }

  return { update, updatePreview, clearPreview, destroy, getElement: () => svg };
}
