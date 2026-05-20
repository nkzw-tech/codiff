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

  return url ? (
    <img alt="" className={className} draggable={false} src={url} />
  ) : (
    <span aria-hidden className={`${className} fallback`}>
      {fallback.trim()[0]?.toUpperCase() ?? '?'}
    </span>
  );
}

export { Gravatar };
