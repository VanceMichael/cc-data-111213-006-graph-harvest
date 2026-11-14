import { readFile, mkdtemp, rm, readdir, readFile as readFileAsync } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Archive } from './archive.js';
import { inspect } from './domain.js';
import { HarvestRunner } from './harvest/runner.js';
import { MockEndpoint } from './endpoints/mock.js';
import { baseDataset, changedDataset, symmetricDataset, PROFILES } from './endpoints/dataset.js';
import { diffRuns } from './diff/compare.js';

const [command = 'help', ...args] = process.argv.slice(2);

function buildEndpoint(profileId) {
  if (profileId === 'graph-export') return new MockEndpoint(PROFILES.graphExport, baseDataset());
  if (profileId === 'limited-table') return new MockEndpoint(PROFILES.limitedTable, baseDataset());
  throw new Error(`未知端点档案: ${profileId}`);
}

async function run() {
  if (command === 'help') {
    console.log(JSON.stringify({
      usage: 'npm start -- <命令> [参数]',
      commands: ['inspect <trig>', 'capture <trig> [归档目录]', 'list [归档目录]',
        'harvest <端点档案> <命名图IRI|默认图用DEFAULT> [归档目录]',
        'bounded <端点档案> [归档目录]', 'diff <runA.json> <runB.json>', 'demo'],
    }, null, 2));
    return;
  }

  if (command === 'inspect') {
    console.log(JSON.stringify(await inspect(resolve(args[0])), null, 2));
    return;
  }

  if (command === 'capture') {
    const [file, directory = '.local/archive'] = args;
    const inventory = await inspect(resolve(file));
    const receipt = await new Archive(directory).accept(await readFile(file),
      { source: resolve(file), inventory });
    console.log(JSON.stringify(receipt, null, 2));
    return;
  }

  if (command === 'list') {
    console.log(JSON.stringify(await new Archive(args[0] || '.local/archive').receipts(), null, 2));
    return;
  }

  if (command === 'harvest') {
    const [profileId, graphArg, directory = '.local/archive'] = args;
    const endpoint = buildEndpoint(profileId);
    const graphIri = graphArg === 'DEFAULT' ? '' : graphArg;
    const run = await new HarvestRunner(endpoint, directory).harvestNamedGraph(graphIri);
    console.log(JSON.stringify(summarizeRun(run), null, 2));
    return;
  }

  if (command === 'bounded') {
    const [profileId, directory = '.local/archive'] = args;
    const endpoint = buildEndpoint(profileId);
    const pattern = [['graph', 'https://lab.invalid/instruments']];
    const run = await new HarvestRunner(endpoint, directory).harvestBounded({
      pattern, variables: ['subject', 'predicate', 'object', 'graph'],
    });
    console.log(JSON.stringify(summarizeRun(run), null, 2));
    return;
  }

  if (command === 'diff') {
    const [runAPath, runBPath] = args;
    const runA = JSON.parse(await readFileAsync(resolve(runAPath), 'utf8'));
    const runB = JSON.parse(await readFileAsync(resolve(runBPath), 'utf8'));
    console.log(JSON.stringify(diffRuns(runA, runB), null, 2));
    return;
  }

  if (command === 'demo') {
    await demo();
    return;
  }

  throw new Error('支持 inspect、capture、list、harvest、bounded、diff、demo');
}

function summarizeRun(run) {
  return {
    runId: run.runId,
    endpointId: run.endpointId,
    target: run.target,
    status: run.status,
    strategy: run.strategyDecision,
    gate: run.gate,
    termination: run.termination ?? null,
    responses: run.responses.map(r => ({
      responseSeq: r.responseSeq,
      sha256: r.sha256,
      size: r.size,
      quadCount: r.normalized?.quadCount ?? r.rows?.rowCount ?? 0,
      blankNodeScope: r.normalized?.blankNode.scope ?? null,
      blankNodeLabelMap: r.normalized?.blankNode.labelMap ?? [],
      canonicalStatus: r.canonical?.components.map(c => c.status) ?? [],
      canonicalSha256: r.canonical?.canonicalSha256 ?? null,
    })),
  };
}

