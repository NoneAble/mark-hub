# MarkHub Known Issues and Remediation TODO

最后核对：2026-07-13

本文记录当前代码中仍可确认、但本轮未修改的核心与非核心问题。它是人工维护的工程清单，不受 workflow 自动生成的 `workflow-review-todo.md` 管理。

优先级：

- P0：可能造成数据损坏，或破坏恢复原子性。
- P1：核心功能或发布验收不能可靠成立。
- P2：测试、部署或维护问题，会降低持续交付可靠性。
- P3：维护性改进，不直接影响当前主要功能。

## MH-RESTORE-001：`replace_all` 缺少用户级互斥

- 优先级：P0
- 分类：核心 / 数据完整性
- 状态：Open

### 问题与影响

两个恢复请求，或恢复与普通 CRUD，可以交错执行。最终数据可能不是任一输入的完整快照；恢复期间创建的书签可能穿透 cutover，标签关联也可能被全局删除。

### 当前证据

- `apps/worker/src/index.ts:3073` 在恢复开始时读取 live snapshot。
- `apps/worker/src/index.ts:3417` 至 `3429` 分块写入 staging，期间没有用户锁。
- `apps/worker/src/index.ts:3438` 至 `3533` 才执行 cutover。
- `apps/worker/src/index.ts:3482` 删除该用户全部 bookmark/tag 关联，而不是只处理本次 snapshot。
- `apps/worker/migrations/0006_restore_staging.sql:2` 没有用户锁、lease 或 generation 字段。

### 确定性复现

1. 同一用户准备只包含 A 和只包含 B 的两个 `replace_all` payload。
2. 在两个请求完成 staging、进入 cutover 前设置测试 barrier。
3. 依次释放 A、B 的 cutover。
4. 导出最终数据，可观察到 A∪B，而不是严格的 A 或 B。
5. 在同一 barrier 中创建带标签书签 C，可进一步观察 C 穿透恢复或其标签关联被删除。

### 修复方向

- 使用 Durable Object，或 D1 lock row，为每个用户建立带 `restore_id`、`expires_at` 的原子 lease。
- 所有书签、文件夹、标签写接口检查同一个 lease，选择串行化或明确返回 `409/423`。
- cutover 增加 dataset generation/version 前置条件。
- 将 `bookmark_tags` 删除限定在本次旧 snapshot 或明确的 staged entity 集合内。

### 验收方法与通过标准

- 增加确定性双恢复 barrier 测试和恢复期间 CRUD 测试。
- 双恢复最终只能完整等于一个 payload；另一个请求必须等待或明确失败。
- CRUD 不得静默穿透，不得丢失标签。
- lease 超时后可以安全恢复，不能永久锁死用户。

## MH-RESTORE-002：FTS 重建不属于原子 cutover

- 优先级：P1
- 分类：核心 / 数据完整性
- 状态：Open

### 问题与影响

live 数据提交后才重建 FTS。FTS 失败被吞掉，接口仍返回 `atomic: true`，导致恢复成功后的书签可能永久无法搜索。

### 当前证据

- live cutover 在 `apps/worker/src/index.ts:3533` 完成。
- FTS 在 `apps/worker/src/index.ts:3547` 至 `3563` 通过第二个 batch 重建。
- `apps/worker/src/index.ts:3564` 至 `3565` 吞掉失败。
- `apps/worker/src/index.ts:3575` 无条件返回 `atomic: true`。

### 确定性复现

1. 对 FTS `INSERT` 增加测试故障注入。
2. 执行包含唯一关键词的 `replace_all`。
3. 恢复返回 HTTP 200 和 `atomic:true`。
4. 普通列表可见书签，但用该关键词搜索返回空结果。

### 修复方向

- 优先将 FTS 删除和重建加入同一 cutover batch，使失败回滚 live 数据。
- 如果平台限制无法同事务完成，引入明确的 `search_index_status`、可靠重试和 degraded 响应，不能宣称完整原子成功。

### 验收方法与通过标准

- 增加 FTS delete/insert 故障注入。
- 成功响应后，所有恢复书签必须立即可搜索。
- FTS 失败时旧 live dataset 保持完整；或者接口明确报告 degraded 状态并自动恢复。
- 失败路径不得返回虚假的 `atomic:true`。

