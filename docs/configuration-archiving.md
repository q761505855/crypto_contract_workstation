# 配置持久化与存档约定

本规则由 2026-11-04 的配置存档要求确立，适用于后续所有用户配置修改。功能实现和存档实现是同一个交付项。

## 必须打通的链路

用户修改配置后先保存到当前浏览器。导出“应用配置”和“全部数据”时都应包含它；GitHub 同步选择“应用配置”时，应参与差异比较、上传、校验、冲突处理和拉取恢复。刷新页面或在另一个浏览器恢复存档后，应得到相同配置。

用户配置同步继续沿用手动操作流程。保存本地设置不会自动发起配置上传；用户在“数据管理 → GitHub 公共仓库同步”中比较、上传或拉取。默认已连接通用存储仓库，配置路径均相对 `projects/crypto-contract-workstation/`；历史行情下载后自动上传到同项目的 `data/market-history/`，与配置的触发方式分开。详见 [通用云端存储约定](cloud-storage.md)。

不能把“组件 useState 里记住了”或“刷新后还在”作为配置修改的完整验收标准。

## 当前配置清单

| 配置 | 本地键与读写入口 | `BackupPreferences` 字段 | 云端文件 |
| --- | --- | --- | --- |
| 行情 REST 地址 | `marketData.binanceBaseUrl`；`market-data/runtime.ts` | `binanceRestBaseUrl` | `config/preferences.json` |
| 指标选择、参数、样式、副图布局 | `chart.indicators.v1`；`chart/indicator-preferences.ts` | `chartIndicators` | `config/preferences.json` |
| 收藏产品列表 | `marketData.favoriteSymbols`；`market-data/favorites.ts` | `favoriteSymbols` | `config/favorites.json` |
| 固定周期列表 | `chart.pinnedPeriods.v1`；`chart/period-preferences.ts` | `pinnedPeriods` | `config/preferences.json` |
| 当前产品及图表精度等元信息 | `marketData.selectedSymbol`；`market-data/symbol-preferences.ts` | `selectedSymbol` | `config/preferences.json` |

上述入口均位于 `src/`。新增配置必须更新本表，不得在组件中另建脱离存档的持久化键。配置读写和校验应放在可独立调用的模块中，备份服务不能依赖 React 组件。

会话的交易参数、进度、持仓和交易记录由现有 IndexedDB 会话及模拟状态存储负责，走会话／全部数据存档和云端“会话与交易”类别，不能为了保存配置而破坏会话隔离。

Token 等凭据不得进入用户配置存档。手动 Token 只保留在页面内存；默认连接凭据通过本机 `.env.local` 或 Pages 构建 Secret 注入前端产物，不新增 `BackupPreferences` 字段。行情缓存、待上传设备队列、请求额度、冷却状态和跨页面锁也不是可迁移用户偏好，不应混入配置文件。当前临时展开／收起、弹窗打开等状态不代表已经承诺保存；以后若将其改为可记住的用户设置，必须同时接通存档。

## 修改入口

| 环节 | 必须检查的位置 |
| --- | --- |
| 本地默认值、读写、校验 | 对应的配置模块及使用组件 |
| 存档模型 | `src/storage/backup-service.ts` → `BackupPreferences` |
| 导入校验 | `validatePreferences()`，由 `validateBackupEnvelope()` 在写入前调用 |
| 配置和完整导出 | `defaultPreferences()`，由 `exportPreferences()` / `exportAll()` 共用 |
| 恢复写入 | `WorkstationBackupService.import()` |
| 云端序列化 | `src/github-sync/sync-service.ts` → `GitHubSyncService.prepare()` |
| 云端解析与恢复 | `GitHubSyncService.pull()` → 完整校验 → `WorkstationBackupService.import()` |
| 用户恢复提示 | `src/components/BackupSyncPanel.tsx` |

云端按字段构造文件，更新本地备份模型不会自动更新云端序列化或解析。这两个方向都必须检查。不要只补上传而漏掉拉取，也不要只保存字段而漏掉导入校验。

## 兼容与校验

目前本地备份和云端配置的 `schemaVersion` 均为 `1`。固定周期作为可选字段加入，旧存档仍然可以导入。

- 新增兼容字段时：旧存档缺失该字段应保留目标浏览器已有设置；目标浏览器没有本地设置时由读入口使用默认值。不要在校验阶段擅自补默认值后覆盖本地偏好。
- 显式空值和缺失值分开处理：`pinnedPeriods: []` 表示不固定任何周期，必须原样恢复；没有 `pinnedPeriods` 才表示旧存档未提供它。布尔值、数字配置同理，避免 `value || default`。
- 固定周期只接受受支持且不重复的周期文本，并按图表标准顺序排列。`1m` 和 `1M` 大小写有不同含义，不能统一转换大小写。
- 读到损坏的本地配置时允许回退默认值以保证界面可打开；导入损坏的本地或云端存档必须报错，不能静默丢弃非法项再覆盖用户数据。
- 所有远端文件先通过大小和 SHA-256 校验，再完成存档结构和字段校验，最后写入。校验失败不得留下部分导入的数据。
- 字段重命名、类型变化或语义变化需要明确迁移方案；不能简单删除旧解析器或无条件提升版本导致旧存档失效。

当前恢复配置后需要刷新页面，使指标、当前产品、固定周期等组件从已恢复的存储重新加载。界面会提示刷新，不自动重载以免中断用户操作。若后续改成即时生效，需要同步所有相关组件，避免后台持有的旧状态反向写回。

窄屏下的主图／副图最小显示高度属于自适应布局计算，不是新增用户配置。`ProChartAdapter.layoutSubPanes()` 临时放大副图，`getIndicatorPreferences()` 仍返回原始存档高度，避免切换设备后把手机显示尺寸写回桌面布局。只有用户主动拖动分隔线时更新相关副图的存档高度，继续通过 `chartIndicators.sub[].height` 导出、上传和恢复，不另建存储键。

## 验收与回归

每次配置修改至少验证：

1. 本地修改后刷新可恢复；默认值与用户主动清空的设置均正确。
2. 配置导出、完整导出，以及导入后再次导出的配置一致。
3. 仅勾选“应用配置”也能完成云端往返；只修改该配置时差异比较能发现变化。
4. 旧本地／云端存档缺字段时不覆盖现有值。
5. 非法类型、枚举值或重复项被拒绝；即使云端校验和正确，非法配置仍不能写入。
6. 恢复后刷新界面显示相同设置，原有指标、收藏和当前产品不丢失。

`src/github-sync/sync-service.test.ts` 的完整配置样本使用 `Required<BackupPreferences>`。新增字段会要求更新该样本，完整对象往返断言可发现漏掉的云端序列化或解析。还需在 `src/storage/backup-service.test.ts` 和对应配置模块测试中覆盖校验、旧版本和空值语义。

常用验证命令：

```sh
npm run check
npx playwright test
```

最终交付说明应明确本地保存、JSON 存档、云端上传与拉取恢复是否均已覆盖，以及旧存档的处理方式。
