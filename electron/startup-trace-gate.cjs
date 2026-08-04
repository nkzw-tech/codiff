// @ts-check

const STARTUP_BUDGETS = Object.freeze({
  gitlab: Object.freeze({ cold: 10_000, maxCommandsBeforeFirstUsable: 10, warm: 9_000 }),
  local: Object.freeze({ cold: 5_000, maxCommandsBeforeFirstUsable: 10, warm: 5_000 }),
});

/** @param {unknown} condition @param {string} message */
const assertTrace = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

/**
 * @template Value
 * @param {ReadonlyArray<Value>} values
 * @param {string} label
 * @returns {Value}
 */
const requireOne = (values, label) => {
  assertTrace(values.length === 1, `Expected exactly one ${label}; found ${values.length}.`);
  return /** @type {Value} */ (values[0]);
};

/** @param {Record<string, unknown>} record */
const commandArgs = (record) =>
  Array.isArray(record.args) ? record.args.filter((value) => typeof value === 'string') : [];

/** @param {Record<string, unknown>} record */
const providerResource = (record) =>
  commandArgs(record).find(
    (argument) =>
      argument === '/user' ||
      /^\/projects\/[^/]+\/(?:merge_requests\/|repository\/compare(?:\?|$))/.test(argument),
  ) || null;

/** @param {Record<string, unknown>} record @param {string} argument */
const hasArgument = (record, argument) => commandArgs(record).includes(argument);

/** @param {Record<string, unknown>} record */
const isRepositoryHistoryCommand = (record) =>
  hasArgument(record, 'log') &&
  commandArgs(record).some((argument) => /^--max-count=/.test(argument));

/** @param {Record<string, unknown>} record */
const isEarlyHydrationCommand = (record) =>
  ['cat-file', 'diff-tree'].some((argument) => hasArgument(record, argument));

/** @param {Record<string, unknown>} record */
const isExplicitBranchDiscovery = (record) =>
  ['branch', 'for-each-ref', 'show-ref', 'symbolic-ref'].some((argument) =>
    hasArgument(record, argument),
  );

/** @param {Record<string, unknown>} record @param {RegExp} pattern */
const hasProviderResource = (record, pattern) => {
  const resource = providerResource(record);
  return resource != null && pattern.test(resource);
};

/**
 * @param {ReadonlyArray<Record<string, unknown>>} records
 * @param {{actionId?: number, scenario: 'gitlab' | 'local', temperature: 'cold' | 'warm'}} options
 */
