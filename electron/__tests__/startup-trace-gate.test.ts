import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { evaluateStartupTrace } = require('../startup-trace-gate.cjs') as {
  evaluateStartupTrace: (
    records: ReadonlyArray<Record<string, unknown>>,
    options: {
      actionId?: number;
      scenario: 'gitlab' | 'local';
      temperature: 'cold' | 'warm';
    },
  ) => {
    budgetMs: number;
    commandCountBeforeFirstUsable: number;
    firstUsableMs: number;
  };
};

const createTrace = (scenario: 'gitlab' | 'local', firstUsableMs: number) => {
  const records: Array<Record<string, unknown>> = [
    { event: 'session-start', monotonicMs: 0 },
    { event: 'milestone', monotonicMs: 0, name: 'electron-process-start' },
    { event: 'milestone', monotonicMs: 100, name: 'electron-ready' },
    { command: 'initial-load', event: 'start', id: 1, kind: 'action' },
    { actionId: 1, event: 'milestone', monotonicMs: 200, name: 'window-created' },
  ];
  let commandId = 2;
  const command = (args: ReadonlyArray<string>) => {
    const id = commandId++;
    records.push({ actionId: 1, args, command: 'command', event: 'start', id, kind: 'command' });
    records.push({
      actionId: 1,
      command: 'command',
      event: 'finish',
      id,
      kind: 'command',
      status: 'ok',
    });
  };
  command(['git', 'config', '--get', 'user.name']);
  command(['git', 'config', '--get', 'user.email']);
  if (scenario === 'local') {
    command(['git', 'status', '--porcelain=v2']);
    command(['git', 'diff', '--cached']);
    command(['git', 'diff', '--patch']);
  } else {
    command(['glab', '/projects/group%2Frepo/merge_requests/7']);
    command([
      'glab',
      `/projects/group%2Frepo/repository/compare?from=${'a'.repeat(40)}&straight=true&to=${'b'.repeat(40)}`,
    ]);
  }
  records.push({
    actionId: 1,
    event: 'milestone',
    monotonicMs: firstUsableMs - 100,
    name: 'repository-review-state-available',
  });
  records.push({
    actionId: 1,
    event: 'milestone',
    monotonicMs: firstUsableMs,
    name: 'first-usable-review-rendered',
  });
  if (scenario === 'gitlab') {
    command(['glab', '/projects/group%2Frepo/merge_requests/7/commits']);
  } else {
    command(['git', 'log', '--max-count=30']);
  }
  records.push({
    actionId: 1,
    event: 'milestone',
    monotonicMs: firstUsableMs + 1_000,
    name: 'deferred-review-data-complete',
  });
  records.push({ command: 'initial-load', event: 'finish', id: 1, kind: 'action', status: 'ok' });
  return records;
};

test('accepts measured local and GitLab startup contracts', () => {
  expect(
    evaluateStartupTrace(createTrace('local', 4_900), { scenario: 'local', temperature: 'cold' }),
  ).toMatchObject({
    budgetMs: 5_000,
    firstUsableMs: 4_900,
  });
  expect(
    evaluateStartupTrace(createTrace('gitlab', 8_900), { scenario: 'gitlab', temperature: 'warm' }),
  ).toMatchObject({
    budgetMs: 9_000,
    firstUsableMs: 8_900,
  });
});

test('selects complete initial-load actions in multi-window and reload traces', () => {
  const first = createTrace('local', 3_500);
  const second = createTrace('local', 4_000)
    .filter(
      (record) =>
        record.event !== 'session-start' &&
        !(record.event === 'milestone' && String(record.name).startsWith('electron-')),
    )
    .map((record) => ({
      ...record,
      ...(record.actionId === 1 ? { actionId: 2 } : {}),
      ...(record.id === 1
        ? { id: 2 }
        : typeof record.id === 'number'
          ? { id: record.id + 100 }
          : {}),
    }));
  const records = [...first, ...second];

  expect(evaluateStartupTrace(records, { scenario: 'local', temperature: 'cold' })).toMatchObject({
    actionId: 2,
    firstUsableMs: 4_000,
  });
  expect(
    evaluateStartupTrace(records, { actionId: 1, scenario: 'local', temperature: 'cold' }),
  ).toMatchObject({ actionId: 1, firstUsableMs: 3_500 });
});

test('ignores failed initial-load actions when a later action completes', () => {
  const records = createTrace('local', 4_000);
  const firstAction = records.findIndex(
    (record) => record.command === 'initial-load' && record.event === 'start',
  );
  records.splice(
    firstAction,
    0,
    { command: 'initial-load', event: 'start', id: 99, kind: 'action' },
    { command: 'initial-load', event: 'finish', id: 99, kind: 'action', status: 'error' },
  );
  expect(evaluateStartupTrace(records, { scenario: 'local', temperature: 'cold' })).toMatchObject({
    actionId: 1,
  });
});

