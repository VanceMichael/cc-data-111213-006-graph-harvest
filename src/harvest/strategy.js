// 面向能力差异的领取策略。
//
// 可解释的两条路线：
//   GRAPH_EXPORT —— 端点支持按命名图整图 CONSTRUCT/DESCRIBE。一次请求取回一张图的
//       完整 RDF（空白节点关联在同一响应内闭合），可做完整发布声明。
//   BOUNDED_SELECT —— 端点只能限行数 SELECT。仅当目标模式不含空白节点、且能取得
//       终止证据（COUNT 或稳定的不足一页尾页）时，逐页领取落地三元组并声明边界；
//       一旦模式涉及空白节点，跨请求标签无法稳定连接，分页必然破坏空白节点结构，
//       直接 BLOCKED：停止发布并写明缺口，绝不假装无损。
export const STRATEGY = Object.freeze({
  GRAPH_EXPORT: 'GRAPH_EXPORT',
  BOUNDED_SELECT: 'BOUNDED_SELECT',
  BLOCKED: 'BLOCKED',
});

export function chooseStrategy(capabilities, target) {
  if (capabilities.exportGraph) {
    return {
      strategy: STRATEGY.GRAPH_EXPORT,
      publishable: true,
      completenessClaim: `命名图 <${target.graphIri}> 整图导出，响应内空白节点闭合`,
      limitations: [],
    };
  }

  // 只能限行数：先探测空白节点。
  if (target.patternHasBlankNodes) {
    return {
      strategy: STRATEGY.BLOCKED,
      publishable: false,
      completenessClaim: null,
      limitations: [{
        code: 'BLANK_NODE_PAGING_UNSAFE',
        detail: '目标模式包含空白节点，而端点只能限行数返回；空白节点标签无跨请求稳定性，'
          + '分页无法保证同一响应内的关联不被拆散，拒绝承诺无损分页。',
      }],
    };
  }

  const termination = capabilities.countSupported
    ? { kind: 'COUNT', detail: '端点支持 COUNT，逐页累计与总数一致即终止' }
    : { kind: 'SHORT_PAGE', detail: '端点不支持 COUNT，仅能以“不足一页”作为终止证据；'
      + '若尾页恰好满页，无法排除还有后续数据，必须停止发布' };

  return {
    strategy: STRATEGY.BOUNDED_SELECT,
    // 策略层面不能提前承诺完整：COUNT 才有确定终止证据；
    // SHORT_PAGE 是否真的终止，要等执行器看到尾页后由发布闸门裁决。
    publishable: capabilities.countSupported,
    completenessClaim: capabilities.countSupported
      ? '落地三元组逐页领取，COUNT 对账完整'
      : '仅在出现不足一页的短尾页时声明完整，否则不发布',
    limitations: capabilities.countSupported ? [] : [{
      code: 'NO_TERMINATION_PROOF',
      detail: termination.detail,
    }],
  };
}

// 发布闸门：综合规范化状态与策略，给出可发布 / 阻断 / 需人工确认。
export function publishGate(run) {
  const blockers = [];
  if (run.strategyDecision.strategy === STRATEGY.BLOCKED) {
    blockers.push(...run.strategyDecision.limitations);
  }
  for (const response of run.responses) {
    if (response.normalized && response.normalized.blankNode.scope !== 'response') {
      blockers.push({ code: 'SCOPE_VIOLATION', detail: `响应 ${response.responseSeq} 空白节点作用域异常` });
    }
    if (response.canonical && response.canonical.bounded) {
      blockers.push({ code: 'CANONICALIZATION_BOUNDED',
        detail: `响应 ${response.responseSeq} 规范化触及资源边界，结果不可作为确定结论` });
    }
  }
  if (run.termination && run.termination.satisfied === false) {
    blockers.push({ code: 'INCOMPLETE_PAGINATION', detail: run.termination.reason });
  }
  // 无 COUNT 且末页恰好满页：短页终止证据没有出现，不能排除还有后续数据。
  if (run.termination && run.termination.kind === 'SHORT_PAGE'
      && run.termination.shortPageObserved === false) {
    blockers.push({
      code: 'NO_TERMINATION_PROOF',
      detail: '所有页面均为满页且端点不支持 COUNT，无法证明分页已经结束，停止发布并说明缺口。',
    });
  }

  const ambiguousResponses = run.responses
    .filter(r => r.canonical && r.canonical.ambiguous)
    .map(r => r.responseSeq);

  if (blockers.length) {
    return { decision: 'BLOCKED', publishable: false, ambiguousResponses, blockers };
  }
  if (ambiguousResponses.length) {
    // 对称结构不阻断“按字节/按同构”的归档发布，但禁止宣称节点级身份，状态显式保留。
    return {
      decision: 'PUBLISH_WITH_AMBIGUITY',
      publishable: true,
      ambiguousResponses,
      blockers: [],
      note: '存在无法低成本消歧的对称空白节点；仅发布规范形式与对称类，不发布节点身份声明。',
    };
  }
  return { decision: 'PUBLISH', publishable: true, ambiguousResponses: [], blockers: [] };
}