// 全流程演练：重复领取、跨图同标签、结构对称、能力不足阻断与逐页对账。
async function demo() {
  const root = await mkdtemp(join(tmpdir(), 'graph-harvest-'));
  try {
    const report = {};

    // 场景 1：整图端点两次领取同一命名图，空白节点标签每次都被改名。
    const graphEndpoint1 = new MockEndpoint(PROFILES.graphExport, baseDataset());
    const graphEndpoint2 = new MockEndpoint(PROFILES.graphExport, baseDataset());
    const runner1 = new HarvestRunner(graphEndpoint1, join(root, 'archive'));
    const runner2 = new HarvestRunner(graphEndpoint2, join(root, 'archive'));
    const run1 = await runner1.harvestNamedGraph('https://lab.invalid/instruments');
    const run2 = await runner2.harvestNamedGraph('https://lab.invalid/instruments');
    report.repeatHarvest = {
      gate: [run1.gate.decision, run2.gate.decision],
      labelMaps: [run1.responses[0].normalized.blankNode.labelMap,
        run2.responses[0].normalized.blankNode.labelMap],
      diff: diffRuns(run1, run2),
    };

    // 场景 2：第二次领取换成 changed 数据集——改名之外另有真实增删。
    const changedEndpoint = new MockEndpoint(PROFILES.graphExport, changedDataset());
    const run3 = await new HarvestRunner(changedEndpoint, join(root, 'archive'))
      .harvestNamedGraph('https://lab.invalid/instruments');
    report.realChange = diffRuns(run1, run3);

    // 场景 3：跨命名图同标签——staff 图里的 _:b0 与 instruments 图里的 _:b0
    // 在同一响应内是同一节点；单独导出 staff 图时标签不得跨响应连接。
    const staffRun = await new HarvestRunner(
      new MockEndpoint(PROFILES.graphExport, baseDataset()), join(root, 'archive'))
      .harvestNamedGraph('https://lab.invalid/staff');
    report.crossGraphSameLabel = {
      instrumentsLabels: run1.responses[0].normalized.blankNode.labelMap,
      staffLabels: staffRun.responses[0].normalized.blankNode.labelMap,
      scopesKeptSeparate: run1.runId !== staffRun.runId
        && run1.responses[0].normalized.blankNode.scope === 'response'
        && staffRun.responses[0].normalized.blankNode.scope === 'response',
    };

    // 场景 4：8 节点对称结构，规范化必须报告 AMBIGUOUS 与对称类。
    const symmetricRun = await new HarvestRunner(
      new MockEndpoint(PROFILES.graphExport, symmetricDataset()), join(root, 'archive'))
      .harvestNamedGraph('https://lab.invalid/symmetric-a');
    report.symmetric = {
      gate: symmetricRun.gate,
      components: symmetricRun.responses[0].canonical.components,
    };

    // 场景 5：限行数端点，目标含空白节点 → 阻断发布并写明缺口。
    const blockedRun = await new HarvestRunner(
      new MockEndpoint(PROFILES.limitedTable, baseDataset()), join(root, 'archive'))
      .harvestBounded({
        pattern: [['graph', 'https://lab.invalid/instruments']],
        variables: ['subject', 'predicate', 'object', 'graph'],
      });
    report.blocked = summarizeRun(blockedRun);

    // 场景 6：限行数端点、仅落地三元组、且拿到 COUNT 对账 → 边界内可发布。
    const groundDataset = {
      id: 'ground-only',
      quads: baseDataset().quads.filter(q =>
        q.subject.termType !== 'BlankNode' && q.object.termType !== 'BlankNode'),
    };
    const countableProfile = { ...PROFILES.limitedTable, id: 'limited-table-count', countSupported: true };
    const boundedRun = await new HarvestRunner(
      new MockEndpoint(countableProfile, groundDataset), join(root, 'archive'))
      .harvestBounded({
        pattern: [['subject', 'https://lab.invalid/A']],
        variables: ['subject', 'predicate', 'object', 'graph'],
      });
    report.boundedComplete = summarizeRun(boundedRun);

    // 证据链清单：归档对象与 run 记录落盘位置。
    report.archive = { root, receipts: await readdir(join(root, 'archive', 'receipts')),
      runs: await readdir(join(root, 'archive', 'runs')),
      objects: await readdir(join(root, 'archive', 'objects')) };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
