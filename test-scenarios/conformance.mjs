const callCountMatches = (actual, expected) =>
  expected === 'positive' ? actual > 0 : actual === expected;

/**
 * Evaluate format-neutral scenario invariants. `narrative` is an optional
 * projection for artifact formats that do not expose chapters at their root.
 *
 * @param {{
 *   callTopology?: Record<string, number>,
 *   expectation: any,
 *   narrative?: {chapters: ReadonlyArray<any>, focus: string},
 *   reviewScope?: {comparisonScope?: string, reviewStructure?: string},
 *   walkthrough: any,
 * }} input
 */
export const evaluateScenarioConformance = ({
  callTopology = {},
  expectation,
  narrative = undefined,
  reviewScope = undefined,
  walkthrough,
}) => {
  const failures = [];
  const projection = narrative ?? walkthrough;
  const chapters = Array.isArray(projection?.chapters) ? projection.chapters : [];
  const chapterCount = chapters.length;
  const stopCount = chapters.reduce(
    (total, chapter) => total + (Array.isArray(chapter.stops) ? chapter.stops.length : 0),
    0,
  );

  if (expectation.artifactVersion != null && walkthrough?.version !== expectation.artifactVersion) {
    failures.push(
      `Expected V${expectation.artifactVersion} walkthrough output, received V${walkthrough?.version ?? 'unknown'}.`,
    );
  }
  if (!projection || !Array.isArray(projection.chapters)) {
    failures.push('Expected a narrative projection with chapters.');
  }
  if (expectation.comparisonScope && reviewScope?.comparisonScope !== expectation.comparisonScope) {
    failures.push(
      `Expected ${expectation.comparisonScope} review scope, received ${reviewScope?.comparisonScope ?? 'none'}.`,
    );
  }
  if (expectation.reviewStructure && reviewScope?.reviewStructure !== expectation.reviewStructure) {
    failures.push(
      `Expected ${expectation.reviewStructure} review structure, received ${reviewScope?.reviewStructure ?? 'none'}.`,
    );
  }
  if (chapterCount < expectation.minimumChapters) {
    failures.push(
      `Expected at least ${expectation.minimumChapters} chapters, received ${chapterCount}.`,
    );
  }
  if (stopCount < expectation.minimumStops) {
    failures.push(`Expected at least ${expectation.minimumStops} stops, received ${stopCount}.`);
  }

  for (const [kind, expected] of Object.entries(expectation.callTopology ?? {})) {
    const actual = callTopology[kind] ?? 0;
    if (!callCountMatches(actual, expected)) {
      failures.push(
        `Expected ${kind} model calls to be ${expected === 'positive' ? 'positive' : expected}, received ${actual}.`,
      );
    }
  }

  return {
    chapterCount,
    failures,
    pass: failures.length === 0,
    stopCount,
  };
};
