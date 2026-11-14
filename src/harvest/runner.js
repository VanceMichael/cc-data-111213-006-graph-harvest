// 领取执行器：一次 run 针对一个端点上的一个命名图目标。
// 每个 HTTP 响应的原始字节都内容寻址归档，规范化记录与字节摘要双向可查。
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Archive, digest } from '../archive.js';
import { parseTriGResponse, parseResultRows } from '../rdf/parse.js';
import { canonicalize } from '../rdf/canonical.js';
import { serializeCanonical, quadFromJson } from '../rdf/terms.js';
import { chooseStrategy, publishGate, STRATEGY } from './strategy.js';

export class HarvestRunner {
  constructor(endpoint, archiveDirectory) {
    this.endpoint = endpoint;
    this.archive = new Archive(archiveDirectory);
  }

  // 领取一个命名图（graphIri 为 '' 表示默认图）。
  async harvestNamedGraph(graphIri) {
    const run = this.#newRun({ kind: 'NAMED_GRAPH', graphIri });
    const decision = chooseStrategy(this.endpoint.capabilities,
      { graphIri, patternHasBlankNodes: false });
    run.strategyDecision = decision;

    if (decision.strategy === STRATEGY.BLOCKED) {
      run.status = 'BLOCKED';
      return this.#finalize(run);
    }
    if (decision.strategy !== STRATEGY.GRAPH_EXPORT) {
      throw new Error('harvestNamedGraph 只能由支持整图导出的端点使用');
    }

    const bytes = await this.endpoint.exportNamedGraph(graphIri);
    await this.#ingestResponse(run, bytes, {
      request: { operation: 'exportNamedGraph', graphIri },
      parse: 'trig',
    });
    run.status = 'COMPLETE';
    return this.#finalize(run);
  }

  // 限行数端点的逐页领取。pattern 为 [位置, IRI|null] 约束，variables 为四元组位置名。
  async harvestBounded({ pattern, variables, pageLimit = 100 }) {
    const patternHasBlankNodes = this.endpoint.patternHasBlankNodes(pattern);
    const run = this.#newRun({ kind: 'BOUNDED_SELECT', pattern, variables });
    run.strategyDecision = chooseStrategy(this.endpoint.capabilities, { patternHasBlankNodes });

    if (run.strategyDecision.strategy === STRATEGY.BLOCKED) {
      run.status = 'BLOCKED';
      return this.#finalize(run);
    }

    const pageSize = this.endpoint.capabilities.maxRows;
    let offset = 0;
    let pages = 0;
    const collectedRows = [];
    let expectedCount = null;
    if (this.endpoint.capabilities.countSupported) {
      expectedCount = this.endpoint.countRows(pattern);
    }

    for (;;) {
      let page;
      try {
        page = this.endpoint.selectRows({ pattern, variables, offset, limit: pageSize });
      } catch (error) {
        if (error.code !== 'OFFSET_OUT_OF_RANGE') throw error;
        // 满页耗尽后没有下一页可取，又没有 COUNT：无法证明数据恰在此处结束。
        run.termination = {
          satisfied: false, kind: 'SHORT_PAGE', shortPageObserved: false,
          pages, rows: collectedRows.length,
          reason: '全部页面均为满页，继续请求已越界；无 COUNT 可用，无法排除后续数据',
        };
        break;
      }
      const bytes = Buffer.from(JSON.stringify({ offset, rows: page.rows }, null, 2), 'utf8');
      await this.#ingestResponse(run, bytes, {
        request: { operation: 'selectRows', pattern, variables, offset, limit: pageSize },
        parse: 'rows',
        page,
      });
      collectedRows.push(...page.rows);
      pages += 1;
      offset += page.rows.length;

      if (page.rows.length < pageSize) {
        run.termination = {
          satisfied: true, kind: 'SHORT_PAGE', shortPageObserved: true,
          pages, rows: collectedRows.length,
        };
        break;
      }
      if (pages >= pageLimit) {
        run.termination = {
          satisfied: false, kind: 'PAGE_LIMIT', shortPageObserved: false,
          pages, rows: collectedRows.length,
          reason: `达到页上限 ${pageLimit}，未取得终止证据，停止并标记不完整`,
        };
        break;
      }
    }

    if (expectedCount !== null) {
      const ok = expectedCount === collectedRows.length;
      run.termination = {
        satisfied: ok, kind: 'COUNT', shortPageObserved: run.termination.shortPageObserved,
        expected: expectedCount, observed: collectedRows.length,
        reason: ok ? undefined : `COUNT=${expectedCount} 与累计行数 ${collectedRows.length} 不一致`,
      };
    }
    run.boundedRows = parseResultRows(collectedRows);
    run.status = run.termination.satisfied ? 'COMPLETE' : 'INCOMPLETE';
    return this.#finalize(run);
  }

  #newRun(target) {
    return {
      runId: randomUUID(),
      endpointId: this.endpoint.id,
      target,
      startedAt: new Date().toISOString(),
      capabilities: this.endpoint.capabilities,
      responses: [],
    };
  }

  async #ingestResponse(run, bytes, context) {
    const sha256 = digest(bytes);
    const receipt = await this.archive.accept(bytes, {
      runId: run.runId,
      endpointId: run.endpointId,
      request: context.request,
      mediaType: context.parse === 'rows' ? 'application/json' : 'application/trig',
    });

    const responseRecord = {
      responseSeq: run.responses.length,
      sha256,
      size: bytes.length,
      receiptId: receipt.id,
      request: context.request,
    };

    if (context.parse === 'rows') {
      responseRecord.rows = parseResultRows(context.page.rows);
      responseRecord.normalized = null;
      responseRecord.canonical = null;
    } else {
      const normalized = parseTriGResponse(bytes.toString('utf8'), responseRecord.responseSeq);
      const canonical = canonicalize(normalized.quads);
      const canonicalBytes = Buffer.from(
        serializeCanonical(normalized.quads.map(quadFromJson)), 'utf8');
      const canonicalReceipt = await this.archive.accept(canonicalBytes, {
        runId: run.runId,
        kind: 'canonical-normalization',
        derivedFrom: sha256,
      });
      responseRecord.normalized = normalized;
      responseRecord.canonical = {
        ...canonical,
        canonicalSha256: digest(canonicalBytes),
        canonicalReceiptId: canonicalReceipt.id,
      };
    }
    run.responses.push(responseRecord);
  }

  async #finalize(run) {
    run.finishedAt = new Date().toISOString();
    run.gate = publishGate(run);
    run.publishable = run.gate.publishable;
    await this.archive.initialize();
    await mkdir(join(this.archive.directory, 'runs'), { recursive: true });
    await writeFile(
      join(this.archive.directory, 'runs', `${run.runId}.json`),
      JSON.stringify(run, null, 2), { mode: 0o600 });
    return run;
  }
}
