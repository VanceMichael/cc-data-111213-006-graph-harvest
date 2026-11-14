import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataFactory as DF } from 'n3';
import {
  encodeTerm, decodeTerm, serializeCanonical, quadFromJson, termFromJson,
} from '../src/rdf/terms.js';

const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

test('术语编解码保真：IRI、语言标签、数据类型、默认图、空白节点', () => {
  const terms = [
    DF.namedNode('https://lab.invalid/A'),
    DF.literal('光谱仪'),
    DF.literal('检定', 'zh'),
    DF.literal('2026', DF.namedNode(XSD_INTEGER)),
    DF.blankNode('b0'),
    DF.defaultGraph(),
  ];
  for (const term of terms) {
    const roundTrip = decodeTerm(encodeTerm(term));
    assert.equal(roundTrip.termType, term.termType);
    assert.equal(roundTrip.value, term.value);
    if (term.termType === 'Literal') {
      assert.equal(roundTrip.language, term.language);
      assert.equal(roundTrip.datatype.value, term.datatype.value);
    }
  }
});

test('不同术语类型不会因字符串相同而碰撞', () => {
  const iri = encodeTerm(DF.namedNode('b0'));
  const blank = encodeTerm(DF.blankNode('b0'));
  assert.notEqual(iri, blank);
  assert.equal(decodeTerm(iri).termType, 'NamedNode');
  assert.equal(decodeTerm(blank).termType, 'BlankNode');
});

test('规范序列化确定性：同组四元组字节一致，且重新解析后术语集合等价', async () => {
  const { Parser } = await import('n3');
  const trig = '@prefix ex: <https://lab.invalid/> .\n'
    + '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n'
    + 'ex:instruments { ex:A ex:certificate _:b0 . _:b0 ex:label "检定"@zh ; ex:year "2026"^^xsd:integer . }\n'
    + 'ex:A ex:name "光谱仪" .\n';
  const quads = new Parser({ format: 'TriG' }).parse(trig);
  const first = serializeCanonical(quads);
  const shuffled = [...quads].reverse();
  const second = serializeCanonical(shuffled);
  assert.equal(first, second);

  const reparsed = new Parser({ format: 'TriG' }).parse(first);
  // 解析器每次会给空白节点加新的文档作用域前缀，因此比较时剥离 bN_ 前缀，
  // 只验证术语类型、IRI/字面量内容与图结构，不把内部 id 当成稳定身份。
  const strip = value => value.replace(/^(?:b\d+_)+/, '');
  const keyOf = quad => `${quad.subject.termType}:${strip(quad.subject.value)}|${quad.predicate.value}`
    + `|${quad.object.termType}:${strip(quad.object.value)}|${quad.graph.termType}:${quad.graph.value}`;
  const originalKeys = new Set(quads.map(keyOf));
  for (const quad of reparsed) {
    assert.ok(originalKeys.has(keyOf(quad)), `重新解析出现未知四元组: ${keyOf(quad)}`);
  }
  assert.equal(reparsed.length, quads.length);
  const literal = reparsed.find(q => q.object.termType === 'Literal' && q.object.datatype.value === XSD_INTEGER).object;
  assert.equal(literal.value, '2026');
  assert.equal(literal.datatype.value, XSD_INTEGER);
});

test('四元组 JSON 往返保留默认图', () => {
  const quad = DF.quad(DF.namedNode('https://lab.invalid/A'),
    DF.namedNode('https://lab.invalid/name'), DF.literal('光谱仪'));
  const json = JSON.parse(JSON.stringify({
    subject: { termType: quad.subject.termType, value: quad.subject.value },
    predicate: { termType: quad.predicate.termType, value: quad.predicate.value },
    object: { termType: quad.object.termType, value: quad.object.value,
      language: quad.object.language, datatype: quad.object.datatype.value },
    graph: { termType: 'DefaultGraph', value: '' },
  }));
  const back = quadFromJson(json);
  assert.equal(back.graph.termType, 'DefaultGraph');
  assert.equal(termFromJson(json.graph).termType, 'DefaultGraph');
});