const evaluateStartupTrace = (records, options) => {
  const budget = STARTUP_BUDGETS[options.scenario]?.[options.temperature];
  assertTrace(Number.isFinite(budget), `Unknown startup scenario or temperature.`);
  assertTrace(records.length > 0, 'Startup trace is empty.');

  const initialActionStarts = records.filter(
    (record) =>
      record.command === 'initial-load' &&
      record.event === 'start' &&
      record.kind === 'action' &&
      typeof record.id === 'number',
  );
  const completeActionIds = initialActionStarts
    .map((record) => record.id)
    .filter((actionId) =>
      [
        'repository-review-state-available',
        'first-usable-review-rendered',
        'deferred-review-data-complete',
      ].every((name) =>
        records.some(
          (record) =>
            record.event === 'milestone' && record.name === name && record.actionId === actionId,
        ),
      ),
    );
  const selectedActionId = options.actionId ?? completeActionIds.at(-1);
  assertTrace(
    typeof selectedActionId === 'number',
    'Startup trace has no complete initial-load action.',
  );
  const selectedActionStartIndex = records.findIndex(
    (record) =>
      record.command === 'initial-load' &&
      record.event === 'start' &&
      record.kind === 'action' &&
      record.id === selectedActionId,
  );
  const selectedDeferredIndex = records.findIndex(
    (record) =>
      record.event === 'milestone' &&
      record.name === 'deferred-review-data-complete' &&
      record.actionId === selectedActionId,
  );
  const scopedRecords = records.filter(
    (record, index) =>
      record.actionId === selectedActionId ||
      (record.kind === 'action' && record.id === selectedActionId) ||
      (record.command === 'standalone-command' &&
        record.kind === 'action' &&
        index > selectedActionStartIndex &&
        index < selectedDeferredIndex) ||
      (record.event === 'milestone' &&
        (record.name === 'electron-process-start' || record.name === 'electron-ready')) ||
      record.event === 'session-start',
  );
  const indexed = scopedRecords.map((record, index) => ({ index, record }));
  const milestone = (name) =>
    requireOne(
      indexed.filter(({ record }) => record.event === 'milestone' && record.name === name),
      `${name} milestone`,
    );
  const processStart = milestone('electron-process-start');
  const repositoryState = milestone('repository-review-state-available');
  const firstUsable = milestone('first-usable-review-rendered');
  const deferredComplete = milestone('deferred-review-data-complete');
  assertTrace(
    processStart.index < repositoryState.index,
    'Repository state preceded process start.',
  );
  assertTrace(
    repositoryState.index < firstUsable.index,
    'First usable preceded repository state availability.',
  );
  assertTrace(
    firstUsable.index < deferredComplete.index,
    'Deferred completion did not follow first usable.',
  );
  const firstUsableMs = firstUsable.record.monotonicMs;
  assertTrace(
    typeof firstUsableMs === 'number' && Number.isFinite(firstUsableMs),
    'First usable is missing a finite process-relative duration.',
  );
  assertTrace(
    /** @type {number} */ (firstUsableMs) <= /** @type {number} */ (budget),
    `First usable took ${firstUsableMs}ms, exceeding the ${budget}ms ${options.scenario} ${options.temperature} budget.`,
  );

  const initialAction = requireOne(
    indexed.filter(
      ({ record }) =>
        record.command === 'initial-load' && record.event === 'start' && record.kind === 'action',
    ),
    'initial-load action',
  );
  const actionId = initialAction.record.id;
  assertTrace(typeof actionId === 'number', 'Initial-load action has no numeric ID.');
  assertTrace(
    initialAction.index < firstUsable.index,
    'Initial-load action started after first usable.',
  );
  const actionFinish = requireOne(
    indexed.filter(
      ({ record }) =>
        record.event === 'finish' && record.id === actionId && record.kind === 'action',
    ),
    'initial-load action finish',
  );
  assertTrace(
    actionFinish.index > deferredComplete.index,
    'Initial-load action finished too early.',
  );
  assertTrace(
    actionFinish.record.status === 'ok',
    'Initial-load action did not finish successfully.',
  );
  for (const namedMilestone of [repositoryState, firstUsable, deferredComplete]) {
    assertTrace(
      namedMilestone.record.actionId === actionId,
      `${namedMilestone.record.name} was not attributed to the initial-load action.`,
    );
  }

  const commandStarts = indexed.filter(
    ({ record }) => record.event === 'start' && record.kind === 'command',
  );
  const beforeFirstUsable = commandStarts.filter(({ index }) => index < firstUsable.index);
  const throughDeferred = commandStarts.filter(({ index }) => index < deferredComplete.index);
  const maxCommands = STARTUP_BUDGETS[options.scenario].maxCommandsBeforeFirstUsable;
  assertTrace(
    beforeFirstUsable.length <= maxCommands,
    `${beforeFirstUsable.length} commands started before first usable; budget is ${maxCommands}.`,
  );
  const standaloneActions = indexed.filter(
    ({ index, record }) =>
      index < deferredComplete.index &&
      record.command === 'standalone-command' &&
      record.event === 'start' &&
      record.kind === 'action',
  );
  assertTrace(
    standaloneActions.length === 0,
    `Found ${standaloneActions.length} standalone actions before deferred completion.`,
  );
  for (const command of throughDeferred) {
    assertTrace(
      command.record.actionId === actionId,
      `Command ${String(command.record.id)} was not attributed to the initial-load action.`,
    );
    const finish = requireOne(
      indexed.filter(
        ({ record }) =>
          record.event === 'finish' && record.id === command.record.id && record.kind === 'command',
      ),
      `finish for command ${String(command.record.id)}`,
    );
    assertTrace(
      finish.index < deferredComplete.index,
      `Command ${String(command.record.id)} outlived deferred completion.`,
    );
  }

  const identityReads = commandStarts.filter(({ record }) => {
    const key = commandArgs(record).at(-1);
    return key === 'user.email' || key === 'user.name';
  });
  assertTrace(
    identityReads.length === 2,
    `Expected one Git identity pair; found ${identityReads.length} reads.`,
  );
  assertTrace(
    identityReads
      .map(({ record }) => commandArgs(record).at(-1))
      .toSorted()
      .join(',') === 'user.email,user.name',
    'Git identity reads did not contain exactly user.email and user.name.',
  );
  assertTrace(
    identityReads.every(({ record }) => record.actionId === actionId),
    'Git identity escaped the initial-load action.',
  );

  assertTrace(
    beforeFirstUsable.every(({ record }) => !isEarlyHydrationCommand(record)),
    'Off-screen file hydration started before first usable.',
  );

  if (options.scenario === 'local') {
    const historyCommands = commandStarts.filter(({ record }) =>
      isRepositoryHistoryCommand(record),
    );
    const historyCommand = requireOne(historyCommands, 'repository-history log command');
    assertTrace(
      historyCommand.index > firstUsable.index && historyCommand.index < deferredComplete.index,
      'Repository history did not run strictly between first usable and deferred completion.',
    );
    assertTrace(
      throughDeferred.every(({ record }) => providerResource(record) == null),
      'Local startup unexpectedly contacted a provider.',
    );
    const statusReads = beforeFirstUsable.filter(
      ({ record }) => hasArgument(record, 'status') && hasArgument(record, '--porcelain=v2'),
    );
    const cachedDiffs = beforeFirstUsable.filter(
      ({ record }) => hasArgument(record, 'diff') && hasArgument(record, '--cached'),
    );
    const workingDiffs = beforeFirstUsable.filter(
      ({ record }) => hasArgument(record, 'diff') && !hasArgument(record, '--cached'),
    );
    requireOne(statusReads, 'startup repository status snapshot');
    requireOne(cachedDiffs, 'startup staged diff snapshot');
    requireOne(workingDiffs, 'startup working-tree diff snapshot');
  } else {
    const metadata = commandStarts.filter(({ record }) =>
      hasProviderResource(record, /\/merge_requests\/\d+$/),
    );
    const comparisons = commandStarts.filter(({ record }) =>
      hasProviderResource(record, /\/projects\/[^/]+\/repository\/compare(?:\?|$)/),
    );
    const history = commandStarts.filter(({ record }) =>
      hasProviderResource(record, /\/merge_requests\/\d+\/commits(?:\?|$)/),
    );
    for (const [label, requests] of [
      ['GitLab metadata request', metadata],
      ['GitLab repository comparison request', comparisons],
      ['GitLab deferred history request', history],
    ]) {
      requireOne(requests, label);
    }
    for (const request of [...metadata, ...comparisons]) {
      assertTrace(
        request.index < firstUsable.index,
        'Required GitLab review data started too late.',
      );
    }
    for (const request of history) {
      assertTrace(request.index > firstUsable.index, 'GitLab history started before first usable.');
      assertTrace(
        request.index < deferredComplete.index,
        'GitLab history started after completion.',
      );
    }
    assertTrace(
      beforeFirstUsable.every(({ record }) => !isExplicitBranchDiscovery(record)),
      'Explicit GitLab review performed branch discovery before first usable.',
    );
  }

  return {
    actionId,
    budgetMs: budget,
    commandCountBeforeFirstUsable: beforeFirstUsable.length,
    firstUsableMs,
    scenario: options.scenario,
    temperature: options.temperature,
  };
};

/** @param {string} contents */
const parseStartupTrace = (contents) =>
  contents
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(
          `Invalid JSONL record on line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });

module.exports = {
  STARTUP_BUDGETS,
  evaluateStartupTrace,
  parseStartupTrace,
};
