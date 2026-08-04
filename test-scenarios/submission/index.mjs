const loaders = {
  'current-commit-stack': {
    github: () =>
      import('./notification-preferences/current-commit-stack/github-submission-tests.mjs'),
    gitlab: () =>
      import('./notification-preferences/current-commit-stack/gitlab-submission-tests.mjs'),
  },
  'unstructured-commits': {
    github: () =>
      import('./notification-preferences/unstructured-commits/github-submission-tests.mjs'),
    gitlab: () =>
      import('./notification-preferences/unstructured-commits/gitlab-submission-tests.mjs'),
  },
};

export const getSubmissionPlan = async ({ provider, revisions, scenarioId }) => {
  const load = loaders[scenarioId]?.[provider];
  if (!load) {
    throw new Error(`No ${provider} submission plan for scenario ${scenarioId}.`);
  }
  const module = await load();
  const createPlan =
    provider === 'github' ? module.githubSubmissionTests : module.gitlabSubmissionTests;
  return createPlan({ revisions });
};
