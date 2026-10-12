export async function startCamera(video) {
  if (!video) throw new Error('Camera preview is not ready');
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: 'user',
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 }
    },
    audio: false
  });
  video.srcObject = stream;
  await video.play();
  return stream;
}

export function stopCamera(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

export function captureFrame(video, options = {}) {
  if (!video) throw new Error('Camera preview is not ready');
  const { maxWidth = 640, quality = 0.82, crop = 'full' } = options;
  const canvas = frameToCanvas(video, { maxWidth, crop });
  return canvas.toDataURL('image/jpeg', quality);
}

function frameToCanvas(video, options = {}) {
  const { maxWidth = 640, crop = 'full' } = options;
  const sourceWidth = video.videoWidth || 960;
  const sourceHeight = video.videoHeight || 540;
  let sx = 0;
  let sy = 0;
  let sw = sourceWidth;
  let sh = sourceHeight;

  if (crop === 'face-guide') {
    const side = Math.min(sourceWidth, sourceHeight) * 0.9;
    sx = (sourceWidth - side) / 2;
    sy = (sourceHeight - side) / 2;
    sw = side;
    sh = side;
  }

  const scale = Math.min(1, maxWidth / sw);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function frameSharpness(canvas) {
  const sampleWidth = Math.min(180, canvas.width);
  const scale = sampleWidth / canvas.width;
  const sampleHeight = Math.max(1, Math.round(canvas.height * scale));
  const sample = document.createElement('canvas');
  sample.width = sampleWidth;
  sample.height = sampleHeight;
  const ctx = sample.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, sampleWidth, sampleHeight);
  const { data } = ctx.getImageData(0, 0, sampleWidth, sampleHeight);
  const gray = new Float32Array(sampleWidth * sampleHeight);
  for (let i = 0, pixel = 0; i < data.length; i += 4, pixel += 1) {
    gray[pixel] = (data[i] * 0.299) + (data[i + 1] * 0.587) + (data[i + 2] * 0.114);
  }

  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let y = 1; y < sampleHeight - 1; y += 1) {
    for (let x = 1; x < sampleWidth - 1; x += 1) {
      const idx = (y * sampleWidth) + x;
      const value = (gray[idx] * 4) - gray[idx - 1] - gray[idx + 1] - gray[idx - sampleWidth] - gray[idx + sampleWidth];
      sum += value;
      sumSquares += value * value;
      count += 1;
    }
  }
  if (!count) return 0;
  const mean = sum / count;
  return (sumSquares / count) - (mean * mean);
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function captureBestFrame(video, options = {}) {
  if (!video) throw new Error('Camera preview is not ready');
  const {
    samples = 4,
    intervalMs = 80,
    quality = 0.9,
    ...frameOptions
  } = options;

  let best = null;
  for (let index = 0; index < samples; index += 1) {
    if (index > 0) await delay(intervalMs);
    const canvas = frameToCanvas(video, frameOptions);
    const sharpness = frameSharpness(canvas);
    if (!best || sharpness > best.sharpness) best = { canvas, sharpness };
  }

  return best.canvas.toDataURL('image/jpeg', quality);
}
