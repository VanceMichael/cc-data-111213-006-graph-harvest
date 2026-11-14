// RDF 术语的无损表示与编解码。
// 设计目标：IRI、字面量（语言标签 / 数据类型）、空白节点、默认图四类术语都可以
// 序列化为稳定字符串再还原，绝不把 RDF 数据降级成表格字符串。
import { DataFactory as DF } from 'n3';

const RDF_LANGSTRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

// 与 n3 解析结果一致的普通对象形态，便于 JSON 持久化。
export function termToJson(term) {
  const json = { termType: term.termType, value: term.value };
  if (term.termType === 'Literal') {
    json.language = term.language ?? '';
    json.datatype = term.datatype.value;
  }
  return json;
}

export function termFromJson(json) {
  if (json.termType === 'NamedNode') return DF.namedNode(json.value);
  if (json.termType === 'BlankNode') return DF.blankNode(json.value);
  if (json.termType === 'DefaultGraph') return DF.defaultGraph();
  if (json.termType === 'Literal') {
    return DF.literal(json.value, json.language
      ? json.language
      : DF.namedNode(json.datatype || XSD_STRING));
  }
  throw new Error(`不支持的术语类型: ${json.termType}`);
}

// 稳定且可还原的术语编码（不是 N-Triples 也不是展示文本）。
// 前缀单字符区分术语类型，避免不同类型术语的字符串碰撞。
export function encodeTerm(term) {
  if (term.termType === 'NamedNode') return `I<${term.value}>`;
  if (term.termType === 'DefaultGraph') return 'D';
  if (term.termType === 'BlankNode') return `B<${term.value}>`;
  if (term.termType === 'Literal') {
    if (term.language) return `L<${term.value}>@${term.language}`;
    return `L<${term.value}>^^<${term.datatype?.value ?? XSD_STRING}>`;
  }
  throw new Error(`不支持的术语类型: ${term.termType}`);
}

// 解码回 RDF 术语（字面量的语言/数据类型完整还原）。
export function decodeTerm(text) {
  const kind = text[0];
  if (kind === 'D') return DF.defaultGraph();
  if (kind === 'I') return DF.namedNode(text.slice(2, -1));
  if (kind === 'B') return DF.blankNode(text.slice(2, -1));
  if (kind === 'L') {
    const close = text.indexOf('>');
    const value = text.slice(2, close);
    const tail = text.slice(close + 1);
    if (tail.startsWith('@')) return DF.literal(value, tail.slice(1));
    if (tail.startsWith('^^<')) return DF.literal(value, DF.namedNode(tail.slice(3, -1)));
  }
  throw new Error(`无法解码术语: ${text}`);
}

export function quadKey(quad) {
  return `${encodeTerm(quad.subject)} ${encodeTerm(quad.predicate)} ${encodeTerm(quad.object)} ${encodeTerm(quad.graph)}`;
}

export function quadToJson(quad) {
  return {
    subject: termToJson(quad.subject),
    predicate: termToJson(quad.predicate),
    object: termToJson(quad.object),
    graph: termToJson(quad.graph),
  };
}

export function quadFromJson(json) {
  return DF.quad(
    termFromJson(json.subject), termFromJson(json.predicate),
    termFromJson(json.object), termFromJson(json.graph),
  );
}

// 确定性 TriG 序列化：同一组四元组（含给定空白节点标签）输出字节完全一致，
// 因此可以对规范化结果再做内容寻址，并重新解析验证保真。
// 按图 IRI 分组输出，默认图写在最前，组内四元组按完整键排序。
export function serializeCanonical(quads) {
  const groups = new Map();
  for (const quad of quads) {
    const graphKey = quad.graph.termType === 'DefaultGraph' ? '' : quad.graph.value;
    if (!groups.has(graphKey)) groups.set(graphKey, []);
    groups.get(graphKey).push(quad);
  }
  const orderedGraphs = [...groups.keys()].sort();
  const out = [];
  for (const graphKey of orderedGraphs) {
    const groupQuads = groups.get(graphKey)
      .map(quad => ({ quad, key: quadKey(quad) }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const header = graphKey === '' ? null : ntTerm(DF.namedNode(graphKey));
    if (header) out.push(`${header} {\n`);
    for (const { quad } of groupQuads) {
      const line = `${ntTerm(quad.subject)} ${ntTerm(quad.predicate)} ${ntTerm(quad.object)} .\n`;
      out.push(header ? line : line);
    }
    if (header) out.push('}\n');
  }
  return out.join('');
}

// N-Triples 风格的单术语文本，用于确定性 TriG 输出。
function ntTerm(term) {
  if (term.termType === 'NamedNode') return `<${term.value}>`;
  if (term.termType === 'BlankNode') return `_:${term.value}`;
  if (term.termType === 'DefaultGraph') return '';
  const lexical = escapeString(term.value);
  if (term.language) return `"${lexical}"@${term.language}`;
  const dt = term.datatype?.value ?? XSD_STRING;
  if (dt === XSD_STRING) return `"${lexical}"`;
  return `"${lexical}"^^<${dt}>`;
}

function escapeString(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

export { RDF_LANGSTRING, XSD_STRING };
