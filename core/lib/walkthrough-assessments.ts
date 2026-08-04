import { maxLength, minLength, parse, picklist, pipe, strictObject, string } from 'valibot';
import type {
  AssessmentCodeScope,
  AssessmentCollection,
  AssessmentComponent,
  AssessmentInput,
  AssessmentThreadComment,
  GenerationMetadata,
  GenerationProfile,
  PullRequestExistingReviewComment,
  ThreadAssessmentResult,
  WalkthroughCapturedContext,
} from '../types.ts';
import {
  assessmentValuesEqual,
  reconcileWalkthroughAssessments,
  type AssessmentDemand,
} from './walkthrough-assessment-cache.ts';
import type { AssessmentSelection } from './walkthrough-assessment-relevance.ts';

export const walkthroughAssessmentAuthoringVersion = 'walkthrough-assessment-1';

export const createAssessmentGenerationProfile = (
  input: Omit<GenerationProfile, 'authoringVersion'>,
): GenerationProfile => {
  if (input.modelCandidates.length === 0) {
    throw new Error('An assessment generation profile requires at least one model candidate.');
  }
  return { ...input, authoringVersion: walkthroughAssessmentAuthoringVersion };
};

const assessmentResponseSchema = strictObject({
  disposition: picklist([
    'addressed',
    'partially-addressed',
    'still-applies',
    'no-longer-applicable',
    'unclear',
  ]),
  explanation: pipe(string(), minLength(1), maxLength(2000)),
});

const cleanText = (value: string, maximum: number) => value.trim().slice(0, maximum);

const commentAnchor = (
  comment: PullRequestExistingReviewComment,
): AssessmentThreadComment['anchor'] =>
  comment.filePath
    ? {
        filePath: comment.filePath,
        ...(comment.lineNumber != null ? { lineNumber: comment.lineNumber } : {}),
        ...(comment.position ? { position: comment.position } : {}),
        ...(comment.side ? { side: comment.side } : {}),
        ...(comment.startLineNumber != null ? { startLineNumber: comment.startLineNumber } : {}),
        ...(comment.startSide ? { startSide: comment.startSide } : {}),
      }
    : undefined;

/** Normalize one provider thread without retaining capabilities or presentation state. */
export const normalizeAssessmentInput = ({
  codeScope,
  comments,
}: {
  codeScope: AssessmentCodeScope;
  comments: ReadonlyArray<PullRequestExistingReviewComment>;
}): AssessmentInput => {
  if (comments.length === 0) {
    throw new Error('Assessment input requires one non-empty review thread.');
  }
  const threadIds = new Set(comments.map((comment) => comment.threadId ?? comment.id));
  if (threadIds.size !== 1) {
    throw new Error('Assessment input cannot combine multiple review threads.');
  }
  const orderedComments = comments.toSorted(
    (left, right) =>
      Date.parse(left.submittedAt ?? '') - Date.parse(right.submittedAt ?? '') ||
      left.id.localeCompare(right.id),
  );
  const rootAnchor = commentAnchor(orderedComments[0]!);
  return {
    codeScope,
    thread: {
      comments: orderedComments.map((comment) => {
        const anchor = commentAnchor(comment) ?? rootAnchor;
        return {
          ...(anchor ? { anchor } : {}),
          author: {
            login: cleanText(comment.author.login, 200),
            ...(comment.author.name ? { name: cleanText(comment.author.name, 200) } : {}),
          },
          body: cleanText(comment.body, 4000),
          id: comment.id,
          ...(comment.submittedAt ? { submittedAt: comment.submittedAt } : {}),
        };
      }),
      id: [...threadIds][0]!,
    },
  };
};

export const createAssessmentDemand = ({
  codeScope,
  comments,
}: {
  codeScope: AssessmentCodeScope;
  comments: ReadonlyArray<PullRequestExistingReviewComment>;
}): AssessmentDemand => {
  const input = normalizeAssessmentInput({ codeScope, comments });
  const root = comments.toSorted(
    (left, right) =>
      Date.parse(left.submittedAt ?? '') - Date.parse(right.submittedAt ?? '') ||
      left.id.localeCompare(right.id),
  )[0]!;
  return {
    capturedPresentationState: {
      threadState: root.isThreadResolved === true ? 'resolved' : 'open',
    },
    identity: { codeScope, threadId: input.thread.id },
    input,
  };
};

/** Join routing demand with captured presentation state only after eligibility is resolved. */
export const createAssessmentDemandsFromSelections = ({
  capturedThreadStateById,
  selections,
}: {
  capturedThreadStateById: ReadonlyMap<string, 'open' | 'resolved'>;
  selections: ReadonlyArray<AssessmentSelection>;
}): ReadonlyArray<AssessmentDemand> =>
  selections.flatMap((selection) => {
    if (selection.kind !== 'eligible') {
      return [];
    }
    const threadState = capturedThreadStateById.get(selection.candidate.thread.id);
    if (!threadState) {
      throw new Error('Eligible assessment demand is missing captured thread presentation state.');
    }
    const input: AssessmentInput = {
      codeScope: selection.codeScope,
      thread: selection.candidate.thread,
    };
    return [
      {
        capturedPresentationState: { threadState },
        identity: { codeScope: selection.codeScope, threadId: input.thread.id },
        input,
      },
    ];
  });

