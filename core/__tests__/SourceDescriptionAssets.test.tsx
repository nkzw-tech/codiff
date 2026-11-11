/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { expect, test, vi } from 'vite-plus/test';
import { PullRequestSourceDescription } from '../app/components/ReviewCodeView.tsx';
import { embedGitHubAttachments } from '../lib/github-attachments.ts';
import type { ReviewSource } from '../types.ts';
import { renderReact, waitFor } from './helpers/react.tsx';

const videoId = '013867d7-8788-4446-9c66-75d6ba74a91a';
const imageId = 'c29fc8d3-f2b1-41e3-8759-83a840c6aef2';
const videoUrl = `https://github.com/user-attachments/assets/${videoId}`;
const imageUrl = `https://github.com/user-attachments/assets/${imageId}`;
const signedVideoUrl = `https://private-user-images.githubusercontent.com/1/2-${videoId}.webm?jwt=video-token`;
const signedImageUrl = `https://private-user-images.githubusercontent.com/1/3-${imageId}.png?jwt=image-token`;
const assetUrls = { [imageId]: signedImageUrl, [videoId]: signedVideoUrl };

test('only bare GitHub attachment URLs on their own line become media', () => {
  const legacyUrl = `https://github.com/owner/repo/assets/42/${videoId.toUpperCase()}`;
  const unchanged = [
    `Recording: ${videoUrl}`,
    `[Download](${videoUrl})`,
    `<${videoUrl}>`,
    `![screen](${imageUrl})`,
    `\`![example](${imageUrl})\``,
    'https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000000',
    '',
    `    ${videoUrl}`,
    '',
    '````',
    '````still code',
    videoUrl,
    '````',
    '',
    '> ```',
    `> ${videoUrl}`,
    '> ```',
  ];
  expect(
    embedGitHubAttachments(
      [videoUrl, `  ${legacyUrl}  `, '', ...unchanged].join('\n'),
      assetUrls,
    ).split('\n'),
  ).toEqual([`![](${videoUrl})`, `  ![](${legacyUrl})  `, '', ...unchanged]);
});

const source = {
  canEditDescription: true,
  description: `## Evidence\n\n${videoUrl}\n`,
  number: 392,
  provider: 'github',
  title: 'Videos',
  type: 'pull-request',
  url: 'https://github.com/jitta/mutual-fund/pull/392',
} satisfies ReviewSource;

test('PR descriptions play private GitHub attachment videos but edit the original Markdown', async () => {
  await using app = await renderReact(
    <PullRequestSourceDescription
      descriptionAssetUrls={assetUrls}
      onUpdateDescription={() => {}}
      source={source}
    />,
  );

  await waitFor(() => {
    expect(
      app.container.querySelector<HTMLVideoElement>('.source-description-markdown video')?.src,
    ).toBe(signedVideoUrl);
  });

  const edit = [...app.container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Edit',
  )!;
  await act(async () => edit.click());
  await waitFor(() => {
    expect(app.container.querySelector('.source-description-edit-shell.ready')).not.toBeNull();
  });
  const editor = app.container.querySelector<HTMLElement>(
    '[contenteditable="true"][aria-label="Edit source description"]',
  )!;
  expect(editor.textContent).toContain(videoUrl);
  expect(editor.textContent).not.toContain('jwt=');
});

test('PR descriptions resolve only complete media sources and preserve links and code', async () => {
  const externalImageUrl = `https://example.invalid/screenshot?src=${imageUrl}`;
  const requestedImages: Array<string> = [];
  // jsdom does not load images. Record the requested sources and complete the
  // load so the preview can render them, without making any network requests.
  vi.stubGlobal(
    'Image',
    class {
      onload?: () => void;
      set src(value: string) {
        requestedImages.push(value);
        queueMicrotask(() => this.onload?.());
      }
    },
  );
  try {
    const description = [
      `    ${videoUrl}`,
      `[Download](${imageUrl})`,
      `\`![example](${imageUrl})\``,
      `![Markdown image](${imageUrl})`,
      `<img alt="HTML image [1]" src="${imageUrl}" width="80" />`,
      `![External image](${externalImageUrl})`,
    ].join('\n\n');
    await using app = await renderReact(
      <PullRequestSourceDescription
        descriptionAssetUrls={assetUrls}
        source={{ ...source, description }}
      />,
    );

    await waitFor(() => {
      expect(requestedImages).toContain(externalImageUrl);
      expect(app.container.querySelector('img[alt="Markdown image"]')?.getAttribute('src')).toBe(
        signedImageUrl,
      );
      const htmlImage = app.container.querySelector('img[alt="HTML image [1]"]');
      expect(htmlImage?.getAttribute('src')).toBe(signedImageUrl);
      expect(htmlImage?.getAttribute('width')).toBe('80');
      expect(app.container.querySelector('img[alt="External image"]')?.getAttribute('src')).toBe(
        externalImageUrl,
      );
    });
    expect(app.container.querySelector('a')?.getAttribute('href')).toBe(imageUrl);
    expect(app.container.textContent).toContain(`![example](${imageUrl})`);
    expect(app.container.querySelector('video')).toBeNull();
    expect(new Set(requestedImages)).toEqual(new Set([externalImageUrl, signedImageUrl]));
  } finally {
    vi.unstubAllGlobals();
  }
});
