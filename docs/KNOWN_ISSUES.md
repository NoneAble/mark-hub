# MarkHub Known Issues 与修复参考

最后核对：2026-07-18（commit `5cc1ee6`）。本轮已将全部条目逐条对照当前实现重新验证并改写，删除了失效证据，行号全部刷新。

阅读约定（写给后续修复会话）：

- 行号基于 2026-07-18 的代码，会随提交漂移；每条证据都同时给出**函数名或搜索锚点**，定位以锚点为准。
- 每条包含：现状结论 → 证据 → 复现 → 修复方案 → 验收。修复时先跑一遍"复现"确认问题仍在。
- 状态只有两种：`Open`、`Open（部分修复）`。关闭条件见文末"关闭规则"。

优先级：

- P0：可能造成数据损坏，或破坏恢复原子性。
- P1：核心功能或发布验收不能可靠成立。
- P2：测试、部署或维护问题，降低持续交付可靠性。
- P3：维护性改进，不直接影响当前主要功能。

## 总览

| ID | 优先级 | 状态 | 一句话 | 主要触点 |
|---|---|---|---|---|
| MH-RESTORE-001 | P0 | Open（已改写） | 恢复无用户级互斥，快照过期窗口可产生 A∪B / 标签丢失 | `atomicReplaceAllRestore` |
| MH-RESTORE-002 | P1 | Open | FTS 重建在 cutover 之外，失败被吞掉仍返回 `atomic:true` | `atomicReplaceAllRestore` 尾部 |
| MH-RESTORE-003 | P1 | Open | `restore_staging` 无 TTL，Worker 中途被杀会永久残留 | `0006_restore_staging.sql`、`scheduled` |
| MH-EXPORT-001 | P1 | Open | 导出按每 80 条书签查一次标签，5 万条超 D1 Free 查询预算 | `tagsForBookmarks`、`exportJsonPayload` |
| MH-EXPORT-002 | P1 | Open | portable metadata 经 `String.fromCharCode(...bytes)` 展开，大导出触发 `RangeError` | `b64url`、`portableBackupMetadata` |
| MH-BACKUP-001 | P2 | Open（部分修复） | Worker S3 listing 不分页；FastAPI retention 错误只留最后一条 | `pruneS3Backups`、`s3ListObjects`、`remote_backup.py` |
| MH-BACKUP-002 | P1 | Open | `last_retention_error` 已持久化但 GET 不返回、UI 不显示 | 各 `/backup/*` GET、`SettingsModal` |
| MH-BACKUP-003 | P1 | Open | scheduled S3 分支在两个 runtime 都没有真实回归 | `scheduled`、两个 r3 测试 |
| MH-CF-001 | P1 | Open | assets 缺 `run_worker_first`，navigate 请求可能吃掉 `/api/*` | `wrangler.toml` |
| MH-UI-001 | P2 | Open | 设置弹窗缺 `keep_backups` 控件，WebDAV 缺 `backup_time` | `SettingsModal.tsx` |
| MH-TEST-001 | P1 | Open | `pnpm test` 不含 server/Docker/E2E，不是完整 release gate | 根 `package.json` |
| MH-TEST-002 | P2 | Open | Docker 测试 cleanup 失败仍可能退出 0 | `test-docker-deploy.sh` |
| MH-TEST-003 | P2 | Open | 测试依赖仓库外 `~/.pi/.../bounded-run.mjs` | 6 处 harness 脚本 |
| MH-TEST-004 | P1 | Open | "大型恢复"测试默认只有 460 条 | `worker-d1-runtime-test.mjs` |
| MH-MAINT-001 | P3 | Open | Worker `Env` 手写类型，与 wrangler 配置可漂移 | `index.ts` 头部 |
| MH-MAINT-002 | P2 | Open | Wrangler 锁 v3、compatibility date 停在 2024-12-01 | `apps/worker/package.json`、`wrangler.toml` |

## 建议修复分组与顺序

同一组的条目触碰同一片代码，应一起设计、一次改完，避免反复重构：

