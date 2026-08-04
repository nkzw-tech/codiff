const transcriptIdentityKeys = new Set([
  'actor',
  'author',
  'assignee',
  'closed_by',
  'committer',
  'merge_user',
  'owner',
  'reviewer',
  'user',
  'viewer',
]);
const forbiddenTranscriptKeys = new Set([
  'author_email',
  'author_name',
  'avatar_url',
  'committer_email',
  'committer_name',
  'email',
  'node_id',
  'public_email',
]);

const providerProfilePaths = new Set(['/api/v4/user', '/user']);
const sanitizedProviderProfile = Object.freeze({
  login: 'scenario-user',
  username: 'scenario-user',
});

export const isExpectedMissingProviderRoute = (error) => {
  if (!(error instanceof Error)) {
    return false;
  }
  const status = error.status ?? error.statusCode ?? error.response?.status;
  return status === 404 || status === '404' || /\b404\b/.test(error.message);
};

export const captureOptionalProviderRoute = async (operation) => {
  try {
    return await operation();
  } catch (error) {
    if (isExpectedMissingProviderRoute(error)) {
      return null;
    }
    throw error;
  }
};

export const sanitizeProviderTranscript = (value, review, key = '') => {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeProviderTranscript(item, review, key));
  }
  if (value && typeof value === 'object') {
    if (transcriptIdentityKeys.has(key)) {
      return { login: 'scenario-user', username: 'scenario-user' };
    }
    const providerProfileRoute =
      typeof value.path === 'string' && providerProfilePaths.has(value.path);
    return Object.fromEntries(
      Object.entries(value).flatMap(([entryKey, item]) =>
        forbiddenTranscriptKeys.has(entryKey)
          ? []
          : [
              [
                entryKey,
                providerProfileRoute && entryKey === 'response'
                  ? sanitizedProviderProfile
                  : sanitizeProviderTranscript(item, review, entryKey),
              ],
            ],
      ),
    );
  }
  if (typeof value !== 'string') {
    return value;
  }

  const [providerOwner = '', scenarioRepository = ''] = review.repository.split('/', 2);
  let sanitized = value;
  for (const [name, revision] of Object.entries(review.revisions).toSorted(
    ([, left], [, right]) => right.length - left.length,
  )) {
    sanitized = sanitized
      .replaceAll(revision, `{{revision:${name}}}`)
      .replaceAll(revision.slice(0, 8), `{{shortRevision:${name}}}`);
  }
  sanitized = sanitized
    .replaceAll(review.url, '{{review-url}}')
    .replaceAll(encodeURIComponent(review.repository), '{{encodedRepository}}')
    .replaceAll(review.repository, '{{repository}}')
    .replaceAll(providerOwner, '{{provider-owner}}')
    .replaceAll(scenarioRepository, '{{scenario-repository}}');

  return sanitized.replaceAll(/https?:\/\/[^/\s]+/g, (origin) =>
    origin.includes('api.') ? 'https://api.provider.example.test' : 'https://provider.example.test',
  );
};
