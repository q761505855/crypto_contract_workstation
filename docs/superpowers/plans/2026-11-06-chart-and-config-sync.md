# 图表与自动配置同步实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. 用户指定当前会话直接在 main 实施，不再确认。

**Goal:** 完成价格百分比、RSI 水平线、全颜色透明度和跨设备配置自动同步。

**Architecture:** 复用 KLineCharts 的扩展和补丁；新增统一颜色工具及配置同步服务；启动同步先于工作台初始化，运行期间监听统一配置变更入口。

**Tech Stack:** React、TypeScript、KLineCharts、Vitest、Playwright。

**Spec:** [已确认设计](../specs/2026-11-06-chart-and-config-sync-design.md)

## Global Constraints

- 直接 main，中文提交，测试通过后推送，不新增确认。
- 只写 projects/crypto-contract-workstation，保持 schema 1 和旧存档缺失语义。
- 凭据及设备保护不进入配置存档。

## Review Focus

- 全透明 0 alpha 不得退回默认颜色。
- 启动网络失败不能丢失本地或阻止使用。
- 上传期间新修改不能被清除待上传状态。
- 其他设备同字段修改不能被静默覆盖。
- 旧界面和跨页面操作不能覆盖刚恢复的配置。

### Task 1: 图表和配置扩展

Files: src/chart/colors.ts、rsi.ts、indicator-preferences.ts、pivots.ts、patches、相应单测。

- [x] 添加颜色、RSI 校验回归，运行确认失败。
- [x] 实现统一颜色格式和 RSI 三条线；在 Pro 设置补丁统一添加透明度控件，在核心价格标签补丁显示百分比。
- [x] 扩展本地、备份及云端完整配置样本；运行相关测试。

### Task 2: 自动配置同步

Files: src/github-sync/config-auto-sync.ts、配置写入口、sync-service.ts、src/main.tsx、App.tsx、状态组件及测试。

- [x] 添加启动恢复、三方合并、冲突、失败重试、上传期间修改测试，运行确认失败。
- [x] 分离配置只读获取与导入，保留远端固定快照和严格校验。
- [x] 所有本地配置写入口发变更事件；自动服务记录本设备基线，合并一秒上传，自动重试。
- [x] 启动先同步后挂载，运行恢复重新加载相关界面，显示同步状态。
- [x] 运行模块测试并核对本地、JSON、云端兼容行为。

### Task 3: 回归与交付

Files: e2e/app-shell.spec.ts、README.md、docs/configuration-archiving.md、docs/cloud-storage.md。

- [x] 加入浏览器自动上传、跨设备启动恢复、RSI 与透明度及价格标签回归。
- [x] 更新配置清单、兼容说明及自动同步文案。
- [x] npm run check；相关 Playwright；最终 diff 和凭据检查。
- 交付动作：中文提交并 git push origin main，随后核对远端提交和干净工作区；结果记录于最终交付说明。

## 实施记录

- Ruling: 按用户明确要求直接 main、当前会话执行，不建工作树、不再要求批准。
- Ruling: RSI 新值放入样式而非周期参数，原有最多五条计算周期及数值算法保持不变；rsi.ts 负责水平值校验，绘制扩展在现有依赖补丁中。
- 全新安装发现旧零上下文类型补丁落在接口外；修正为有上下文补丁，npm ci 后类型检查通过。
- 一次独立整体审查发现上传期间合并、跨标签旧状态和活动会话产品三个问题，均补回归后修正。分别记录本地／远端确认快照，完整写入后通知其他标签，回放延后应用产品偏好。
- 浏览器验证发现同步状态换行影响图表高度，固定状态条高度；新增透明度控件后颜色定位改用精确标签，保持原断言。
- 验证：全新 npm ci 补丁安装成功；npm run check 的类型检查、695 项单测及构建通过。全量 38 项浏览器用例中 37 项通过；剩余大数据导入用例将“状态发生变化”改为明确等待“导入完成”（90 秒），单独复测通过。长回放测试明确等待界面起点就绪后创建，不放宽数据断言。
- Windows 对生成的测试附件监听会产生 EBUSY，Vite 排除测试输出目录。临时结果保留并仅在本地排除，不进入代码提交。
