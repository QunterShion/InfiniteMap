# Change Log

## 1.0.4

界面可视化：

- 标签下拉框预置标签新增「待协同」（原有「已完成」「待拆解」保留）
- 标签下拉框交互从点击展开改为鼠标悬浮展开、移出收起
- 新增右下角节点信息卡片：选中节点时显示文本、创建时间、节点 ID、层级、子节点数与彩色标签；未选中时隐藏
- 节点卡片展示并行执行状态：执行状态、认领人、租约到期时间与失败原因，随旁车文件变化实时刷新

KM MCP 并行任务拆解（工具 8 → 12 个）：

- `km_list_todos` 返回文件版本 `kmRevision`，并标注叶子待办与认领状态
- `km_mark_done` 支持可选 `expectedRevision` 乐观校验，拒绝并发覆盖
- 新增租约工具链：`km_claim_todos` / `km_renew_claim` / `km_complete_claim` / `km_release_claim`，支持多个独立智能体互不干扰地认领、续租、完成与释放叶子待办
- 新增旁车执行状态文件 `<km>.exec.json` 与跨进程文件锁 `<km>.lock`（原子创建、过期抢占）
- KM 与旁车写入全部改为临时文件 + rename 原子替换
- `km_mark_done` 与 `km_expand_collaboration` 纳入同一把文件锁；活跃租约节点禁止绕过 claim 直接回写
- 新增 15 个测试用例覆盖版本冲突、租约过期、快照冲突、残留锁抢占等并发场景

KM MCP 待协同分批并行（工具 12 → 14 个）：

- 新增 `km_claim_collaboration_tasks`，支持按 `workerId` 批量认领互不重叠的 `待协同` 节点
- 新增 `km_complete_collaboration_claim`，锁内校验租约和目标完整子树哈希，批量追加无标签直接子节点并完成父节点
- `km_renew_claim` / `km_release_claim` 同时支持待拆解与待协同租约
- `km_list_collaboration_tasks` 返回 `execState`、`claimedBy`、`leaseUntil` 与 `claimKind`
- 活动协同租约禁止通过 legacy `km_expand_collaboration` 绕过；无关节点先写回不再导致目标 claim 冲突
- 新增 8 个测试用例覆盖独立协同并行完成、目标子树冲突、批次零写入、会话追溯元数据兼容及租约保护

## 1.0.3

Fix unable to create xmind file

## 1.0.0

release