const scopeFiles = (input: AssessmentInput, context: WalkthroughCapturedContext) => {
  const scope = input.codeScope;
  if (scope.type !== 'commit') {
    return context.files;
  }
  return context.files.flatMap((file) => {
    const sections = file.sections.filter(
      (section) =>
        section.range != null &&
        'sha' in section.range.head &&
        section.range.head.sha === scope.sha,
    );
    return sections.length > 0 ? [{ ...file, sections }] : [];
  });
};

/** Deterministic bounded prompt projection for exactly one assessment input. */
export const buildWalkthroughAssessmentPrompt = (
  input: AssessmentInput,
  capturedContext: WalkthroughCapturedContext,
) => `Assess one review thread against its exact captured code scope.

Return one structured disposition and a concise evidence-based explanation. Do not repeat the
thread text, infer presentation metadata, or discuss comments outside this input.

Assessment input:
${JSON.stringify(input)}

Captured code:
${JSON.stringify(
  scopeFiles(input, capturedContext).map((file) => ({
    oldPath: file.oldPath,
    path: file.path,
    sections: file.sections.map((section) => ({
      id: section.id,
      kind: section.kind,
      patch: section.patch.slice(0, 12_000),
      range: section.range,
    })),
    status: file.status,
  })),
)}`;

export const normalizeThreadAssessmentResult = (value: unknown): ThreadAssessmentResult => {
  const result = parse(assessmentResponseSchema, value);
  const paragraphs = result.explanation
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  if (
    paragraphs.length === 0 ||
    paragraphs.some((paragraph) => /(^|\n)\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+\.\s|```)/m.test(paragraph))
  ) {
    throw new Error('Assessment explanation must contain one or two prose paragraphs.');
  }
  return { ...result, explanation: paragraphs.slice(0, 2).join('\n\n') };
};

export const sanitizeAssessmentError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message
      .replaceAll(/(?:Bearer\s+|token[=:]\s*)[^\s,;]+/gi, '[redacted]')
      .replaceAll(/(?:\/[\w.-]+){2,}/g, '[path]')
      .replaceAll(/\s+/g, ' ')
      .trim()
      .slice(0, 500) || 'Assessment generation failed.'
  );
};

export type AssessmentModelResult = {
  generationMetadata: GenerationMetadata;
  response: unknown;
};

export type RunAssessmentModel = (input: {
  capturedContext: WalkthroughCapturedContext;
  input: AssessmentInput;
  profile: GenerationProfile;
  prompt: string;
}) => Promise<AssessmentModelResult>;

const validateGenerationMetadata = (metadata: GenerationMetadata, profile: GenerationProfile) => {
  if (
    profile.authoringVersion !== walkthroughAssessmentAuthoringVersion ||
    !assessmentValuesEqual(metadata.profile, profile) ||
    metadata.agent !== profile.agent ||
    !profile.modelCandidates.includes(metadata.model)
  ) {
    throw new Error('Assessment generation metadata does not match the requested profile.');
  }
};

export const generateAssessmentComponent = async ({
  capturedContext,
  demand,
  profile,
  runModel,
}: {
  capturedContext: WalkthroughCapturedContext;
  demand: AssessmentDemand;
  profile: GenerationProfile;
  runModel: RunAssessmentModel;
}): Promise<AssessmentComponent> => {
  try {
    const generated = await runModel({
      capturedContext,
      input: demand.input,
      profile,
      prompt: buildWalkthroughAssessmentPrompt(demand.input, capturedContext),
    });
    validateGenerationMetadata(generated.generationMetadata, profile);
    return {
      ...demand,
      outcome: {
        generationMetadata: generated.generationMetadata,
        result: normalizeThreadAssessmentResult(generated.response),
        status: 'ready',
      },
    };
  } catch (error) {
    return { ...demand, outcome: { error: sanitizeAssessmentError(error), status: 'failed' } };
  }
};

/** Generate/reuse each demanded assessment independently; sibling failure never gates others. */
export const generateAssessmentCollection = async ({
  capturedContext,
  demands,
  existing = [],
  profile,
  runModel,
}: {
  capturedContext: WalkthroughCapturedContext;
  demands: ReadonlyArray<AssessmentDemand>;
  existing?: ReadonlyArray<AssessmentComponent>;
  profile: GenerationProfile;
  runModel: RunAssessmentModel;
}): Promise<AssessmentCollection> => {
  const reconciliation = reconcileWalkthroughAssessments({
    components: existing,
    demands,
    profile,
  });
  const generated = await Promise.all(
    reconciliation.generate.map((demand) =>
      generateAssessmentComponent({ capturedContext, demand, profile, runModel }),
    ),
  );
  const available = [...reconciliation.reuse, ...generated];
  return {
    items: demands.map((demand) =>
      available.find((component) => assessmentValuesEqual(component.identity, demand.identity))!,
    ),
  };
};
