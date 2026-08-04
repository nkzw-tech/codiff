import { describe, expect, test } from 'vite-plus/test';
import {
  projectRegionAwareReplay,
  regionAwareMovedBlockPolicy,
  type RegionReplayFileProjection,
  type RegionReplayInput,
} from '../lib/region-aware-replay.ts';

const project = (input: Omit<RegionReplayInput, 'path'>) =>
  projectRegionAwareReplay({ path: 'src/example.ts', ...input });

const cleanRegions = (projection: RegionReplayFileProjection) =>
  projection.regions.filter((region) => region.kind === 'replay-clean');

const conflictRegions = (projection: RegionReplayFileProjection) =>
  projection.regions.filter((region) => region.kind === 'replay-conflict');

describe('region-aware replay', () => {
  test('uses the selected conflict-only anchor policy', () => {
    expect(regionAwareMovedBlockPolicy).toBe('conflict-only-anchors');
  });

  test('retains endpoint paths on edit blocks and real-source projection rows', () => {
    const projection = projectRegionAwareReplay({
      earlierBase: 'old\n',
      earlierBasePath: 'src/old-name.ts',
      earlierHead: 'prior\n',
      earlierHeadPath: 'src/new-name.ts',
      laterBase: 'base\n',
      laterBasePath: 'src/new-name.ts',
      laterHead: 'current\n',
      laterHeadPath: 'src/current-name.ts',
      path: 'src/current-name.ts',
    });

    expect(projection.endpointPaths).toEqual({
      earlierBase: 'src/old-name.ts',
      earlierHead: 'src/new-name.ts',
      laterBase: 'src/new-name.ts',
      laterHead: 'src/current-name.ts',
    });
    expect(projection.priorEdits[0]).toMatchObject({
      afterPath: 'src/new-name.ts',
      beforePath: 'src/old-name.ts',
    });
    expect(projection.regions[0]).toMatchObject({
      kind: 'replay-conflict',
      laterBase: { path: 'src/new-name.ts' },
      laterHead: { path: 'src/current-name.ts' },
    });
  });

  test('cancels target-base-only movement around a clean replay', () => {
    const projection = project({
      earlierBase: 'base old\nkeep\nauthor old\ntail\n',
      earlierHead: 'base old\nkeep\nauthor reviewed\ntail\n',
      laterBase: 'base advanced\nkeep\nauthor old\ntail\n',
      laterHead: 'base advanced\nkeep\nauthor reviewed\ntail\n',
    });

    expect(projection.outcomes).toMatchObject([{ kind: 'applied', priorEditId: 'prior-patch:0' }]);
    expect(projection.expectedReplay).toBe(
      projection.regions[0]?.kind === 'replay-clean'
        ? projection.regions[0].laterHead.content
        : undefined,
    );
    expect(conflictRegions(projection)).toEqual([]);
    expect(cleanRegions(projection)).toHaveLength(1);
  });

  test('keeps a later revision against Expected Replay without base noise', () => {
    const projection = project({
      earlierBase: 'base old\nkeep\nauthor old\ntail\n',
      earlierHead: 'base old\nkeep\nauthor reviewed\ntail\n',
      laterBase: 'base advanced\nkeep\nauthor old\ntail\n',
      laterHead: 'base advanced\nkeep\nauthor revised again\ntail\n',
    });
    const [clean] = cleanRegions(projection);

    expect(clean).toMatchObject({
      expectedReplay: { content: 'base advanced\nkeep\nauthor reviewed\ntail\n' },
      laterHead: { content: 'base advanced\nkeep\nauthor revised again\ntail\n' },
    });
    expect(clean?.laterHead.content).not.toContain('base old');
  });

  test('continues replay after a failed earlier block and keeps later clean work clean', () => {
    const projection = project({
      earlierBase: 'start\nconflict old\nmiddle\nclean old\nend\n',
      earlierHead: 'start\nconflict prior\nmiddle\nclean prior\nend\n',
      laterBase: 'start\nconflict base\nmiddle\nclean old\nend\n',
      laterHead: 'start\nconflict base\nmiddle\nclean current\nend\n',
    });
    const conflicts = conflictRegions(projection);
    const cleans = cleanRegions(projection);

    expect(projection.outcomes.map((outcome) => outcome.kind)).toEqual(['conflict', 'applied']);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ priorEditIds: ['prior-patch:0'] });
    expect(cleans).toHaveLength(1);
    expect(cleans[0]).toMatchObject({
      expectedReplay: { content: 'clean prior\nend\n' },
      laterHead: { content: 'clean current\nend\n' },
      priorEditIds: ['prior-patch:1'],
    });
  });

  test('keeps a located conflict with zero affected current edits explicit', () => {
    const projection = project({
      earlierBase: 'before\nsubject old\nafter\n',
      earlierHead: 'before\nsubject prior\nafter\n',
      laterBase: 'before\nsubject base\nafter\n',
      laterHead: 'before\nsubject base\nafter\n',
    });
    const [conflict] = conflictRegions(projection);

    expect(conflict).toMatchObject({
      affectedCurrentEditIds: [],
      laterBase: { content: 'before\nsubject base\nafter\n' },
      priorEditIds: ['prior-patch:0'],
    });
    expect(conflict?.laterHead.content).toBe('before\nsubject base\nafter\n');
  });

  test('collects every current edit closed over one conflict region without claiming correspondence', () => {
    const projection = project({
      earlierBase: 'before\nsubject old\nnear old\nafter\n',
      earlierHead: 'before\nsubject prior\nnear old\nafter\n',
      laterBase: 'before\nsubject base\nnear old\nafter\n',
      laterHead: 'before\nsubject current\nnear current\nafter\n',
    });
    const [conflict] = conflictRegions(projection);

    expect(conflict?.affectedCurrentEditIds).toEqual(['current-patch:0']);
    expect(conflict?.closureEvidence).toContain('current:current-patch:0');
  });

  test('keeps several affected current edits on one failed prior block', () => {
    const projection = project({
      earlierBase: 'start\nold\nafter\n',
      earlierHead: 'start\nprior\nafter\n',
      laterBase: 'start\nbase\nafter\n',
      laterHead: 'start current\nbase\nafter current\n',
    });
    const [conflict] = conflictRegions(projection);

    expect(projection.outcomes).toMatchObject([{ kind: 'conflict', priorEditId: 'prior-patch:0' }]);
    expect(conflict).toMatchObject({
      affectedCurrentEditIds: ['current-patch:0', 'current-patch:1'],
      priorEditIds: ['prior-patch:0'],
    });
    expect(conflict?.closureEvidence).toEqual(
      expect.arrayContaining(['current:current-patch:0', 'current:current-patch:1']),
    );
  });

  test('recognizes exact replacement, insertion, and deletion absorption independently', () => {
    const replacement = project({
      earlierBase: 'before\nold\nafter\n',
      earlierHead: 'before\nnew\nafter\n',
      laterBase: 'before\nnew\nafter\n',
      laterHead: 'before\nnew\nafter\n',
    });
    const insertion = project({
      earlierBase: 'before\nafter\n',
      earlierHead: 'before\ninserted\nafter\n',
      laterBase: 'before\ninserted\nafter\n',
      laterHead: 'before\ninserted\nafter\n',
    });
    const deletion = project({
      earlierBase: 'before\ndelete me\nafter\n',
      earlierHead: 'before\nafter\n',
      laterBase: 'before\nafter\n',
      laterHead: 'before\nafter\n',
    });

    for (const result of [replacement, insertion, deletion]) {
      expect(result.outcomes).toMatchObject([
        { kind: 'absorbed', provenance: 'exact-base-operation' },
      ]);
      expect(conflictRegions(result)).toEqual([]);
    }
  });

  test('does not infer deletion absorption from an empty postimage alone', () => {
    const projection = project({
      earlierBase: 'before\ndelete me\nafter\n',
      earlierHead: 'before\nafter\n',
      laterBase: 'before\nreplacement\nafter\n',
      laterHead: 'before\nreplacement\nafter\n',
    });

    expect(projection.outcomes).toMatchObject([{ kind: 'conflict' }]);
    expect(conflictRegions(projection)).toHaveLength(1);
  });

  test('keeps an absorbed prior change reviewable when the later head reverts it', () => {
    const projection = project({
      earlierBase: 'before\nold\nafter\n',
      earlierHead: 'before\nprior\nafter\n',
      laterBase: 'before\nprior\nafter\n',
      laterHead: 'before\nreverted\nafter\n',
    });
    const [clean] = cleanRegions(projection);

    expect(projection.outcomes).toMatchObject([
      { kind: 'absorbed', priorEditId: 'prior-patch:0', provenance: 'exact-base-operation' },
    ]);
    expect(conflictRegions(projection)).toEqual([]);
    expect(clean).toMatchObject({
      expectedReplay: { content: 'before\nprior\nafter\n' },
      laterHead: { content: 'before\nreverted\nafter\n' },
    });
  });

  test('treats repeated edited context as ambiguous instead of choosing a textual match', () => {
    const projection = project({
      earlierBase: 'start\nrepeat\nrepeat\nend\n',
      earlierHead: 'start\nauthor\nrepeat\nend\n',
      laterBase: 'start\nrepeat\nend\n',
      laterHead: 'start\nrepeat\nend\n',
    });

    expect(projection.outcomes[0]).toMatchObject({
      kind: 'conflict',
      reason: expect.stringMatching(/ambiguous-anchor|overlapping-edit/),
    });
    expect(projection.expectedReplay).not.toContain('author');
  });

  test('translates later blocks after an earlier length-changing replay', () => {
    const projection = project({
      earlierBase: 'one\nold a\nmiddle\nold b\nend\n',
      earlierHead: 'one\nnew a\nextra a\nmiddle\nnew b\nend\n',
      laterBase: 'base advanced\nold a\nmiddle\nold b\nend\n',
      laterHead: 'base advanced\nnew a\nextra a\nmiddle\nnew b\nend\n',
    });

    expect(projection.outcomes.map((outcome) => outcome.kind)).toEqual(['applied', 'applied']);
    expect(projection.expectedReplay).toBe('base advanced\nnew a\nextra a\nmiddle\nnew b\nend\n');
    expect(conflictRegions(projection)).toEqual([]);
  });

  test('treats competing boundary insertions as a conflict instead of choosing one', () => {
    const projection = project({
      earlierBase: 'start\nend\n',
      earlierHead: 'start\nprior\nend\n',
      laterBase: 'start\nbase\nend\n',
      laterHead: 'start\ncurrent\nend\n',
    });
    const [conflict] = conflictRegions(projection);

    expect(projection.outcomes).toMatchObject([
      { kind: 'conflict', priorEditId: 'prior-patch:0', reason: 'overlapping-edit' },
    ]);
    expect(conflict).toMatchObject({
      affectedCurrentEditIds: ['current-patch:0'],
      priorEditIds: ['prior-patch:0'],
    });
    expect(projection.expectedReplay).not.toContain('prior');
  });

  test('keeps formatter churn without stable line anchors as a conflict', () => {
    const projection = project({
      earlierBase: 'function foo() {\n  return 1;\n}\n',
      earlierHead: 'function foo() {\n  return 2;\n}\n',
      laterBase: 'function foo(){\n\treturn 1\n}\n',
      laterHead: 'function foo(){\n\treturn 3\n}\n',
    });

    expect(projection.outcomes).toMatchObject([{ kind: 'conflict', priorEditId: 'prior-patch:0' }]);
    expect(conflictRegions(projection)).toHaveLength(1);
    expect(projection.expectedReplay).not.toContain('return 2');
  });

  test('keeps one atomic prior block intact when target movement splits its locus', () => {
    const projection = project({
      earlierBase: 'start\nold one\nold two\nend\n',
      earlierHead: 'start\nprior one\nprior two\nend\n',
      laterBase: 'start\nold one\nintervening\nold two\nend\n',
      laterHead: 'start\ncurrent one\nintervening\ncurrent two\nend\n',
    });
    const [conflict] = conflictRegions(projection);

    expect(projection.priorEdits).toHaveLength(1);
    expect(projection.outcomes).toMatchObject([{ kind: 'conflict', priorEditId: 'prior-patch:0' }]);
    expect(conflictRegions(projection)).toHaveLength(1);
    expect(conflict).toMatchObject({
      affectedCurrentEditIds: ['current-patch:0', 'current-patch:1'],
      priorEditIds: ['prior-patch:0'],
    });
    expect(projection.expectedReplay).not.toContain('prior one');
  });

  test('uses the explicit empty-file boundary to replay an added file', () => {
    const projection = project({
      earlierBase: null,
      earlierHead: 'author old\n',
      laterBase: null,
      laterHead: 'author revised\n',
    });

    expect(projection.outcomes).toMatchObject([{ kind: 'applied' }]);
    expect(cleanRegions(projection)).toMatchObject([
      {
        expectedReplay: { content: 'author old\n' },
        laterHead: { content: 'author revised\n' },
      },
    ]);
  });

  test('handles an EOF deletion without trailing context', () => {
    const projection = project({
      earlierBase: 'keep\ndelete\n',
      earlierHead: 'keep\n',
      laterBase: 'keep\ndelete\n',
      laterHead: 'keep\n',
    });

    expect(projection.expectedReplay).toBe('keep\n');
    expect(projection.outcomes).toMatchObject([{ kind: 'applied' }]);
  });

  test('coalesces conflict seeds bridged by one current operation', () => {
    const projection = project({
      earlierBase: 'start\nfirst old\nbridge\nsecond old\nend\n',
      earlierHead: 'start\nfirst prior\nbridge\nsecond prior\nend\n',
      laterBase: 'start\nfirst base\nbridge\nsecond base\nend\n',
      laterHead: 'start\nfirst base\nbridge current\nsecond base\nend\n',
    });
    const [conflict] = conflictRegions(projection);

    expect(conflictRegions(projection)).toHaveLength(1);
    expect(conflict?.priorEditIds).toEqual(['prior-patch:0', 'prior-patch:1']);
    expect(conflict?.affectedCurrentEditIds).toEqual(['current-patch:0']);
  });

  test('returns an explicit incomplete region for unavailable or binary endpoints', () => {
    const unavailable = project({
      earlierBase: undefined,
      earlierHead: 'head\n',
      laterBase: 'base\n',
      laterHead: 'head\n',
    });
    const binary = project({
      earlierBase: 'base\n',
      earlierHead: 'head\n',
      laterBase: 'base\0binary',
      laterHead: 'head\n',
    });

    expect(unavailable.regions).toMatchObject([
      { completeness: 'incomplete', missingEvidence: ['Earlier Base content is unavailable.'] },
    ]);
    expect(binary.regions).toMatchObject([
      { completeness: 'incomplete', missingEvidence: ['Later Base is non-textual.'] },
    ]);
  });
});