1. **恢复内核组**：MH-RESTORE-001 → 002 → 003。三条全部落在 `atomicReplaceAllRestore` 与 `restore_staging` 表上。给 staging 表加 lease/TTL 字段时一并设计（一次 migration），FTS 归入 cutover batch 时顺带处理。
2. **导出规模组**：MH-EXPORT-001、MH-EXPORT-002。都在导出链路（`exportJsonPayload` → CSV/HTML metadata），一次改完后用同一个 5 万条数据集验收，同时消解 MH-TEST-004 的一部分。
3. **备份可观测组**：MH-BACKUP-001、MH-BACKUP-002、MH-UI-001。统一 retention 返回结构 → GET 透出 → UI 展示，是同一条数据流。MH-BACKUP-003 的测试补齐放在这组末尾做验收。
4. **平台组**：先 MH-CF-001（加 `run_worker_first` 并补 navigate 测试），再 MH-MAINT-002（升 Wrangler 4 + compatibility date），升级时顺带做 MH-MAINT-001（`wrangler types`）。顺序不能反，否则升级会直接暴露 assets routing 行为变化。
5. **测试基建组**：MH-TEST-003（去掉仓库外依赖）→ MH-TEST-002 → MH-TEST-001（统一 `test:release` 入口）→ MH-TEST-004（5 万条用例挂进 release gate）。003 是其余几条的前置，否则新 gate 在干净环境跑不起来。

---

## MH-RESTORE-001：`replace_all` 缺少用户级互斥（快照过期窗口）

- 优先级：P0 ｜ 分类：核心 / 数据完整性 ｜ 状态：Open
- 2026-07-18 复核：**问题仍在，但机制已变化，本条为改写版。** 恢复流程已重写为"staging 分块写入 + 单个 `env.DB.batch` 原子 cutover"，旧文档描述的"两个恢复在 cutover 中途交错"已不可能发生（batch 本身原子）。剩余问题是**快照读取与 batch 提交之间没有互斥**。

### 问题与影响

`atomicReplaceAllRestore` 在请求开头读取 live 快照并据此**预先规划** soft-delete 语句（旧行以 `old_bookmark`/`old_folder` 的 entity_key 写入 staging）。快照之后、batch 提交之前，任何并发写入产生的新行都不在删除集合里：

1. 并发双恢复：后提交的 batch 不会删除先提交 batch 插入的行，最终数据为 A∪B，而非任一完整快照。
2. 恢复期间的普通 CRUD：新建书签会穿透恢复存活。
3. `bookmark_tags` 的删除语句是**用户全局**的（按 `user_id` 关联全部书签/标签删），并发新建书签的标签关联会被无差别清掉——即使书签本身存活。

### 当前证据（`apps/worker/src/index.ts`）

- `atomicReplaceAllRestore` 定义于 2117 行；live 快照读取在 2130–2150 行。
- staging 分块写入 2474–2485 行；期间无任何用户锁（全文件 grep 无 lease/mutex/lock 机制）。
- cutover batch 组装 2494–2586 行，`env.DB.batch(statements)` 在 2589 行。
- 用户全局 `bookmark_tags` 删除：2536–2541 行（`WHERE bookmark_id IN (SELECT id FROM bookmarks WHERE user_id = ?) OR tag_id IN (...)`）。
- 旧行 soft-delete 仅限快照集合：2550–2563 行（`WHERE id IN (SELECT entity_key FROM restore_staging ... kind = 'old_bookmark')`）。
- `apps/worker/migrations/0006_restore_staging.sql` 仍无用户锁、lease 或 generation 字段。

### 确定性复现

1. 同一用户准备只含 A、只含 B 的两个 `replace_all` payload。
2. 在两个请求完成 staging、调用 `env.DB.batch` 前设置测试 barrier（可仿照现有 `RESTORE_TEST_FAIL_PHASE` 注入点）。
3. 依次放行 A、B。导出最终数据可见 A∪B。
4. 在 barrier 期间创建带标签书签 C：C 存活但其 `bookmark_tags` 关联被清除。

### 修复方案

- 用 D1 lock row（或 Durable Object）为每用户建立带 `restore_id`、`expires_at` 的原子 lease；写接口（书签/文件夹/标签/恢复）检查 lease，冲突时返回 `409/423`。
- cutover batch 增加 generation 前置条件（如 lease row 的 `restore_id` 匹配才执行，可用 batch 内条件 UPDATE + 影响行数校验）。
- `bookmark_tags` 删除限定在 staged 的 `old_bookmark` 集合与本次 staged 关联内，去掉用户全局删除。
- lease 字段与 MH-RESTORE-003 的 TTL 字段放进**同一个 migration**。

### 验收

