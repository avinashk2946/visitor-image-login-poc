import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: Number(process.env.PORT || 4000),
  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/visitor-poc',
  faceServiceUrl: process.env.FACE_SERVICE_URL || 'http://localhost:8000',
  matchThreshold: Number(process.env.MATCH_THRESHOLD || 0.35),
  retentionDays: Number(process.env.RETENTION_DAYS || 1)
};
