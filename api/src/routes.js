import express from 'express';
import multer from 'multer';
import { config } from './config.js';
import { Attempt, Visitor } from './models.js';
import { getEmbedding, recognizeSubjects } from './faceClient.js';
import { decodeDataUrl, makeThumbnail } from './image.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
export const router = express.Router();

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function imageFromRequest(req) {
  if (req.file?.buffer) return req.file.buffer;
  if (req.body.photo) return decodeDataUrl(req.body.photo);
  if (req.body.image) return decodeDataUrl(req.body.image);
  throw new Error('A photo/image is required');
}

function registrationImageBuffers(req) {
  const photos = req.files?.photos || [];
  const legacyPhoto = req.files?.photo || [];
  const uploaded = [...photos, ...legacyPhoto].map((file) => file.buffer);
  if (uploaded.length) return uploaded;

  if (Array.isArray(req.body.photos)) return req.body.photos.map(decodeDataUrl);
  if (req.body.photos) return [decodeDataUrl(req.body.photos)];
  return [imageFromRequest(req)];
}

function parseFaceModel(value, required = false) {
  if (!value) {
    if (required) throw new Error('A valid 3D face model is required');
    return null;
  }
  const model = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(model?.features) || model.features.length < 6) {
    throw new Error('A valid 3D face model is required');
  }
  return {
    version: model.version || 'mediapipe-face-landmarker-v1',
    points: Array.isArray(model.points) ? model.points : [],
    features: model.features.map(Number)
  };
}

function faceGeometryScore(a, b) {
  if (!a?.features?.length || !b?.features?.length) return null;
  const count = Math.min(a.features.length, b.features.length);
  if (!count) return null;

  let total = 0;
  for (let index = 0; index < count; index += 1) {
    total += Math.abs(Number(a.features[index]) - Number(b.features[index]));
  }

  const meanDistance = total / count;
  return Math.max(0, Math.min(1, 1 - meanDistance * 2.8));
}

function scoreDetails(best) {
  if (!best) return {};
  return {
    score: best.score,
    embeddingScore: best.embeddingScore,
    geometryScore: best.geometryScore
  };
}

function visitorSummary(visitor) {
  return {
    id: visitor._id,
    name: visitor.name,
    email: visitor.email,
    phone: visitor.phone,
    hostName: visitor.hostName,
    visitDate: visitor.visitDate,
    status: visitor.status,
    checkedInAt: visitor.checkedInAt,
    thumbnail: visitor.thumbnail,
    hasFaceModel: Boolean(visitor.faceModel?.features?.length)
  };
}

router.get('/health', (_req, res) => {
  res.json({ ok: true });
});

router.post('/api/visitors', upload.fields([
  { name: 'photo', maxCount: 1 },
  { name: 'photos', maxCount: 5 }
]), async (req, res, next) => {
  try {
    const consent = req.body.consent === true || req.body.consent === 'true';
    if (!consent) {
      return res.status(400).json({ error: 'Biometric consent is required for pre-registration.' });
    }

    const imageBuffers = registrationImageBuffers(req).slice(0, 1);
    const faceModel = parseFaceModel(req.body.faceModel);
    const embedResult = await getEmbedding(imageBuffers[0], 'registration-3d.jpg');

    const thumbnail = await makeThumbnail(imageBuffers[0]);

    const visitor = await Visitor.create({
      name: req.body.name,
      email: req.body.email,
      phone: req.body.phone,
      hostName: req.body.hostName,
      visitDate: req.body.visitDate,
      consent,
      embedding: embedResult.embedding,
      embeddings: [embedResult.embedding],
      faceModel,
      thumbnail,
      faceQuality: embedResult.quality
    });

    const saved = visitor.toObject();
    delete saved.embedding;
    delete saved.embeddings;
    delete saved.faceModel;
    res.status(201).json(saved);
  } catch (error) {
    next(error);
  }
});

router.get('/api/visitors', async (req, res, next) => {
  try {
    const visitDate = req.query.date || todayIsoDate();
    const visitors = await Visitor.find({ visitDate })
      .select('-embedding')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ visitors });
  } catch (error) {
    next(error);
  }
});

router.get('/api/visitors/:id', async (req, res, next) => {
  try {
    const visitor = await Visitor.findById(req.params.id).select('-embedding -embeddings -faceModel');
    if (!visitor) return res.status(404).json({ error: 'Visitor not found' });
    res.json({ visitor: visitorSummary(visitor) });
  } catch (error) {
    next(error);
  }
});

