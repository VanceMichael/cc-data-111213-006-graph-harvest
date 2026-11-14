import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataFactory as DF } from 'n3';
import { canonicalize, LIMITS } from '../src/rdf/canonical.js';
import { quadToJson } from '../src/rdf/terms.js';

const EX = 'https://lab.invalid/';
const n = local => DF.namedNode(EX + local);
const lit = (value, lang) => DF.literal(value, lang);
const G = n('instruments');

function quadsWith(label) {
  return [
    DF.quad(n('A'), n('certificate'), DF.blankNode(label), G),
    DF.quad(DF.blankNode(label), n('label'), lit('检定', 'zh'), G),
    DF.quad(DF.blankNode(label), n('year'),
      DF.literal('2026', DF.namedNode('http://www.w3.org/2001/XMLSchema#integer')), G),
  ].map(quadToJson);
}

test('仅空白节点改名时规范形式完全一致（同构识别）', () => {
  const first = canonicalize(quadsWith('random-label-aaa'));
  const second = canonicalize(quadsWith('another-label-bbb'));
  assert.deepEqual(first.canonicalQuads, second.canonicalQuads);
  assert.equal(first.components[0].structuralSignature, second.components[0].structuralSignature);
  assert.equal(first.ambiguous, false);
  assert.equal(first.components[0].status, 'UNAMBIGUOUS');
});

test('结构相似但落地描述不同的节点不会被压成一个', () => {
  const similar = [
    DF.quad(n('A'), n('certificate'), DF.blankNode('x'), G),
    DF.quad(DF.blankNode('x'), n('year'),
      DF.literal('2026', DF.namedNode('http://www.w3.org/2001/XMLSchema#integer')), G),
    DF.quad(n('B'), n('certificate'), DF.blankNode('y'), G),
    DF.quad(DF.blankNode('y'), n('year'),
      DF.literal('2025', DF.namedNode('http://www.w3.org/2001/XMLSchema#integer')), G),
  ].map(quadToJson);
  const result = canonicalize(similar);
  assert.equal(result.components.length, 2);
  assert.notEqual(result.components[0].structuralSignature, result.components[1].structuralSignature);
});

test('对称 4 环报告 AMBIGUOUS 与对称等价类，而不是臆造身份', () => {
  const quads = [];
  for (let i = 0; i < 4; i += 1) {
    quads.push(DF.quad(n('Anchor'), n('holds'), DF.blankNode(`s${i}`), G));
    quads.push(DF.quad(DF.blankNode(`s${i}`), n('kind'), lit('标准砝码', 'zh'), G));
  }
  for (let i = 0; i < 4; i += 1) {
    quads.push(DF.quad(DF.blankNode(`s${i}`), n('pairedWith'),
      DF.blankNode(`s${(i + 1) % 4}`), G));
  }
  const result = canonicalize(quads.map(quadToJson));
  assert.equal(result.components.length, 1);
  assert.equal(result.components[0].nodeCount, 4);
  assert.equal(result.ambiguous, true);
  assert.equal(result.components[0].status, 'AMBIGUOUS');
  assert.deepEqual(result.components[0].symmetryClasses[0].sort(),
    ['c0', 'c1', 'c2', 'c3']);
});

test('资源边界可配置：分量超限时标记 BOUNDED 而非静默确定', () => {
  const quads = [];
  for (let i = 0; i < 6; i += 1) {
    quads.push(DF.quad(n('Anchor'), n('holds'), DF.blankNode(`s${i}`), G));
    quads.push(DF.quad(DF.blankNode(`s${i}`), n('kind'), lit('标准砝码', 'zh'), G));
  }
  // 串成一个 6 节点连通分量，把节点上限压到 4。
  for (let i = 0; i < 5; i += 1) {
    quads.push(DF.quad(DF.blankNode(`s${i}`), n('pairedWith'), DF.blankNode(`s${i + 1}`), G));
  }
  const result = canonicalize(quads.map(quadToJson), { ...LIMITS, maxComponentNodes: 4 });
  assert.equal(result.components.length, 1);
  assert.equal(result.components[0].nodeCount, 6);
  assert.equal(result.bounded, true);
  assert.equal(result.components[0].status, 'BOUNDED');
});