- 确定性双恢复 barrier 测试：最终数据严格等于其中一个 payload；另一请求等待或明确失败。
- 恢复期间 CRUD 测试：不得静默穿透、不得丢标签。
- lease 超时后可重新恢复，不会永久锁死用户。

## MH-RESTORE-002：FTS 重建不属于原子 cutover

- 优先级：P1 ｜ 分类：核心 / 数据完整性 ｜ 状态：Open
- 2026-07-18 复核：仍有效。现实现已从旧版的逐行重建改为 batch 内两条 bulk 语句，但仍在 cutover **之后**执行、失败仍被吞掉。

### 问题与影响

live 数据 batch 提交成功后才重建 FTS；FTS batch 失败被空 `catch` 吞掉，接口仍返回 `atomic: true`。恢复"成功"后的书签可能永久无法搜索，且没有任何信号。

### 当前证据（`apps/worker/src/index.ts`）

- cutover batch 提交：2589 行。
- FTS 重建：2603–2619 行（注释 `FTS is optional derived state`，DELETE + INSERT…SELECT 两条 bulk 语句）。
- 失败吞掉：2620–2622 行 `catch { /* optional */ }`。
- 无条件 `atomic: true`：2624–2634 行响应体。
- 搜索依赖该表：FTS 查询在 1782–1808 行。

### 确定性复现

1. 用 `RESTORE_TEST_FAIL_PHASE` 风格的注入让 FTS batch 失败（当前注入点只覆盖 `insert`/`swap` 两阶段，需新增 `fts` 阶段）。
2. 执行含唯一关键词的 `replace_all` → 返回 200 + `atomic:true`。
3. 列表可见该书签，但关键词搜索为空。

### 修复方案

- 首选：把 FTS 的 DELETE/INSERT 两条语句并入 cutover 的同一个 `env.DB.batch`，失败即整体回滚（D1 batch 无语句数上限问题，当前恰好是纯 SQL bulk 语句，合并成本低）。
- 若实测 batch 语句限制不允许：响应中返回 `search_index_status: degraded`，持久化标记并由 `scheduled` 重试，不得宣称完整原子成功。

### 验收

- 新增 `fts` 阶段故障注入：失败时要么整体回滚（列表也看不到新数据），要么明确 degraded 且后续自动恢复。
- 成功响应后所有恢复书签立即可搜索。
- 失败路径不得返回 `atomic:true`。

## MH-RESTORE-003：staging 数据没有 TTL、lease 或异常回收

- 优先级：P1 ｜ 分类：核心 / 运维与数据完整性 ｜ 状态：Open
- 2026-07-18 复核：仍有效。成功路径的 staging 清理现在是 cutover batch 的最后一条语句（原子），失败路径有 `cleanupStaging`；但 Worker 在 staging 写入后、batch 前被终止时仍永久残留，且 `scheduled` handler 不清理该表。

### 当前证据

- `apps/worker/migrations/0006_restore_staging.sql`：只有 `restore_id/user_id/kind/entity_key/payload`，无 `created_at/expires_at/status`。
- 请求内清理：`cleanupStaging`（`index.ts:2468–2472`）与 batch 末尾的 DELETE（2581–2586 行）。
- `scheduled` handler（`index.ts:3724–3777`）只做 soft-delete GC 与 WebDAV/S3 备份，无 `restore_staging` 清理；全文件中 `restore_staging` 仅出现在恢复代码内。

### 确定性复现

1. staging 写完、batch 前强制终止 Worker（dev 环境 kill 进程即可）。
2. 重启后 `SELECT COUNT(*) FROM restore_staging` 非零，且不会被任何 scheduled/后续请求清除。

### 修复方案

- migration：为 `restore_staging` 增加 `created_at`（最小方案）或完整的 `status/expires_at/lease owner`（与 MH-RESTORE-001 的 lease 同一个 migration），为过期字段建索引。
- `scheduled` handler 清理过期且无活跃 lease 的 staging 行；清理必须幂等，不得删除进行中的 restore。

### 验收

- 强制终止测试：残留 staging 在 TTL 内被 scheduled 清除；同一用户随后可正常重新恢复。
- 活跃恢复的 staging 不被误删。

## MH-EXPORT-001：5 万条导出超过 D1 Free 查询次数限制

- 优先级：P1 ｜ 分类：核心 / 规模与部署 ｜ 状态：Open
- 2026-07-18 复核：仍有效，仅行号变化。

### 问题与影响

