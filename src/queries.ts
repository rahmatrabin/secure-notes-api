import type { PipelineStage, Types } from 'mongoose';

type InterestPosition = { interest: string; userId: Types.ObjectId };

export function interestsPipeline(limit: number, cursor?: InterestPosition): PipelineStage[] {
  const pipeline: PipelineStage[] = [
    { $match: { active: true } },
    { $project: { name: 1, interests: 1 } },
    { $unwind: '$interests' }
  ];
  if (cursor) {
    pipeline.push({ $match: { $or: [
      { interests: { $gt: cursor.interest } },
      { interests: cursor.interest, _id: { $gt: cursor.userId } }
    ] } });
  }
  // Page memberships before grouping, keeping the number of returned members bounded.
  return [
    ...pipeline,
    { $sort: { interests: 1, _id: 1 } },
    { $limit: limit + 1 },
    { $group: { _id: '$interests', users: { $push: { _id: '$_id', name: '$name' } } } },
    { $sort: { _id: 1 } }
  ];
}

export function postsPipeline(authorId: Types.ObjectId, limit: number, cursor?: Types.ObjectId): PipelineStage[] {
  const postPage: PipelineStage.Lookup['$lookup']['pipeline'] = [
    ...(cursor ? [{ $match: { _id: { $lt: cursor } } }] : []),
    { $sort: { _id: -1 } },
    { $limit: limit + 1 },
    { $project: { title: 1, body: 1, createdAt: 1 } }
  ];
  return [
    { $match: { _id: authorId, active: true } },
    { $lookup: {
      from: 'posts', localField: '_id', foreignField: 'authorId',
      pipeline: postPage, as: 'posts'
    } },
    { $project: { name: 1, posts: 1 } }
  ];
}
