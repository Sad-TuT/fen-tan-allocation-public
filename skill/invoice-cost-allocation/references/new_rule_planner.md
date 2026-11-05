# 新规则规划器与独立审计

项目规则 schema 8 的正式分摊必须使用支持以下能力的规划器：

- 只有申领部门和使用中心（旧表头可能写“使用部门”）同时非空且逐字相同时才能合组；
- 任一部门字段为空的来源行必须独立成组，不能补填，也不能与另一空白行或非空行合并；
- 多来源与 canonical `I:L` 来源身份、优先级和原行 FIFO；
- 先最大化第一来源实际贡献，再在相同贡献下减少分组；
- 整组使用额为单价整数倍，整组余额为 0 或大于等于 300 元的整数；
- 法律主体按唯一字母 `L` 加六位数字识别，缺码或歧义时隔离；
- 输出冻结方案，并能由独立审计重放分组、金额、余额和来源守恒。

本项目已在网站代码中提供经过测试的新规则规划器：

- 精确规划：[`site/app/lib/allocation.ts`](../../../site/app/lib/allocation.ts)
- 批次、冻结和双 agent 门禁：[`site/app/lib/workflow.ts`](../../../site/app/lib/workflow.ts)
- Excel 输出与税务修正：[`site/app/lib/spreadsheets.ts`](../../../site/app/lib/spreadsheets.ts)
- 分摊与独立重放测试：[`site/tests/allocation.test.ts`](../../../site/tests/allocation.test.ts)
- 部门规则独立测试：[`site/tests/department-exact-v4.test.ts`](../../../site/tests/department-exact-v4.test.ts)

使用网站或已连接的网站 app 完成正式试算和制表。读取金额前先执行网站账簿同步；方案应标记 `department-exact-v4`，`validateAllocationPlan` 必须通过。正式入账只能发生在两名独立复核者依据同一冻结哈希提交两份通过报告之后，网站正式入账后再次同步账簿。

`scripts/plan_invoice.py` 和 `scripts/validate_invoice_outputs.py` 仅是显式启用 `--legacy-six-exact` 的旧单来源严格六字段工具。即使某批数据碰巧字段完整，也不能用其 PASS、无解或最优结果代替本项目的新规则规划和核验。

交付前至少运行网站的分摊测试、AI 兼容测试、TypeScript 类型检查和 Skill Python 测试。测试通过只证明已覆盖的范围；真实批次仍须核对最终 Excel、税务状态、双复核报告和工作区版本。