## MH-EXPORT-001：5 万条导出超过 D1 Free 查询次数限制

- 优先级：P1
- 分类：核心 / 规模与部署
- 状态：Open

### 问题与影响

标签按每 80 个书签查询一次。5 万条书签约需 625 次标签查询，再加其他查询后会明显超过 D1 Free 每次 Worker invocation 50 次查询的限制。JSON、WebDAV 和 S3 复用该路径。

### 当前证据

- `apps/worker/src/index.ts:453` 至 `481` 使用 `chunkSize = 80`。
- `apps/worker/src/index.ts:1209` 至 `1226` 的 JSON、WebDAV、S3 共同复用该导出路径。
- Cloudflare D1 当前限制见 <https://developers.cloudflare.com/d1/platform/limits/>。
- CSV/HTML 也从 `apps/worker/src/index.ts:5513` 调用同一 export payload。

### 确定性复现

1. 为单一用户写入 50,000 条带标签书签。
2. 在 Free D1 环境请求 JSON 导出；或在 harness 中把 D1 查询预算限制为 50。
3. 标签聚合完成前即可超过查询预算。
4. WebDAV/S3 立即备份应复现相同失败。

### 修复方向

- 使用一次带聚合的 SQL 查询获取书签及标签，或设计总查询数严格小于 50 的分页方案。
- 同时评估 Worker 内存；必要时采用流式导出或异步写入 R2，避免一次构造全部对象。

### 验收方法与通过标准

- 在 Free 限制模型下完成 50,000 条带标签书签的 JSON 导出、WebDAV 和 S3 备份。
- 单 invocation D1 查询数不超过 50。
- 总数、首尾记录、标签关联和 checksum 与源数据一致。

## MH-EXPORT-002：大型 CSV/HTML portable metadata 会触发 `RangeError`

- 优先级：P1
- 分类：核心 / 规模与可移植性
- 状态：Open

### 问题与影响

portable metadata 编码将整个 `Uint8Array` 展开为函数参数。较大输入会触发 JavaScript 参数数量上限；5 万条导出远超可安全处理的大小。

### 当前证据

- `apps/worker/src/index.ts:91` 至 `106` 把全部书签复制进 metadata。
- `apps/worker/src/index.ts:266` 至 `269` 调用 `String.fromCharCode(...bytes)`。
- CSV 和 HTML 分别在 `apps/worker/src/index.ts:5519`、`5643` 使用该 metadata。
- 当前 Node 环境中约 150 KB 参数即可出现 `RangeError: Maximum call stack size exceeded`。

### 确定性复现

```bash
node -e 'console.log(String.fromCharCode(...new Uint8Array(150000)).length)'
```

随后使用足以生成超过该大小 metadata 的数据请求 CSV/HTML；5 万条输入会稳定超过阈值。

### 修复方向

- 使用固定大小 chunk 编码，禁止把任意长度字节数组展开为参数。
- 评估将 metadata 分块或压缩，避免在 CSV 首行或单个 HTML META 中复制完整数据。
- importer 保持向后兼容。

### 验收方法与通过标准

- 50,000 条 CSV 和 HTML 导出不得抛异常。
- 导出文件可重新导入，并完整保留层级、visibility、顺序、标签和颜色。
- 峰值内存处于明确预算内，不能因重复 metadata 无界增长。

## MH-RESTORE-003：staging 数据没有 TTL、lease 或异常回收

- 优先级：P1
- 分类：核心 / 运维与数据完整性
- 状态：Open

### 问题与影响

正常 catch 和成功 cutover 会清理 staging，但 Worker 在中途被终止时会留下永久数据，且没有定时回收机制。

### 当前证据

- `apps/worker/migrations/0006_restore_staging.sql:2` 至 `8` 只有标识和 payload。
- `apps/worker/src/index.ts:3412` 的 cleanup 只能由当前请求执行。
- 仓库中不存在按创建时间清理 `restore_staging` 的 cron 或恢复逻辑。

### 确定性复现

1. 在 staging 写完、cutover 前暂停大型恢复。
2. 强制终止 Worker。
3. 重启并查询 `SELECT COUNT(*) FROM restore_staging`。
4. 残留行不会随 scheduled handler 或后续请求消失。

