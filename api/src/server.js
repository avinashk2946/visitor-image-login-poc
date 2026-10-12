import cors from 'cors';
import express from 'express';
import mongoose from 'mongoose';
import morgan from 'morgan';
import { config } from './config.js';
import { startCleanupJob } from './cleanup.js';
import { router } from './routes.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan('dev'));
app.use(router);

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(400).json({ error: error.message || 'Request failed' });
});

await mongoose.connect(config.mongoUri);
startCleanupJob();

app.listen(config.port, () => {
  console.log(`API listening on ${config.port}`);
});
