import { Types } from 'mongoose';
import { z } from 'zod';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid ObjectId')
  .transform(value => new Types.ObjectId(value));
export const pageSize = z.string().regex(/^[1-9][0-9]?$/).transform(Number)
  .pipe(z.number().max(50)).optional().transform(value => value ?? 20);
export const pageQuery = z.strictObject({ limit: pageSize, cursor: objectId.optional() });
export const email = z.string().trim().toLowerCase().email().max(254);
export const password = z.string()
  .min(6, 'Password must be at least 6 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[A-Z]/, 'Password must include an uppercase letter (A–Z)')
  .regex(/[a-z]/, 'Password must include a lowercase letter (a–z)')
  .regex(/[0-9]/, 'Password must include a digit (0–9)')
  .regex(/[\p{P}\p{S}]/u, 'Password must include a special character');
const title = z.string().trim().min(1).max(160);
const interests = z.array(z.string().trim().toLowerCase().min(1).max(40)).max(20)
  .transform(values => [...new Set(values)]);
export const loginInput = z.strictObject({ email, password: z.string().min(1).max(128) });
const userFields = z.strictObject({
  name: z.string().trim().min(1).max(100),
  email,
  password,
  interests
});
export const createUser = userFields.extend({ interests: interests.default([]) });
export const updateUser = userFields.partial()
  .refine(value => Object.keys(value).length > 0, 'Provide at least one field');
const noteFields = z.strictObject({ title, body: z.string().max(10000) });
export const noteInput = noteFields.extend({ body: noteFields.shape.body.default('') });
export const updateNote = noteFields.partial()
  .refine(value => Object.keys(value).length > 0, 'Provide at least one field');
export const postInput = z.strictObject({ title, body: z.string().trim().min(1).max(10000) });

export function page<T, R>(rows: T[], limit: number, cursor: (row: T) => string, map: (row: T) => R) {
  const visible = rows.slice(0, limit);
  return {
    items: visible.map(map),
    nextCursor: rows.length > limit ? cursor(visible[visible.length - 1]) : null
  };
}
