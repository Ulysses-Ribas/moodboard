export interface BoardItem {
  id: string;
  type: 'image' | 'text' | 'link' | 'color' | 'note' | 'frame' | 'board' | 'draw';
  content: string;
  color?: string;
  /** Stroke width for draw items */
  strokeWidth?: number;
  sourceUrl?: string;
  sourceApp?: 'manual' | 'sondar' | 'chrome-ext';
  position: { x: number; y: number };
  size: { w: number; h: number };
  tags?: string[];
  locked?: boolean;
  /** Items sharing the same groupId move/select as a unit */
  groupId?: string;
  zIndex: number;
  createdAt: number;
}

export interface Connection {
  id: string;
  fromId: string;
  toId: string;
  label?: string;
}

export interface Board {
  id: string;
  name: string;
  description?: string;
  archived?: boolean;
  /** When true this board is embedded inside a 'board' item and hidden from the home list */
  isSubBoard?: boolean;
  /** Custom slide order for presentation mode (frame IDs). Auto-detected if absent. */
  slideOrder?: string[];
  items: BoardItem[];
  connections: Connection[];
  viewport: { x: number; y: number; zoom: number };
  createdAt: number;
  updatedAt?: number;
}

export interface BoardRef {
  boardId: string;
  boardName: string;
}

export interface BoardState {
  boards: Board[];
  activeBoardId: string | null;
}