标签按每 80 个书签一次查询。5 万条 ≈ 625 次标签查询，加上其余查询远超 D1 Free 单次 invocation 50 次查询的限制。JSON 手动导出、CSV/HTML 导出、WebDAV/S3 备份全部复用该路径。

### 当前证据（`apps/worker/src/index.ts`）

- `tagsForBookmarks`：400–428 行，`chunkSize = 80` 在 407 行（注释即"D1 bind limit — chunk"）。
- `exportJsonPayload`：853–897 行，调用 `tagsForBookmarks`（868 行）；注释标明 manual + remote backups 共用。
- CSV/HTML/JSON 导出入口：3504 行起（`// CSV/HTML/JSON export — lossless native schema shared with scheduled backups`）。
- WebDAV/S3 备份经 `runWebdavBackup`/`runS3Backup` 复用同一 payload。
- D1 限制：<https://developers.cloudflare.com/d1/platform/limits/>。

### 确定性复现

单用户写入 50,000 条带标签书签，在 Free D1（或把查询预算限制为 50 的 harness）请求 JSON 导出；标签聚合阶段即超预算。

### 修复方案

- 一条聚合 SQL 拿到书签+标签（`GROUP_CONCAT` 或 JSON 聚合，FTS 重建语句 2610–2617 行已有同款 JOIN 写法可参考），或设计总查询数 < 50 的分页。
- 同步评估 Worker 内存；必要时流式导出。

### 验收

- 查询预算 ≤ 50 的模型下完成 5 万条 JSON 导出、WebDAV、S3 备份；总数、首尾记录、标签、checksum 与源一致。

## MH-EXPORT-002：大型 CSV/HTML portable metadata 触发 `RangeError`

- 优先级：P1 ｜ 分类：核心 / 规模与可移植性 ｜ 状态：Open
- 2026-07-18 复核：仍有效，仅行号变化。

### 问题与影响

portable metadata 把**全部书签**序列化后经 `b64url` 编码，而 `b64url` 用 `String.fromCharCode(...bytes)` 把整个字节数组展开为函数参数。约 150 KB 即触发 `RangeError: Maximum call stack size exceeded`；5 万条远超该阈值。CSV 首行与 HTML META 都会嵌入完整 metadata。

### 当前证据（`apps/worker/src/index.ts`）

- `portableBackupMetadata`：88–104 行，包含全部 `bookmarks`。
- `b64url`：213–217 行，215 行 `btoa(String.fromCharCode(...bytes))`。
- CSV 嵌入：3514–3516 行；HTML 嵌入：3640 行。
- （221 行 JWT 签名与 186 行密码 hash 也用同款展开，但输入恒为小字节数组，不构成问题。）

### 确定性复现

```bash
node -e 'console.log(String.fromCharCode(...new Uint8Array(150000)).length)'
```

再用足以生成超阈值 metadata 的数据请求 CSV/HTML 导出。

### 修复方案

- `b64url` 改为固定大小 chunk 循环编码（一处修复覆盖所有调用方）。
- 评估 metadata 压缩/分块；importer（`decodePortableBackupMetadata`，106–129 行）保持向后兼容。

### 验收

- 5 万条 CSV/HTML 导出不抛异常；导出文件可重新导入并完整保留层级、visibility、顺序、标签、颜色。

## MH-BACKUP-001：retention 失败信息不完整 + Worker S3 listing 不分页

- 优先级：P2（原 P1，部分修复后降级）｜ 分类：核心 / 备份保留 ｜ 状态：Open（部分修复）
- 2026-07-18 复核：**已部分修复**。Worker 侧 prune 现在收集全部删除错误并返回 `delete failed (N): <首条>`（有失败总数）；FastAPI 的 S3 listing 已实现 `NextContinuationToken` 分页。剩余缺口如下。

### 剩余问题

1. Worker 的 `s3ListObjects` 单次请求、无 continuation 分页（`apps/worker/src/s3.ts:161–187`，`max-keys` 传 1000）；对象超 1000 时后续页不参与 retention。注意：默认 `max-keys` 为 `"1"`（167 行），新调用方若忘传 `maxKeys` 会几乎不列出对象。
2. 两端都没有结构化的逐 key 失败列表：Worker 只返回 `首条错误 + 计数`（`pruneS3Backups`，`index.ts:930–936`；`pruneWebdavBackups` 同款在 985–990 行）；FastAPI 在循环里**逐次覆盖** `retention_error`，只留最后一条且无计数（`server/app/domain/remote_backup.py` 中 WebDAV prune ~118–128 行、S3 prune ~350–359 行）。

