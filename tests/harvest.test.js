import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataFactory as DF } from 'n3';
import { HarvestRunner } from '../src/harvest/runner.js';
import { MockEndpoint } from '../src/endpoints/mock.js';
import { baseDataset, changedDataset, symmetricDataset, PROFILES } from '../src/endpoints/dataset.js';
import { diffRuns } from '../src/diff/compare.js';
import { Archive, digest } from '../src/archive.js';

async function withArchive(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'harvest-test-'));
  try { return await fn(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

const INSTRUMENTS = 'https://lab.invalid/instruments';

test('整图端点可发布；两次领取标签不同但 diff 判定 IDENTICAL', async () => {
  await withArchive(async directory => {
    const run1 = await new HarvestRunner(
      new MockEndpoint(PROFILES.graphExport, baseDataset()), directory)
      .harvestNamedGraph(INSTRUMENTS);
    const run2 = await new HarvestRunner(
      new MockEndpoint(PROFILES.graphExport, baseDataset()), directory)
      .harvestNamedGraph(INSTRUMENTS);

    assert.equal(run1.gate.decision, 'PUBLISH');
    assert.equal(run2.gate.decision, 'PUBLISH');
    const label1 = run1.responses[0].normalized.blankNode.labelMap[0].originalLabel;
    const label2 = run2.responses[0].normalized.blankNode.labelMap[0].originalLabel;
    assert.notEqual(label1, label2);

    const result = diffRuns(run1, run2);
    assert.equal(result.verdict, 'IDENTICAL');
    assert.equal(result.summary.relabeledComponents, 1);
    assert.equal(result.ground.added.length, 0);
    assert.equal(result.blankNodeQuads.added.length, 0);
  });
});

test('真实新增关系被识别为 CHANGED，且能列出具体新增四元组', async () => {
  await withArchive(async directory => {
    const before = await new HarvestRunner(
      new MockEndpoint(PROFILES.graphExport, baseDataset()), directory)
      .harvestNamedGraph(INSTRUMENTS);
    const after = await new HarvestRunner(
      new MockEndpoint(PROFILES.graphExport, changedDataset()), directory)
      .harvestNamedGraph(INSTRUMENTS);
    const result = diffRuns(before, after);
    assert.equal(result.verdict, 'CHANGED');
    assert.ok(result.blankNodeQuads.added.some(line => line.includes('calibration')));
    assert.ok(result.blankNodeQuads.added.some(line => line.includes('https://lab.invalid/C')));
  });
});

test('跨命名图同标签：响应作用域隔离，不跨 run 合并 _:b0', async () => {
  await withArchive(async directory => {
    const instruments = await new HarvestRunner(
      new MockEndpoint(PROFILES.graphExport, baseDataset()), directory)
      .harvestNamedGraph(INSTRUMENTS);
    const staff = await new HarvestRunner(
      new MockEndpoint(PROFILES.graphExport, baseDataset()), directory)
      .harvestNamedGraph('https://lab.invalid/staff');
    assert.equal(instruments.responses[0].normalized.blankNode.scope, 'response');
    assert.equal(staff.responses[0].normalized.blankNode.scope, 'response');
    // 两个响应各自从 r0_b0 编号，但属于不同 run，不会被当成同一节点。
    assert.equal(instruments.responses[0].normalized.blankNode.labelMap[0].harvestLabel, 'r0_b0');
    assert.equal(staff.responses[0].normalized.blankNode.labelMap[0].harvestLabel, 'r0_b0');
    assert.notEqual(instruments.runId, staff.runId);
  });
});

test('对称结构两次领取：标签全换仍判定 IDENTICAL_WITH_SYMMETRY，不臆造身份', async () => {
  await withArchive(async directory => {
    const before = await new HarvestRunner(
      new MockEndpoint(PROFILES.graphExport, symmetricDataset()), directory)
      .harvestNamedGraph('https://lab.invalid/symmetric-a');
    const after = await new HarvestRunner(
      new MockEndpoint(PROFILES.graphExport, symmetricDataset()), directory)
      .harvestNamedGraph('https://lab.invalid/symmetric-a');
    assert.notEqual(
      before.responses[0].normalized.blankNode.labelMap[0].originalLabel,
      after.responses[0].normalized.blankNode.labelMap[0].originalLabel);
    const result = diffRuns(before, after);
    assert.equal(result.verdict, 'IDENTICAL_WITH_SYMMETRY');
    assert.equal(result.ambiguous, true);
    assert.equal(result.blankNodeQuads.added.length, 0);
    assert.equal(result.blankNodeQuads.removed.length, 0);
    assert.ok(result.blankNodeComponents.every(c => c.status === 'RELABELED_AMBIGUOUS'));
  });
});

test('对称结构：PUBLISH_WITH_AMBIGUITY，保留对称类且不发布节点身份', async () => {
  await withArchive(async directory => {
    const run = await new HarvestRunner(
      new MockEndpoint(PROFILES.graphExport, symmetricDataset()), directory)
      .harvestNamedGraph('https://lab.invalid/symmetric-a');
    assert.equal(run.gate.decision, 'PUBLISH_WITH_AMBIGUITY');
    assert.deepEqual(run.gate.ambiguousResponses, [0]);
    const component = run.responses[0].canonical.components[0];
    assert.equal(component.status, 'AMBIGUOUS');
    assert.equal(component.symmetryClasses[0].length, 4);
  });
});

test('限行数端点遇到空白节点模式：BLOCKED 并写明缺口，不产生发布', async () => {
  await withArchive(async directory => {
    const run = await new HarvestRunner(
      new MockEndpoint(PROFILES.limitedTable, baseDataset()), directory)
      .harvestBounded({
        pattern: [['graph', INSTRUMENTS]],
        variables: ['subject', 'predicate', 'object', 'graph'],
      });
    assert.equal(run.status, 'BLOCKED');
    assert.equal(run.publishable, false);
    assert.equal(run.gate.blockers[0].code, 'BLANK_NODE_PAGING_UNSAFE');
    assert.equal(run.responses.length, 0);
  });
});

test('限行数端点、仅落地三元组且支持 COUNT：分页对账完整后发布', async () => {
  await withArchive(async directory => {
    const ground = {
      id: 'ground',
      quads: baseDataset().quads.filter(q =>
        q.subject.termType !== 'BlankNode' && q.object.termType !== 'BlankNode'),
    };
    const profile = { ...PROFILES.limitedTable, id: 'limited-count', countSupported: true };
    const run = await new HarvestRunner(new MockEndpoint(profile, ground), directory)
      .harvestBounded({
        pattern: [['subject', 'https://lab.invalid/A']],
        variables: ['subject', 'predicate', 'object', 'graph'],
      });
    assert.equal(run.status, 'COMPLETE');
    assert.equal(run.gate.decision, 'PUBLISH');
    assert.equal(run.termination.kind, 'COUNT');
    assert.equal(run.termination.satisfied, true);
  });
});

test('无 COUNT 且无法取得终止证据：满页收尾时不发布并保留缺口', async () => {
  await withArchive(async directory => {
    const ground = {
      id: 'ground-many',
      // 行数恰为页长整数倍，SHORT_PAGE 无法排除尾页缺失。
      quads: Array.from({ length: 4 }, (_, i) =>
        DF.quad(DF.namedNode('https://lab.invalid/A'),
          DF.namedNode(`https://lab.invalid/p${i}`), DF.literal(`v${i}`))),
    };
    const run = await new HarvestRunner(
      new MockEndpoint(PROFILES.limitedTable, ground), directory)
      .harvestBounded({
        pattern: [['subject', 'https://lab.invalid/A']],
        variables: ['subject', 'predicate', 'object', 'graph'],
      });
    assert.equal(run.publishable, false);
    assert.equal(run.status, 'INCOMPLETE');
    assert.ok(run.gate.blockers.some(l => l.code === 'NO_TERMINATION_PROOF'));
  });
});

test('无 COUNT 但出现不足一页的短尾页：可凭短页终止并发布', async () => {
  await withArchive(async directory => {
    const ground = {
      id: 'ground-short',
      quads: Array.from({ length: 3 }, (_, i) =>
        DF.quad(DF.namedNode('https://lab.invalid/A'),
          DF.namedNode(`https://lab.invalid/p${i}`), DF.literal(`v${i}`))),
    };
    const run = await new HarvestRunner(
      new MockEndpoint(PROFILES.limitedTable, ground), directory)
      .harvestBounded({
        pattern: [['subject', 'https://lab.invalid/A']],
        variables: ['subject', 'predicate', 'object', 'graph'],
      });
    assert.equal(run.status, 'COMPLETE');
    assert.equal(run.termination.kind, 'SHORT_PAGE');
    assert.equal(run.termination.shortPageObserved, true);
    assert.equal(run.gate.decision, 'PUBLISH');
  });
});

test('默认图整图领取：graphIri 为空串时只取 DefaultGraph 四元组', async () => {
  await withArchive(async directory => {
    const run = await new HarvestRunner(
      new MockEndpoint(PROFILES.graphExport, baseDataset()), directory)
      .harvestNamedGraph('');
    assert.equal(run.gate.decision, 'PUBLISH');
    const quads = run.responses[0].normalized.quads;
    assert.equal(quads.length, 1);
    assert.equal(quads[0].graph.termType, 'DefaultGraph');
    assert.equal(quads[0].object.value, '光谱仪');
  });
});

test('语言标签与数据类型端到端保真，不被降级为无类型字符串', async () => {
  await withArchive(async directory => {
    const run = await new HarvestRunner(
      new MockEndpoint(PROFILES.graphExport, baseDataset()), directory)
      .harvestNamedGraph(INSTRUMENTS);
    const quads = run.responses[0].normalized.quads;
    const labeled = quads.find(q => q.object.termType === 'Literal' && q.object.language === 'zh');
    assert.ok(labeled, '语言标签字面量必须保留');
    const year = quads.find(q => q.object.datatype
      && q.object.datatype === 'http://www.w3.org/2001/XMLSchema#integer');
    assert.ok(year, 'xsd:integer 数据类型必须保留');
    assert.equal(year.object.value, '2026');
    // 规范化产物重新解析后同样保留。
    const canonicalText = await new Archive(directory).read(run.responses[0].canonical.canonicalSha256);
    const reparsed = new (await import('n3')).Parser({ format: 'TriG' }).parse(canonicalText.toString());
    const reYear = reparsed.find(q => q.object.termType === 'Literal'
      && q.object.datatype.value === 'http://www.w3.org/2001/XMLSchema#integer');
    assert.equal(reYear.object.language, '');
    assert.equal(reYear.object.value, '2026');
  });
});

test('原始字节与规范化记录双向可查：归档摘要可还原并重新校验', async () => {
  await withArchive(async directory => {
    const run = await new HarvestRunner(
      new MockEndpoint(PROFILES.graphExport, baseDataset()), directory)
      .harvestNamedGraph(INSTRUMENTS);
    const response = run.responses[0];
    const bytes = await new Archive(directory).read(response.sha256);
    assert.equal(digest(bytes), response.sha256);
    // 规范化产物也内容寻址，且记录里保留派生关系。
    const canonicalBytes = await new Archive(directory).read(response.canonical.canonicalSha256);
    assert.equal(digest(canonicalBytes), response.canonical.canonicalSha256);
    const receipt = JSON.parse(await readFile(
      join(directory, 'receipts', `${response.canonical.canonicalReceiptId}.json`), 'utf8'));
    assert.equal(receipt.metadata.derivedFrom, response.sha256);
    // 词法证据可直接切回原始字节中的 _:标签。
    const occurrence = response.normalized.blankNode.occurrences[0];
    assert.equal(bytes.slice(occurrence.start, occurrence.end).toString(),
      `_:${occurrence.originalLabel}`);
  });
});
