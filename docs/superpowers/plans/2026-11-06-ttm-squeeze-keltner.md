# TTM Squeeze 与肯特纳通道 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 将 KC 主图和 TTM Squeeze 副图完整接入指标、设置及存档。

**Architecture:** 通过现有自定义指标注册和 Pro 补丁扩展菜单。KC 计算复用于 TTM，配置复用 chartIndicators，不新增存储键或依赖。

**Tech Stack:** TypeScript、KLineCharts 9.8.12、KLineChart Pro 0.1.1、Vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-11-06-ttm-squeeze-keltner-design.md`

## Global Constraints

- KC 默认 `[20, 1.5, 20]`；TTM 默认 `[20, 2, 1.5]`。
- EMA 用 SMA 起始，ATR 用 SMA 起始和 Wilder 平滑；TTM 采用总体标准差及线性回归末端值。
- 不修改默认指标组合，不新增依赖，不使用未来数据。
- 配置与完整备份及 GitHub 应用配置均覆盖；非法存档必须在写入前拒绝。
- 旧存档缺失保留，空列表清空，false 和 0 原样保留，恢复后刷新生效。

## Review Focus

- KC 的不同 EMA/ATR 周期必须等待二者预热完成（任务 1）。
- 常量行情和周期 1 不产生除零或伪动量（任务 1）。
- 修改末根行情不能污染之前的结果（任务 1）。
- 正确校验和但非法指标参数也不能部分恢复（任务 2）。
- 菜单选择、设置、刷新和 JSON 恢复必须保留同一指标（任务 3）。

### Task 1: 计算与渲染模板

**Files:** 新增 `src/chart/keltner.ts`、`src/chart/ttm-squeeze.ts` 及各自 `.test.ts`。

**Interfaces:** `calculateKeltner(candles: KLineData[], emaPeriod?: number, multiplier?: number, atrPeriod?: number): KeltnerValue[]`；`calculateTtmSqueeze(candles: KLineData[], period?: number, bbMultiplier?: number, kcMultiplier?: number): TtmSqueezeValue[]`；分别导出指标模板和注册函数。

- [x] 添加手算 EMA、跳空 ATR、不同周期预热、常量和非法参数测试；运行 `npx vitest run src/chart/keltner.test.ts src/chart/ttm-squeeze.test.ts`，确认缺失功能导致失败。
- [x] 实现三轨、红绿零轴点、四色柱、中文悬浮值及无未来依赖；相同命令应通过。

### Task 2: 参数校验与存档

**Files:** `src/chart/indicator-preferences.ts` 及测试、`src/storage/backup-service.test.ts`、`src/github-sync/sync-service.test.ts`。

**Interfaces:** 继续使用 `ChartIndicatorPreferences` 与 `BackupPreferences.chartIndicators`。新增指标只接受精确三个有限数值参数，周期为正整数、倍数为正数。

- [x] 添加非法类型、长度、周期和倍数拒绝测试，先运行确认失败。
- [x] 实现校验；扩充完整云端样本和本地备份样本，使 KC 与 TTM 的参数、样式、false、0、布局完整往返；补充非法导入无写入和缺失／空列表测试。
- [x] 运行 `npx vitest run src/chart/indicator-preferences.test.ts src/storage/backup-service.test.ts src/github-sync/sync-service.test.ts`，应全部通过。

### Task 3: 图表接入、浏览器验证与文档

**Files:** `src/chart/pro-chart-adapter.ts`、`patches/@klinecharts+pro+0.1.1.patch`、`e2e/app-shell.spec.ts`、`README.md`、`docs/configuration-archiving.md`。

**Interfaces:** 在构建 Pro 图表前注册 KC、TTM，扩展已有菜单及参数表，保留标准 tooltip 的可编辑样式与图表工具按钮。

- [x] 添加 Playwright 用例：选择两个指标，画布中出现对应轨道／柱／点，编辑小数参数、刷新保留、JSON 配置导出与恢复；先运行确认失败。
- [x] 修改注册和 Pro 补丁并重新生成 patch-package 补丁；不破坏现有 Supertrend/Pivots。
- [x] 更新公式、参数、兼容性和存档说明。
- [x] 运行 `npm run check` 和相关 Playwright 用例，应通过；检查 diff 并完成代码审查。

## 执行记录

- 用户已确认“按此方案直接实现”；原地切换到 `codex/ttm-squeeze-keltner` 分支，不再创建另一个工作目录。
- 本任务不自动提交、推送或部署；以工作区改动交付。

- Task 1: complete — 10 个计算／绘图模板测试通过；手算、预热、常量、非法参数、未来数据隔离均覆盖。
- Task 2: complete — 67 个本地配置、备份和 GitHub 同步测试通过；完整配置样本已加入两个指标，非法参数在写入前拒绝。
- Task 3: complete — 指标菜单、参数和颜色编辑、刷新、JSON 与模拟 GitHub 恢复已接通；README 和配置清单已更新。
- Ruling: 不增加 BackupPreferences 顶层字段，复用 chartIndicators — 该字段已覆盖选择、参数、样式与布局，所有存档方向均已验证。
- Ruling: 补丁生成器在成功写出补丁后出现 Windows 临时目录清理 EPERM；以 git apply --check --reverse 验证补丁与实际依赖文件匹配，不删除工具临时目录。
- 浏览器测试时钟：图表库的 500ms 双击计时器会吞掉快速的第二次点击；设置窗口之间使用 page.clock.runFor(600)，不修改产品行为。
- 验证：npm run check 通过（47 个文件，500 个测试，类型检查及生产构建通过）；构建仍提示单包超过 500kB。
- 浏览器回归：新指标、Supertrend、Pivots、JSON／云端配置、窄屏副图共 5 个测试通过。复跑曾出现已有窄屏用例的布局高度时序失败；随后窄屏与新指标单独复跑均通过，未改动该用例或布局代码。
- 独立代码审查：review_ttm 检查计算、渲染、参数校验与存档实现，无需修复的生产代码问题。
