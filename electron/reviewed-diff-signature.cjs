// @ts-check

const revisionIdentity = (range) =>
  range
    ? `${range.base?.kind || (range.base ? 'commit' : 'absent')}:${range.base?.sha || ''}:${range.head?.kind || (range.head ? 'commit' : 'absent')}:${range.head?.sha || ''}`
    : '';

/**
 * Stable identity for the reviewed diff. Base-only range changes invalidate
 * the signature independently of provider ordering.
 *
 * @param {ReadonlyArray<import('../core/types.ts').ChangedFile>} files
 */
const getReviewedDiffSignature = (files) => {
  const input = [...files]
    .sort((left, right) => {
      const path = left.path.localeCompare(right.path);
      return path || (left.oldPath || '').localeCompare(right.oldPath || '');
    })
    .flatMap((file) => [
      file.path,
      file.oldPath || '',
      file.status,
      file.fingerprint,
      ...[...file.sections].map((section) => revisionIdentity(section.range)).sort(),
    ])
    .join('\0');
  let hash = 2_166_136_261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16);
};

module.exports = { getReviewedDiffSignature };