### 修复方向

- 增加 `status`、`created_at`、`updated_at`、`expires_at` 和 lease owner。
- 为 `expires_at` 建索引。
- scheduled handler 清理过期且无有效 lease 的 staging。
- retry 和 cleanup 必须幂等，不能删除仍活跃的 restore。

### 验收方法与通过标准

- 增加强制终止测试。
- 过期 staging 必须在规定 TTL 内清除。
- 活跃 lease 不得被误删；同一用户随后能够重新恢复。

## MH-BACKUP-001：retention 多项失败信息不完整

- 优先级：P1
- 分类：核心 / 备份保留
- 状态：Open

### 问题与影响

多个对象删除失败时，调用方只能看到其中一项，无法识别全部残留对象。Worker 的 S3 listing 还只读取单页，超过 1000 个对象时 retention 不完整。

### 当前证据

- Worker 在 `apps/worker/src/index.ts:1276` 收集错误，但 `1289` 只返回第一条详情。
- FastAPI 在 `server/app/domain/remote_backup.py:350` 至 `356` 每次覆盖 `retention_error`，最终只保留最后一条。
- Worker 在 `apps/worker/src/index.ts:1262` 只读取一页 ListObjectsV2。
- 当前 Worker/Python provider 测试都只注入一个 S3 delete failure。

### 确定性复现

1. fake S3 中放入至少 4 个超出 retention 的对象。
2. 将两个不同 key 配置为删除失败。
3. 执行立即备份。
4. 返回结果只包含一个失败详情。
5. 再准备超过 1000 个对象，确认后续页对象未被处理。

### 修复方向

- 返回结构化 `retention_failures: [{key, code, message}]`。
- 同时返回 `attempted`、`pruned`、`failed` 和 `failure_count`。
- 可以限制响应中的详情数量，但必须保留总数和稳定 key，并将完整详情写入日志。
- Worker 实现 ListObjectsV2 continuation 分页。

### 验收方法与通过标准

- Worker 和 FastAPI 都用两个以上失败 key 回归。
- 响应可识别每个失败 key，计数严格一致。
- 超过 1000 个对象的分页 retention 测试通过。

## MH-BACKUP-002：retention 部分失败在刷新后和 UI 中不可见

- 优先级：P1
- 分类：核心 / 备份状态
- 状态：Open

### 问题与影响

POST 响应可能带 `retention_ok:false`，但 GET 配置不返回已保存错误，UI 也固定显示成功。管理员无法判断上传成功但 retention 失败的状态。

### 当前证据

- Worker S3/WebDAV GET 在 `apps/worker/src/index.ts:4052` 至 `4073`、`5463` 至 `5472` 忽略 `last_retention_error`。
- FastAPI S3/WebDAV GET 在 `server/app/domain/remote_backup.py:17` 至 `29`、`180` 至 `196` 忽略该字段。
- UI 在 `apps/web/src/pages/admin/Backup.tsx:234`、`258` 不读取 POST retention 结果，固定显示完成。

### 确定性复现

1. fake provider 注入 retention delete failure。
2. 从管理页点击 Run now。
3. API 返回 `retention_ok:false`，页面仍显示成功。
4. 刷新页面，GET 配置仍无错误状态。

### 修复方向

- GET 配置返回 `last_retention_error`、失败时间、失败数和最后成功 retention 时间。
- UI 根据 `retention_ok` 显示持久 warning，而不是成功提示。
- 明确区分“上传成功”和“retention 完整成功”。
- 只有一次完整成功的 retention 才清除旧错误。

### 验收方法与通过标准

- Worker、FastAPI、S3、WebDAV 均覆盖 partial failure。
- 错误在当前操作和刷新后都可见。
- 下一次完整成功后 warning 才消失。

## MH-BACKUP-003：scheduled S3 路径缺少真实回归

- 优先级：P1
- 分类：核心 / 备份调度测试
- 状态：Open

### 问题与影响

生产代码有 scheduled S3 分支，但现有测试只真正触发 WebDAV。S3 scheduler 可以失效而测试继续通过。

### 当前证据

