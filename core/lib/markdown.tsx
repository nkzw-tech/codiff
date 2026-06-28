import type { ReactNode } from 'react';

const renderText = (value: string, keyPrefix: string): Array<ReactNode> => {
  const textNodes: Array<ReactNode> = [];
  const emphasisPattern =
    /\*\*([^*\n]+)\*\*|(?<![\w_])_([^_\n]+)_(?![\w_])|(?<![\w*])\*([^*\n]+)\*(?![\w*])/g;
  let textLastIndex = 0;
  let emphasisMatch: RegExpExecArray | null;

  while ((emphasisMatch = emphasisPattern.exec(value))) {
    if (emphasisMatch.index > textLastIndex) {
      textNodes.push(value.slice(textLastIndex, emphasisMatch.index));
    }

    if (emphasisMatch[1] != null) {
      textNodes.push(
        <strong key={`${keyPrefix}:bold:${emphasisMatch.index}`}>{emphasisMatch[1]}</strong>,
      );
    } else {
      textNodes.push(
        <em key={`${keyPrefix}:italic:${emphasisMatch.index}`}>
          {emphasisMatch[2] ?? emphasisMatch[3]}
        </em>,
      );
    }
    textLastIndex = emphasisPattern.lastIndex;
  }

  if (textLastIndex < value.length) {
    textNodes.push(value.slice(textLastIndex));
  }

  return textNodes.length > 0 ? textNodes : [value];
};

const getSafeImageSource = (source: string) => {
  const trimmed = source.trim();

  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? trimmed : null;
  } catch {
    return null;
  }
};

const getHtmlAttribute = (html: string, name: string) => {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i').exec(
    html,
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
};

const getImageDimension = (value: string) => (/^\d{1,5}$/.test(value) ? value : undefined);

const renderImage = (
  source: string,
  alt: string,
  key: string,
  dimensions: { height?: string; width?: string } = {},
) => {
  const safeSource = getSafeImageSource(source);
  if (!safeSource) {
    return null;
  }

  return (
    <img
      alt={alt}
      className="codiff-markdown-image"
      decoding="async"
      height={dimensions.height}
      key={key}
      loading="lazy"
      src={safeSource}
      width={dimensions.width}
    />
  );
};

export const sanitizeMarkdownImages = (text: string) =>
  text.replaceAll(
    /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)|<img\b[^>]*>/gi,
    (match, markdownAlt: string | undefined, markdownSource: string | undefined) => {
      const htmlImage = match.startsWith('<');
      const source = htmlImage ? getHtmlAttribute(match, 'src') : (markdownSource ?? '');
      if (getSafeImageSource(source)) {
        return match;
      }

      const alt = htmlImage ? getHtmlAttribute(match, 'alt') : (markdownAlt ?? '');
      return alt;
    },
  );

export const renderInlineMarkdown = (text: string): ReactNode => {
  const nodes: Array<ReactNode> = [];
  const pattern =
    /`([^`\n]+)`|!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)|<img\b[^>]*>/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) {
      nodes.push(...renderText(text.slice(lastIndex, match.index), `${lastIndex}`));
    }

    if (match[1] != null) {
      nodes.push(
        <code className="walkthrough-inline-code" key={`${match.index}:${match[1]}`}>
          {match[1]}
        </code>,
      );
    } else {
      const htmlImage = match[0].startsWith('<');
      const src = htmlImage ? getHtmlAttribute(match[0], 'src') : (match[3] ?? '');
      const alt = htmlImage ? getHtmlAttribute(match[0], 'alt') : (match[2] ?? '');
      const image = htmlImage
        ? renderImage(src, alt, `image:${match.index}`, {
            height: getImageDimension(getHtmlAttribute(match[0], 'height')),
            width: getImageDimension(getHtmlAttribute(match[0], 'width')),
          })
        : renderImage(src, alt, `image:${match.index}`);
      if (image) {
        nodes.push(image);
      } else {
        nodes.push(...renderText(match[0], `${match.index}:image`));
      }
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(...renderText(text.slice(lastIndex), `${lastIndex}`));
  }

  return nodes.length > 0 ? nodes : text;
};
