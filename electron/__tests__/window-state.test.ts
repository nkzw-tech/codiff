import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { readWindowState, validateWindowStateOnScreen, writeWindowState } =
  require('../window-state.cjs') as {
    readWindowState: (configDir?: string) => {
      x: number;
      y: number;
      width: number;
      height: number;
      isMaximized: boolean;
      isFullScreen: boolean;
    } | null;
    validateWindowStateOnScreen: (
      state: { x: number; y: number; width: number; height: number },
      displays: ReadonlyArray<{
        workArea: { x: number; y: number; width: number; height: number };
      }>,
    ) => { x: number; y: number; width: number; height: number } | null;
    writeWindowState: (
      state: {
        x: number;
        y: number;
        width: number;
        height: number;
        isMaximized: boolean;
        isFullScreen: boolean;
      },
      configDir?: string,
    ) => void;
  };

const validState = {
  height: 720,
  isFullScreen: false,
  isMaximized: false,
  width: 1120,
  x: 100,
  y: 50,
};

const primaryDisplay = { workArea: { height: 900, width: 1440, x: 0, y: 0 } };

test('readWindowState returns null when file does not exist', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codiff-ws-'));
  try {
    expect(readWindowState(dir)).toBeNull();
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('readWindowState returns null for corrupt JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codiff-ws-'));
  try {
    await writeFile(join(dir, 'window-state.json'), '{not valid json');
    expect(readWindowState(dir)).toBeNull();
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('readWindowState returns null for invalid fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codiff-ws-'));
  try {
    await writeFile(join(dir, 'window-state.json'), JSON.stringify({ x: 'not a number' }));
    expect(readWindowState(dir)).toBeNull();
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('readWindowState returns null when width is below minimum', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codiff-ws-'));
  try {
    await writeFile(join(dir, 'window-state.json'), JSON.stringify({ ...validState, width: 500 }));
    expect(readWindowState(dir)).toBeNull();
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('readWindowState returns null when height is below minimum', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codiff-ws-'));
  try {
    await writeFile(join(dir, 'window-state.json'), JSON.stringify({ ...validState, height: 400 }));
    expect(readWindowState(dir)).toBeNull();
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('readWindowState returns valid state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codiff-ws-'));
  try {
    await writeFile(join(dir, 'window-state.json'), JSON.stringify(validState));
    expect(readWindowState(dir)).toEqual(validState);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('readWindowState defaults isMaximized and isFullScreen to false when missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codiff-ws-'));
  try {
    const { isMaximized: _, isFullScreen: __, ...partial } = validState;
    await writeFile(join(dir, 'window-state.json'), JSON.stringify(partial));
    const result = readWindowState(dir);
    expect(result?.isMaximized).toBe(false);
    expect(result?.isFullScreen).toBe(false);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('writeWindowState creates directory and file', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'codiff-ws-')), 'nested');
  try {
    writeWindowState(validState, dir);
    expect(readWindowState(dir)).toEqual(validState);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('write then read round-trips correctly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codiff-ws-'));
  try {
    const state = { ...validState, isFullScreen: true, isMaximized: true };
    writeWindowState(state, dir);
    expect(readWindowState(dir)).toEqual(state);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('validateWindowStateOnScreen returns state when visible on primary display', () => {
  const state = { ...validState, x: 100, y: 50 };
  expect(validateWindowStateOnScreen(state, [primaryDisplay])).toEqual(state);
});

test('validateWindowStateOnScreen returns null when off all displays', () => {
  const state = { ...validState, x: 5000, y: 5000 };
  expect(validateWindowStateOnScreen(state, [primaryDisplay])).toBeNull();
});

test('validateWindowStateOnScreen returns state when partially overlapping', () => {
  const state = { ...validState, x: 1440 - 150, y: 0 };
  expect(validateWindowStateOnScreen(state, [primaryDisplay])).toEqual(state);
});

test('validateWindowStateOnScreen returns null when overlap is too small', () => {
  const state = { ...validState, x: 1440 - 50, y: 0 };
  expect(validateWindowStateOnScreen(state, [primaryDisplay])).toBeNull();
});

test('validateWindowStateOnScreen finds window on secondary display', () => {
  const secondary = { workArea: { height: 1080, width: 1920, x: 1440, y: 0 } };
  const state = { ...validState, x: 1500, y: 100 };
  expect(validateWindowStateOnScreen(state, [primaryDisplay, secondary])).toEqual(state);
});

test('validateWindowStateOnScreen returns null with no displays', () => {
  expect(validateWindowStateOnScreen(validState, [])).toBeNull();
});
