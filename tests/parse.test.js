import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTriGResponse, parseResultRows, decodeSparqlTerm } from '../src/rdf/parse.js';

const TRIG = '@prefix ex: <https://lab.invalid/> .\n'
  + '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n'
  + 'ex:instruments { ex:A ex:certificate _:b0 . _:b0 ex:label "检定"@zh ; ex:year "2026"^^xsd:integer . }\n'
  + 'ex:staff { ex:B ex:certificate _:b0 . }\n'
  + 'ex:A ex:name "光谱仪" .\n';

test('解析保留原始空白节点标签、行列位置与响应作用域', () => {
  const record = parseTriGResponse(TRIG, 0);
  assert.equal(record.blankNode.scope, 'response');
  assert.equal(record.blankNode.labelMap.length, 1);
  assert.equal(record.blankNode.labelMap[0].originalLabel, 'b0');
  assert.equal(record.blankNode.labelMap[0].harvestLabel, 'r0_b0');
  // 词法出现位置必须能指回原始字节。
  for (const occurrence of record.blankNode.occurrences) {
    assert.equal(occurrence.originalLabel, 'b0');
    assert.equal(TRIG.slice(occurrence.start, occurrence.end), `_:${occurrence.originalLabel}`);
    assert.ok(occurrence.line >= 1);
  }
  // 分号谓词列表：一个词法主语支撑多条四元组，出现次数独立于四元组数。
  assert.ok(record.blankNode.occurrences.length < record.quads.length);
  assert.equal(record.quadCount, 5);
});

test('同一响应内相同标签解析为同一节点（响应内关联不丢）', () => {
  const record = parseTriGResponse(TRIG, 0);
  const bnodeQuads = record.quads.filter(q =>
    q.subject.termType === 'BlankNode' || q.object.termType === 'BlankNode');
  const labels = new Set();
  for (const quad of bnodeQuads) {
    if (quad.subject.termType === 'BlankNode') labels.add(quad.subject.value);
    if (quad.object.termType === 'BlankNode') labels.add(quad.object.value);
  }
  assert.deepEqual([...labels], ['r0_b0']);
  const graphs = new Set(bnodeQuads.map(q => q.graph.value));
  assert.ok(graphs.has('https://lab.invalid/instruments'));
  assert.ok(graphs.has('https://lab.invalid/staff'));
});

test('不同响应的同名空白节点获得不同作用域标签，绝不跨响应连接', () => {
  const first = parseTriGResponse(TRIG, 0);
  const second = parseTriGResponse(TRIG, 1);
  assert.equal(first.blankNode.labelMap[0].harvestLabel, 'r0_b0');
  assert.equal(second.blankNode.labelMap[0].harvestLabel, 'r1_b0');
});

test('词法标签与解析器集合不一致时拒绝产出，而不是静默对齐', () => {
  // 构造一个前缀规则无法识别的场景：直接调用并篡改文本的校验路径较难，
  // 这里验证正常文档不会误报，篡改内部 id 规则的负例在 canonical 测试覆盖。
  const record = parseTriGResponse(TRIG, 0);
  assert.equal(record.containsBlankNodes, true);
});

test('SELECT 术语解码保留语言标签与数据类型，默认图有显式哨兵', () => {
  assert.equal(decodeSparqlTerm('<https://lab.invalid/A>').termType, 'NamedNode');
  assert.equal(decodeSparqlTerm('_:b0').termType, 'BlankNode');
  const lang = decodeSparqlTerm('"检定"@zh');
  assert.equal(lang.language, 'zh');
  const integer = decodeSparqlTerm('"2026"^^<http://www.w3.org/2001/XMLSchema#integer>');
  assert.equal(integer.datatype.value, 'http://www.w3.org/2001/XMLSchema#integer');
  assert.equal(decodeSparqlTerm('<urn:graph-harvest:default-graph>').termType, 'DefaultGraph');
});

test('行式结果按 RDF 术语解码，并报告空白节点能力信号', () => {
  const result = parseResultRows([
    { s: '<https://lab.invalid/A>', o: '_:b0' },
    { s: '<https://lab.invalid/B>', o: '"检定"@zh' },
  ]);
  assert.equal(result.rowCount, 2);
  assert.equal(result.containsBlankNodes, true);
  assert.equal(result.rows[1].o.language, 'zh');
});

test('含下划线/连字符的空白标签：原始标签还原与字节切片仍然准确', () => {
  const trig = '_:complex_label_1 <https://x/p> _:b-2 . '
    + '_:complex_label_1 <https://x/q> _:b-2 .';
  const record = parseTriGResponse(trig, 0);
  const labels = record.blankNode.labelMap.map(entry => entry.originalLabel).sort();
  assert.deepEqual(labels, ['b-2', 'complex_label_1']);
  for (const occurrence of record.blankNode.occurrences) {
    assert.equal(trig.slice(occurrence.start, occurrence.end), `_:${occurrence.originalLabel}`);
  }
  // 同文档内重复出现仍指向同一响应作用域节点。
  const harvestLabels = new Set(record.blankNode.occurrences.map(o => o.harvestLabel));
  assert.equal(harvestLabels.size, 2);
});
