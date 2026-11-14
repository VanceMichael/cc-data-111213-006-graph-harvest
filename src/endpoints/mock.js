// 模拟两类授权 SPARQL 端点。
//
// 真实端点允许的查询能力不同，这里用确定性“随机改名”复现关键事实：
// 同一资源两次领取，空白节点标签几乎必然不同；同一响应内相同标签仍指向同一节点。
// 任何采集流程都不能假设 _:b0 可以跨请求连接。
import { createHash, randomUUID } from 'node:crypto';
import { DataFactory as DF, Writer } from 'n3';

// graph-export：可以对命名图做 CONSTRUCT/DESCRIBE 整图导出。
// limited-table：只能 SELECT 限行数，maxRows=2，不保证空白节点可无损还原。
export class MockEndpoint {
  constructor(profile, dataset) {
    this.profile = profile;
    this.dataset = dataset;
    this.requestCount = 0;
    // 每个端点实例独立盐值：两个独立实例即便请求序号相同，改名结果也不同，
    // 模拟真实端点之间标签互不稳定。
    this.salt = randomUUID();
  }

  get id() { return this.profile.id; }
  get capabilities() {
    return {
      id: this.profile.id,
      exportGraph: Boolean(this.profile.exportGraph),
      maxRows: this.profile.maxRows ?? null,
      stableBlankLabels: false,
      countSupported: Boolean(this.profile.countSupported),
    };
  }

  // 整图导出：返回 TriG 字节。每次调用都给空白节点换一套名字。
  exportNamedGraph(graphIri) {
    this.#assertCapability(this.profile.exportGraph, '该端点不支持命名图整图导出');
    const graph = graphIri === '' ? null : DF.namedNode(graphIri);
    const quads = this.dataset.quads.filter(q =>
      graph === null ? q.graph.termType === 'DefaultGraph'
        : q.graph.termType === 'NamedNode' && q.graph.value === graphIri);
    if (quads.length === 0) throw new Error(`端点上不存在图: ${graphIri}`);
    const rename = this.#renamePlan(quads);
    return this.#writeTrig(quads, rename);
  }

  // 限行数 SELECT：按 OFFSET/LIMIT 返回术语字符串行，不透明表格不出现，
  // 每个绑定值都是完整 RDF 术语。OFFSET 越过结果集时抛错，绝不返回伪造空页，
  // 否则采集器会把“耗尽后又取一页”误判成短尾页终止。
  selectRows({ pattern, variables, offset = 0, limit }) {
    if (offset > 0) {
      const matched = this.dataset.quads.filter(q =>
        pattern.every(([position, iri]) => termMatches(q[position], iri)));
      if (offset >= matched.length) {
        const error = new Error(`OFFSET ${offset} 已越过结果集，端点不返回任何页面`);
        error.code = 'OFFSET_OUT_OF_RANGE';
        throw error;
      }
    }
    const effectiveLimit = Math.min(limit ?? Infinity, this.profile.maxRows ?? Infinity);
    const rename = this.#renamePlan(this.dataset.quads);
    const all = this.dataset.quads
      .filter(q => pattern.every(([position, iri]) => termMatches(q[position], iri)))
      .map(q => Object.fromEntries(variables.map(variable =>
        [variable, sparqlText(renameTerm(q[variable], rename))])));
    return {
      rows: all.slice(offset, offset + effectiveLimit),
      totalMatched: all.length,
      offset,
      limit: effectiveLimit,
      hasMore: offset + effectiveLimit < all.length,
    };
  }

  // 能力探测：询问某模式是否涉及空白节点。真实环境可由一次小规模探测查询得到。
  patternHasBlankNodes(pattern) {
    return this.dataset.quads.some(q =>
      pattern.every(([position, iri]) => termMatches(q[position], iri))
      && (q.subject.termType === 'BlankNode' || q.object.termType === 'BlankNode'));
  }

  countRows(pattern) {
    this.#assertCapability(this.profile.countSupported, '该端点不支持 COUNT 聚合，无法给出完整性终止证据');
    return this.dataset.quads.filter(q =>
      pattern.every(([position, iri]) => termMatches(q[position], iri))).length;
  }

  #assertCapability(ok, message) {
    if (!ok) {
      const error = new Error(message);
      error.code = 'CAPABILITY_UNSUPPORTED';
      throw error;
    }
  }

  // 生成“本响应作用域”的改名计划：内部节点 id -> 本响应标签。
  #renamePlan(quads) {
    this.requestCount += 1;
    const internal = new Set();
    for (const q of quads) {
      if (q.subject.termType === 'BlankNode') internal.add(q.subject.value);
      if (q.object.termType === 'BlankNode') internal.add(q.object.value);
    }
    const suffix = createHash('sha1')
      .update(`${this.profile.id}:${this.salt}:${this.requestCount}`)
      .digest('hex').slice(0, 8);
    const plan = new Map();
    [...internal].sort().forEach((id, index) => plan.set(id, `b${index}_${suffix}`));
    return plan;
  }

  #writeTrig(quads, rename) {
  const rewritten = quads.map(q => DF.quad(
    renameTerm(q.subject, rename), renameTerm(q.predicate, rename),
    renameTerm(q.object, rename), q.graph));
    return new Promise((resolve, reject) => {
      const writer = new Writer({ format: 'application/trig' });
      writer.addQuads(rewritten);
      writer.end((error, result) => (error ? reject(error) : resolve(Buffer.from(result, 'utf8'))));
    });
  }
}

function renameTerm(term, plan) {
  if (term.termType !== 'BlankNode') return term;
  return DF.blankNode(plan.get(term.value));
}

function termMatches(term, iri) {
  if (iri === null) return true;
  return term.termType === 'NamedNode' && term.value === iri;
}

// SELECT 绑定里的完整 RDF 术语文本（语言标签与数据类型保留）。
const DEFAULT_GRAPH_URN = 'urn:graph-harvest:default-graph';
function sparqlText(term) {
  if (term.termType === 'DefaultGraph') return `<${DEFAULT_GRAPH_URN}>`;
  if (term.termType === 'NamedNode') return `<${term.value}>`;
  if (term.termType === 'BlankNode') return `_:${term.value}`;
  const lexical = term.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  if (term.language) return `"${lexical}"@${term.language}`;
  const dt = term.datatype?.value ?? 'http://www.w3.org/2001/XMLSchema#string';
  return `"${lexical}"^^<${dt}>`;
}
