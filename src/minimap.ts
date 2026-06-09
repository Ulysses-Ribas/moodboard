import type { BoardItem } from './types';
import type { Viewport } from './canvas';

const MAP_W = 160;
const MAP_H = 120;

interface MinimapTransform {
  minX: number;
  minY: number;
  scale: number;
  offsetX: number;
  offsetY: number;
}

export function createMinimap(
  canvasEl: HTMLElement,
  onNavigate: (boardX: number, boardY: number) => void
): {
  update: (items: BoardItem[], viewport: Viewport, canvasRect: DOMRect) => void;
  destroy: () => void;
} {
  const wrapper = document.createElement('div');
  wrapper.className = 'minimap';

  const cvs = document.createElement('canvas');
  cvs.width = MAP_W;
  cvs.height = MAP_H;
  wrapper.appendChild(cvs);

  canvasEl.appendChild(wrapper);

  const ctx = cvs.getContext('2d')!;
  let transform: MinimapTransform | null = null;
  let isDragging = false;

  function minimapToBoard(mx: number, my: number): { x: number; y: number } | null {
    if (!transform) return null;
    return {
      x: (mx - transform.offsetX) / transform.scale + transform.minX,
      y: (my - transform.offsetY) / transform.scale + transform.minY,
    };
  }

  function handleNav(e: MouseEvent) {
    const rect = cvs.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const pos = minimapToBoard(mx, my);
    if (pos) onNavigate(pos.x, pos.y);
  }

  cvs.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    isDragging = true;
    handleNav(e);
  });

  const onMove = (e: MouseEvent) => {
    if (!isDragging) return;
    handleNav(e);
  };

  const onUp = () => {
    isDragging = false;
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);

  function update(items: BoardItem[], viewport: Viewport, canvasRect: DOMRect) {
    ctx.clearRect(0, 0, MAP_W, MAP_H);

    // Viewport bounds in board coordinates
    const vpLeft = -viewport.x / viewport.zoom;
    const vpTop = -viewport.y / viewport.zoom;
    const vpRight = (canvasRect.width - viewport.x) / viewport.zoom;
    const vpBottom = (canvasRect.height - viewport.y) / viewport.zoom;

    // Bounding box: all items + viewport
    let minX = vpLeft, minY = vpTop, maxX = vpRight, maxY = vpBottom;
    for (const item of items) {
      minX = Math.min(minX, item.position.x);
      minY = Math.min(minY, item.position.y);
      maxX = Math.max(maxX, item.position.x + item.size.w);
      maxY = Math.max(maxY, item.position.y + item.size.h);
    }

    // Padding
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;
    minX -= rangeX * 0.08;
    minY -= rangeY * 0.08;
    maxX += rangeX * 0.08;
    maxY += rangeY * 0.08;

    const totalW = maxX - minX;
    const totalH = maxY - minY;
    const scale = Math.min(MAP_W / totalW, MAP_H / totalH);
    const offsetX = (MAP_W - totalW * scale) / 2;
    const offsetY = (MAP_H - totalH * scale) / 2;

    transform = { minX, minY, scale, offsetX, offsetY };

    // Background
    ctx.fillStyle = 'rgba(246, 244, 239, 0.95)';
    ctx.fillRect(0, 0, MAP_W, MAP_H);

    // Draw items as small rectangles
    const typeColors: Record<string, string> = {
      text: '#d8d4cc',
      image: '#a8b8c8',
      link: '#b8cce0',
    };

    for (const item of items) {
      const x = (item.position.x - minX) * scale + offsetX;
      const y = (item.position.y - minY) * scale + offsetY;
      const w = Math.max(2, item.size.w * scale);
      const h = Math.max(2, item.size.h * scale);

      if (item.type === 'frame') {
        ctx.strokeStyle = '#b0ada6';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 2]);
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle =
          item.type === 'color'
            ? (item.content || '#ccc')
            : item.type === 'note'
            ? (item.color || '#fff9c4')
            : (typeColors[item.type] || '#d8d4cc');
        ctx.fillRect(x, y, w, h);
      }
    }

    // Viewport indicator
    const vx = (vpLeft - minX) * scale + offsetX;
    const vy = (vpTop - minY) * scale + offsetY;
    const vw = (vpRight - vpLeft) * scale;
    const vh = (vpBottom - vpTop) * scale;

    ctx.fillStyle = 'rgba(192, 57, 43, 0.06)';
    ctx.fillRect(vx, vy, vw, vh);
    ctx.strokeStyle = 'rgba(192, 57, 43, 0.6)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(vx, vy, vw, vh);
  }

  function destroy() {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    wrapper.remove();
  }

  return { update, destroy };
}
