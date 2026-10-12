import { config } from './config.js';

export async function getEmbedding(imageBuffer, filename = 'capture.jpg') {
  const form = new FormData();
  form.append('image', new Blob([imageBuffer], { type: 'image/jpeg' }), filename);

  const response = await fetch(`${config.faceServiceUrl}/embed`, {
    method: 'POST',
    body: form
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.detail || body.error || 'Face service rejected the image');
  }
  return body;
}

export async function recognizeSubjects(imageBuffer, subjects, filename = 'capture.jpg') {
  const form = new FormData();
  form.append('image', new Blob([imageBuffer], { type: 'image/jpeg' }), filename);
  form.append('subjects', JSON.stringify(subjects));

  const response = await fetch(`${config.faceServiceUrl}/recognize`, {
    method: 'POST',
    body: form
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.detail || body.error || 'Face service rejected the recognition request');
  }
  return body;
}

export function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
