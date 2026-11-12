import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Archive, digest } from '../src/archive.js';

test('资料对象可核验并保留不同领取来源', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'archive-'));
  try {
    const archive = new Archive(folder);
    const first = await archive.accept(Buffer.from('资料'), { source: '甲' });
    const second = await archive.accept(Buffer.from('资料'), { source: '乙' });
    assert.equal(first.sha256, second.sha256);
    assert.notEqual(first.id, second.id);
    assert.equal((await archive.receipts()).length, 2);
    assert.equal((await archive.read(first.sha256)).toString(), '资料');
    await writeFile(join(folder, 'objects', first.sha256), '损坏');
    await assert.rejects(archive.read(first.sha256), /完整性/);
    await assert.rejects(archive.read('../外部'), /格式/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
test('摘要以来源字节为准', () => {
  assert.notEqual(digest(Buffer.from('1')), digest(Buffer.from('1\n')));
});
