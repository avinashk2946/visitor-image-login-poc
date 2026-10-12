import mongoose from 'mongoose';

const visitorSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    hostName: { type: String, required: true, trim: true },
    visitDate: { type: String, required: true, index: true },
    consent: { type: Boolean, required: true },
    status: {
      type: String,
      enum: ['registered', 'checked_in'],
      default: 'registered',
      index: true
    },
    checkedInAt: { type: Date },
    embedding: { type: [Number], required: true, select: false },
    embeddings: { type: [[Number]], select: false },
    faceModel: { type: mongoose.Schema.Types.Mixed, select: false },
    thumbnail: { type: String },
    faceQuality: {
      det_score: Number,
      face_size: Number,
      blur: Number
    }
  },
  { timestamps: true }
);

const attemptSchema = new mongoose.Schema(
  {
    success: { type: Boolean, required: true, index: true },
    score: Number,
    visitor: { type: mongoose.Schema.Types.ObjectId, ref: 'Visitor' },
    visitorName: String,
    reason: String,
    liveness: {
      passed: Boolean,
      challenge: String
    },
    capturedAt: { type: Date, default: Date.now, index: true }
  },
  { timestamps: true }
);

export const Visitor = mongoose.model('Visitor', visitorSchema);
export const Attempt = mongoose.model('Attempt', attemptSchema);