test('rejects startup traces over their process-to-first-usable budget', () => {
  expect(() =>
    evaluateStartupTrace(createTrace('local', 5_001), { scenario: 'local', temperature: 'cold' }),
  ).toThrow('exceeding the 5000ms local cold budget');
});

test('rejects duplicate Git identity reads', () => {
  const records = createTrace('local', 4_000);
  const firstUsable = records.findIndex(
    (record) => record.event === 'milestone' && record.name === 'first-usable-review-rendered',
  );
  records.splice(
    firstUsable,
    0,
    {
      actionId: 1,
      args: ['git', 'config', '--get', 'user.name'],
      command: 'git',
      event: 'start',
      id: 99,
      kind: 'command',
    },
    { actionId: 1, command: 'git', event: 'finish', id: 99, kind: 'command', status: 'ok' },
  );
  expect(() => evaluateStartupTrace(records, { scenario: 'local', temperature: 'cold' })).toThrow(
    'Expected one Git identity pair',
  );
});

test('rejects GitLab history before first usable', () => {
  const records = createTrace('gitlab', 8_000);
  const history = records.findIndex(
    (record) =>
      record.event === 'start' &&
      Array.isArray(record.args) &&
      record.args.some((argument) => String(argument).endsWith('/commits')),
  );
  const moved = records.splice(history, 2);
  const firstUsable = records.findIndex(
    (record) => record.event === 'milestone' && record.name === 'first-usable-review-rendered',
  );
  records.splice(firstUsable, 0, ...moved);
  expect(() => evaluateStartupTrace(records, { scenario: 'gitlab', temperature: 'cold' })).toThrow(
    'GitLab history started before first usable',
  );
});

test('rejects duplicate GitLab history requests', () => {
  const records = createTrace('gitlab', 8_000);
  const deferred = records.findIndex(
    (record) => record.event === 'milestone' && record.name === 'deferred-review-data-complete',
  );
  records.splice(
    deferred,
    0,
    {
      actionId: 1,
      args: ['glab', '/projects/group%2Frepo/merge_requests/7/commits'],
      command: 'glab',
      event: 'start',
      id: 99,
      kind: 'command',
    },
    { actionId: 1, command: 'glab', event: 'finish', id: 99, kind: 'command', status: 'ok' },
  );
  expect(() => evaluateStartupTrace(records, { scenario: 'gitlab', temperature: 'cold' })).toThrow(
    'Expected exactly one GitLab deferred history request; found 2',
  );
});

test('rejects repository history before first usable', () => {
  const records = createTrace('local', 4_000);
  const history = records.findIndex(
    (record) =>
      record.event === 'start' && Array.isArray(record.args) && record.args.includes('log'),
  );
  const moved = records.splice(history, 2);
  const firstUsable = records.findIndex(
    (record) => record.event === 'milestone' && record.name === 'first-usable-review-rendered',
  );
  records.splice(firstUsable, 0, ...moved);
  expect(() => evaluateStartupTrace(records, { scenario: 'local', temperature: 'cold' })).toThrow(
    'Repository history did not run strictly between first usable and deferred completion',
  );
});

test('rejects standalone actions before deferred completion', () => {
  const records = createTrace('local', 4_000);
  const deferred = records.findIndex(
    (record) => record.event === 'milestone' && record.name === 'deferred-review-data-complete',
  );
  records.splice(deferred, 0, {
    command: 'standalone-command',
    event: 'start',
    id: 99,
    kind: 'action',
  });
  expect(() => evaluateStartupTrace(records, { scenario: 'local', temperature: 'cold' })).toThrow(
    'Found 1 standalone actions before deferred completion',
  );
});

test('rejects a Git identity command that finishes after deferred completion', () => {
  const records = createTrace('local', 4_000);
  const identityStart = records.find(
    (record) =>
      record.event === 'start' && Array.isArray(record.args) && record.args.at(-1) === 'user.email',
  );
  if (!identityStart) {
    throw new Error('Expected the Git identity command in the startup fixture.');
  }
  const finishIndex = records.findIndex(
    (record) =>
      record.event === 'finish' && record.kind === 'command' && record.id === identityStart.id,
  );
  const [identityFinish] = records.splice(finishIndex, 1);
  const deferredIndex = records.findIndex(
    (record) => record.event === 'milestone' && record.name === 'deferred-review-data-complete',
  );
  records.splice(deferredIndex + 1, 0, identityFinish!);

  expect(() => evaluateStartupTrace(records, { scenario: 'local', temperature: 'cold' })).toThrow(
    `Command ${String(identityStart.id)} outlived deferred completion.`,
  );
});
