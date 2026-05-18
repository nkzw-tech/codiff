import type {
  CodiffPreferences,
  CodiffLaunchOptions,
  DiffSection,
  DiffSectionContentRequest,
  GitIdentity,
  RepositoryHistory,
  RepositoryState,
  ReviewSource,
  WalkthroughResult,
} from './types.ts';

declare global {
  interface Window {
    codiff: {
      getDiffSectionContent: (request: DiffSectionContentRequest) => Promise<DiffSection>;
      getGitIdentity: () => Promise<GitIdentity>;
      getLaunchOptions: () => Promise<CodiffLaunchOptions>;
      getPreferences: () => Promise<CodiffPreferences>;
      getRepositoryHistory: (limit?: number) => Promise<RepositoryHistory>;
      getRepositoryState: (source?: ReviewSource) => Promise<RepositoryState>;
      getWalkthrough: (source?: ReviewSource) => Promise<WalkthroughResult>;
      onFindInDiffs: (callback: () => void) => () => void;
      onPreferencesChanged: (callback: (preferences: CodiffPreferences) => void) => () => void;
      onRepositoryChanged: (callback: (change: { root: string }) => void) => () => void;
      showInFolder: (path: string) => Promise<void>;
      writeReviewComments: (payload: {
        comments: ReadonlyArray<{
          body: string;
          filePath: string;
          id: string;
          lineNumber: number;
          sectionId: string;
          side: 'additions' | 'deletions';
        }>;
        markdown: string;
      }) => Promise<{ jsonPath: string; markdownPath: string }>;
    };
  }
}
