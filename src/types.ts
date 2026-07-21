/** Identifying details of a locally-held original image, used to find/verify it again */
export interface OriginalMeta {
  name: string;
  size: number;
  type: string;
  lastModified: number;
  /** Dimensions of the ORIGINAL file, not of the compressed proxy */
  width: number;
  height: number;
}

export interface BoardItem {
  id: string;
  type: 'image' | 'text' | 'link' | 'color' | 'note' | 'frame' | 'board' | 'draw' | 'embed';
  content: string;
  color?: string;
  /** Optional display title (link items) shown above the domain */
  title?: string;
  /** Stroke width for draw items */
  strokeWidth?: number;
  sourceUrl?: string;
  sourceApp?: 'manual' | 'sondar' | 'chrome-ext';
  position: { x: number; y: number };
  size: { w: number; h: number };
  /** Rotation in degrees, applied around the item's center (absent/0 = unrotated) */
  rotation?: number;
  /**
   * Key into the LOCAL originals store (`orig://<uuid>`) holding the full-quality
   * source image. Deliberately kept out of `content` so the sync layer never
   * uploads it — only the compressed proxy in `content` reaches the server.
   */
  originalRef?: string;
  originalMeta?: OriginalMeta;
  /** Profile that imported the original — others never have the local file */
  originalOwner?: string;
  /** Profile IDs mentioned in this item's text/note content */
  mentions?: string[];
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

export interface Profile {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  color: string;
  is_admin: boolean;
  created_at: string;
}

export interface Comment {
  id: string;
  board_id: string;
  item_id: string;
  profile_id: string;
  content: string;
  created_at: string;
}

export interface BoardState {
  boards: Board[];
  activeBoardId: string | null;
}