### 复现

fake provider 配置两个不同 key 删除失败 → 立即备份 → 响应只能识别一个失败 key。Worker 侧再准备 >1000 对象验证后续页未处理。

### 修复方案

- 统一返回 `retention_failures: [{key, code, message}]` + `attempted/pruned/failed` 计数（可截断详情条数，但保留总数与稳定 key，完整详情写日志）。
- Worker `s3ListObjects` 实现 ListObjectsV2 continuation 分页，并把默认 `max-keys` 改为合理值。
- FastAPI 收集错误列表而非覆盖。

### 验收

- 两端各用 ≥2 个失败 key 回归，响应可识别每个失败 key，计数一致。
- Worker >1000 对象分页 retention 测试通过。

## MH-BACKUP-002：retention 部分失败在刷新后和 UI 中不可见

- 优先级：P1 ｜ 分类：核心 / 备份状态 ｜ 状态：Open
- 2026-07-18 复核：仍有效。后端**已把** `last_retention_error` 持久化进 config（这是改进），但 GET 不返回、UI 不消费，用户仍然完全看不到。

### 当前证据

- Worker 持久化：`runS3Backup` 在 `index.ts:1058–1061`、`runWebdavBackup` 在 1121–1124 行写入/清除 `cfg.last_retention_error`。
- Worker GET 不返回：`/backup/s3` GET 响应 3118–3130 行、`/backup/webdav` GET 响应 3460–3469 行，均无 `last_retention_error` 字段。
- FastAPI GET 不返回：`get_webdav_config`（`remote_backup.py:17–29`）、`get_s3_config`（~180–196 行）同样缺失（FastAPI 侧同样有持久化，见 ~163 行）。
- UI 完全不感知：`apps/web/src` 全目录 grep 无任何 `retention` 字样；`SettingsModal.tsx` 不读取 POST 返回的 `retention_ok`。

### 复现

fake provider 注入 retention delete 失败 → 设置页 Run now → API 返回 `retention_ok:false` 但页面显示成功；刷新后 GET 配置也无错误状态。

### 修复方案

- GET 配置返回 `last_retention_error`（及失败时间/计数、最后成功时间）——后端已存，只差透出，改动很小。
- UI 根据 POST 的 `retention_ok` 与 GET 的持久化字段显示 warning，区分"上传成功"与"retention 完整成功"；仅完整成功清除旧错误（后端清除逻辑已存在）。
- 与 MH-BACKUP-001 的结构化返回、MH-UI-001 的表单补齐同批实施。

### 验收

- Worker、FastAPI × S3、WebDAV 四条路径覆盖 partial failure；错误在当次操作与刷新后都可见；下次完整成功后 warning 消失。

## MH-BACKUP-003：scheduled S3 路径缺少真实回归

- 优先级：P1 ｜ 分类：核心 / 备份调度测试 ｜ 状态：Open
- 2026-07-18 复核：仍有效。两个 runtime 的测试都只在 WebDAV 阶段触发调度；S3 阶段全部是 run-now。

### 当前证据

- Worker scheduled S3 分支：`index.ts:3756–3772`（WebDAV 分支 3737–3754）。
- `apps/worker/scripts/test-remote-backups-r3.mjs`：`__scheduled` 触发在 211–216 行（此时只配置了 WebDAV）；S3 从 237 行 `testS3` 才配置，之后再未触发 `__scheduled`。
- `server/tests/test_remote_backup_fake_provider_r3.py`：`_run_scheduled_backups` 仅在 WebDAV 用例（130 行起，调度在 ~198–202 行）中调用；S3 用例（~210 行起）只测 run-now。

### 复现

把任一 runtime 的 scheduled S3 调用改成 no-op，现有远程备份套件仍全绿。

### 修复方案

- 两个 runtime：先配置 enabled S3 + 匹配当前时间的 `backup_time`，再触发真实 scheduler；fake provider 断言 PUT、listing、retention 与持久化状态。
- 补 scheduled partial failure、时间不匹配不执行两个用例。

### 验收

- mutation test：no-op 掉 scheduled S3 调用必须使测试失败；两端都证明 scheduled PUT 与 retention 实际发生。

## MH-CF-001：assets 配置缺少 `run_worker_first`

