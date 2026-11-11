/**
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { expect, test } from 'vite-plus/test';
import { PullRequestSourceDescription } from '../app/components/ReviewCodeView.tsx';
import { resolveGitHubAssetUrls } from '../lib/markdown.tsx';
import type { ReviewSource } from '../types.ts';
import { renderReact, waitFor } from './helpers/react.tsx';

const videoId = '013867d7-8788-4446-9c66-75d6ba74a91a';
const imageId = 'c29fc8d3-f2b1-41e3-8759-83a840c6aef2';
const videoUrl = `https://github.com/user-attachments/assets/${videoId}`;
const imageUrl = `https://github.com/user-attachments/assets/${imageId}`;
const signedVideoUrl = `https://private-user-images.githubusercontent.com/1/2-${videoId}.webm?jwt=video-token`;
const signedImageUrl = `https://private-user-images.githubusercontent.com/1/3-${imageId}.png?jwt=image-token`;
const assetUrls = { [imageId]: signedImageUrl, [videoId]: signedVideoUrl };

test('GitHub attachment URLs resolve to signed URLs outside code', () => {
  expect(
    resolveGitHubAssetUrls(
      [
        videoUrl,
        `  https://github.com/jitta/mutual-fund/assets/42/${videoId.toUpperCase()}  `,
        `Recording: ${videoUrl}`,
        `<img alt="screen" src="${imageUrl}" />`,
        `![screen](${imageUrl})`,
        `https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000000`,
        '```',
        videoUrl,
        '```',
      ].join('\n'),
      assetUrls,
    ).split('\n'),
  ).toEqual([
    `![](${signedVideoUrl})`,
    `![](${signedVideoUrl})`,
    `Recording: ${videoUrl}`,
    `<img alt="screen" src="${signedImageUrl}" />`,
    `![screen](${signedImageUrl})`,
    `https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000000`,
    '```',
    videoUrl,
    '```',
  ]);
});

const source = {
  canEditDescription: true,
  description: `## Evidence\n\n${videoUrl}\n`,
  descriptionAssetUrls: assetUrls,
  number: 392,
  provider: 'github',
  title: 'Videos',
  type: 'pull-request',
  url: 'https://github.com/jitta/mutual-fund/pull/392',
} satisfies ReviewSource;

test('PR descriptions play private GitHub attachment videos but edit the original Markdown', async () => {
  await using app = await renderReact(
    <PullRequestSourceDescription onUpdateDescription={() => {}} source={source} />,
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
