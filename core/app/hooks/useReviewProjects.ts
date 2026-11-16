import { useEffect, useState } from 'react';
import type { ReviewProject } from '../../types.ts';

const emptyProjects: ReadonlyArray<ReviewProject> = [];

export function useReviewProjects(root: string | undefined) {
  const [result, setResult] = useState<{
    error?: string;
    projects?: ReadonlyArray<ReviewProject>;
    root: string;
  }>();
  const [selection, setSelection] = useState<{ id: string; root: string }>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!root) {
      return;
    }
    let canceled = false;
    void window.codiff.getReviewProjects().then(
      (projects) => {
        if (!canceled) {
          setResult({ projects, root });
        }
      },
      (error: unknown) => {
        if (!canceled) {
          setResult({ error: error instanceof Error ? error.message : String(error), root });
        }
      },
    );
    return () => {
      canceled = true;
    };
  }, [attempt, root]);

  const current = result?.root === root ? result : undefined;
  const projects = current?.projects ?? emptyProjects;
  const project =
    (selection?.root === root && projects.find(({ id }) => selection?.id === id)) || projects[0];

  return {
    error: current?.error,
    loading: !current,
    project,
    projects,
    retry: () => {
      setResult(undefined);
      setAttempt((value) => value + 1);
    },
    select: (id: string) => {
      if (root) {
        setSelection({ id, root });
      }
    },
  };
}
