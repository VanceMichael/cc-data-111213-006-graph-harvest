import { mkdir, open, readFile, rename, readdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export class Archive {
  constructor(directory) { this.directory = resolve(directory); }
  async initialize() {
    await mkdir(join(this.directory, 'objects'), { recursive: true });
    await mkdir(join(this.directory, 'receipts'), { recursive: true });
  }
  async writeAtomic(path, bytes) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
  }
  async accept(bytes, metadata) {
    await this.initialize();
    const sha256 = digest(bytes);
    await this.writeAtomic(join(this.directory, 'objects', sha256), bytes);
    const receipt = { id: randomUUID(), sha256, size: bytes.length,
      observedAt: new Date().toISOString(), metadata };
    await this.writeAtomic(join(this.directory, 'receipts', `${receipt.id}.json`),
      JSON.stringify(receipt, null, 2));
    return receipt;
  }
  async receipts() {
    await this.initialize();
    const files = (await readdir(join(this.directory, 'receipts')))
      .filter(name => name.endsWith('.json')).sort();
    return Promise.all(files.map(name => readFile(join(this.directory, 'receipts', name), 'utf8').then(JSON.parse)));
  }
  async read(sha256) {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('对象摘要格式不正确');
    const bytes = await readFile(join(this.directory, 'objects', sha256));
    if (digest(bytes) !== sha256) throw new Error('对象完整性校验失败');
    return bytes;
  }
}
