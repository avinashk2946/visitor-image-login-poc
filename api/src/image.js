import sharp from 'sharp';

export function decodeDataUrl(dataUrl) {
  const match = /^data:image\/(?:jpeg|jpg|png|webp);base64,(.+)$/i.exec(dataUrl || '');
  if (!match) {
    throw new Error('Photo must be a base64 image data URL');
  }
  return Buffer.from(match[1], 'base64');
}

export async function makeThumbnail(imageBuffer) {
  const thumbnail = await sharp(imageBuffer)
    .rotate()
    .resize({ width: 180, height: 180, fit: 'cover' })
    .jpeg({ quality: 75 })
    .toBuffer();

  return `data:image/jpeg;base64,${thumbnail.toString('base64')}`;
}
