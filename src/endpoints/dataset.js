// 采集演练用的机构资质数据集（仅含 https://lab.invalid/ 测试命名空间）。
// 三组数据各自覆盖一类必须正确处理的情形：
//   base       —— 两个命名图 + 默认图，空白节点被两张图共同引用（响应内关联）
//   changed    —— 仅空白节点改名 + 真实新增/删除关系，用于区分两种差异
//   symmetric  —— 8 个结构对称节点分布在两张图，无法低成本消歧
import { DataFactory as DF } from 'n3';

const EX = 'https://lab.invalid/';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const n = local => DF.namedNode(EX + local);
const b = id => DF.blankNode(id);
const lit = (value, languageOrDatatype) => DF.literal(value, languageOrDatatype);
const G = {
  instruments: n('instruments'),
  staff: n('staff'),
  symmetricA: n('symmetric-a'),
  symmetricB: n('symmetric-b'),
};

// 基础数据集。_:cert 同时被 instruments 与 staff 两张图引用，
// 响应内这种关联必须保留；默认图里还有一条没有图包裹的普通三元组。
export function baseDataset() {
  const quads = [
    DF.quad(n('A'), n('certificate'), b('cert1'), G.instruments),
    DF.quad(b('cert1'), n('label'), lit('检定', 'zh'), G.instruments),
    DF.quad(b('cert1'), n('year'), lit('2026', DF.namedNode(XSD_INTEGER)), G.instruments),
    DF.quad(n('B'), n('certificate'), b('cert1'), G.staff),
    DF.quad(n('A'), n('name'), lit('光谱仪')),
  ];
  return { id: 'qualification-base', quads, graphs: [G.instruments.value, G.staff.value, ''] };
}

// 变化数据集：
//   - 所有空白节点内部 id 全部更换（模拟两次领取仅仅换了标签名）
//   - 真实新增：cert 多一条 ex:calibration 关系，且新增第二台仪器 C
//   - 真实删除：staff 图里 B -> cert 的引用被移除
export function changedDataset() {
  const quads = [
    DF.quad(n('A'), n('certificate'), b('renamed-cert-z9'), G.instruments),
    DF.quad(b('renamed-cert-z9'), n('label'), lit('检定', 'zh'), G.instruments),
    DF.quad(b('renamed-cert-z9'), n('year'), lit('2026', DF.namedNode(XSD_INTEGER)), G.instruments),
    DF.quad(b('renamed-cert-z9'), n('calibration'), lit('年度校准', 'zh'), G.instruments),
    DF.quad(n('C'), n('certificate'), b('renamed-cert-z9'), G.instruments),
    DF.quad(n('A'), n('name'), lit('光谱仪')),
  ];
  return { id: 'qualification-changed', quads, graphs: [G.instruments.value, G.staff.value, ''] };
}

// 对称数据集：8 个空白节点，每个都有完全相同的落地描述。
// 每张命名图内 4 个节点连成一个 4 环（单连通分量、4 节点互为对称），
// 颜色细化无法区分它们，正确行为是报告 AMBIGUOUS 与对称等价类，
// 而不是臆造身份；两张图同标签的节点也不得跨图合并。
export function symmetricDataset() {
  const quads = [];
  for (let i = 0; i < 8; i += 1) {
    const node = b(`sym${i}`);
    const graph = i < 4 ? G.symmetricA : G.symmetricB;
    quads.push(DF.quad(n('Anchor'), n('holds'), node, graph));
    quads.push(DF.quad(node, n('kind'), lit('标准砝码', 'zh'), graph));
  }
  for (const base of [0, 4]) {
    const graph = base === 0 ? G.symmetricA : G.symmetricB;
    for (let offset = 0; offset < 4; offset += 1) {
      const from = b(`sym${base + offset}`);
      const to = b(`sym${base + ((offset + 1) % 4)}`);
      quads.push(DF.quad(from, n('pairedWith'), to, graph));
    }
  }
  return {
    id: 'symmetric-pairing',
    quads,
    graphs: [G.symmetricA.value, G.symmetricB.value],
  };
}

export const PROFILES = Object.freeze({
  graphExport: Object.freeze({
    id: 'graph-export', exportGraph: true, stableBlankLabels: false, countSupported: true,
  }),
  limitedTable: Object.freeze({
    id: 'limited-table', exportGraph: false, maxRows: 2, stableBlankLabels: false,
    countSupported: false,
  }),
});
