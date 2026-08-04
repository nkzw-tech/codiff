import type { CommitMetadata, ResolvedReviewSource, ReviewAuthor } from '../types.ts';

export type SourceDescriptionAuthor = {
  avatarUrl?: string;
  displayName: string;
  title?: string;
};

export type SourceDescriptionModel = {
  allowsBodyEdit: boolean;
  allowsTitleEdit: boolean;
  ariaLabel: string;
  author?: SourceDescriptionAuthor;
  body: string;
  defaultCollapsed: boolean;
  identity: string;
  kind: 'commit' | 'pull-request';
  label: string;
  title: string;
};

const getPullRequestDescriptionLabel = (
  source: Extract<ResolvedReviewSource, { type: 'pull-request' }>,
) =>
  source.provider === 'github'
    ? 'PR description'
    : source.provider === 'gitlab'
      ? 'MR description'
      : 'Description';

const getPullRequestDescriptionAuthor = (author: ReviewAuthor): SourceDescriptionAuthor => ({
  avatarUrl: author.avatarUrl,
  displayName: author.name || `@${author.login}`,
  title: `@${author.login}`,
});

const getCommitDescriptionAuthor = (author: CommitMetadata['author']): SourceDescriptionAuthor => ({
  avatarUrl: author.gravatarUrl,
  displayName: author.name || author.email || 'Unknown author',
  title: author.email || undefined,
});

export const buildSourceDescriptionModel = ({
  commitMetadata,
  showPullRequestDescription = true,
  source,
}: {
  commitMetadata: CommitMetadata | null;
  showPullRequestDescription?: boolean;
  source: ResolvedReviewSource;
}): SourceDescriptionModel | null => {
  if (source.type === 'commit' && commitMetadata) {
    return {
      allowsBodyEdit: false,
      allowsTitleEdit: false,
      ariaLabel: 'Preview commit message',
      author: getCommitDescriptionAuthor(commitMetadata.author),
      body: commitMetadata.body.trim(),
      defaultCollapsed: false,
      identity: `commit-message:${source.sha}`,
      kind: 'commit',
      label: 'Commit',
      title: commitMetadata.subject.trim() || commitMetadata.shortSha,
    };
  }

  if (source.type !== 'pull-request' || !showPullRequestDescription) {
    return null;
  }
  const body = source.description?.trim() ?? '';
  const title = source.title?.trim() ?? '';
  if (!body && !title) {
    return null;
  }
  const allowsBodyEdit = source.canEditDescription === true;
  return {
    allowsBodyEdit,
    allowsTitleEdit: source.canEditTitle === true || allowsBodyEdit,
    ariaLabel: 'Preview source description',
    ...(source.author ? { author: getPullRequestDescriptionAuthor(source.author) } : {}),
    body,
    defaultCollapsed: false,
    identity: `source-description:${source.provider ?? ''}:${source.url}:${source.headSha ?? 'unresolved-head'}`,
    kind: 'pull-request',
    label: getPullRequestDescriptionLabel(source),
    title,
  };
};
