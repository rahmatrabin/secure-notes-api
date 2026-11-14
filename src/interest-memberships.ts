import type { ClientSession, Types } from 'mongoose';
import { InterestMembership } from './models.js';

type InterestUser = {
  _id: Types.ObjectId;
  name: string;
  active: boolean;
  interests?: string[];
};

export function membershipRows(user: InterestUser) {
  if (!user.active) return [];
  return [...new Set(user.interests ?? [])].map(interest => ({
    userId: user._id, name: user.name, interest
  }));
}

export async function syncInterestMemberships(user: InterestUser, session: ClientSession) {
  await InterestMembership.deleteMany({ userId: user._id }, { session });
  const rows = membershipRows(user);
  if (rows.length) await InterestMembership.insertMany(rows, { session });
}