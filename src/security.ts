import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import type { RequestHandler } from 'express';
import { Types } from 'mongoose';
import { ApiError, objectId } from './input.js';
import { User } from './models.js';

const issuer = 'secure-notes-api';
const audience = 'secure-notes-client';

export type Principal = { id: Types.ObjectId; role: 'user' | 'admin' };

export function hashPassword(password: string) {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 46 * 1024,
    timeCost: 2,
    parallelism: 1
  });
}

// The fallback keeps missing accounts on the same password-verification path.
const dummyHash = hashPassword(randomBytes(32).toString('hex'));

export async function verifyPassword(hash: string | undefined, password: string) {
  return argon2.verify(hash ?? await dummyHash, password);
}

export function issueToken(id: Types.ObjectId, version: number, secret: string) {
  return jwt.sign({ ver: version }, secret, {
    algorithm: 'HS256', issuer, audience, subject: id.toHexString(), expiresIn: '30m'
  });
}

export function authenticate(secret: string): RequestHandler {
  return async (req, res, next) => {
    const token = /^Bearer ([^\s]+)$/i.exec(req.get('authorization') ?? '')?.[1];
    if (!token) throw new ApiError(401, 'Authentication required');
    let claims;
    try {
      claims = jwt.verify(token, secret, { algorithms: ['HS256'], issuer, audience });
    } catch {
      throw new ApiError(401, 'Invalid or expired session');
    }
    if (typeof claims === 'string' || typeof claims.exp !== 'number') {
      throw new ApiError(401, 'Invalid or expired session');
    }
    const subject = objectId.safeParse(claims.sub);
    if (!subject.success) throw new ApiError(401, 'Invalid or expired session');
    const user = await User.findById(subject.data).select('role active +tokenVersion').lean();
    if (!user?.active || user.tokenVersion !== claims.ver) {
      throw new ApiError(401, 'Invalid or expired session');
    }
    res.locals.principal = { id: user._id, role: user.role } satisfies Principal;
    next();
  };
}

export const requireAdmin: RequestHandler = (_req, res, next) => {
  if (res.locals.principal.role !== 'admin') throw new ApiError(403, 'Admin access required');
  next();
};
