import type { FileDiffLoadedFiles } from '@pierre/diffs';
import { useCallback, useRef, useState } from 'react';
import {
  getFailedSectionLoadState,
  shouldLoadDiffSectionContents,
  updateDiffSection,
} from '../../lib/diff.ts';
import type {
  ChangedFile,
  DiffImageContentRequest,
  DiffImageContentResult,
  DiffSection,
  DiffSectionContentRequest,
  SharedWalkthroughSnapshot,
} from '../../types.ts';

export type ReviewContentLoader = {
  loadImageContent: (request: DiffImageContentRequest) => Promise<DiffImageContentResult>;
  loadSectionContent: (request: DiffSectionContentRequest) => Promise<DiffSection>;
};

const getInitialState = (snapshot: SharedWalkthroughSnapshot) => ({
  files: snapshot.files,
  loadingSectionIds: new Set<string>() as ReadonlySet<string>,
  snapshot,
});

export function useReviewContentLoader({
  contentLoader,
  onSectionChange,
  snapshot,
}: {
  contentLoader: ReviewContentLoader | undefined;
  onSectionChange: (path: string) => void;
  snapshot: SharedWalkthroughSnapshot;
}) {
  const [storedState, setState] = useState(() => getInitialState(snapshot));
  const state = storedState.snapshot === snapshot ? storedState : getInitialState(snapshot);
  if (state !== storedState) {
    setState(state);
  }
  const pendingSectionsRef = useRef(new WeakSet<DiffSection>());

  const requestSection = useCallback(
    (file: ChangedFile, section: DiffSection) => {
      if (!contentLoader) {
        throw new Error(`Cannot load diff contents for '${file.path}'.`);
      }

      return contentLoader.loadSectionContent({
        force: true,
        kind: section.kind,
        path: file.path,
        showWhitespace: snapshot.preferences.showWhitespace,
        source: snapshot.repository.source,
      });
    },
    [contentLoader, snapshot.preferences.showWhitespace, snapshot.repository.source],
  );

  const loadSection = useCallback(
    async (file: ChangedFile, section: DiffSection) => {
      if (!shouldLoadDiffSectionContents(section) || pendingSectionsRef.current.has(section)) {
        return;
      }

      pendingSectionsRef.current.add(section);
      // A result for a snapshot that has since been replaced is dropped.
      const finish = (update: (section: DiffSection) => DiffSection) => {
        setState((current) => {
          if (current.snapshot !== snapshot) {
            return current;
          }

          const loadingSectionIds = new Set(current.loadingSectionIds);
          loadingSectionIds.delete(section.id);
          return {
            ...current,
            files: updateDiffSection(current.files, file.path, section.id, update),
            loadingSectionIds,
          };
        });
        onSectionChange(file.path);
      };

      setState((current) =>
        current.snapshot === snapshot
          ? { ...current, loadingSectionIds: new Set(current.loadingSectionIds).add(section.id) }
          : current,
      );
      try {
        const loadedSection = await requestSection(file, section);
        finish(() => loadedSection);
      } catch {
        finish(getFailedSectionLoadState);
      } finally {
        pendingSectionsRef.current.delete(section);
      }
    },
    [onSectionChange, requestSection, snapshot],
  );

  // Hydrates a patch-only diff in place, so this must not replace the section.
  const loadSectionContents = useCallback(
    async (file: ChangedFile, section: DiffSection): Promise<FileDiffLoadedFiles> => {
      const { newFile, oldFile } = await requestSection(file, section);
      if (!newFile) {
        throw new Error(`No file contents available for '${file.path}'.`);
      }

      return { newFile, oldFile: oldFile ?? null };
    },
    [requestSection],
  );

  return {
    files: state.files,
    loadingSectionIds: state.loadingSectionIds,
    onLoadImageContent: contentLoader?.loadImageContent,
    onLoadSection: contentLoader ? loadSection : undefined,
    onLoadSectionContents: contentLoader ? loadSectionContents : undefined,
  };
}