- Worker S3 scheduled 分支位于 `apps/worker/src/index.ts:5966` 至 `5982`。
- `apps/worker/scripts/test-remote-backups-r3.mjs:211` 触发 schedule 时只配置 WebDAV；S3 到 `245` 才配置，之后未再次触发 schedule。
- `server/tests/test_remote_backup_fake_provider_r3.py:198` 至 `208` 触发 schedule，S3 配置从 `218` 才开始。

### 确定性复现

将 Worker 或 FastAPI 的 scheduled S3 调用临时改为 no-op，再运行当前远程备份套件；套件仍可通过。

### 修复方向

- 两个 runtime 都先配置 enabled S3 和匹配当前时间的 `backup_time`，再调用真实 scheduler。
- fake provider 断言 PUT、listing、retention 和持久化状态。
- 加入 scheduled partial failure 和时间不匹配时不执行的用例。

### 验收方法与通过标准

- 对 scheduled S3 分支做 mutation test；删除或 no-op 该调用必须导致测试失败。
- Worker 和 FastAPI 都必须证明 scheduled PUT 和 retention 实际发生。

## MH-CF-001：assets 配置缺少 `run_worker_first`

- 优先级：P1
- 分类：核心 / Cloudflare 部署
- 状态：Open

### 问题与影响

升级 compatibility date 后，SPA fallback 可能先于 Worker 处理浏览器 navigation 形式的 `/api/*` 请求，导致 API 返回 HTML。

### 当前证据

- `apps/worker/wrangler.toml:12` 至 `15` 配置 assets 和 SPA fallback，但没有 `run_worker_first = true`。
- `apps/worker/node_modules/wrangler/config-schema.json:39` 说明该字段控制所有请求是否先进入 Worker。
- `apps/worker/scripts/cf-assets-test.mjs:238` 之后只测普通 API GET，没有模拟 `Sec-Fetch-Mode: navigate`。
- 当前 compatibility date 为 `2024-12-01`，会掩盖升级后的行为变化。

### 确定性复现

1. 使用临时 config 把 compatibility date 更新到当前日期。
2. 保留现有 SPA assets 配置。
3. 请求：

```bash
curl -i -H 'Sec-Fetch-Mode: navigate' http://127.0.0.1:PORT/api/v1/health
```

4. 检查响应是否为 SPA HTML 而不是 API JSON。

### 修复方向

- 在生产 `[assets]` 中显式设置 `run_worker_first = true`。
- assets harness 继承并断言该配置。
- 同时测试普通 fetch 和 browser navigation header。

### 验收方法与通过标准

- `/api/v1/*` 在普通请求和 navigate 请求中始终由 Worker 返回正确 JSON/status。
- `/admin/login` 等前端路由仍返回 SPA。
- 当前 compatibility date 下 dry-run 和真实本地 assets harness 通过。

## MH-UI-001：远程备份页面缺少 retention 与完整调度配置

- 优先级：P2
- 分类：非核心 / 管理端配置完整性
- 状态：Open

### 问题与影响

后端的 S3 和 WebDAV 配置都支持 `keep_backups` 与 `backup_time`，但管理页没有任何 `keep_backups` 控件，WebDAV 也没有 `backup_time` 控件。管理员只能依赖默认值或直接调用 API，无法从产品界面完整配置已实现的能力。

### 当前证据

- `apps/web/src/pages/admin/Backup.tsx:226` 只为 S3 渲染 `backup_time`。
- `apps/web/src/pages/admin/Backup.tsx:242` 至 `261` 的 WebDAV 表单没有 `backup_time` 或 `keep_backups`。
- 整个 `apps/web/src/pages/admin/Backup.tsx` 没有 `keep_backups` 字段。
- Worker 在 `apps/worker/src/index.ts:4069`、`4070`、`5469`、`5470` 返回这两个配置。
- FastAPI 在 `server/app/domain/remote_backup.py:26`、`27`、`191`、`192` 返回这两个配置。

### 确定性复现

1. 以管理员身份打开 Backup 页面。
2. 查看 S3 表单，只能配置执行时间，不能配置保留份数。
3. 查看 WebDAV 表单，执行时间和保留份数都不可配置。
4. 通过 API 写入非默认值后刷新页面；数据虽在 state 中返回，但没有可见、可编辑的对应控件。

### 修复方向

