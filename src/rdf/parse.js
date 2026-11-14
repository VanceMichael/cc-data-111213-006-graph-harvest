// SPARQL/TriG 响应的 RDF 级解析。
//
// 两个必须同时守住的边界：
//  1. 空白节点的作用域是“单个响应文档”。n3 解析器会给标签加文档作用域前缀 bN_，
//     同文档内相同标签仍指向同一节点（响应内关联不丢），但我们绝不把不同响应里
//     同名的 _:b0 当作同一节点——跨请求标签不具备连接语义。
//  2. 原始响应字节与规范化四元组之间要能对证。Lexer 保留了原始空白节点标签和
//     行列位置；解析器内部 id 的 bN_ 前缀可还原出原始标签，两份证据互相校验。
import { Parser, Lexer, DataFactory as DF } from 'n3';
import { termToJson, quadToJson, termFromJson } from './terms.js';

// 解析一份 TriG 响应文本，返回响应级记录（不修改任何字节本身）。
// responseSeq 是该响应在一次领取中的序号（0 起），用于生成响应作用域空白标签。
export function parseTriGResponse(text, responseSeq) {
  const lexer = new Lexer({ format: 'TriG' });
  // n3 Lexer 的 start/end 是“行内偏移”且 end 含尾随空白，不是全局字节偏移。
  // 这里预先记录每一行在原始字节中的起始位置，自行还原可切片的全局区间。
  const lineStarts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') lineStarts.push(i + 1);
    if (text[i] === '\r' && text[i + 1] === '\n') i += 1;
  }
  const blankTokens = lexer.tokenize(text)
    .filter(token => token.type === 'blank')
    .map(token => {
      const lineStart = lineStarts[token.line - 1];
      // 行内 start 指向 "_:" 的下划线；标签文本长度已知，end 截到标签最后一个字符。
      const start = lineStart + token.start;
      const end = start + 2 + token.value.length;
      return { label: token.value, line: token.line, start, end };
    });

  const quads = new Parser({ format: 'TriG' }).parse(text);
  const graphs = new Set();
  for (const quad of quads) {
    graphs.add(quad.graph.termType === 'DefaultGraph' ? '' : quad.graph.value);
  }

  // 解析器内部 id 形如 bN_<原始标签>，用首个空白词法标记还原前缀并校验。
  const parserIds = new Set();
  for (const quad of quads) {
    if (quad.subject.termType === 'BlankNode') parserIds.add(quad.subject.value);
    if (quad.object.termType === 'BlankNode') parserIds.add(quad.object.value);
  }
  const scopedToOriginal = new Map();
  for (const id of parserIds) {
    const separator = id.indexOf('_');
    if (separator < 0 || !/^b\d+$/.test(id.slice(0, separator))) {
      throw new Error(`无法识别解析器空白节点作用域前缀: ${id}`);
    }
    scopedToOriginal.set(id, id.slice(separator + 1));
  }
  // 还原出的原始标签集合必须与词法流看到的标签集合一致（双向证据校验）。
  const lexicalLabels = new Set(blankTokens.map(token => token.label));
  const restoredLabels = new Set(scopedToOriginal.values());
  if (lexicalLabels.size !== restoredLabels.size
      || [...lexicalLabels].some(label => !restoredLabels.has(label))) {
    throw new Error('词法空白标签与解析器空白节点集合不一致，拒绝在证据不完整时继续');
  }

  // 生成只在“本响应内”有效的稳定标签 r{seq}_b{n}，替换解析器内部 id。
  const scopedToHarvest = new Map();
  const labelMap = [];
  let counter = 0;
  for (const [scopedId, originalLabel] of [...scopedToOriginal.entries()]
    .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))) {
    const harvestLabel = `r${responseSeq}_b${counter++}`;
    scopedToHarvest.set(scopedId, harvestLabel);
    labelMap.push({ harvestLabel, parserScopedId: scopedId, originalLabel });
  }

  // 词法出现证据：每个空白标签在原始字节中的位置，映射到本响应规范标签。
  // 同一标签可能因分号谓词列表只出现一次却支撑多条四元组，因此出现次数独立记录。
  const originalToHarvest = new Map(
    labelMap.map(entry => [entry.originalLabel, entry.harvestLabel]));
  const occurrences = blankTokens.map(token => ({
    originalLabel: token.label,
    harvestLabel: originalToHarvest.get(token.label),
    line: token.line,
    start: token.start,
    end: token.end,
  }));

  const normalizedQuads = quads.map(quad => DF.quad(
    rewrite(quad.subject), rewrite(quad.predicate), rewrite(quad.object), quad.graph));
  function rewrite(term) {
    if (term.termType !== 'BlankNode') return term;
    return DF.blankNode(scopedToHarvest.get(term.value));
  }

  return {
    responseSeq,
    graphs: [...graphs],
    containsBlankNodes: labelMap.length > 0,
    quadCount: normalizedQuads.length,
    quads: normalizedQuads.map(quadToJson),
    blankNode: {
      scope: 'response',
      labelMap,
      occurrences,
    },
  };
}

// 解析 SPARQL SELECT 风格的行式结果（每个绑定值已是 RDF 术语字符串）。
// 只做术语级解码，绝不把行当成不透明字符串；返回是否出现空白节点这一能力信号。
export function parseResultRows(rows) {
  const decoded = rows.map(row => {
    const result = {};
    for (const [variable, termText] of Object.entries(row)) {
      result[variable] = termToJson(decodeSparqlTerm(termText));
    }
    return result;
  });
  return {
    rows: decoded,
    rowCount: decoded.length,
    containsBlankNodes: decoded.some(row =>
      Object.values(row).some(term => term.termType === 'BlankNode')),
  };
}

// 解码 SELECT 结果绑定中的 RDF 术语字符串，保留语言标签与数据类型。
const DEFAULT_GRAPH_URN = 'urn:graph-harvest:default-graph';
export function decodeSparqlTerm(text) {
  if (text === `<${DEFAULT_GRAPH_URN}>`) return DF.defaultGraph();
  if (text.startsWith('<') && text.endsWith('>')) return DF.namedNode(text.slice(1, -1));
  if (text.startsWith('_:')) return DF.blankNode(text.slice(2));
  if (text.startsWith('"')) {
    // 找结束引号（允许转义），再区分 @语言 与 ^^数据类型。
    let i = 1;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i] === '"') break;
      i += 1;
    }
    const lexical = unescapeString(text.slice(1, i));
    const suffix = text.slice(i + 1);
    if (suffix.startsWith('@')) return DF.literal(lexical, suffix.slice(1));
    if (suffix.startsWith('^^<') && suffix.endsWith('>')) {
      return DF.literal(lexical, DF.namedNode(suffix.slice(3, -1)));
    }
    return DF.literal(lexical);
  }
  throw new Error(`无法识别的 SPARQL 术语: ${text}`);
}

function unescapeString(value) {
  return value.replace(/\\(.)/g, (_, char) => {
    if (char === 'n') return '\n';
    if (char === 'r') return '\r';
    if (char === 't') return '\t';
    return char;
  });
}

export { termFromJson };
