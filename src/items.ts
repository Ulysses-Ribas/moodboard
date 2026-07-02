import type { BoardItem } from './types';

export function generateId(): string {
  return crypto.randomUUID();
}

export function createItem(
  type: BoardItem['type'],
  position: { x: number; y: number },
  content: string = ''
): BoardItem {
  const defaults: Record<BoardItem['type'], { w: number; h: number }> = {
    image: { w: 240, h: 180 },
    text: { w: 220, h: 140 },
    link: { w: 260, h: 72 },
    color: { w: 100, h: 120 },
    note: { w: 180, h: 160 },
    frame: { w: 400, h: 300 },
    board: { w: 200, h: 140 },
    draw: { w: 100, h: 100 },
    embed: { w: 800, h: 500 },
  };

  return {
    id: generateId(),
    type,
    content,
    sourceApp: 'manual',
    position,
    size: defaults[type],
    zIndex: Date.now(),
    createdAt: Date.now(),
  };
}

/** Deep-clone an item with a new ID and offset position */
export function duplicateItem(item: BoardItem, offset = 20): BoardItem {
  return {
    ...item,
    id: generateId(),
    position: { x: item.position.x + offset, y: item.position.y + offset },
    size: { ...item.size },
    tags: item.tags ? [...item.tags] : undefined,
    locked: undefined,
    groupId: undefined,
    zIndex: Date.now(),
    createdAt: Date.now(),
  };
}
