import type { FileDiffLoadedFiles } from '@pierre/diffs';
import type {
  ChangedFile,
  DiffImageContentResult,
  DiffImageRevision,
  DiffRange,
  DiffSection,
  ResolvedReviewSource,
  ResolvedRevisionBytes,
  Revision,
  RevisionContentBatchRequest,
  RevisionContentBatchResult,
  RevisionContentItemResult,
  RevisionContentRequest,
} from '../types.ts';
import { getSourceRevisionKey } from './source.ts';

export const manualTextFileLimit = 2 * 1024 * 1024;
export const imageFileLimit = 32 * 1024 * 1024;

type WithoutKey<Result> = Result extends unknown ? Omit<Result, 'key'> : never;
type RevisionReadResult = WithoutKey<RevisionContentItemResult>;

export type ReviewContentTransport = (
  request: RevisionContentBatchRequest,
) => Promise<RevisionContentBatchResult>;

export type ReviewContentRunDiagnostics = {
  cacheHits: number;
  sourceCalls: number;
  sourceReads: Readonly<Record<string, number>>;
};

export type ReviewContentRun = {
  abort(reason?: unknown): void;
  diagnostics(): ReviewContentRunDiagnostics;
  readDiffBytes(
    file: Pick<ChangedFile, 'oldPath' | 'path' | 'status'>,
    section: Pick<DiffSection, 'range'>,
    maxBytes?: number,
  ): Promise<{ newBytes: ResolvedRevisionBytes | null; oldBytes: ResolvedRevisionBytes | null }>;
  readDiffBytesBatch(
    requests: ReadonlyArray<{
      file: Pick<ChangedFile, 'oldPath' | 'path' | 'status'>;
      section: Pick<DiffSection, 'range'>;
    }>,
    maxBytes?: number,
  ): Promise<
    ReadonlyArray<{
      newBytes: ResolvedRevisionBytes | null;
      oldBytes: ResolvedRevisionBytes | null;
    }>
  >;
  resolveImage(
    file: Pick<ChangedFile, 'oldPath' | 'path' | 'status'>,
    section: Pick<DiffSection, 'range'>,
  ): Promise<DiffImageContentResult>;
  resolveSectionContents(file: ChangedFile, section: DiffSection): Promise<FileDiffLoadedFiles>;
  resolveSectionContentsBatch(
    requests: ReadonlyArray<{ file: ChangedFile; section: DiffSection }>,
  ): Promise<ReadonlyArray<FileDiffLoadedFiles>>;
};

const revisionKind = (revision: Revision) => revision.kind ?? 'commit';

const revisionCoordinate = (revision: Revision) =>
  revisionKind(revision) === 'commit'
    ? `commit:${'sha' in revision ? revision.sha.toLowerCase() : ''}`
    : revision.kind === 'index'
      ? `index:${revision.stage ?? 0}`
      : 'working-copy';

const contentKey = (
  source: ResolvedReviewSource,
  generation: string,
  revision: Revision,
  path: string,
  maxBytes: number,
) => {
  const kind = revisionKind(revision);
  const mutable = kind === 'commit' ? '' : `:${generation}`;
  return `${getSourceRevisionKey(source)}:${revisionCoordinate(revision)}:${path}:${maxBytes}${mutable}`;
};

const getEffectiveRange = (
  file: Pick<ChangedFile, 'status'>,
  range: DiffRange | undefined,
): DiffRange => {
  if (!range) {
    throw new Error('Exact contents are unavailable because this section has no revision range.');
  }
  return {
    base: file.status === 'added' || file.status === 'untracked' ? null : range.base,
    head: file.status === 'deleted' ? null : range.head,
  };
};

const getImageMimeType = (path: string) => {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
  return new Map([
    ['.apng', 'image/apng'],
    ['.avif', 'image/avif'],
    ['.bmp', 'image/bmp'],
    ['.gif', 'image/gif'],
    ['.ico', 'image/x-icon'],
    ['.jpeg', 'image/jpeg'],
    ['.jpg', 'image/jpeg'],
    ['.png', 'image/png'],
    ['.webp', 'image/webp'],
  ]).get(extension);
};

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = '';
  const chunkSize = 0x80_00;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
};

export const decodeImageRevision = (
  value: ResolvedRevisionBytes | null,
  path: string,
): DiffImageRevision | null => {
  if (!value) {
    return null;
  }
  const mimeType = getImageMimeType(path);
  if (!mimeType) {
    throw new Error('Unsupported image file type.');
  }
  if (value.size > imageFileLimit) {
    throw new Error(
      `Image is larger than ${imageFileLimit} bytes, so Codiff skipped rendering it.`,
    );
  }
  return {
    dataUrl: `data:${mimeType};base64,${bytesToBase64(value.bytes)}`,
    mimeType,
    name: path,
    size: value.size,
  };
};

export const decodeTextRevision = (
  value: ResolvedRevisionBytes | null,
  path: string,
  emptyCacheKey: string,
) => {
  if (!value) {
    return { cacheKey: emptyCacheKey, contents: '', name: path };
  }
  if (value.bytes.includes(0)) {
    throw new Error(`Full review context is unavailable for '${path}': the file is binary.`);
  }
  return {
    cacheKey: value.cacheKey,
    contents: new TextDecoder().decode(value.bytes),
    name: path,
  };
};

