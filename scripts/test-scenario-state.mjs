import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export const assertReusableStatePath = async (path) => {
  let contents;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  if (!contents.trim()) {
    return;
  }
  let existing;
  try {
    existing = JSON.parse(contents);
  } catch {
    throw new Error(`Refusing to replace unreadable scenario state at ${path}.`);
  }
  if (!Array.isArray(existing.reviews) || existing.reviews.length > 0) {
    throw new Error(
      `Refusing to replace live scenario state at ${path}. Run destroy --state ${JSON.stringify(path)} --yes first.`,
    );
  }
};

export const writeStateAtomically = async (path, state) => {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
};

const upsertScenarioReview = (state, review) => {
  const index = state.reviews.findIndex(
    (candidate) => candidate.provider === review.provider && candidate.scenario === review.scenario,
  );
  if (index === -1) {
    state.reviews.push(review);
  } else {
    state.reviews[index] = review;
  }
};

export const createStatePersistence = (path, state) => async (review) => {
  upsertScenarioReview(state, review);
  await writeStateAtomically(path, state);
};
