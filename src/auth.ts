import { supabase } from './supabase';
import type { User, Session } from '@supabase/supabase-js';
import type { Profile } from './types';

export type AuthState = {
  user: User | null;
  profile: Profile | null;
  session: Session | null;
};

const listeners: ((state: AuthState) => void)[] = [];
let current: AuthState = { user: null, profile: null, session: null };

export function getAuth(): AuthState {
  return current;
}

export function onAuthChange(fn: (state: AuthState) => void): () => void {
  listeners.push(fn);
  return () => {
    const idx = listeners.indexOf(fn);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

function notify() {
  for (const fn of listeners) fn(current);
}

export async function fetchProfile(userId: string): Promise<Profile | null> {
  const { data } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();
  return data as Profile | null;
}

export async function initAuth(): Promise<AuthState> {
  try {
    const sessionResult = await Promise.race([
      supabase.auth.getSession(),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 5000)),
    ]);
    if (sessionResult && 'data' in sessionResult) {
      const session = sessionResult.data.session;
      if (session?.user) {
        const profile = await fetchProfile(session.user.id);
        current = { user: session.user, profile, session };
      }
    }
  } catch {
    // Supabase unreachable — continue offline
  }

  supabase.auth.onAuthStateChange(async (_event, session) => {
    if (session?.user) {
      const profile = await fetchProfile(session.user.id);
      current = { user: session.user, profile, session };
    } else {
      current = { user: null, profile: null, session: null };
    }
    notify();
  });

  return current;
}

export async function signIn(email: string, password: string): Promise<{ error: string | null }> {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (!error && data.user) {
    const profile = await fetchProfile(data.user.id);
    current = { user: data.user, profile, session: data.session };
  }
  return { error: error?.message ?? null };
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
  current = { user: null, profile: null, session: null };
  notify();
}

export async function createUser(
  email: string,
  password: string,
  displayName: string,
  color: string
): Promise<{ error: string | null; userId: string | null }> {
  const { createClient } = await import('@supabase/supabase-js');
  const url = import.meta.env.VITE_SUPABASE_URL as string;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
  const tempClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await tempClient.auth.signUp({ email, password });
  if (error) return { error: error.message, userId: null };
  if (!data.user) return { error: 'Falha ao criar usuário', userId: null };

  const userId = data.user.id;

  await supabase.from('profiles').update({
    display_name: displayName,
    color,
  }).eq('id', userId);

  return { error: null, userId };
}

export async function updateProfile(
  userId: string,
  updates: Partial<Pick<Profile, 'display_name' | 'avatar_url' | 'color'>>
): Promise<void> {
  await supabase.from('profiles').update(updates).eq('id', userId);
}

export async function getAllProfiles(): Promise<Profile[]> {
  const { data } = await supabase.from('profiles').select('*').order('created_at');
  return (data as Profile[]) || [];
}
