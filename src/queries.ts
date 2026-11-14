import type { PipelineStage, Types } from 'mongoose';

type InterestPosition = { interest: string; userId: Types.ObjectId };

export function interestsPipeline(limit: number, cursor?: InterestPosition): PipelineStage[] {
  const pageSize = limit + 1;
  const sort: PipelineStage.Sort = { $sort: { interest: 1, userId: 1 } };
  const take: PipelineStage.Limit = { $limit: pageSize };
  const page: PipelineStage[] = cursor ? [
    { $match: { interest: cursor.interest, userId: { $gt: cursor.userId } } },
    sort,
    take,
    { $unionWith: {
      coll: 'interest_memberships',
      pipeline: [{ $match: { interest: { $gt: cursor.interest } } }, sort, take]
    } },
    sort,
    take
  ] : [sort, take];

  return [
    ...page,
    { $group: { _id: '$interest', users: { $push: { _id: '$userId', name: '$name' } } } },
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
