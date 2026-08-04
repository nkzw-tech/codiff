const parseGrepMatch = (line) => {
  const match = /^(.*):(\d+):/.exec(line);
  return match ? { line: Number(match[2]), path: match[1] } : null;
};

/**
 * Resolve a fixture marker to one immutable source line before asking a provider
 * adapter to create a review comment. Ambiguous markers are fixture errors, not
 * an excuse to choose an arbitrary line.
 */
export const resolveSubmissionAnchor = async ({ marker, revision, runGit }) => {
  if (typeof marker !== 'string' || marker.length === 0) {
    throw new Error('A submission anchor marker is required.');
  }
  if (typeof revision !== 'string' || revision.length === 0) {
    throw new Error(`Submission marker '${marker}' has no revision.`);
  }

  let output;
  try {
    output = await runGit(['grep', '-n', '-F', marker, revision, '--']);
  } catch {
    throw new Error(`Submission marker '${marker}' was not found at revision ${revision}.`);
  }
  const matches = String(output)
    .split('\n')
    .map((line) =>
      parseGrepMatch(line.startsWith(`${revision}:`) ? line.slice(revision.length + 1) : line),
    )
    .filter(Boolean);
  if (matches.length !== 1) {
    throw new Error(
      `Submission marker '${marker}' resolved to ${matches.length} lines at revision ${revision}.`,
    );
  }
  return { ...matches[0], revision };
};
