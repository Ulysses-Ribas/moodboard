import { supabase } from './supabase';
import { isIdbRef, getImage, saveImage } from './imageStore';
import { uploadImageToStorage } from './storageUpload';
import type { Board, BoardState, BoardItem } from './types';

export type BoardRole = 'owner' | 'editor' | 'viewer';

export async function getBoardRole(boardId: string, userId: string): Promise<BoardRole> {
  const { data: board } = await supabase
    .from('boards')
    .select('owner_id')
    .eq('id', boardId)
    .single();
  if (board?.owner_id === userId) return 'owner';

  const { data: access } = await supabase
    .from('board_access')
    .select('role')
    .eq('board_id', boardId)
    .eq('profile_id', userId)
    .single();
  return (access?.role as BoardRole) || 'viewer';
}

// Upload idb:// image refs to Supabase Storage; expand embeds as inline data
async function expandIdbRefs(items: BoardItem[], userId?: string): Promise<BoardItem[]> {
  const expanded: BoardItem[] = [];
  for (const item of items) {
    if ((item.type === 'image' || item.type === 'embed') && isIdbRef(item.content)) {
      const data = await getImage(item.content);
      if (data) {
        // Only upload actual images to Storage; embeds stay inline
        if (userId && item.type === 'image') {
          const url = await uploadImageToStorage(data, userId);
          if (url) {
            expanded.push({ ...item, content: url });
            continue;
          }
        }
        expanded.push({ ...item, content: data });
        continue;
      }
    }
    expanded.push(item);
  }
  return expanded;
}

// Restore large content to IndexedDB and replace with idb:// refs
export async function compressToIdb(items: BoardItem[]): Promise<boolean> {
  let changed = false;
  for (const item of items) {
    if (item.type === 'image' && item.content.startsWith('data:')) {
      item.content = await saveImage(item.content);
      changed = true;
    }
    if (item.type === 'embed' && !isIdbRef(item.content) && !item.content.startsWith('http') && item.content.length > 1000) {
      item.content = await saveImage(item.content);
      changed = true;
    }
  }
  return changed;
}

export async function loadBoardsFromSupabase(): Promise<Board[]> {
  const { data, error } = await supabase
    .from('boards')
    .select('id, name, data, owner_id, created_at, updated_at')
    .order('updated_at', { ascending: false });

  if (error || !data) {
    console.error('[load] error:', error?.message);
    return [];
  }

  const boards: Board[] = [];
  for (const row of data as any[]) {
    const board = row.data as Board;
    board.id = row.id;
    board.name = row.name;
    board.createdAt = new Date(row.created_at).getTime();
    board.updatedAt = new Date(row.updated_at).getTime();
    // Store large inline content into local IndexedDB
    if (board.items) {
      await compressToIdb(board.items);
    }
    boards.push(board);
  }
  return boards;
}

// Re-save boards that have idb:// refs we can expand locally.
// This pushes inline content to Supabase so other users can see it.
export async function resyncIdbContent(boards: Board[], ownerId: string): Promise<void> {
  for (const board of boards) {
    if (!board.items) continue;
    let hasExpandable = false;
    for (const item of board.items) {
      if ((item.type === 'image' || item.type === 'embed') && isIdbRef(item.content)) {
        const data = await getImage(item.content);
        if (data) { hasExpandable = true; break; }
      }
    }
    if (hasExpandable) {
      await saveBoardToSupabase(board, ownerId);
    }
  }
}

