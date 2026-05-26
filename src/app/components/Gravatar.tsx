import { useState } from 'react';

function Gravatar({
  fallback,
  size,
  url,
}: {
  fallback: string;
  size: 'medium' | 'small';
  url?: string;
}) {
  const className = `gravatar ${size}`;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = url && failedUrl !== url;

  return showImage ? (
    <img
      alt=""
      className={className}
      draggable={false}
      onError={() => setFailedUrl(url)}
      src={url}
    />
  ) : (
    <span aria-hidden className={`${className} fallback`}>
      {fallback.trim()[0]?.toUpperCase() ?? '?'}
    </span>
  );
}

export { Gravatar };
