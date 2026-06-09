/**
 * Image compression utilities.
 *
 * Every image imported into the board goes through `compressImage()` which
 * resizes it to fit within MAX_DIM and re-encodes it as JPEG (or keeps PNG
 * for transparent images).  This keeps localStorage light and board switching
 * fast even with many images.
 */

const MAX_DIM = 1600;   // px – longest side
const JPEG_QUALITY = 0.82;

export interface CompressedImage {
  dataUrl: string;
  /** Natural width after resize */
  width: number;
  /** Natural height after resize */
  height: number;
}

/**
 * Load an image from a data-URL or blob URL and return a decoded
 * HTMLImageElement.  Rejects if the image fails to load.
 */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = src;
  });
}

/**
 * Detect whether the image has any transparent pixels.
 * Uses a small sampled canvas for speed.
 */
function hasTransparency(img: HTMLImageElement): boolean {
  // Sample at a small resolution for speed
  const sampleW = Math.min(img.naturalWidth, 64);
  const sampleH = Math.min(img.naturalHeight, 64);
  const cvs = document.createElement('canvas');
  cvs.width = sampleW;
  cvs.height = sampleH;
  const ctx = cvs.getContext('2d')!;
  ctx.drawImage(img, 0, 0, sampleW, sampleH);
  const data = ctx.getImageData(0, 0, sampleW, sampleH).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) return true;
  }
  return false;
}

/**
 * Compress and resize an image file.
 *
 * - Scales down to fit within MAX_DIM on the longest side.
 * - Re-encodes as JPEG for opaque images, PNG for transparent.
 * - Returns the data URL and the actual dimensions after resize.
 */
export async function compressImage(file: File): Promise<CompressedImage> {
  // Read file as data URL first
  const rawUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });

  const img = await loadImage(rawUrl);
  const { naturalWidth: w, naturalHeight: h } = img;

  // Calculate target dimensions
  let targetW = w;
  let targetH = h;
  if (w > MAX_DIM || h > MAX_DIM) {
    if (w >= h) {
      targetW = MAX_DIM;
      targetH = Math.round(h * (MAX_DIM / w));
    } else {
      targetH = MAX_DIM;
      targetW = Math.round(w * (MAX_DIM / h));
    }
  }

  // Determine format: keep PNG for transparent images
  const isPng = file.type === 'image/png';
  const transparent = isPng && hasTransparency(img);
  const mime = transparent ? 'image/png' : 'image/jpeg';

  // If image is small enough and already JPEG, skip re-encoding
  const alreadySmall = targetW === w && targetH === h;
  const alreadyJpeg = file.type === 'image/jpeg';
  if (alreadySmall && alreadyJpeg) {
    return { dataUrl: rawUrl, width: w, height: h };
  }

  // Draw to canvas at target size
  const cvs = document.createElement('canvas');
  cvs.width = targetW;
  cvs.height = targetH;
  const ctx = cvs.getContext('2d')!;

  if (!transparent) {
    // Fill white background for JPEG (no transparency)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetW, targetH);
  }

  ctx.drawImage(img, 0, 0, targetW, targetH);

  const dataUrl = cvs.toDataURL(mime, mime === 'image/jpeg' ? JPEG_QUALITY : undefined);

  return { dataUrl, width: targetW, height: targetH };
}
