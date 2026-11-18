# @nkzw/codiff-core

Reusable code diffing primitives from Codiff.

## Example

```tsx
import type { SharedWalkthroughSnapshot } from '@nkzw/codiff-core';
import { ReviewSurface } from '@nkzw/codiff-core/react';
import '@nkzw/codiff-core/styles.css';

export function Review({ snapshot }: { snapshot: SharedWalkthroughSnapshot }) {
  return <ReviewSurface snapshot={snapshot} />;
}
```

## Deferred content

A snapshot can omit large files, unchanged context and image contents. Pass a `contentLoader` to
let `ReviewSurface` request them on demand. Requests carry the snapshot's source and whitespace
preference. Keep the loader referentially stable, since a new loader reloads visible image
previews.

```tsx
import { ReviewSurface, type ReviewContentLoader } from '@nkzw/codiff-core/react';

const contentLoader: ReviewContentLoader = {
  loadImageContent: (request) => host.loadImage(request),
  loadSectionContent: (request) => host.loadSection(request),
};

<ReviewSurface contentLoader={contentLoader} snapshot={snapshot} />;
```