- 为 S3 和 WebDAV 增加数值输入或 stepper，编辑 `keep_backups`，最小值为 1。
- 为 WebDAV 增加与 S3 一致的 `backup_time` 时间输入。
- 使用明确的 typed form model 替代 `any`，并在提交前展示与后端一致的字段级校验错误。
- 对 API 返回的非默认值进行受控表单回填，避免保存其他字段时意外覆盖隐藏配置。

### 验收方法与通过标准

- 浏览器 E2E 分别为 S3 和 WebDAV 设置非默认 `keep_backups`、`backup_time`，保存并刷新后值保持一致。
- 非法时间和小于 1 的保留份数在 UI 中得到明确错误，且不会发出无效保存或覆盖已有配置。
- 只修改凭据、endpoint 或 path 时，现有 retention/schedule 值保持不变。

## MH-TEST-001：`pnpm test` 不是完整 release gate

- 优先级：P1
- 分类：非核心 / 测试基础设施
- 状态：Open

### 问题与影响

根测试只递归执行 workspace package tests，不运行 FastAPI、Docker 和浏览器 E2E。reviewer 只看 `pnpm test` 绿灯会得到错误的完整验收结论。

### 当前证据

- `package.json:8` 的 `test` 只有 `pnpm -r run test`。
- `pnpm-workspace.yaml:1` 至 `3` 只包含 `packages/*`、`apps/*`。
- `test:server`、`test:docker`、`test:e2e` 是独立脚本，没有被根 `test` 调用。

### 确定性复现

运行 `pnpm test` 并查看命令输出，不会出现 pytest、Docker integration 或根浏览器 E2E。

### 修复方向

- 增加单一 `test:release`，串联 lint、core、server、worker、E2E、Docker、Cloudflare dry-run/assets。
- CI 和 workflow 最终验收调用该统一入口。

### 验收方法与通过标准

- 对每个子套件分别注入失败，`test:release` 都必须非零退出。
- 成功日志列出全部必需 gate，不能依赖 reviewer 临时拼装命令。

## MH-TEST-002：Docker cleanup 失败可能仍退出 0

- 优先级：P2
- 分类：非核心 / 测试基础设施
- 状态：Open

### 问题与影响

EXIT trap 只返回 cleanup 状态时，Bash 可能保留主流程的原始成功码，使资源清理失败被误报为测试通过。

### 当前证据

- `scripts/test-docker-deploy.sh:65` 至 `91` 返回 cleanup 状态。
- `scripts/test-docker-deploy.sh:93` 使用 `trap cleanup EXIT`，没有合并原始 status 并显式退出。
- `bash -c 'trap "false" EXIT; true'; echo $?` 可观察退出码仍为 0。

### 确定性复现

1. 将 cleanup 中一个受控清理步骤替换为稳定失败 stub。
2. 让主测试流程成功。
3. 观察脚本仍可能退出 0。

### 修复方向

- cleanup 捕获 `$?`，执行清理后合并主流程和 cleanup 状态。
- 显式 `exit "$status"` 前移除 EXIT trap，避免递归。

### 验收方法与通过标准

- 主流程成功、cleanup stub 失败时脚本必须非零退出。
- 主流程失败时保留原始失败。
- 成功退出后没有容器、volume、镜像或监听端口残留。

## MH-TEST-003：测试依赖仓库外的 `bounded-run.mjs`

- 优先级：P2
- 分类：非核心 / 测试可移植性
- 状态：Open

### 问题与影响

干净 CI 或没有安装 pi-trio-workflow 的开发机无法运行 release tests，测试在业务逻辑执行前即失败。

### 当前证据

以下路径均引用 `~/.pi/agent/extensions/trio-workflow/bounded-run.mjs`：

- `scripts/e2e-smoke.sh:6`
- `scripts/test-docker-deploy.sh:6`
- `apps/worker/scripts/run-test.sh:5`
- `apps/worker/scripts/worker-d1-runtime-test.mjs:17`
- `apps/worker/scripts/cf-assets-test.mjs:20`
- `server/tests/test_remote_backup_fake_provider_r3.py:24`

### 确定性复现

在空 `HOME` 的容器或干净账号中运行 `pnpm test:worker`、`pnpm test:e2e` 或 `pnpm test:docker`，测试会因缺少 helper 失败。