router.post('/api/kiosk/identify', upload.single('image'), async (req, res, next) => {
  let liveness = {};
  try {
    liveness = req.body.liveness ? JSON.parse(req.body.liveness) : {};

    if (!liveness.passed) {
      await Attempt.create({
        success: false,
        reason: 'Liveness challenge failed',
        liveness
      });
      return res.status(400).json({ matched: false, error: 'Liveness challenge failed' });
    }

    const imageBuffer = imageFromRequest(req);
    const candidates = await Visitor.find({
      visitDate: todayIsoDate(),
      status: 'registered'
    }).select('+embedding +embeddings +faceModel');

    if (!candidates.length) {
      await Attempt.create({
        success: false,
        reason: 'No registered visitors for today',
        liveness
      });
      return res.json({
        matched: false,
        score: 0,
        threshold: config.matchThreshold,
        reason: 'No registered visitors for today'
      });
    }

    const kioskFaceModel = parseFaceModel(req.body.faceModel);
    const subjectPayload = candidates.map((visitor) => ({
      subject: visitor._id.toString(),
      embeddings: visitor.embeddings?.length ? visitor.embeddings : [visitor.embedding]
    }));
    const recognition = await recognizeSubjects(imageBuffer, subjectPayload, 'kiosk.jpg');
    const visitorBySubject = new Map(candidates.map((visitor) => [visitor._id.toString(), visitor]));

    let best = null;
    for (const match of recognition.result || []) {
      const visitor = visitorBySubject.get(match.subject);
      if (!visitor) continue;
      const embeddingScore = match.similarity;
      const geometryScore = faceGeometryScore(kioskFaceModel, visitor.faceModel);
      const score = geometryScore === null ? embeddingScore : ((embeddingScore * 0.78) + (geometryScore * 0.22));
      if (!best || score > best.score) {
        best = { visitor, score, embeddingScore, geometryScore };
      }
    }

    if (!best || best.score < config.matchThreshold) {
      const details = scoreDetails(best);
      await Attempt.create({
        success: false,
        score: details.score,
        reason: best ? `No candidate above threshold; embedding=${best.embeddingScore?.toFixed(3)}, geometry=${best.geometryScore?.toFixed(3) || 'n/a'}` : 'No registered visitors for today',
        liveness
      });
      return res.json({
        matched: false,
        score: details.score || 0,
        embeddingScore: details.embeddingScore,
        geometryScore: details.geometryScore,
        threshold: config.matchThreshold,
        reason: best ? 'No candidate above threshold' : 'No registered visitors for today'
      });
    }

    console.log(`Kiosk match ${best.visitor.name}: score=${best.score.toFixed(3)} embedding=${best.embeddingScore.toFixed(3)} geometry=${best.geometryScore?.toFixed(3) || 'n/a'}`);

    await Attempt.create({
      success: true,
      score: best.score,
      visitor: best.visitor._id,
      visitorName: best.visitor.name,
      reason: 'Face matched; awaiting kiosk confirmation',
      liveness
    });

    res.json({
      matched: true,
      score: best.score,
      embeddingScore: best.embeddingScore,
      geometryScore: best.geometryScore,
      threshold: config.matchThreshold,
      visitor: visitorSummary(best.visitor)
    });
  } catch (error) {
    await Attempt.create({
      success: false,
      reason: error.message,
      liveness
    }).catch(() => {});
    next(error);
  }
});

router.post('/api/kiosk/check-in/:id', async (req, res, next) => {
  try {
    const visitor = await Visitor.findOne({
      _id: req.params.id,
      visitDate: todayIsoDate(),
      status: 'registered'
    });

    if (!visitor) {
      return res.status(404).json({ error: 'Visitor is not available for check-in today.' });
    }

    visitor.status = 'checked_in';
    visitor.checkedInAt = new Date();
    await visitor.save();

    await Attempt.create({
      success: true,
      visitor: visitor._id,
      visitorName: visitor.name,
      reason: 'Kiosk check-in confirmed'
    });

    res.json({ checkedIn: true, visitor: visitorSummary(visitor) });
  } catch (error) {
    next(error);
  }
});

router.delete('/api/visitors/:id', async (req, res, next) => {
  try {
    const deleted = await Visitor.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Visitor not found' });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});