export const createReviewContentRun = ({
  generation,
  source,
  transport,
}: {
  generation: string;
  source: ResolvedReviewSource;
  transport: ReviewContentTransport;
}): ReviewContentRun => {
  const controller = new AbortController();
  const values = new Map<string, RevisionReadResult>();
  const pending = new Map<string, Promise<RevisionReadResult>>();
  const sourceReads = new Map<string, number>();
  let cacheHits = 0;
  let sourceCalls = 0;

  const readRevisionBytesBatch = async (
    requests: ReadonlyArray<Omit<RevisionContentRequest, 'key'>>,
  ) => {
    controller.signal.throwIfAborted();
    const keyed = requests.map((request) => ({
      ...request,
      key: contentKey(source, generation, request.revision, request.path, request.maxBytes),
    }));
    const misses = [
      ...new Map(
        keyed
          .filter((request) => {
            if (values.has(request.key) || pending.has(request.key)) {
              cacheHits += 1;
              return false;
            }
            return true;
          })
          .map((request) => [request.key, request]),
      ).values(),
    ];

    if (misses.length > 0) {
      sourceCalls += 1;
      for (const request of misses) {
        sourceReads.set(request.key, (sourceReads.get(request.key) ?? 0) + 1);
      }
      const batch = transport({ generation, requests: misses, source }).then((result) => {
        controller.signal.throwIfAborted();
        return new Map(result.results.map((item) => [item.key, item]));
      });
      for (const request of misses) {
        const promise = batch
          .then((results) => {
            const result = results.get(request.key) ?? {
              key: request.key,
              reason: 'The content reader did not return this revision coordinate.',
              status: 'unavailable' as const,
            };
            const normalized =
              result.status === 'ready'
                ? { status: result.status, value: result.value }
                : result.status === 'missing'
                  ? { status: result.status }
                  : { reason: result.reason, status: result.status };
            values.set(request.key, normalized);
            return normalized;
          })
          .finally(() => pending.delete(request.key));
        pending.set(request.key, promise);
      }
    }

    const results = await Promise.all(
      keyed.map(async (request) => {
        const result = values.get(request.key) ?? (await pending.get(request.key));
        if (!result) {
          throw new Error('Revision content cache entry is unavailable.');
        }
        if (result.status === 'unavailable') {
          throw new Error(result.reason);
        }
        return result.status === 'ready' ? result.value : null;
      }),
    );
    controller.signal.throwIfAborted();
    return results;
  };

  const readDiffBytesBatch: ReviewContentRun['readDiffBytesBatch'] = async (
    requests,
    maxBytes = manualTextFileLimit,
  ) => {
    const descriptors = requests.map(({ file, section }) => {
      const range = getEffectiveRange(file, section.range);
      return {
        newRequest: range.head ? { maxBytes, path: file.path, revision: range.head } : null,
        oldRequest: range.base
          ? { maxBytes, path: file.oldPath ?? file.path, revision: range.base }
          : null,
      };
    });
    const flatRequests = descriptors.flatMap(({ newRequest, oldRequest }) => [
      ...(newRequest ? [newRequest] : []),
      ...(oldRequest ? [oldRequest] : []),
    ]);
    const flatResults = await readRevisionBytesBatch(flatRequests);
    let cursor = 0;
    return descriptors.map(({ newRequest, oldRequest }) => ({
      newBytes: newRequest ? (flatResults[cursor++] ?? null) : null,
      oldBytes: oldRequest ? (flatResults[cursor++] ?? null) : null,
    }));
  };

  const readDiffBytes: ReviewContentRun['readDiffBytes'] = async (file, section, maxBytes) => {
    const [result] = await readDiffBytesBatch([{ file, section }], maxBytes);
    if (!result) {
      throw new Error('Diff content result is unavailable.');
    }
    return result;
  };

  const resolveLoadedFiles = (
    file: ChangedFile,
    section: DiffSection,
    {
      newBytes,
      oldBytes,
    }: {
      newBytes: ResolvedRevisionBytes | null;
      oldBytes: ResolvedRevisionBytes | null;
    },
  ): FileDiffLoadedFiles => {
    if (!newBytes && !oldBytes && file.status !== 'added' && file.status !== 'deleted') {
      throw new Error(`Full review context is unavailable for '${file.path}'.`);
    }
    return {
      newFile: decodeTextRevision(
        newBytes,
        file.path,
        `${getSourceRevisionKey(source)}:${generation}:${file.path}:empty`,
      ),
      oldFile:
        section.range?.base == null || file.status === 'added' || file.status === 'untracked'
          ? null
          : decodeTextRevision(
              oldBytes,
              file.oldPath ?? file.path,
              `${getSourceRevisionKey(source)}:${generation}:${file.oldPath ?? file.path}:empty`,
            ),
    };
  };

  return {
    abort: (reason) => controller.abort(reason),
    diagnostics: () => ({
      cacheHits,
      sourceCalls,
      sourceReads: Object.fromEntries(sourceReads),
    }),
    readDiffBytes,
    readDiffBytesBatch,
    resolveImage: async (file, section) => {
      try {
        const { newBytes, oldBytes } = await readDiffBytes(file, section, imageFileLimit);
        const oldImage = decodeImageRevision(oldBytes, file.oldPath ?? file.path);
        const newImage = decodeImageRevision(newBytes, file.path);
        return oldImage || newImage
          ? {
              ...(newImage ? { newImage } : {}),
              ...(oldImage ? { oldImage } : {}),
              status: 'ready',
            }
          : { reason: 'Codiff could not load either side of this image.', status: 'unavailable' };
      } catch (error) {
        return {
          reason: error instanceof Error ? error.message : 'Codiff could not load this image.',
          status: 'unavailable',
        };
      }
    },
    resolveSectionContents: async (file, section) => {
      const result = await readDiffBytes(file, section);
      return resolveLoadedFiles(file, section, result);
    },
    resolveSectionContentsBatch: async (requests) => {
      const results = await readDiffBytesBatch(requests);
      return requests.map(({ file, section }, index) =>
        resolveLoadedFiles(file, section, results[index]!),
      );
    },
  };
};
