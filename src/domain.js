import { readFile } from 'node:fs/promises';
import { Parser } from 'n3';
export const sample = 'fixtures/catalog.trig';
export async function inspect(filename) {
  const quads = new Parser({ format: 'TriG' }).parse(await readFile(filename, 'utf8'));
  const term = value => ({ termType: value.termType, value: value.value,
    ...(value.termType === 'Literal' ? { language: value.language, datatype: value.datatype.value } : {}) });
  return { quads: quads.map(quad => ({ subject: term(quad.subject), predicate: term(quad.predicate),
    object: term(quad.object), graph: term(quad.graph) })) };
}
