import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect, sample } from '../src/domain.js';

test('既有资料查看与本地来源符合领域约定', async () => {
  const result = await inspect(sample);
  assert.equal(result.quads.length, 5);
  assert.equal(result.quads.find(quad => quad.object.value === '检定').object.language, 'zh');
  assert.equal(result.quads.filter(quad => quad.graph.termType === 'DefaultGraph').length, 1);
});
