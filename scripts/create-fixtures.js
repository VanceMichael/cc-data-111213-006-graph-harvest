import { mkdir as ensureFixtureDirectory } from 'node:fs/promises';
await ensureFixtureDirectory('fixtures', {recursive:true});

import { writeFile } from 'node:fs/promises';
await writeFile('fixtures/catalog.trig', `@prefix ex: <https://lab.invalid/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
ex:instruments { ex:A ex:certificate _:b0 . _:b0 ex:label "检定"@zh ; ex:year "2026"^^xsd:integer . }
ex:staff { ex:B ex:certificate _:b0 . }
ex:A ex:name "光谱仪" .
`);
await writeFile('fixtures/endpoint.json', JSON.stringify({ endpoints: [
  { id: 'graph-export', exportGraph: true, stableBlankLabels: false },
  { id: 'limited-table', exportGraph: false, maxRows: 2, stableBlankLabels: false }
], symmetricGraphSize: 8 }, null, 2));
