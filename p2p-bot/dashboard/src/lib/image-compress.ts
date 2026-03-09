import sharp from 'sharp';

const MAX_WIDTH = 1200;
const MAX_HEIGHT = 1600;
const JPEG_QUALITY = 70;

export interface CompressedImage {
  data: Buffer;
  mimeType: string;
  originalSize: number;
  compressedSize: number;
}

/**
 * Compress an image buffer to JPEG with max dimensions 1200x1600
 */
export async function compressImage(input: Buffer): Promise<CompressedImage> {
  const originalSize = input.length;

  const compressed = await sharp(input)
    .resize(MAX_WIDTH, MAX_HEIGHT, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();

  return {
    data: compressed,
    mimeType: 'image/jpeg',
    originalSize,
    compressedSize: compressed.length,
  };
}
