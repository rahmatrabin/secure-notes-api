import 'dotenv/config';
import { z } from 'zod';

export function readDatabaseUri() {
  return z.string().regex(/^mongodb(?:\+srv)?:\/\//).parse(process.env.MONGODB_URI);
}

export function readConfig() {
  return {
    mongoUri: readDatabaseUri(),
    secret: z.string().min(43, 'Set JWT_SECRET to a randomly generated secret').parse(process.env.JWT_SECRET),
    frontendOrigin: z.url().refine(value => /^https?:\/\//.test(value) && new URL(value).origin === value)
      .parse(process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173'),
    port: z.coerce.number().int().min(1).max(65535).parse(process.env.PORT ?? 4000),
    trustProxy: z.coerce.number().int().min(0).max(1).parse(process.env.TRUST_PROXY ?? 0)
  };
}
