// 空白节点规范化（有界）。
//
// 目标：把“只换了空白节点名字”的两次领取识别为同构，同时不把结构相似但实际不同
// 的节点压成一个。采用颜色细化（1-WL）求规范形式：
//   - 颜色唯一可区分的节点 → 稳定规范标签 c0、c1…
//   - 细化后仍同色的节点 → 对称等价类，标记 AMBIGUOUS，绝不强行消歧
// 资源边界：分量大小、细化轮次、对称类数量都有上限，超限即标记 BOUNDED，
// 状态写入记录，由发布闸门决定能否发布，而不是静默给出看似确定的结果。
import { createHash } from 'node:crypto';
import { DataFactory as DF } from 'n3';
import { encodeTerm, quadFromJson } from './terms.js';

export const LIMITS = Object.freeze({
  maxComponentNodes: 256,
  maxRefinementRounds: 64,
  maxSymmetryClasses: 1024,
});

// 输入四元组 JSON 数组，输出规范化结果。
export function canonicalize(quadsJson, limits = LIMITS) {
  const quads = quadsJson.map(quadFromJson);
  const bnodeIds = new Set();
  for (const q of quads) {
    if (q.subject.termType === 'BlankNode') bnodeIds.add(q.subject.value);
    if (q.object.termType === 'BlankNode') bnodeIds.add(q.object.value);
  }

  // 用“共享同一空白节点的四元组”构建连通分量。
  const adjacency = new Map([...bnodeIds].map(id => [id, new Set()]));
  for (const q of quads) {
    const sb = q.subject.termType === 'BlankNode' ? q.subject.value : null;
    const ob = q.object.termType === 'BlankNode' ? q.object.value : null;
    if (sb && ob) { adjacency.get(sb).add(ob); adjacency.get(ob).add(sb); }
  }
  const components = connectedComponents([...bnodeIds], adjacency);

  const canonicalLabel = new Map();
  const componentRecords = [];
  let bounded = false;
  let ambiguous = false;
  let nameCounter = 0;

  // 单例“孤立”分量也要处理：没有邻居但有自己的落地描述。
  for (const nodeGroup of components) {
    const nodeIds = [...nodeGroup].sort();
    const componentQuads = quads.filter(q =>
      (q.subject.termType === 'BlankNode' && nodeGroup.has(q.subject.value)) ||
      (q.object.termType === 'BlankNode' && nodeGroup.has(q.object.value)));

    const status = nodeGroup.size > limits.maxComponentNodes ? 'BOUNDED' : null;
    const { colors, symmetryClasses, rounds } = refineColors(nodeIds, componentQuads, limits);

    const componentAmbiguous = symmetryClasses.some(group => group.length > 1);
    const componentBounded = Boolean(status) || rounds >= limits.maxRefinementRounds
      || symmetryClasses.length > limits.maxSymmetryClasses;
    ambiguous ||= componentAmbiguous;
    bounded ||= componentBounded;

    // 分量局部规范名：颜色细化后同色节点连续编号，只在本分量内有意义，
    // 保证同构分量在不同运行里得到相同的局部编号与结构签名。
    const ordered = [...nodeIds].sort((a, b) =>
      (colors.get(a) < colors.get(b) ? -1 : colors.get(b) < colors.get(a) ? 1 : a < b ? -1 : a > b ? 1 : 0));
    // 全局规范标签 cN 仅用于输出可读的规范形式，不参与结构签名。
    // 对称节点的次序依赖输入标签，这一不确定性只在对称类层面暴露，不影响签名。
    for (const id of ordered) canonicalLabel.set(id, `c${nameCounter++}`);
    const graphs = [...new Set(componentQuads.map(q =>
      q.graph.termType === 'DefaultGraph' ? '' : q.graph.value))].sort();
    const anchors = new Set();
    for (const q of componentQuads) {
      if (q.subject.termType !== 'BlankNode') anchors.add(encodeTerm(q.subject));
      if (q.object.termType !== 'BlankNode') anchors.add(encodeTerm(q.object));
    }
    // 标签无关的结构签名：用颜色等价类编号（而不是依赖输入标签次序的节点编号）
    // 重写分量四元组。颜色细化对同构图必然收敛到相同的类划分，
    // 因此两次领取即使空白标签全换、对称节点无法逐一对应，签名仍一致。
    const classNumberOf = new Map();
    symmetryClasses.forEach((group, index) => {
      for (const id of group) classNumberOf.set(id, index);
    });
    const componentCanonicalLines = componentQuads.map(q => {
      const cq = DF.quad(
        rewriteToClass(q.subject, classNumberOf), rewriteToClass(q.predicate, classNumberOf),
        rewriteToClass(q.object, classNumberOf), q.graph);
      return `${encodeTerm(cq.subject)} ${encodeTerm(cq.predicate)} ${encodeTerm(cq.object)} ${encodeTerm(cq.graph)}`;
    }).sort();
    const structuralSignature = createHash('sha256')
      .update(componentCanonicalLines.join('\n')).digest('hex');

    componentRecords.push({
      nodeCount: nodeGroup.size,
      quadCount: componentQuads.length,
      graphs,
      groundAnchors: [...anchors].sort(),
      structuralSignature,
      symmetryClasses: symmetryClasses.map(group => group.map(id => canonicalLabel.get(id))),
      refinementRounds: rounds,
      status: componentBounded ? 'BOUNDED' : componentAmbiguous ? 'AMBIGUOUS' : 'UNAMBIGUOUS',
    });
  }

  // 用规范标签重写四元组并确定性排序，得到可比较的规范形式。
  const canonicalQuads = quads.map(q => DF.quad(
    rewrite(q.subject), rewrite(q.predicate), rewrite(q.object), q.graph));
  function rewrite(term) {
    return term.termType === 'BlankNode'
      ? DF.blankNode(canonicalLabel.get(term.value)) : term;
  }
  const canonicalLines = canonicalQuads.map(q =>
    `${encodeTerm(q.subject)} ${encodeTerm(q.predicate)} ${encodeTerm(q.object)} ${encodeTerm(q.graph)}`)
    .sort();

  return {
    canonicalQuads: canonicalLines,
    components: componentRecords,
    blankNodeCount: bnodeIds.size,
    ambiguous,
    bounded,
    limits,
  };
}

