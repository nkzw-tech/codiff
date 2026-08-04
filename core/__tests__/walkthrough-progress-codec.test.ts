import { expect, test } from 'vite-plus/test';
import {
  decodeWalkthroughProgress,
  encodeWalkthroughProgress,
  walkthroughProgressPrefix,
} from '../lib/walkthrough-progress-codec.ts';

const progress = {
  completed: 1,
  phase: 'generating-units' as const,
  summary: 'Generated 1 of 2 walkthrough tasks.',
  total: 2,
  units: [
    { id: 'task:first', label: 'First task', status: 'ready' as const },
    {
      detail: 'Loading input.',
      id: 'task:second',
      label: 'Second task',
      status: 'preparing' as const,
    },
  ],
};

const encode = (value: unknown) => `${walkthroughProgressPrefix}${JSON.stringify(value)}`;

test('round-trips valid versioned walkthrough progress', () => {
  const encoded = encodeWalkthroughProgress(progress);

  expect(encoded.startsWith(walkthroughProgressPrefix)).toBe(true);
  expect(decodeWalkthroughProgress(encoded)).toEqual(progress);
});

test('rejects malformed and unsupported progress envelopes', () => {
  const payload = JSON.stringify(progress);

  expect(decodeWalkthroughProgress(payload)).toBeNull();
  expect(decodeWalkthroughProgress('codiff-walkthrough-progress:v1')).toBeNull();
  expect(decodeWalkthroughProgress('codiff-walkthrough-progress:v2:' + payload)).toBeNull();
  expect(decodeWalkthroughProgress(`${walkthroughProgressPrefix}{`)).toBeNull();
});

test('rejects unknown fields and invalid identifiers', () => {
  expect(decodeWalkthroughProgress(encode({ ...progress, extra: true }))).toBeNull();
  expect(
    decodeWalkthroughProgress(
      encode({ ...progress, units: [{ ...progress.units[0], unknown: 'field' }] }),
    ),
  ).toBeNull();
  expect(
    decodeWalkthroughProgress(
      encode({ ...progress, units: [{ ...progress.units[0], id: 'bad id' }] }),
    ),
  ).toBeNull();
});