- 优先级：P1 ｜ 分类：核心 / Cloudflare 部署 ｜ 状态：Open
- 2026-07-18 复核：仍有效。

### 问题与影响

升级 compatibility date 后，SPA fallback 可能先于 Worker 处理浏览器 navigation 形式的 `/api/*` 请求，API 返回 HTML。当前 `2024-12-01` 的旧日期掩盖了该行为变化。

### 当前证据

- `apps/worker/wrangler.toml:12–15` `[assets]` 配置 SPA fallback，无 `run_worker_first = true`；compatibility date 在第 3 行。根目录 `wrangler.toml:4` 同样 `2024-12-01`。
- `apps/worker/scripts/cf-assets-test.mjs` 无任何 `Sec-Fetch-Mode: navigate` 用例（grep 为空）。

### 复现

```bash
# 临时 config 把 compatibility_date 改到当前日期后：
curl -i -H 'Sec-Fetch-Mode: navigate' http://127.0.0.1:PORT/api/v1/health
```

观察是否返回 SPA HTML 而非 JSON。

### 修复方案

- `[assets]` 显式加 `run_worker_first = true`（两个 wrangler.toml）；assets harness 断言该配置，并同时测普通 fetch 与 navigate header。
- 本条是 MH-MAINT-002（Wrangler 4 升级）的**前置**。

### 验收

- `/api/v1/*` 在普通与 navigate 请求下均由 Worker 返回 JSON；前端路由仍返回 SPA；当前 compatibility date 下 assets harness 通过。

## MH-UI-001：设置弹窗缺少 retention 与完整调度配置

- 优先级：P2 ｜ 分类：非核心 / 配置完整性 ｜ 状态：Open
- 2026-07-18 复核：仍有效。原文档所述"管理页"已在重构中移除，备份配置现全部位于 `SettingsModal`。

### 当前证据

- `apps/web/src/components/SettingsModal.tsx`：仅 S3 有 `backup_time` 输入（526–527 行）；整个文件无 `keep_backups`；WebDAV 表单无 `backup_time`。
- 后端两个 runtime 的 GET/PUT 均支持这两个字段（Worker `index.ts:3125–3126`、3466–3467 行；FastAPI `get_webdav_config`/`get_s3_config`）。

### 复现

打开设置 → 备份区块：S3 只能配时间不能配保留份数；WebDAV 两者都不能配。API 写入非默认值后刷新，无可见控件承载。

### 修复方案

- S3、WebDAV 各加 `keep_backups` 数值输入（min 1）；WebDAV 补 `backup_time`。
- 受控表单回填 API 返回值，避免保存其他字段时覆盖隐藏配置。与 MH-BACKUP-002 的 warning UI 同批做。

### 验收

- E2E：为两种 provider 设置非默认 `keep_backups`/`backup_time`，保存刷新后一致；非法值有明确错误；只改凭据时 retention/schedule 不变。

## MH-TEST-001：`pnpm test` 不是完整 release gate

- 优先级：P1 ｜ 分类：非核心 / 测试基础设施 ｜ 状态：Open
- 2026-07-18 复核：仍有效。

### 当前证据

- 根 `package.json`：`"test": "pnpm -r run test"`；`test:server`（pytest）、`test:docker`、`test:e2e`、`test:parity` 均为独立脚本，无统一 `test:release` 入口。
- `pnpm-workspace.yaml` 只含 `packages/*`、`apps/*`。

### 修复方案

- 增加 `test:release` 串联 lint、core、worker、server、E2E、Docker、CF assets/dry-run；CI 与最终验收只调这一个入口。
- 前置：MH-TEST-003（否则干净环境跑不了）。

### 验收

- 对每个子套件分别注入失败，`test:release` 均非零退出；成功日志列出全部 gate。

## MH-TEST-002：Docker cleanup 失败可能仍退出 0

- 优先级：P2 ｜ 分类：非核心 / 测试基础设施 ｜ 状态：Open
- 2026-07-18 复核：仍有效。

### 当前证据

- `scripts/test-docker-deploy.sh:66–91`：`cleanup()` 以 `return "$cleanup_status"` 结束；93 行 `trap cleanup EXIT`。EXIT trap 中的 return 值不改变脚本退出码，主流程成功 + cleanup 失败 → 仍退出 0。
- 佐证：`bash -c 'trap "false" EXIT; true'; echo $?` 输出 0。

### 修复方案

