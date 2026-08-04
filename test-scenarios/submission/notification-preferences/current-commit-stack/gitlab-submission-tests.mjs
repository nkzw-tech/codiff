export const gitlabSubmissionTests = ({ revisions }) => [
  {
    expected: { artifact: 'discussion', target: 'current-head' },
    id: 'current-inline-comment',
    target: {
      marker: 'updated-intentional-response',
      revision: revisions['lifecycle-verification'],
    },
    type: 'inline-comment',
  },
  {
    event: 'REQUEST_CHANGES',
    expected: { submittedDrafts: 2, target: 'current-head' },
    id: 'current-review',
    targets: [
      {
        marker: 'updated-intentional-response',
        revision: revisions['lifecycle-verification'],
      },
      {
        marker: 'updated-intentional-schedule',
        revision: revisions['lifecycle-verification'],
      },
    ],
    type: 'review',
  },
  {
    expected: { error: 'target-resolution-failed', writes: 0 },
    id: 'historical-target-rejected',
    target: {
      marker: 'delivery-schedule-original',
      revision: revisions['delivery-orchestration'],
    },
    type: 'invalid-target',
  },
];
