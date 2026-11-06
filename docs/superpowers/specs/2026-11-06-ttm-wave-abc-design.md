# TTM Wave A / B / C 独立指标设计

## 目标与接入方式

增加 `TTM_WAVE_A`、`TTM_WAVE_B`、`TTM_WAVE_C` 三个独立副图指标，菜单分别显示 TTM Wave A（短期波）、TTM Wave B（中期波）、TTM Wave C（长期波）。可以单独勾选、移除、隐藏、修改参数和颜色，各自保存副图高度；沿用当前实时行情与历史回放计算入口，不自动添加到默认指标组合。

沿用已接入的 TTM Squeeze 自定义指标注册、Pro 指标菜单／设置窗口和 chartIndicators 存档。三者共用一个计算模块与模板工厂，但注册为三个不同名称，不采用一个指标里的 A/B/C 显示开关；后者不符合用户要求的三个独立指标。没有增加图表库或计算依赖的必要。

## 公式来源与实现口径（提议）

采用 UDAY_C_Santhakumar 公开的 [UCS_TTM_Wave A & B & C](https://www.tradingview.com/script/nYOzTA1Y-UCS-TTM-Wave-A-B-C/) 数学口径，以 TypeScript 独立实现计算，不直接搬运 Pine 源码。已核对该公开页面中的源代码。

[thinkorswim 官方 TTM_Wave](https://toslc.thinkorswim.com/center/reference/Tech-Indicators/studies-library/T-U/TTM-Wave) 的说明是 A/C 合并图，只列出 Wave1、Wave2High、Wave2Low，没有公开 B 波及完整计算公式，因此不能将公开 ABC 版本宣称为官方原版逐点复刻。

定义 `D(p) = EMA(close, fast) - EMA(close, p)`，`H(p) = D(p) - EMA(D(p), p)`。

| 独立指标 | 参数：快线／慢线一／慢线二 | 波形一 | 波形二 | 默认颜色 |
| --- | --- | --- | --- | --- |
| A | `[8, 34, 55]` | H(55) | H(34) | 绿、金 |
| B | `[8, 89, 144]` | H(144) | H(89) | 紫、蓝 |
| C | `[8, 233, 377]` | D(377) | H(233) | 红、橙 |

重要区别：C 波第一组为未经信号线相减的 EMA 差值，不能把 A/B/C 全部实现为相同的双 MACD 柱状图。

每个副图显示两组从零轴延伸的重叠柱状波和零轴线，提供中文参数标签与两组悬浮数值。保留参考版本的默认配色，允许分别调整两组颜色。这里的短／中／长期指当前图表周期上的不同 EMA 长度，不额外读取其他周期。

EMA 从首个有效收盘价起始，信号 EMA 从首个 EMA 差值起始；首根结果为零。仅使用当前及以前的收盘价，不用未来 K 线、不修改输入。短历史也能计算，但尤其 B/C 的初始结果会受所加载历史长度及 EMA 初始化方式影响；README 明确这一点，不承诺与其他数据源或闭源版本逐点一致。

三个周期必须为有限正整数，且快线 < 慢线一 < 慢线二。计算函数对非法参数防御性返回同长度空结果，存档导入在任何数据写入之前拒绝非法类型、参数数量或顺序。

## 配置与兼容

继续复用 `chart.indicators.v1`、`BackupPreferences.chartIndicators` 和 GitHub 的 `config/preferences.json`，不新增顶层配置字段、存储键或版本。覆盖独立选择、参数、可见性、两组颜色、零轴样式和副图高度。

配置与完整 JSON 导出／导入、GitHub 只勾选“应用配置”时的比较、上传与拉取恢复均覆盖三个指标。继续沿用大小、校验和、结构校验和冲突流程；不向真实云端写测试数据，不修改其他项目命名空间。

旧存档不自动添加这些指标；缺少 chartIndicators 时保留目标浏览器现有配置，显式空主／副图列表表示清空，visible:false 和合法样式数值 0 原样保留。恢复后沿用当前界面的刷新生效提示，不让旧组件状态覆盖恢复配置。

## 验证与交付

先写失败测试再实现。计算测试覆盖独立手算 EMA／信号 EMA、A/B/C 的不同分支、首根与常量行情、非法参数、三组默认值、未来数据隔离、实时末根修改，以及模板读取编辑参数与颜色。

完整配置样本在本地配置、备份服务和 `src/github-sync/sync-service.test.ts` 的 `Required<BackupPreferences>` 中同时加入 A/B/C，断言完整对象往返；覆盖缺失、空列表、false、0 和校验和正确但参数非法时无部分写入。

Playwright 验证三个独立菜单项、同时添加到三个副图、独立编辑与移除、颜色、刷新、JSON 与模拟 GitHub 恢复，以及与已实现 TTM Squeeze/KC 的共存。运行 `npm run check` 和相关浏览器回归测试，更新 README 与配置清单；保留本次任务开始时已有的未提交改动。
