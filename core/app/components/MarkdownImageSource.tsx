import { MarkdownEditor } from '@nkzw/mdx-editor';
import { imagePreviewHandler$, realmPlugin, type RealmPlugin } from '@nkzw/mdx-editor/core';
import { type ComponentProps, useContext, useMemo } from 'react';
import { MarkdownImageSourceContext } from '../../lib/markdownImageSource.ts';
import { mermaidPlugin } from './MermaidCodeBlock.tsx';

// Only the rendered `src` changes; the image node keeps its original source, so edits
// serialize the Markdown as written.
const imageSourcePlugin = realmPlugin<(source: string) => Promise<string>>({
  postInit: (realm, previewImage) => realm.pub(imagePreviewHandler$, previewImage ?? null),
  update: (realm, previewImage) => realm.pub(imagePreviewHandler$, previewImage ?? null),
});

function useMarkdownPlugins(plugins: Array<RealmPlugin> | undefined, renderDiagrams: boolean) {
  const resolveImageSource = useContext(MarkdownImageSourceContext);
  return useMemo(() => {
    if (!resolveImageSource && !renderDiagrams) {
      return plugins;
    }
    const previewImage = resolveImageSource
      ? (source: string) => Promise.resolve(resolveImageSource(source))
      : null;
    return [
      ...(plugins ?? []),
      ...(previewImage ? [imageSourcePlugin(previewImage)] : []),
      ...(renderDiagrams ? [mermaidPlugin()] : []),
    ];
  }, [plugins, renderDiagrams, resolveImageSource]);
}

export function ImageSourceMarkdownEditor({
  additionalPlugins,
  renderDiagrams = false,
  ...props
}: ComponentProps<typeof MarkdownEditor> & { renderDiagrams?: boolean }) {
  return (
    <MarkdownEditor
      {...props}
      additionalPlugins={useMarkdownPlugins(additionalPlugins, renderDiagrams)}
    />
  );
}
