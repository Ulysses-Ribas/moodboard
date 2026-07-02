import { supabase } from './supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { Profile } from './types';

export interface PresenceState {
  id: string;
  profile: Profile;
  cursor: { x: number; y: number } | null;
  viewport: { x: number; y: number; zoom: number };
}

export interface FollowTarget {
  centerX: number;
  centerY: number;
  zoom: number;
}

type PresenceCallback = (users: PresenceState[]) => void;
type FollowCallback = (target: FollowTarget) => void;

let channel: RealtimeChannel | null = null;
let onlineUsers: PresenceState[] = [];
let callback: PresenceCallback | null = null;
let localProfileId: string | null = null;

export function getOnlineUsers(): PresenceState[] {
  return onlineUsers;
}

export function onPresenceChange(fn: PresenceCallback): () => void {
  callback = fn;
  return () => { callback = null; };
}

export function joinBoard(boardId: string, profile: Profile, viewport: { x: number; y: number; zoom: number }): void {
  leaveBoard();
  localProfileId = profile.id;

  channel = supabase.channel(`board:${boardId}`, {
    config: { presence: { key: profile.id } },
  });

  channel.on('presence', { event: 'sync' }, () => {
    const state = channel!.presenceState<PresenceState>();
    onlineUsers = [];
    for (const key in state) {
      const entries = state[key] as unknown as PresenceState[];
      if (entries.length > 0 && entries[0].id !== profile.id) {
        onlineUsers.push(entries[0]);
      }
    }
    callback?.(onlineUsers);
  });

  channel.on('broadcast', { event: 'cursor' }, ({ payload }) => {
    if (!payload || payload.id === profile.id) return;
    cursorCallback?.(payload.id, payload.x, payload.y);
  });

  channel.on('broadcast', { event: 'viewport' }, ({ payload }) => {
    if (!payload || payload.id === profile.id) return;
    const user = onlineUsers.find(u => u.id === payload.id);
    if (user) {
      user.viewport = payload.viewport;
    }
    if (followingUserId && payload.id === followingUserId && followCallback) {
      followCallback({
        centerX: payload.centerX,
        centerY: payload.centerY,
        zoom: payload.zoom,
      });
    }
  });

  channel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      await channel!.track({
        id: profile.id,
        profile,
        cursor: null,
        viewport,
      });
    }
  });
}

export function leaveBoard(): void {
  if (channel) {
    channel.untrack();
    channel.unsubscribe();
    channel = null;
  }
  onlineUsers = [];
  localProfileId = null;
  stopFollowing();
}

export function broadcastViewport(
  viewport: { x: number; y: number; zoom: number },
  screenW: number,
  screenH: number
): void {
  if (!channel || !localProfileId) return;
  const centerX = (screenW / 2 - viewport.x) / viewport.zoom;
  const centerY = (screenH / 2 - viewport.y) / viewport.zoom;
  channel.send({
    type: 'broadcast',
    event: 'viewport',
    payload: {
      id: localProfileId,
      viewport,
      centerX,
      centerY,
      zoom: viewport.zoom,
    },
  });
}

export function broadcastCursor(
  cursor: { x: number; y: number } | null,
  profile: Profile,
  viewport: { x: number; y: number; zoom: number }
): void {
  if (!channel) return;
  channel.track({
    id: profile.id,
    profile,
    cursor,
    viewport,
  });
}

let _cursorTimer: ReturnType<typeof setTimeout> | null = null;
export function broadcastCursorPos(x: number, y: number): void {
  if (!channel || !localProfileId) return;
  if (_cursorTimer) return;
  _cursorTimer = setTimeout(() => { _cursorTimer = null; }, 50);
  channel.send({
    type: 'broadcast',
    event: 'cursor',
    payload: { id: localProfileId, x, y },
  });
}

type CursorCallback = (userId: string, x: number, y: number) => void;
let cursorCallback: CursorCallback | null = null;

export function onRemoteCursor(fn: CursorCallback): () => void {
  cursorCallback = fn;
  return () => { cursorCallback = null; };
}

// --- Follow mode ---

let followingUserId: string | null = null;
let followCallback: FollowCallback | null = null;

export function startFollowing(userId: string, onUpdate: FollowCallback): void {
  followingUserId = userId;
  followCallback = onUpdate;
}

export function stopFollowing(): void {
  followingUserId = null;
  followCallback = null;
}

export function getFollowingUserId(): string | null {
  return followingUserId;
}

export function checkFollowUpdate(): void {
  // No-op: follow updates now come via broadcast, not presence sync
}
