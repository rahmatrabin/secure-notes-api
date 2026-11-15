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

export async function syncInterestMemberships(
  user: InterestUser,
  session: ClientSession,
  previousInterests: string[] = []
) {
  const rows = membershipRows(user);
  const current = new Set(rows.map(row => row.interest));
  const removed = [...new Set(previousInterests)].filter(interest => !current.has(interest));
  if (!removed.length && !rows.length) return;

  await InterestMembership.bulkWrite([
    ...removed.map(interest => ({
      deleteOne: { filter: { interest, userId: user._id } }
    })),
    ...rows.map(({ interest, userId, name }) => ({
      updateOne: {
        filter: { interest, userId },
        update: { $set: { name }, $setOnInsert: { interest, userId } },
        upsert: true
      }
    }))
  ], { session });
}