cleanup 内捕获 `$?`，合并主流程与 cleanup 状态后 `trap - EXIT; exit "$status"`。

### 验收

- 主流程成功 + cleanup stub 失败 → 非零退出；主流程失败保留原始码；成功退出后无容器/volume/端口残留。

## MH-TEST-003：测试依赖仓库外的 `bounded-run.mjs`

- 优先级：P2 ｜ 分类：非核心 / 测试可移植性 ｜ 状态：Open
- 2026-07-18 复核：仍有效；引用位置有变化（原列表中 `server/tests/test_remote_backup_fake_provider_r3.py` 已不再引用，新增 `test_round8_docker_deploy.py`）。

### 当前证据

引用 `~/.pi/agent/extensions/trio-workflow/bounded-run.mjs` 的位置：

- `scripts/e2e-smoke.sh:6`
- `scripts/test-docker-deploy.sh:6`
- `apps/worker/scripts/run-test.sh:5`
- `apps/worker/scripts/worker-d1-runtime-test.mjs:17`
- `apps/worker/scripts/cf-assets-test.mjs:20`
- `apps/worker/scripts/test-remote-backups-r3.mjs:19–20`
- `server/tests/test_round8_docker_deploy.py:295`

### 修复方案

把 deadline/process-group helper 收进仓库（或锁定版本的依赖），所有 harness 引用同一 repo-local 入口。

### 验收

- 空 HOME、仅 checkout + 安装依赖的容器可运行全部 gate；不读取 `~/.pi`。

## MH-TEST-004：所谓大型恢复测试只有约 460 条

- 优先级：P1 ｜ 分类：非核心 / 规模测试缺口 ｜ 状态：Open
- 2026-07-18 复核：仍有效，仅行号变化。

### 当前证据

- `apps/worker/scripts/worker-d1-runtime-test.mjs:811`：`largeRestoreContents(count = 460)`。
- 在 1,000+ 规模注入阈值故障，当前测试仍通过——输入从未超过 460。

### 修复方案

- 增加 5 万条真实 Worker integration 用例（可挂 nightly/release gate）；另加快速 query-budget、metadata-size 单测让常规 CI 捕获规模退化。与导出规模组（MH-EXPORT-001/002）共用数据集与验收。

### 验收

- JSON、CSV、HTML 各至少一次 5 万条恢复与导出；校验 count、首尾、checksum、层级、顺序、visibility、标签、staging 清理，不能只看 HTTP 200。

## MH-MAINT-001：Worker Env 仍为手写类型

- 优先级：P3 ｜ 分类：非核心 / 维护性 ｜ 状态：Open
- 2026-07-18 复核：仍有效。

### 当前证据

- `apps/worker/src/index.ts:33–42` 手写 `interface Env`（含测试专用 `RESTORE_TEST_FAIL_PHASE`）；`apps/worker/wrangler.toml` 是真实 binding 来源。

### 修复方案

- `wrangler types` 生成 Env 并纳入 CI drift check；测试专用 binding 用独立 augmentation。随 MH-MAINT-002 升级时一并做。

### 验收

- 修改 binding 未重新生成类型必须使 CI 失败。

## MH-MAINT-002：Wrangler 3 和旧 compatibility date 待升级

- 优先级：P2 ｜ 分类：非核心 / 平台维护 ｜ 状态：Open
- 2026-07-18 复核：仍有效。

### 当前证据

- `apps/worker/package.json:25`：`"wrangler": "^3.99.0"`。
- `apps/worker/wrangler.toml:3` 与根 `wrangler.toml:4`：`compatibility_date = "2024-12-01"`。

### 修复方案

- **先完成 MH-CF-001**，再升 Wrangler 4、更新 compatibility date、生成 binding 类型（MH-MAINT-001）；按变更逐项跑 D1、remote backup、assets、dry-run 回归。

### 验收

- 受支持的 Wrangler 4 无过期警告；新 compatibility date 下 Worker runtime、remote backup、assets navigation、D1 migrations、deploy dry-run 全部通过。

---

## 关闭规则

任何条目改为 Closed 须全部满足：

1. 根因修复落在共享边界，而不是只屏蔽一个测试症状。
2. 本条"确定性复现"在修复前稳定失败、修复后稳定通过。
3. 所有验收标准有 checked-in 自动化证据，或明确可重复的部署配置检查。
4. 相关 release suite 仍通过，无数据/兼容性破坏。
5. 记录实际修复 commit、验证命令和结果。