function rewriteToClass(term, classNumberOf) {
  return term.termType === 'BlankNode'
    ? DF.blankNode(`k${classNumberOf.get(term.value)}`) : term;
}

function connectedComponents(ids, adjacency) {
  const seen = new Set();
  const result = [];
  for (const start of ids) {
    if (seen.has(start)) continue;
    const stack = [start];
    const group = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      group.add(id);
      for (const neighbor of adjacency.get(id) ?? []) {
        if (!seen.has(neighbor)) stack.push(neighbor);
      }
    }
    result.push(group);
  }
  return result;
}

// 颜色细化：初始颜色由落地描述决定，迭代并入邻居颜色签名直至稳定。
function refineColors(nodeIds, componentQuads, limits) {
  const colors = new Map();
  for (const id of nodeIds) colors.set(id, initialColor(id, componentQuads));

  let rounds = 0;
  let classes = groupByColor(colors);
  while (rounds < limits.maxRefinementRounds) {
    rounds += 1;
    const next = new Map();
    for (const id of nodeIds) {
      const neighborSignature = [...componentQuads]
        .filter(q => q.subject.termType === 'BlankNode' && q.subject.value === id
          && q.object.termType === 'BlankNode')
        .map(q => `out:${q.predicate.value}:${colors.get(q.object.value)}`)
        .concat([...componentQuads]
          .filter(q => q.object.termType === 'BlankNode' && q.object.value === id
            && q.subject.termType === 'BlankNode')
          .map(q => `in:${q.predicate.value}:${colors.get(q.subject.value)}`))
        .sort();
      next.set(id, `${colors.get(id)}|${neighborSignature.join(',')}`);
    }
    const nextClasses = groupByColor(next);
    for (const [id, color] of next) colors.set(id, color);
    if (nextClasses.length === classes.length) break;
    classes = nextClasses;
  }

  // 把可能很长的颜色字符串换成短而确定的编号。
  const distinct = [...new Set(colors.values())].sort();
  const short = new Map(distinct.map((color, index) => [color, index]));
  for (const id of nodeIds) colors.set(id, short.get(colors.get(id)));
  return { colors, symmetryClasses: groupByColor(colors), rounds };
}

function initialColor(id, componentQuads) {
  const features = [];
  for (const q of componentQuads) {
    const graph = q.graph.termType === 'DefaultGraph' ? 'D' : `G:${q.graph.value}`;
    if (q.subject.termType === 'BlankNode' && q.subject.value === id) {
      features.push(`S ${q.predicate.value} ${q.object.termType === 'BlankNode'
        ? 'B' : encodeTerm(q.object)} ${graph}`);
    }
    if (q.object.termType === 'BlankNode' && q.object.value === id) {
      features.push(`O ${q.predicate.value} ${q.subject.termType === 'BlankNode'
        ? 'B' : encodeTerm(q.subject)} ${graph}`);
    }
  }
  return features.sort().join(';');
}

function groupByColor(colors) {
  const groups = new Map();
  for (const [id, color] of colors) {
    if (!groups.has(color)) groups.set(color, []);
    groups.get(color).push(id);
  }
  return [...groups.values()].map(group => group.sort()).sort((a, b) =>
    (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