export async function saveBoardToSupabase(board: Board, ownerId: string): Promise<void> {
  const { id, name, ...rest } = board;
  markLocalSave(id);
  // Upload idb:// images to Storage and get public URLs
  const expandedItems = rest.items ? await expandIdbRefs(rest.items, ownerId) : [];
  // Write back Storage URLs to local board items so we don't re-upload
  if (board.items) {
    for (let i = 0; i < board.items.length; i++) {
      if (expandedItems[i] && expandedItems[i].content !== board.items[i].content
          && expandedItems[i].content.startsWith('http')) {
        board.items[i].content = expandedItems[i].content;
      }
    }
  }
  const payload = {
    name,
    data: { ...rest, items: expandedItems },
    updated_at: new Date().toISOString(),
  };

  // Try UPDATE first (doesn't touch owner_id — safe for editors)
  const { data, error: updateErr } = await supabase
    .from('boards')
    .update(payload)
    .eq('id', id)
    .select('id');

  if (updateErr) {
    console.error('[save] update error:', updateErr.message);
    return;
  }

  // If no row was updated, the board doesn't exist yet — INSERT as owner
  if (!data || data.length === 0) {
    const { error: insertErr } = await supabase
      .from('boards')
      .insert({ id, ...payload, owner_id: ownerId });
    if (insertErr) {
      console.error('[save] insert error:', insertErr.message);
    }
  }
}

export async function deleteBoardFromSupabase(boardId: string): Promise<void> {
  await supabase.from('boards').delete().eq('id', boardId);
}

export async function migrateLocalBoards(localState: BoardState, ownerId: string): Promise<void> {
  for (const board of localState.boards) {
    await saveBoardToSupabase(board, ownerId);
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function debouncedSave(board: Board, ownerId: string, delayMs = 2000): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveBoardToSupabase(board, ownerId);
    saveTimer = null;
  }, delayMs);
}

// --- Realtime sync ---

import type { RealtimeChannel } from '@supabase/supabase-js';

let realtimeChannel: RealtimeChannel | null = null;
let ignoreBoardIds = new Set<string>();

// Mark a board as "just saved by us" to avoid echo
export function markLocalSave(boardId: string): void {
  ignoreBoardIds.add(boardId);
  setTimeout(() => ignoreBoardIds.delete(boardId), 3000);
}

export type BoardChangeCallback = (boardId: string, boardData: Board) => void;

export function subscribeToBoardChanges(onUpdate: BoardChangeCallback): () => void {
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
  }

  realtimeChannel = supabase
    .channel('boards-sync')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'boards' },
      async (payload) => {
        const row = payload.new as any;
        if (ignoreBoardIds.has(row.id)) return;

        const board = row.data as Board;
        board.id = row.id;
        board.name = row.name;
        board.updatedAt = new Date(row.updated_at).getTime();
        board.createdAt = new Date(row.created_at).getTime();
        if (board.items) {
          await compressToIdb(board.items);
        }
        onUpdate(row.id, board);
      }
    )
    .subscribe();

  return () => {
    if (realtimeChannel) {
      supabase.removeChannel(realtimeChannel);
      realtimeChannel = null;
    }
  };
}

// --- Board access ---

export interface BoardAccessEntry {
  id: string;
  board_id: string;
  profile_id: string;
  role: 'editor' | 'viewer';
}

export async function getBoardAccess(boardId: string): Promise<BoardAccessEntry[]> {
  const { data } = await supabase
    .from('board_access')
    .select('*')
    .eq('board_id', boardId);
  return (data as BoardAccessEntry[]) || [];
}

export async function setBoardAccess(
  boardId: string,
  profileId: string,
  role: 'editor' | 'viewer'
): Promise<void> {
  await supabase.from('board_access').upsert(
    { board_id: boardId, profile_id: profileId, role },
    { onConflict: 'board_id,profile_id' }
  );
}

export async function removeBoardAccess(boardId: string, profileId: string): Promise<void> {
  await supabase
    .from('board_access')
    .delete()
    .eq('board_id', boardId)
    .eq('profile_id', profileId);
}

export async function getAccessForProfile(profileId: string): Promise<BoardAccessEntry[]> {
  const { data } = await supabase
    .from('board_access')
    .select('*')
    .eq('profile_id', profileId);
  return (data as BoardAccessEntry[]) || [];
}
