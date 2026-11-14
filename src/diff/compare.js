// 两次领取的结构化对比。
//
// 关键区分：
//   RELABELED —— 空白节点名字不同，但落地锚点、图、边结构与字面量完全一致（同构）；
//   MODIFIED  —— 同构之外真的发生了关系新增/删除；
//   ADDED/REMOVED —— 分量本身新增或消失。
// 落地（不含空白节点）的四元组可以逐行精确 diff；对称分量只报告同构层面的结论，
// 不臆造节点身份。
import { canonicalize } from '../rdf/canonical.js';
import { quadFromJson, encodeTerm } from '../rdf/terms.js';

function isGround(quadJson) {
  return quadJson.subject.termType !== 'BlankNode' && quadJson.object.termType !== 'BlankNode';
}

function lineOf(quadJson) {
  const q = quadFromJson(quadJson);
  return `${encodeTerm(q.subject)} ${encodeTerm(q.predicate)} ${encodeTerm(q.object)} ${encodeTerm(q.graph)}`;
}

// 从 run 中取出合并后的四元组 JSON（一次整图导出通常只有一个响应）。
function runQuads(run) {
  const quads = [];
  for (const response of run.responses) {
    if (response.normalized) quads.push(...response.normalized.quads);
  }
  return quads;
}

function componentIndex(quads) {
  const canonical = canonicalize(quads);
  // 结构签名与空白节点标签无关：两次运行同构即相等，真正增删才会失配。
  const fingerprints = canonical.components.map((component, index) => ({
    index,
    fingerprint: [
      component.structuralSignature,
      `anchors:${component.groundAnchors.join('|')}`,
      `graphs:${component.graphs.join('|')}`,
      `nodes:${component.nodeCount}`,
      `quads:${component.quadCount}`,
    ].join('//'),
    status: component.status,
    symmetryClasses: component.symmetryClasses,
  }));
  return { canonical, fingerprints };
}

export function diffRuns(previousRun, currentRun) {
  if (JSON.stringify(previousRun.target) !== JSON.stringify(currentRun.target)) {
    throw new Error('只能对比同一目标（同端点同命名图/模式）的两次领取');
  }
  const previousQuads = runQuads(previousRun);
  const currentQuads = runQuads(currentRun);

  // 1) 落地四元组精确 diff。
  const previousGround = new Map(previousQuads.filter(isGround).map(q => [lineOf(q), q]));
  const currentGround = new Map(currentQuads.filter(isGround).map(q => [lineOf(q), q]));
  const groundAdded = [...currentGround.keys()].filter(key => !previousGround.has(key));
  const groundRemoved = [...previousGround.keys()].filter(key => !currentGround.has(key));
  const groundUnchanged = [...currentGround.keys()].filter(key => previousGround.has(key));

  // 2) 空白节点分量指纹对比。
  const previousIndex = componentIndex(previousQuads);
  const currentIndex = componentIndex(currentQuads);
  const matchPrev = new Set();
  const matchCurr = new Set();
  const componentDiffs = [];

  for (const current of currentIndex.fingerprints) {
    const candidate = previousIndex.fingerprints.find(p =>
      !matchPrev.has(p.index) && p.fingerprint === current.fingerprint);
    if (candidate) {
      matchPrev.add(candidate.index);
      matchCurr.add(current.index);
      componentDiffs.push({
        status: candidate.status === 'AMBIGUOUS' || current.status === 'AMBIGUOUS'
          ? 'RELABELED_AMBIGUOUS' : 'RELABELED',
        detail: '空白节点标签变化，规范形式同构，无关系增删',
        previousStatus: candidate.status,
        currentStatus: current.status,
        symmetryClasses: current.symmetryClasses,
      });
    }
  }
  for (const previous of previousIndex.fingerprints) {
    if (!matchPrev.has(previous.index)) {
      componentDiffs.push({ status: 'REMOVED', fingerprint: previous.fingerprint,
        detail: '该空白节点分量在新领取中消失（真实删除）' });
    }
  }
  for (const current of currentIndex.fingerprints) {
    if (!matchCurr.has(current.index)) {
      componentDiffs.push({ status: 'ADDED', fingerprint: current.fingerprint,
        detail: '新领取中出现此前不存在的空白节点分量（真实新增）' });
    }
  }

  // 3) 含空白节点四元组的规范行集合对比，捕捉“同锚点但边变化”的修改。
  const previousBnodeLines = new Set(previousIndex.canonical.canonicalQuads);
  const currentBnodeLines = new Set(currentIndex.canonical.canonicalQuads);
  const bnodeAdded = [...currentBnodeLines].filter(line => !previousBnodeLines.has(line));
  const bnodeRemoved = [...previousBnodeLines].filter(line => !currentBnodeLines.has(line));

  const relabeled = componentDiffs.filter(d => d.status.startsWith('RELABELED')).length;
  const added = componentDiffs.filter(d => d.status === 'ADDED').length;
  const removed = componentDiffs.filter(d => d.status === 'REMOVED').length;
  const ambiguous = previousIndex.canonical.ambiguous || currentIndex.canonical.ambiguous;

  const verdict = !groundAdded.length && !groundRemoved.length
      && !bnodeAdded.length && !bnodeRemoved.length && !added && !removed
    ? (ambiguous ? 'IDENTICAL_WITH_SYMMETRY' : 'IDENTICAL')
    : 'CHANGED';

  return {
    target: currentRun.target,
    verdict,
    ambiguous,
    ground: {
      added: groundAdded,
      removed: groundRemoved,
      unchangedCount: groundUnchanged.length,
    },
    blankNodeComponents: componentDiffs,
    blankNodeQuads: { added: bnodeAdded, removed: bnodeRemoved },
    summary: {
      relabeledComponents: relabeled,
      addedComponents: added,
      removedComponents: removed,
      groundAdded: groundAdded.length,
      groundRemoved: groundRemoved.length,
    },
  };
}
