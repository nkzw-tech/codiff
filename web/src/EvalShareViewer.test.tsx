// @vitest-environment jsdom

import { act } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';

HTMLElement.prototype.scrollBy ??= function scrollBy() {};

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  container.id = 'root';
  document.body.append(container);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      branch: 'scenario',
      codiffVersion: 'eval',
      exportedAt: '2026-07-24T00:00:00.000Z',
      files: [],
      kind: 'codiff-walkthrough-share',
      preferences: {
        codeFontFamily: 'Fira Code',
        codeFontSize: 13,
        diffStyle: 'split',
        showWhitespace: false,
        theme: 'system',
        wordWrap: false,
      },
      repository: {
        root: 'eval:scenario/test',
        source: {
          provider: 'github',
          title: 'Scenario',
          type: 'pull-request',
          url: 'https://example.invalid/scenario/1',
        },
        title: 'Scenario review',
      },
      version: 1,
      walkthrough: {
        agent: 'codex',
        chapters: [
          {
            blurb: 'Follow the scenario walkthrough.',
            icon: 'path',
            id: 'scenario',
            stops: [
              {
                added: 0,
                deleted: 0,
                hunkIds: [],
                hunks: [],
                id: 'scenario-stop',
                importance: 'critical',
                prose: 'Review the net change.',
                title: 'Net change',
              },
            ],
            title: 'Scenario walkthrough',
          },
        ],
        focus: 'Review the scenario.',
        generatedAt: '2026-07-24T00:00:00.000Z',
        kind: 'narrative',
        repo: { branch: 'scenario', root: 'eval:scenario/test' },
        source: {
          provider: 'github',
          title: 'Scenario',
          type: 'pull-request',
          url: 'https://example.invalid/scenario/1',
        },
        support: [],
        title: 'Frozen scenario review',
        version: 4,
      },
    }),
  );
});

afterEach(() => {
  container.remove();
  vi.restoreAllMocks();
});

test('renders a local manifest through the real shared walkthrough surface', async () => {
  let EvalShareViewer: typeof import('./EvalShareViewer.tsx').EvalShareViewer;
  await act(async () => {
    ({ EvalShareViewer } = await import('./EvalShareViewer.tsx'));
    expect(EvalShareViewer).toBeTypeOf('function');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(globalThis.fetch).toHaveBeenCalledWith('/__codiff_eval/manifest', {
    signal: expect.any(AbortSignal),
  });
  expect(container.textContent).toContain('Net change');
  expect(document.title).toContain('Frozen scenario review');
}, 20_000);
