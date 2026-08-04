export const githubSubmissionTests = ({ revisions }) => [
  {
    expected: { artifact: 'review-comment', target: 'current-head' },
    id: 'current-inline-comment',
    target: {
      marker: 'updated-intentional-rewrite',
      revision: revisions['bucket-5'],
    },
    type: 'inline-comment',
  },
  {
    event: 'COMMENT',
    expected: { submittedDrafts: 1, target: 'current-head' },
    id: 'current-review',
    targets: [
      {
        marker: 'review-group-current',
        revision: revisions['bucket-5'],
      },
    ],
    type: 'review',
  },
  {
    expected: { error: 'target-resolution-failed', writes: 0 },
    id: 'historical-target-rejected',
    target: {
      marker: 'delivery-schedule-original',
      revision: revisions['bucket-3'],
    },
    type: 'invalid-target',
  },
];
