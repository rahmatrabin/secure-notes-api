import mongoose from 'mongoose';
import { createClient } from 'redis';
import { RedisStore } from 'rate-limit-redis';
import { ApiError } from './input.js';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { connectDatabase } from './models.js';

let redis: ReturnType<typeof createClient> | undefined;

async function closeResources() {
  if (redis?.isOpen) redis.destroy();
  await mongoose.disconnect();
}

try {
  const config = readConfig();
  await connectDatabase(config.mongoUri, {
    manageIndexes: config.manageIndexes,
    maxPoolSize: config.mongoMaxPoolSize
  });

  let loginStore: RedisStore | undefined;
  if (config.redisUrl) {
    const client = createClient({
      url: config.redisUrl,
      disableOfflineQueue: true,
      commandsQueueMaxLength: 1000,
      socket: { connectTimeout: 5000 }
    });
    redis = client;
    client.on('error', error => console.error('Rate limit store error:', error.name));
    const startupDeadline = setTimeout(() => {
      if (client.isOpen && !client.isReady) client.destroy();
    }, 10_000);
    try {
      await client.connect();
    } finally {
      clearTimeout(startupDeadline);
    }
    async function withRedisDeadline<T>(pending: Promise<T>): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;

      try {
        return await Promise.race([
          pending,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error('Redis command deadline exceeded'));
            }, 1500);
          })
        ]);
      } finally {
        clearTimeout(timer);
      }
    }

    await withRedisDeadline(client.ping());
    loginStore = new RedisStore({
      prefix: 'secure-notes:login:',
      sendCommand: async (...args: string[]) => {
        try {
          return await withRedisDeadline(client.sendCommand(args));
        } catch {
          throw new ApiError(503, 'Login is temporarily unavailable');
        }
      }
    });
    await Promise.all([loginStore.incrementScriptSha, loginStore.getScriptSha]);
  }

  const server = createApp({ ...config, loginStore }).listen(config.port, '0.0.0.0', () => {
    console.log('Secure Notes API listening on port %d', config.port);
  });
  server.on('error', error => {
    console.error('Unable to listen:', error.name);
    void closeResources().finally(() => { process.exitCode = 1; });
  });
  const shutdown = () => {
    const deadline = setTimeout(() => process.exit(1), 15_000);
    deadline.unref();
    server.close(() => {
      void closeResources().then(() => clearTimeout(deadline)).catch(() => process.exit(1));
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch (error) {
  console.error('Startup failed:', error instanceof Error ? error.name : 'UnknownError');
  await closeResources();
  process.exitCode = 1;
}
