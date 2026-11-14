import mongoose from 'mongoose';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { connectDatabase } from './models.js';

try {
  const config = readConfig();
  await connectDatabase(config.mongoUri);
  const server = createApp(config).listen(config.port, '0.0.0.0', () => {
    console.log('Secure Notes API listening on port %d', config.port);
  });
  server.on('error', async (error: NodeJS.ErrnoException) => {
    console.error('Unable to listen:', error.code);
    await mongoose.disconnect();
    process.exitCode = 1;
  });
  const shutdown = () => {
    server.close(async () => { await mongoose.disconnect(); });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch (error) {
  console.error('Startup failed. Check environment variables, MongoDB connectivity and indexes.',
    error instanceof Error ? error.name : '');
  await mongoose.disconnect();
  process.exitCode = 1;
}
