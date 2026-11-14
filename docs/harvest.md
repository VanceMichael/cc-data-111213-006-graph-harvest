# graph-harvest 命名图可重复采集流程

面向授权 SPARQL 端点的 RDF 资料采集。核心约束：我们关心的是 RDF 数据本身
（IRI、语言标签、数据类型、空白节点作用域、默认图），不是表格字符串；
不能假设空白节点标签可以跨请求稳定连接，也不能凭空承诺对任意端点无损分页。

## 1. 模块结构

| 模块 | 职责 |
| --- | --- |
| `src/rdf/terms.js` | RDF 术语无损编解码、确定性 TriG 序列化、四元组 JSON 往返 |
| `src/rdf/parse.js` | TriG / SELECT 响应解析，原始空白标签与字节位置证据，响应作用域重写 |
| `src/rdf/canonical.js` | 空白节点连通分量 + 颜色细化规范化，对称歧义与资源边界显式标记 |
| `src/harvest/strategy.js` | 按端点能力选择领取策略，发布闸门 |
| `src/harvest/runner.js` | 领取执行：原始字节内容寻址归档、规范化派生归档、run 落盘 |
| `src/diff/compare.js` | 两次领取对比，区分仅改名与真实增删 |
| `src/endpoints/mock.js` | 两类能力档案的模拟端点，每请求随机改名 |
| `src/endpoints/dataset.js` | 基础 / 变化 / 对称三组演练数据集 |

## 2. RDF 保真

- 四类术语都有类型前缀编码（`I<…>`、`L<…>@lang`、`L<…>^^<dt>`、`B<…>`、`D`），
  不同术语类型不会因字符串相同而碰撞；编解码往返保留语言标签与数据类型。
- 默认图以 `DefaultGraph` 术语保留；SELECT 绑定无法表达默认图时使用显式哨兵
  `urn:graph-harvest:default-graph`，解码侧对称还原。
- 规范化 TriG 按图分组、四元组按完整键排序，同输入同字节，可重新解析校验。

## 3. 空白节点作用域（不重蹈 `_:b0` 合并的覆辙）

- 作用域严格限定为**单个响应文档**。解析时把文档内空白节点重写为
  `r{响应序号}_b{节点序号}`，标签映射与原始标签、词法行列位置一并记录。
- 同一响应内相同标签仍指向同一节点（n3 解析器的文档作用域前缀保证），
  响应内跨命名图的关联因此保留；不同响应即使原始标签同名也不会连接。
- 词法证据通过行起始位置 + 行内偏移还原全局字节区间，可直接从原始响应字节
  切出完整 `_:label`，与规范化记录互相印证。解析器 id 集合与词法标签集合
  不一致时直接报错，拒绝在证据不完整时继续。

## 4. 面向能力差异的领取策略

| 端点能力 | 策略 | 完整性声明 |
| --- | --- | --- |
| 支持整图 CONSTRUCT/DESCRIBE | `GRAPH_EXPORT` | 命名图整图导出，响应内空白节点闭合，可完整发布 |
| 只能限行数 SELECT，目标含空白节点 | `BLOCKED` | 不发布，缺口码 `BLANK_NODE_PAGING_UNSAFE` |
| 只能限行数 SELECT，仅落地三元组，支持 COUNT | `BOUNDED_SELECT` | 逐页领取，COUNT 对账一致才发布 |
| 只能限行数 SELECT，无 COUNT | `BOUNDED_SELECT` | 仅出现不足一页的短尾页才发布；满页耗尽则 `NO_TERMINATION_PROOF` 阻断 |

不能保证完整时的行为是**停止发布并写明缺口**，而不是静默产出看似完整的结果。

## 5. 规范化、对称歧义与资源边界

- 先按“共享空白节点的四元组”求连通分量，再做颜色细化（1-WL）。
- 颜色唯一可区分的节点得到稳定规范标签；细化后仍同色的节点归入对称等价类，
  分量状态标记为 `AMBIGUOUS`，发布裁决为 `PUBLISH_WITH_AMBIGUITY`：
  只发布规范形式与对称类，**不发布节点级身份声明**。
- 资源边界（默认 `maxComponentNodes=256`、`maxRefinementRounds=64`、
  `maxSymmetryClasses=1024`，见 `canonical.js`）触及时标记 `BOUNDED`，
  发布闸门以 `CANONICALIZATION_BOUNDED` 阻断。
- 每个分量带标签无关的 `structuralSignature`（分量局部规范四元组的 SHA-256），
  两次运行同构即相等，结构相似但落地描述不同的节点不会被压成一个。

## 6. 重复领取对比（`diffRuns`）

- 落地四元组（主宾语均非空白节点）逐行精确 diff。
- 空白节点分量按结构签名匹配：
  - `RELABELED` / `RELABELED_AMBIGUOUS`：标签变化但同构，无关系增删；
  - `ADDED` / `REMOVED`：分量真实新增或消失；
  - 含空白节点四元组的规范行集合再做一次 diff，捕捉同锚点但边变化的修改。
- 总裁决：`IDENTICAL`、`IDENTICAL_WITH_SYMMETRY`、`CHANGED`。
  对称场景允许无法低成本消歧，但状态显式保留。

## 7. 证据链与归档布局

```
<archive>/
  objects/<sha256>      # 原始响应字节 + 规范化 TriG 字节，均内容寻址
  receipts/<uuid>.json  # 每次写入的来源元数据（请求、派生关系、媒体类型）
  runs/<runId>.json     # 一次领取的完整记录：策略、响应、规范化、闸门、终止证据
```

规范化产物的 receipt 带 `derivedFrom` 指回原始响应摘要；run 记录里的每个
`occurrences` 条目都能切回原始字节中的 `_:label`，形成
原始响应 ↔ 词法证据 ↔ 响应作用域标签 ↔ 规范形式的完整对应链。

## 8. 命令

```bash
npm test                 # 29 个测试
npm run check            # 全部模块语法检查
npm start -- demo        # 六类场景的端到端演练
npm start -- harvest graph-export https://lab.invalid/instruments <归档目录>
npm start -- bounded limited-table <归档目录>
npm start -- diff <runA.json> <runB.json>
npm start -- inspect fixtures/catalog.trig   # 既有能力保持不变
```
