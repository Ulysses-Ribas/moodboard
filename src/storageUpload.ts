import { supabase } from './supabase';
import { getImage, isIdbRef } from './imageStore';

const BUCKET = 'board-images';

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, base64] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)?.[1] || 'image/jpeg';
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function extFromMime(mime: string): string {
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  return 'jpg';
}

export async function uploadImageToStorage(dataUrl: string, userId: string): Promise<string | null> {
  const blob = dataUrlToBlob(dataUrl);
  const ext = extFromMime(blob.type);
  const path = `${userId}/${crypto.randomUUID()}.${ext}`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, { contentType: blob.type, upsert: false });

  if (error) {
    console.error('[storage] upload error:', error.message);
    return null;
  }

  const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return urlData.publicUrl;
}

export async function migrateIdbToStorage(
  items: { type: string; content: string }[],
  userId: string
): Promise<number> {
  let count = 0;
  for (const item of items) {
    if ((item.type === 'image' || item.type === 'embed') && isIdbRef(item.content)) {
      const dataUrl = await getImage(item.content);
      if (!dataUrl) continue;
      const url = await uploadImageToStorage(dataUrl, userId);
      if (url) {
        item.content = url;
        count++;
      }
    }
  }
  return count;
}
