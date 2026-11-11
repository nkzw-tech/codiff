import { frontmatterPlugin, imagePlugin } from '@nkzw/mdx-editor/core';
import { useCallback, useContext } from 'react';
import { embedGitHubAttachments, getGitHubAttachmentId } from '../../lib/github-attachments.ts';
import {
  MarkdownImageSourceContext,
  MarkdownImageSourceProvider,
} from '../../lib/markdownImageSource.ts';
import { ReadOnlyMarkdownView } from './ReadOnlyMarkdownView.tsx';

const plugins = [
  frontmatterPlugin(),
  imagePlugin({ disableImageResize: true, disableImageSettingsButton: true }),
];

export default function MarkdownPreviewDocument({
  ariaLabel,
  attachmentUrls,
  className,
  density = 'document',
  onHeightChange,
  value,
  variant = 'plain',
}: {
  ariaLabel: string;
  attachmentUrls?: Readonly<Record<string, string>>;
  className: string;
  density?: 'compact' | 'document';
  onHeightChange?: (height: number) => void;
  value: string;
  variant?: 'embedded' | 'plain';
}) {
  const inheritedResolver = useContext(MarkdownImageSourceContext);
  const resolveImageSource = useCallback(
    (source: string) => {
      const id = getGitHubAttachmentId(source);
      return (id ? attachmentUrls?.[id] : undefined) ?? inheritedResolver?.(source) ?? source;
    },
    [attachmentUrls, inheritedResolver],
  );
  const prepareMarkdown = useCallback(
    (markdown: string) =>
      attachmentUrls ? embedGitHubAttachments(markdown, attachmentUrls) : markdown,
    [attachmentUrls],
  );
  const preview = (
    <ReadOnlyMarkdownView
      additionalPlugins={plugins}
      ariaLabel={ariaLabel}
      className={className}
      density={density}
      onHeightChange={onHeightChange}
      prepareMarkdown={attachmentUrls ? prepareMarkdown : undefined}
      value={value}
      variant={variant}
    />
  );
  return attachmentUrls ? (
    <MarkdownImageSourceProvider value={resolveImageSource}>{preview}</MarkdownImageSourceProvider>
  ) : (
    preview
  );
}
