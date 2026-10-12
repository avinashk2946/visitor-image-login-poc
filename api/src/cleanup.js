import cron from 'node-cron';
import { config } from './config.js';
import { Visitor } from './models.js';

export async function runRetentionCleanup() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - config.retentionDays);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  const result = await Visitor.updateMany(
    {
      visitDate: { $lt: cutoffDate },
      $or: [
        { embedding: { $exists: true, $ne: [] } },
        { embeddings: { $exists: true, $ne: [] } },
        { faceModel: { $exists: true, $ne: null } },
        { thumbnail: { $exists: true, $ne: null } }
      ]
    },
    { $set: { embedding: [], embeddings: [], faceModel: null, thumbnail: null } }
  );

  return result.modifiedCount;
}

export function startCleanupJob() {
  cron.schedule('15 * * * *', () => {
    runRetentionCleanup().catch((error) => {
      console.error('Retention cleanup failed', error);
    });
  });
}
