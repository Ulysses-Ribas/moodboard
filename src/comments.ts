import { supabase } from './supabase';
import type { Comment, Profile } from './types';
import type { RealtimeChannel } from '@supabase/supabase-js';

export interface CommentWithAuthor extends Comment {
  author: Profile;
}

const cache = new Map<string, CommentWithAuthor[]>();
const countCache = new Map<string, number>();

export function getCommentCount(itemId: string): number {
  return countCache.get(itemId) || 0;
}

export function getCachedComments(itemId: string): CommentWithAuthor[] | null {
  return cache.get(itemId) || null;
}

export async function loadCommentCounts(boardId: string): Promise<Map<string, number>> {
  const { data, error } = await supabase
    .from('comments')
    .select('item_id')
    .eq('board_id', boardId);

  countCache.clear();
  if (!error && data) {
    for (const row of data) {
      countCache.set(row.item_id, (countCache.get(row.item_id) || 0) + 1);
    }
  }
  return countCache;
}

export async function loadComments(boardId: string, itemId: string): Promise<CommentWithAuthor[]> {
  const { data, error } = await supabase
    .from('comments')
    .select('*, profiles!comments_profile_id_fkey(id, email, display_name, avatar_url, color, is_admin, created_at)')
    .eq('board_id', boardId)
    .eq('item_id', itemId)
    .order('created_at', { ascending: true });

  if (error || !data) return [];

  const comments: CommentWithAuthor[] = (data as any[]).map(row => ({
    id: row.id,
    board_id: row.board_id,
    item_id: row.item_id,
    profile_id: row.profile_id,
    content: row.content,
    created_at: row.created_at,
    author: row.profiles as Profile,
  }));

  cache.set(itemId, comments);
  countCache.set(itemId, comments.length);
  return comments;
}

export async function addComment(
  boardId: string,
  itemId: string,
  profileId: string,
  text: string
): Promise<CommentWithAuthor | null> {
  const { data, error } = await supabase
    .from('comments')
    .insert({ board_id: boardId, item_id: itemId, profile_id: profileId, content: text })
    .select('*, profiles!comments_profile_id_fkey(id, email, display_name, avatar_url, color, is_admin, created_at)')
    .single();

  if (error || !data) return null;

  const row = data as any;
  const comment: CommentWithAuthor = {
    id: row.id,
    board_id: row.board_id,
    item_id: row.item_id,
    profile_id: row.profile_id,
    content: row.content,
    created_at: row.created_at,
    author: row.profiles as Profile,
  };

  const existing = cache.get(itemId) || [];
  existing.push(comment);
  cache.set(itemId, existing);
  countCache.set(itemId, existing.length);

  return comment;
}

export async function deleteComment(commentId: string, itemId: string): Promise<boolean> {
  const { error } = await supabase
    .from('comments')
    .delete()
    .eq('id', commentId);

  if (error) return false;

  const existing = cache.get(itemId);
  if (existing) {
    const filtered = existing.filter(c => c.id !== commentId);
    cache.set(itemId, filtered);
    countCache.set(itemId, filtered.length);
  }

  return true;
}

// --- Realtime ---

let commentsChannel: RealtimeChannel | null = null;
let ignoreCommentIds = new Set<string>();

function markLocalComment(id: string): void {
  ignoreCommentIds.add(id);
  setTimeout(() => ignoreCommentIds.delete(id), 3000);
}

export type CommentChangeCallback = (
  type: 'insert' | 'delete',
  itemId: string,
  comment?: CommentWithAuthor
) => void;

export function subscribeToComments(
  boardId: string,
  onChange: CommentChangeCallback
): () => void {
  if (commentsChannel) {
    supabase.removeChannel(commentsChannel);
  }

  commentsChannel = supabase
    .channel(`comments-sync-${boardId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'comments', filter: `board_id=eq.${boardId}` },
      async (payload) => {
        const row = payload.new as any;
        if (ignoreCommentIds.has(row.id)) return;

        const { data: profileData } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', row.profile_id)
          .single();

        const comment: CommentWithAuthor = {
          id: row.id,
          board_id: row.board_id,
          item_id: row.item_id,
          profile_id: row.profile_id,
          content: row.content,
          created_at: row.created_at,
          author: profileData as Profile,
        };

        const existing = cache.get(row.item_id) || [];
        if (!existing.find(c => c.id === comment.id)) {
          existing.push(comment);
          cache.set(row.item_id, existing);
          countCache.set(row.item_id, existing.length);
        }

        onChange('insert', row.item_id, comment);
      }
    )
    .on(
      'postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'comments', filter: `board_id=eq.${boardId}` },
      (payload) => {
        const row = payload.old as any;
        if (ignoreCommentIds.has(row.id)) return;

        const existing = cache.get(row.item_id);
        if (existing) {
          const filtered = existing.filter(c => c.id !== row.id);
          cache.set(row.item_id, filtered);
          countCache.set(row.item_id, filtered.length);
        }

        onChange('delete', row.item_id);
      }
    )
    .subscribe();

  return () => {
    if (commentsChannel) {
      supabase.removeChannel(commentsChannel);
      commentsChannel = null;
    }
  };
}

export function unsubscribeComments(): void {
  if (commentsChannel) {
    supabase.removeChannel(commentsChannel);
    commentsChannel = null;
  }
  cache.clear();
  countCache.clear();
}

export { markLocalComment };
