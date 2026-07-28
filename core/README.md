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

## Review identity

`codiff main` is a selector. After Git resolves it, the stored source keeps
the exact 40-character commit SHA that was read, not the string `main`. A
GitHub PR or GitLab MR number is also not a commit: the same PR can point at
a new head tomorrow.

`GitSha` is only a full object id. Branch names, tags, bookmarks, and PR/MR
numbers stay ordinary strings. A `Revision` carries a SHA only when it is a
commit. The working copy and index have no SHA.