### 修复方向

- 将 deadline/process-group helper 放进仓库，或声明为锁定版本的项目依赖。
- 所有 harness 只引用同一个 repo-local 入口。

### 验收方法与通过标准

- 在空 HOME、只 checkout 仓库并安装项目依赖的容器中可运行全部 release gate。
- 测试不得读取 `~/.pi` 或其他 workflow 私有路径。

## MH-TEST-004：所谓大型恢复测试只有约 460 条

- 优先级：P1
- 分类：非核心 / 规模测试缺口
- 状态：Open

### 问题与影响

测试名称声称覆盖 size-independent restore，但没有覆盖计划要求的 50,000 条规模，无法发现查询预算、参数上限和内存阈值问题。

### 当前证据

- `apps/worker/scripts/worker-d1-runtime-test.mjs:971` 默认 `count = 460`。
- `apps/worker/scripts/worker-d1-runtime-test.mjs:1401` 将其描述为大型恢复。

### 确定性复现

在 1,000 或更高规模引入阈值故障，当前测试仍通过，因为输入从未超过约 460 条。

### 修复方向

- 增加 50,000 条真实 Worker integration 用例；耗时过长时可放入 nightly/release gate。
- 增加快速 query-budget 和 metadata-size 单测，让常规 CI 稳定捕获规模退化。

### 验收方法与通过标准

- JSON、CSV、HTML 至少各完成一次 50,000 条恢复与导出。
- 校验 count、首尾记录、checksum、层级、顺序、visibility、标签和 staging 清理。
- 不能只证明 HTTP 200。

## MH-MAINT-001：Worker Env 仍为手写类型

- 优先级：P3
- 分类：非核心 / 维护性
- 状态：Open

### 问题与影响

绑定类型可能与生产 Wrangler 配置漂移，TypeScript 无法保证代码声明与实际部署 binding 一致。

### 当前证据

- `apps/worker/src/index.ts:34` 至 `43` 手写 `Env`。
- `apps/worker/wrangler.toml` 是真实 binding 来源。

### 确定性复现

在 Wrangler 配置中添加或重命名 binding，但不更新手写 interface；常规配置校验不会保证两者同步。

### 修复方向

- 使用 `wrangler types` 从生产配置生成 Env 类型。
- 将生成结果 drift check 纳入 CI；测试专用 binding 用独立 augmentation 表达。

### 验收方法与通过标准

- `wrangler types --check` 或等价 drift check 通过。
- 修改 binding 后未重新生成类型必须使 CI 失败。

## MH-MAINT-002：Wrangler 3 和旧 compatibility date 待升级

- 优先级：P2
- 分类：非核心 / 平台维护
- 状态：Open

### 问题与影响

项目仍使用 Wrangler 3 和较旧 compatibility date，升级时可能集中暴露 assets routing、类型和运行时兼容问题。

### 当前证据

- `apps/worker/package.json:23` 至 `25` 锁在 Wrangler 3 范围。
- `apps/worker/wrangler.toml:3` 使用 `2024-12-01`。
- `pnpm --dir apps/worker exec wrangler --version` 当前输出 `3.114.17`。

### 确定性复现

```bash
pnpm --dir apps/worker exec wrangler --version
```

### 修复方向

- 先完成 `MH-CF-001`，再升级 Wrangler 4、生成 binding 类型并更新 compatibility date。
- 按变更逐项运行 D1、remote backup、assets 和 dry-run 回归。

### 验收方法与通过标准

- 使用受支持的 Wrangler 4，无过期警告。
- 当前 compatibility date 下 Worker runtime、remote backup、assets navigation、D1 migrations 和 deploy dry-run 全部通过。

## 关闭规则

任何条目只有在以下条件全部满足后才能改为 Closed：

1. 根因修复已落在共享边界，而不是只屏蔽一个测试症状。
2. 本条“确定性复现”在修复前稳定失败、修复后稳定通过。
3. 本条列出的所有验收标准均有 checked-in 自动化证据，或有明确、可重复的部署配置检查。
4. 相关 broad/release suite 仍通过，且没有破坏原有数据和兼容路径。
5. 文档记录实际修复 commit、验证命令和结果。
