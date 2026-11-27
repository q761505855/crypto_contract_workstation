# 配置持久化与存档约定

本规则由 2026-11-04 的配置存档要求确立，适用于后续所有用户配置修改。功能实现和存档实现是同一个交付项。

## 必须打通的链路

用户修改配置后先保存到当前浏览器。导出“应用配置”和“全部数据”时都应包含它；GitHub 同步选择“应用配置”时，应参与差异比较、上传、校验、冲突处理和拉取恢复。刷新页面或在另一个浏览器恢复存档后，应得到相同配置。

用户配置修改后先本地保存，约一秒内的连续操作合并后自动同步至默认云端。启动时先检查云端：没有待上传修改就恢复远端配置，再初始化界面；有待上传修改则根据本设备上次成功同步的基线进行三方比较。不同字段自动合并，同字段冲突保留本地并提示，可选择“保留本地并同步”或“使用云端冲突项”。数组与成对保存的副图窗口尺寸按整个字段比较，工作区对象可按面板字段合并。断网或提交竞争会保留待同步状态，自动退避重试，联网／重新聚焦时也会检查；刷新后继续。下方原有手动比较、上传、拉取入口仍可用。默认已连接通用存储仓库，配置路径均相对 `projects/crypto-contract-workstation/`；历史行情仍自动上传到同项目的 `data/market-history/`。详见 [通用云端存储约定](cloud-storage.md)。

不能把“组件 useState 里记住了”或“刷新后还在”作为配置修改的完整验收标准。

默认云端连接只读时，改动保存在本机并保留待上传状态。页面显示「配置已保存在本机，云端连接只读」。重新打开页面并取得可写连接后，自动同步沿用原基线处理这些改动及远端冲突。

## cTrader 实验版

实验版的浏览器配置和绘图键使用 `crypto-contract-workstation:ctrader:` 前缀，回放会话和模拟状态保存在独立的 `crypto-contract-workstation-ctrader` IndexedDB。配置使用既有 Schema 1，应用配置／完整 JSON 和 GitHub“应用配置”继续覆盖原配置清单。云端目录固定为 `projects/crypto-contract-workstation/experiments/ctrader/`。手动恢复后按界面提示刷新，自动配置恢复后界面重建。

当前品种使用 `selectedSymbol`，cTrader 品种保存 `exchange: "CTRADER"` 和对应显示精度。旧产品保留原始来源与代码，运行时对不可用的旧产品使用默认 cTrader 品种。收藏列表、固定周期列表与回放步进周期仍原样存档。旧备份中当前运行时不可用的步进周期继续保存，用 `1m` 推进回放。可选字段缺失时保留本地值，显式空列表、布尔 `false` 和样式值 `0` 原样恢复，非法配置在写入前拒绝。旧 `binanceRestBaseUrl` 只用于存档兼容。

cTrader 回放会话沿用 Schema 2，在本地、会话或完整 JSON 以及 GitHub“会话与交易”中保存 `marketSource: "ctrader"`、当前步进类型 `cursorTimeframe` 和排他边界 `visibleUntil`。逐笔游标还保存从零开始的 `cursorTickIndex`，用于恢复同一毫秒里的报价顺序。秒级游标保存时间段起点和排他终点。原生 K 线游标沿用原有格式。缺少来源或标注 `binance` 的旧会话仍能恢复记录、画线和交易，回放只激活 cTrader 会话。历史 Tick 数据缓存在内存。完整 JSON 使用空行情数组兼容原格式，旧行情数据校验后跳过恢复。cTrader 连接资料、GitHub 凭据和设备同步状态均排除在应用存档之外。

cTrader 账户选择以 `ctraderAccount` 保存模拟或真实环境及账户 ID，例如 `demo:17` 或 `live:19`。应用配置、全部数据 JSON 和 GitHub“应用配置”均支持该字段，沿用差异比较、校验和、冲突处理和恢复流程。旧存档缺少字段时保留本机选择。提供字段时，账户 ID 必须是正的安全整数，空值或非法格式在任何写入前拒绝。本地字段缺失、损坏或无法匹配当前授权列表时，唯一授权账户可自动连接，多个授权账户需要重新选择。启动时读取已恢复的选择并重新核对授权。如果连接期间恢复了另一个已授权账户，“工具”菜单会提示刷新后生效。

顶部行情来源保存为 `priceSource`，接受 `ctrader`／`okx`／`okx-local`／`databento-cme`。OKX 和 OKX-本地共用 `okxSelectedSymbol`，须为 `exchange: "OKX"`、`priceCurrency: "USDT"`、`type: "PERPETUAL"` 的 USDT 永续代码。cTrader 的品种使用 `selectedSymbol`。Databento-CME 的品种使用 `databentoSelectedSymbol`，保存产品子文件夹名称，例如 `NQ.FUT`。行情来源和品种随本机、应用配置／完整 JSON 和 GitHub“应用配置”往返。旧档缺字段时保留本机同字段。本机缺省使用 cTrader。OKX 缺省使用 BTC-USDT-SWAP 或目录中的可用合约。Databento-CME 优先尝试恢复已保存的品种，目录里找不到时显示首个可用子文件夹。显式空值和非法值在写入前拒绝。自动恢复切换工作区，手动恢复后按提示刷新。两种本地来源的目录授权及文件属于设备数据。另一台设备恢复该来源后，须重新选择所在设备的目录。

OKX 和 OKX-本地回放会话沿用 Schema 2，分别保存 `marketSource: "okx"` 和 `marketSource: "okx-local"`，以及步进游标、排他边界和会话与模拟状态中的 `tradingConfig.okx`、`config.okx` 合约规格。已结算资金费保存在账户流水，`fundingCheckedThrough` 保存逐仓处理边界。会话按来源隔离。会话／完整 JSON 与 GitHub“会话与交易”原样保存业务记录。两份规格和费率必须一致，非法规格在写入前拒绝。OKX 行情缓存、标记价格、资金费率原始响应和本地归档文件属于行情运行数据。

Databento-CME 会话保存 `marketSource: "databento-cme"`、CME 产品、步进游标、排他边界和模拟状态，支持本地 IndexedDB、会话 JSON、完整 JSON 和 GitHub“会话与交易”。新会话在 `tradingConfig.cmeFeePerContractSide` 和 `config.cmeFeePerContractSide` 保存同一个 USD 每张单边手续费。未内置费率的品种在创建时可输入券商费率，输入仅用于该会话。字符串 `"0"` 表示零费率，`null` 表示仅回放行情，缺少字段的旧会话使用原有规则。非法金额或两处快照不一致会在写入前拒绝。刷新或更换设备后，先加载会话用到的日档，再从回放设置恢复会话。日档选择和行情缓存属于当前页面的运行状态。

四种行情来源的会话可保存 `playbackMode`（`kline` 或 `tick`）和 `tickSpeed`（`0.1–1000` 的数字）。两者随会话进入 IndexedDB、会话／完整 JSON 和 GitHub“会话与交易”，恢复时暂停并保留原游标。旧会话缺少模式时，逐笔游标或 cTrader 旧应用设置中的 `tick` 对应逐笔模式，其余使用 K 线模式。缺少逐笔倍率时使用 `1×`，显式非法值在写入前拒绝。创建前的模式选择只在当前页面有效。K 线步进周期沿用应用配置字段 `replayStepPeriod`，旧 `tick` 值仍可导入导出，在 K 线模式中以 `1m` 运行。

## 当前配置清单

独立副图窗口的打开状态、位置、各窗口所选周期和未点击“设为默认大小”的缩放都是本次浏览的临时状态。新窗口读取已有指标、蜡烛图类型、K 线透明度、悬浮 K 线详情和固定周期作为初始显示，窗口内对这些配置的调整仅在该窗口内生效。

| 配置 | 本地键与读写入口 | `BackupPreferences` 字段 | 云端文件 |
| --- | --- | --- | --- |
| 行情 REST 地址 | `marketData.binanceBaseUrl`；`market-data/runtime.ts` | `binanceRestBaseUrl` | `config/preferences.json` |
| 指标选择、参数、样式、副图布局（含 RSI 水平线、全部颜色透明度、KC、TTM Squeeze、TTM Wave A/B/C、Pivots 分组色与上期线、市场开收盘逐市场显隐与午间时间开关、足迹图的数值与图形内容、大单气泡的阈值、最大显示数量、形状、数字与动态样式、框选／可见范围／逐根 K 线成交分布的分档、关键价位、配色与 Delta 开关、VWAP 和 CVD） | `chart.indicators.v1`；`chart/indicator-preferences.ts` | `chartIndicators` | `config/preferences.json` |
| 收藏产品列表 | `marketData.favoriteSymbols`；`market-data/favorites.ts` | `favoriteSymbols` | `config/favorites.json` |
| 固定周期列表 | `chart.pinnedPeriods.v1`；`chart/period-preferences.ts` | `pinnedPeriods` | `config/preferences.json` |
| 蜡烛图类型（含 Heikin Ashi、收盘价折线和纽约现金时段 K 线） | `chart.candleType.v1`；`chart/candle-preferences.ts` | `candleType` | `config/preferences.json` |
| K 线透明度（所有蜡烛样式、OHLC、收盘价折线及面积图） | `chart.candleTransparency.v1`；`chart/candle-preferences.ts` | `candleTransparency` | `config/preferences.json` |
| 悬浮 K 线详情 | `chart.showCandleHoverDetails.v1`；`chart/candle-hover-preferences.ts` | `showCandleHoverDetails` | `config/preferences.json` |
| 当前产品及图表精度等元信息 | `marketData.selectedSymbol`；`market-data/symbol-preferences.ts` | `selectedSymbol` | `config/preferences.json` |
| 行情来源（cTrader、OKX、OKX-本地、Databento-CME） | `marketData.priceSource.v1`；`market-data/price-source-preferences.ts` | `priceSource` | `config/preferences.json` |
| OKX 和 OKX-本地共用的当前产品及图表精度 | `marketData.okxSelectedSymbol.v1`；`market-data/symbol-preferences.ts` | `okxSelectedSymbol` | `config/preferences.json` |
| Databento-CME 当前产品 | `marketData.databentoSelectedSymbol.v1`；`market-data/symbol-preferences.ts` | `databentoSelectedSymbol` | `config/preferences.json` |
| cTrader 账户环境和 ID | `marketData.ctraderAccount.v1`；`market-data/ctrader-account-preferences.ts` | `ctraderAccount` | `config/preferences.json` |
| K 线步进（含 1s、5s、15s，兼容旧 Tick 值） | `replay.stepPeriod.v1`；`replay/step-preferences.ts` | `replayStepPeriod` | `config/preferences.json` |
| 回放主图交易标记显隐 | `chart.showTradeOverlays.v1`；`chart/trade-overlay-preferences.ts` | `showTradeOverlays` | `config/preferences.json` |
| 独立副图窗口的默认大小 | `chart.windowSize.v1`；`chart/chart-window-preferences.ts` | `chartWindowSize` | `config/preferences.json` |
| 工作区账户／下单／持仓展开／收起、旧回放／状态显隐兼容字段、桌面／手机图表高度、旧持仓面板高度兼容字段 | `workspace.layout.v1`；`workspace/preferences.ts` | `workspace` | `config/preferences.json` |

上述入口均位于 `src/`。新增配置必须更新本表，不得在组件中另建脱离存档的持久化键。配置读写和校验应放在可独立调用的模块中，备份服务不能依赖 React 组件。

图表设置的“悬浮 K 线详情”默认开启，关闭后立即隐藏悬浮详情。主图的选择随本地、应用配置／完整 JSON 和 GitHub“应用配置”往返。恢复默认时重新开启。旧档缺字段时保留本机值，本机无设置时默认开启。字段接受布尔值，显式 `false` 原样恢复，空值与非法值在任何写入前拒绝。自动配置恢复随图表重建生效，手动恢复后按提示刷新。

图表设置的「K 线透明度」使用可选字段 `candleTransparency`，接受 0–100 的整数百分比。默认 0% 沿用原有配色，100% 隐藏价格图形。移动滑杆立即更新蜡烛图形、折线和面积填充，所有价格图形共用该设置。点击「恢复默认」重设为 0%。主图的选择随本地、应用配置／完整 JSON 和 GitHub「应用配置」往返，参与现有差异比较、校验和及冲突处理。继续使用 Schema 1。旧档缺字段时保留本机值，本机缺失或损坏时使用默认值。显式 `0` 原样恢复，空值、字符串、小数或越界值在任何写入前拒绝。自动配置恢复随图表重建生效，手动恢复后按提示刷新。

订单流的足迹图和大单气泡选择保存在 `chartIndicators.main`，CVD 选择保存在 `chartIndicators.sub`。足迹图与 CVD 使用显式空 `calcParams`。新增的足迹图、气泡样式、Profile 和 CVD 参数保存在可选的 `chartIndicators.orderFlow` 中。大单气泡启用时，模式、最低成交额和买卖颜色保存在既有主图指标字段。关闭时移入 `orderFlow.bubbles`，重新开启会应用已保存的值。因为显示半径、成交额上下限成对校验，自动同步以足迹图和大单气泡的各自设置组为单位检测并处理并发冲突。Profile 选区保存在既有绘图存档中，设置属于应用配置。

VWAP 和可见范围成交分布以 `VWAP` 和 `VISIBLE_VOLUME_PROFILE` 加入 `chartIndicators.main`，默认为关闭。二者保存选择和 `visible`，使用显式空 `calcParams` 和空样式。`visible: false` 原样保留。旧档缺少整个 `chartIndicators` 时保留本机指标设置，有指标清单时按清单恢复，其中没有这两项就不启用。空主图列表原样恢复，重复项、副图配置和非法值在任何写入前拒绝。应用配置／完整 JSON 和 GitHub「应用配置」沿用现有差异、校验和及冲突流程。自动恢复会重建图表，手动恢复后按提示刷新。计算结果和图表可见范围属于运行状态。

可见范围 Profile 的独立显示参数以 `chartIndicators.orderFlow.visibleProfile` 保存。位置接受 `left` 或 `right`，偏移 0–40% 和宽度 5–50% 为整数。内容接受 `volumeDelta`、`volume` 或 `delta`。默认靠右、偏移 0%、宽度 26%、双列且显示标题。`showPoc`、`showValueArea` 和 `showLabels` 默认开启。`valueAreaColor`、`pocColor` 和 `levelColor` 分别保存价值区成交量、POC 线和 VAH／VAL 线的颜色。旧档缺字段时保留本机值，本机无值时使用默认值。显式偏移 0、`false` 和透明色原样恢复，空值和非法值在任何写入前拒绝。关闭指标后仍保留设置。本地、配置／完整 JSON 和 GitHub「应用配置」沿用现有流程。框选 Profile 的独立显示设置位于 `chartIndicators.orderFlow.profile`。

K线成交量分布图以 `CANDLE_VOLUME_PROFILE` 保存在 `chartIndicators.main`，默认为关闭，仅允许在主图添加一次，使用空 `calcParams` 和 `styles: null`。独立显示设置保存在 `chartIndicators.orderFlow.candleProfile`，与框选分布共用内容、关键价位、各档数字和配色的校验。`width` 接受 5–100 的整数百分比，默认 95，按每根 K 线左侧的可用宽度计算。`columnWidth` 接受 48–240 的整数像素，默认 120。旧档有主图清单但没有该指标时按清单恢复。整个 `chartIndicators` 缺失时保留本地指标选择，缺少的设置字段保留本地值，本地无值时使用默认值。显式 `visible: false`、空指标列表和透明色原样恢复。每根 K 线的逐笔成交及分布计算结果属于运行状态。

三种 Profile 共用 `chartIndicators.orderFlow.profile.valueArea`，接受 1–100 的整数百分比，默认 70。任一设置窗口修改价值区比例都会保存到该字段，并随本机、应用配置／完整 JSON 和 GitHub「应用配置」比较、上传和恢复。未保存共享比例时依次采用旧版逐根、可见范围的 `valueArea`，最后使用默认值。旧字段仍按原范围严格校验并原样往返。`rows` 仅用于兼容 Schema 1 中的历史档数，接受 4–200 的整数并原样往返。

三种 Profile 的「档宽比例（%）」共用 `chartIndicators.orderFlow.profile.rowSizePercent`，默认 `0.01`（0.01%），接受 0.000001–100 范围内的有限数字。任一分布设置中保存后，框选、逐根和可见范围一同重算。该比例随本机、应用配置／完整 JSON 和 GitHub「应用配置」比较、上传、冲突处理与恢复。旧档缺字段时保留本机值，本机缺省采用 0.01%。空值、字符串、零和越界值在写入前拒绝。计算使用的最新价与实际档宽属于运行数据。自动恢复随图表重建生效，手动导入或拉取后按提示刷新。

逐根分布的配色缺省时沿用框选分布的同名颜色，两处均无值时采用默认色。已有的逐根分布自定义颜色和透明色会原样恢复，保存其他参数时未修改的继承色继续沿用框选配置。旧档缺少逐根分布的价格标签开关时先保留本机值，本机无值时默认隐藏标签。各档数字和价格标签可独立控制。价值区底色与 VAH、VAL 线由「显示 VAH / VAL」控制，两者随现有设置组参与本机、应用配置／完整 JSON 和 GitHub「应用配置」往返。

本机已省略逐根分布的自定义颜色而云端该项与上次同步一致时，自动合并会省略该颜色，继续应用框选分布的继承色。显式透明色原样保存，存档中提供的空值或非法颜色仍在写入前拒绝。

框选、可见范围和 K 线成交量分布分别以 `orderFlow.profile.showDelta`、`orderFlow.visibleProfile.showDelta` 和 `orderFlow.candleProfile.showDelta` 保存「显示 Delta」。默认开启，显式 `false` 原样恢复并使包含 Delta 的模式改为只画总成交量，已保存的显示模式可在重新开启后继续使用。缺少开关时保留本机值，`null`、数字、字符串及其他非法配置在任何写入前拒绝。指标选择和各项设置随本机、应用配置／完整 JSON 和 GitHub「应用配置」往返，参与现有差异比较、校验和与冲突处理。自动配置恢复会重建图表，手动导入或拉取后按提示刷新。

Schema 1 及云端文件路径保持原格式。旧档缺少订单流设置或个别设置字段时保留本机值，本机没有该字段时运行时使用默认值。显式空指标列表、布尔 `false`、数字 `0` 和透明色原样恢复。提供的非法类型、空值、数值范围或枚举值在写入数据前拒绝。自动同步恢复会重建界面，手动恢复后按提示刷新。当前图表缩放、逐笔数据和计算缓存属于运行状态。

足迹图的数值内容沿用 `chartIndicators.orderFlow.footprint.type`，图形内容使用可选的同组字段 `plotType`。图形可选 `bidAsk`、`volume`、`delta`、`volumeDelta` 或 `matchText`。旧档缺少 `plotType` 时保留本机值，本机无值时图形跟随数值，延续旧版显示组合。显式 `matchText` 恢复跟随模式，空字符串、`null` 和未知值在写入前拒绝。两项沿用足迹图设置组进行本地、应用配置／完整 JSON 和 GitHub 应用配置往返。

主图市场开收盘指标 `MARKET_SESSIONS` 的 `calcParams` 为显式空数组。旧存档中合法的两个提前分钟数按原范围校验后迁移为空数组；非法值在任何写入前拒绝。`visible: false` 原样恢复。选择、显隐和样式通过现有 `chartIndicators` 覆盖本地、应用配置／完整 JSON 及 GitHub“应用配置”，沿用现有差异、校验和、冲突与恢复流程。旧存档有指标列表时按列表恢复，缺少整个 `chartIndicators` 时保留本地配置。自动恢复随图表重建生效，手动恢复后按提示刷新。配置格式仍为 Schema 1，未来时段按交易日历动态计算。

该指标的 `styles.sessionVisibility` 按东京、伦敦、纽约顺序保存三个布尔值，默认全部显示。显式 `false` 隐藏该市场的底色、开收盘线及休市标签，三个开关都关闭时取消该指标的未来时段扩展。三个 `false` 会原样恢复。提供该字段时必须恰好包含三个布尔值，空数组、`null` 和非法值在任何写入前拒绝。

`styles.showMidday` 保存“显示午间时间”，默认关闭。旧存档缺少该字段时保留本机选择，本机缺省时关闭。显式 `false` 原样恢复，`null`、数字、字符串及其他非布尔值在任何写入前拒绝。它随 `chartIndicators.main` 在本机、应用配置／完整 JSON 和 GitHub“应用配置”中往返，参与现有差异比较、校验和及冲突处理。自动恢复时界面重建后生效，手动恢复后按提示刷新。

`styles.sessionFills` 按东京、伦敦、纽约顺序保存三个颜色对象，默认底色约 22% 不透明。`styles.sessionLines` 保存一组正式开收盘线型及线宽，默认 1 像素实线。旧的两组配置通过原校验后保留第二组正式线。线型为 `solid`、`dashed` 或 `dotted`，线宽为 0–4 的整数。完全透明的颜色及 0 线宽原样往返。旧存档的 `styles: null`、`{}` 或缺少某个样式组时，缺失组保留本机设置，本机无值时使用默认值。提供样式组时，空数组、`null` 组和非法值在任何写入前拒绝。

主图大单气泡 `BIG_TRADES` 的选择、可见性和最低成交额沿用既有 `chartIndicators`，默认 25,000 USDT，非负有限数，显式 0 表示无成交额下限，`visible: false` 原样恢复。旧版独立工作区保存的同名指标由主图直接恢复。旧档带指标列表时按列表恢复，缺少整个指标配置时保留本地值。非法参数在写入前拒绝。应用配置、完整 JSON、GitHub 应用配置全部支持往返。自动恢复会重建图表，手动恢复仍按界面提示刷新。品种映射属于程序随附的行情目录，无额外用户配置字段。

大单气泡的 `styles.bubbleColors` 按主动买入填充、主动卖出填充、主动买入描边和主动卖出描边的顺序保存四个颜色对象。每项使用标准图表颜色格式，透明度 0% 和 100% 原样往返。含气泡指标但缺少该样式组的旧存档会保留本地样式，本地无设置时使用默认绿红配色和透明度。提供该组时，空数组、`null` 和非法颜色在写入前拒绝。应用配置、完整 JSON 和 GitHub 应用配置均覆盖该样式组。

大单气泡的 `styles.bubbleMode` 接受 `volume` 和 `aggregate`。两者随 `chartIndicators` 在本机、应用配置／完整 JSON 和 GitHub“应用配置”中往返，沿用现有差异、校验和与冲突处理。旧档缺少模式时保留本机选择，本机无值时使用 `volume`。显式 `volume` 可以覆盖 `aggregate`，空字符串、`null` 和其他非法值在写入前拒绝。自动恢复随图表重建生效，手动恢复后按界面提示刷新。配置仍使用 Schema 1。

大单气泡的阈值单位 `thresholdUnit` 和新增上下限 `minQuantity`／`maxQuantity`、`minContracts`／`maxContracts`、`minLots`／`maxLots` 保存在 `chartIndicators.orderFlow.bubbles`，关闭指标后仍保留。单位接受 `notional`、`quantity`、`contracts` 和 `lots`。旧档缺少这些字段时保留本机值，本机无值时使用 `notional` 和原 USDT 阈值。其他单位默认下限为 1，上限为 0。显式 0 原样恢复，代表不设对应限制。提供的数值须非负且有限，非零上限须大于或等于对应下限。空值、非法单位或非法上下限在任何写入前拒绝。本地、应用配置／完整 JSON、GitHub「应用配置」沿用同一校验。云端仍以整个大单气泡设置组为单位合并与处理冲突，自动恢复重建图表，手动恢复按提示刷新。合约面值和每手规格由行情规格提供，属于运行时数据。

大单气泡的动态大小 `sizeByVolume`、动态透明度 `opacityByVolume` 和固定半径 `fixedRadius` 随 `chartIndicators.orderFlow.bubbles` 在本地、配置／完整 JSON 和 GitHub「应用配置」中往返。旧档缺字段时保留本机值，本机无值时默认动态大小开启、动态透明度关闭、固定半径 8 像素。开关接受布尔值，显式 `false` 原样恢复，固定半径接受 1–40 的整数。空值和非法值在任何写入前拒绝。形状 `marker` 和数字显隐 `showText` 继续使用已有字段，旧档的菱形仍可恢复。自动恢复后图表重建，手动恢复后按提示刷新。订单流设置分组的展开状态只在本次打开弹窗时生效。

大单气泡的最大显示数量保存为 `chartIndicators.orderFlow.bubbles.maxBubbles`，接受 1–1000 的整数，默认 1000。旧档缺此字段时保留本机值，本机无设置时使用默认值。显式空值、0、小数和越界值在写入前拒绝。该字段随应用配置／完整 JSON 和 GitHub「应用配置」往返，沿用大单气泡设置组的合并与冲突处理。设置保存后图表即时应用，自动恢复随图表重建生效，手动恢复后按提示刷新。

框选成交分布是绘图业务数据，选区使用两个时间锚点，随品种或回放会话保存，继承本地绘图、完整 JSON 和 GitHub 绘图同步。原有绘图格式保留锚点中的价格字段，旧选区按原起止时间恢复，纵向范围由当时可用的成交价格重建。成交量和 Delta 横条使用半透明配色，透明度由绘制规则决定。

盈亏比是绘图业务数据，使用做多或做空类型及入场、止损、止盈三个锚点。绘图沿用 Schema 1，随本地绘图、「全部数据」JSON 和 GitHub 绘图存档往返，既有绘图可继续恢复。导入前校验锚点数量、时间、价格和方向对应的价格顺序。盈亏比绘制过程中的方向选择是临时状态。

副图窗口默认大小保存为 `chartWindowSize: { width, height }`，宽和高都是正的安全整数，单位为浏览器内容区 CSS 像素。点击“设为默认大小”会捕获两项并作为一个设置同步。新开副图读取最新值，因此保存或恢复后下一次打开就生效。应用配置、全部数据 JSON 和 GitHub“应用配置”均可导出和恢复。旧存档缺字段时保留本地值，本地缺失或损坏则使用 1100 × 760。导入时出现 `null`、空对象、缺少任一尺寸、零、负值或小数会在任何写入前拒绝。存档保持 Schema 1。

会话的交易参数、进度、持仓和交易记录由现有 IndexedDB 会话及模拟状态存储负责，走会话／全部数据存档和云端“会话与交易”类别，不能为了保存配置而破坏会话隔离。

新建回放把 IC Markets 交易规格分别保存到会话的 `tradingConfig.ctrader` 和模拟状态的 `config.ctrader`。本地会话、会话／全部数据 JSON 和 GitHub「会话与交易」保存交易规格、隔夜流水和持仓结算游标。旧存档缺少规格字段时按原模型和倍率恢复。显式空值、无效规格或两份规格不一致时在写入前拒绝。规格快照只保留模拟所需的交易参数，归入会话业务数据。

“回放设置”中的模拟杠杆与滑点属于会话交易参数。`tradingConfig.leverage` 和 `tradingConfig.slippageRate` 是创建时的值，模拟状态的 `config.leverage` 和 `config.slippageRate` 是当前值。新会话以创建时的当前行情时间为结束边界，旧会话继续使用存档中的 `endTime`，回放栏速度保存在 `speed`。这些参数随本地会话、会话／全部数据 JSON 和 GitHub「会话与交易」往返。旧会话沿用原存档值，无模拟状态的会话使用创建时的交易参数。模拟状态提供时，缺失、空值、越界或非法的杠杆和滑点在写入前拒绝，滑点 `0` 原样恢复。步进周期与交易标记由回放栏控制，继续按下述应用配置规则存档。手动恢复后按界面提示刷新生效。

“设置余额”更新会话模拟状态的 `account.walletBalance`，差额通过 `ledger` 中的 `balance_adjustment` 保存。余额与流水随 IndexedDB、会话／全部数据 JSON 和 GitHub「会话与交易」恢复。旧存档没有此类流水时按原余额和统计恢复。目标余额 `0` 原样保存；缺失或无效的金额、零差额、负的调整后余额及带成交引用的余额调整在导入写入前拒绝。手动恢复后按提示刷新，重置回放会回到初始余额并清除调整流水。

回放中的步进周期独立于图表周期，默认 `1m`，`1M` 表示一月。实时行情下的步进和播放始终使用图表当前周期，视口位置、播放状态和浏览速度只保留在当前页面。`replayStepPeriod` 支持 `tick`、`1s`、`5s`、`15s`，随应用配置／全部数据 JSON 和 GitHub“应用配置”往返，沿用现有差异比较、校验和及冲突处理。旧存档缺少字段时保留目标浏览器的值，本地无值或损坏时用默认值。显式空串、`null` 和其他非法值在任何导入写入前拒绝。云端自动恢复会更新回放栏的选择，手动恢复后按界面提示刷新。

回放栏的 `showTradeOverlays` 默认 `true`，显式 `false` 隐藏主图的成交标记及仓位交易线。仅接受布尔值，非法值在导入写入前拒绝。该字段随应用配置／全部数据 JSON 和 GitHub“应用配置”往返。旧存档缺少字段时保留本地选择，本地缺失或损坏时默认显示。恢复会更新主图开关和标记显隐，手动恢复其他会话数据时按界面提示刷新。各独立副图的显隐是窗口内的临时状态，刷新或重新打开时默认显示。

会话 Schema 2 的可选 `visibleUntil` 保存分钟切片后的已揭示时间边界，随本地会话、会话／全部数据 JSON 和 GitHub“会话与交易”恢复。旧会话缺少该字段时沿用当前原始 K 线的收盘边界。导入时在写入前拒绝非分钟边界或越过有效会话进度的值。任一图表拖动确认止盈止损后，触发价和生效时间保存到同一会话的对应仓位。止盈止损输入方式属于弹窗临时状态，按百分比提交后同样保存触发价和生效时间。手动恢复后按提示刷新。

历史模拟双向持仓使用模拟状态 Schema 2 的 `positions` 列表，同方向最多一个仓位；止盈止损价格及各自的生效时间保存在对应仓位中。它们属于会话业务数据，不新增 `BackupPreferences` 或 localStorage 配置键。JSON 会话／全部数据与 GitHub“会话与交易”均包含完整双仓；旧 Schema 1 的 `position` 迁移为对应方向的一项，`position: null` 迁移为空列表，Schema 2 的显式 `positions: []` 保持空仓。缺失或非法列表、重复方向和不匹配的止盈止损生效时间均在导入写入前拒绝。刷新恢复会话直接生效；手动导入／云端恢复后需按提示刷新，避免活动界面的旧状态继续操作。详见 [模拟双向持仓](simulation-positions.md)。

Token 等凭据不得进入用户配置存档。手动 Token 只保留在页面内存。默认连接凭据由本地和线上页面从 Pages 发布的 `cloud-connection.json` 读取，仅在当前页面内存使用，无需增加 `BackupPreferences` 字段。行情缓存、待上传设备队列、请求额度、冷却状态和跨页面锁也不是可迁移用户偏好，不应混入配置文件。工作区账户、下单、持仓三个显示开关属于持久化配置；旧回放／状态显隐字段仅用于存档兼容，新版这两块始终显示；手机抽屉当前打开状态、临时展开／收起和弹窗打开等状态仍不属于存档，之后若改为可记住的用户设置，必须同时接通存档。

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

自动云端恢复在启动界面之前完成；启动网络失败后稍晚恢复，以及自动合并后的远端更改，会通知界面更新工作区布局、产品和行情地址，重建图表并刷新配置面板，释放旧图表的订阅与监听，避免旧状态反向写回。不会导入会话、交易或行情数据。手动 JSON 导入／手动云端拉取仍按界面提示刷新以应用全部配置和活动会话；待上传标记在写配置之前记录，刷新后自动比较和上传。

配置更新时，图表重建以应用指标、当前品种、收藏和固定周期等设置。数据管理面板保留正在执行的备份／同步操作、勾选项和完成提示，避免手动恢复期间的自动同步把操作状态重置。此类操作状态仅存在于页面内存，不新增配置字段或存档键；原有 Schema 1、缺失字段保留及显式空值语义不变。

RSI 的周期列表继续使用原来的 `calcParams`（最多五条周期），新水平值保存在 `styles.rsiLevels: { oversold, overbought }`，默认 30／70，必须是有限数字且满足 `0 ≤ oversold < 50 < overbought ≤ 100`。中线固定 50。三条线的颜色位于 `styles.rsiLines[0..2].color`，顺序为超卖、中线、超买，默认绿／灰／红；线宽 0 与 alpha 0 均保留。旧存档缺少上述新样式时保留目标浏览器对应 RSI 的现有设置，目标无设置时使用绘制默认值，不更改旧周期含义。显式非法对象、阈值、颜色或线宽在任何配置／业务写入前拒绝。

所有现有颜色选择器增加透明度百分比，0% 不透明、100% 完全透明，采用六位或带 alpha 的八位十六进制保存。统一校验亦接受旧三／四位十六进制、合法 rgb／rgba 和 transparent，Pivots 的参数颜色及 TTM Wave 的方向颜色复用相同入口；旧不透明颜色不变，带 alpha 的自定义色不进行旧默认色迁移。选择、参数、水平值、透明度与副图高度均随 `chartIndicators` 进入配置／完整 JSON 与 GitHub 往返，不提升 Schema 1。

设备的 `github.configPending.v1` 记录待上传状态，`github.configBaseline.v1` 保存最后确认的配置基线，用于判断跨设备冲突。它们是同步运行状态，不属于 `BackupPreferences`，不导出或上传；Token、请求保护额度、冷却及跨页面锁仍不进入配置。自动配置提交只更新本项目的配置文件及项目清单，保留清单中其他类别和远端其他项目文件。没有配置更改时不创建提交。

同步基线分别保存已确认的本地快照和远端快照，上传期间再次发生本地修改时，只确认上传开始时的本地值，下一轮继续合并，避免把尚未应用到界面的远端字段误判为用户回改。基线只在完整配置写入后更新，其他标签收到该存储事件后重载配置界面，避免旧标签反写。活动回放期间，云端的当前产品偏好先保存，图表继续显示会话产品，结束会话后再应用该偏好；保留会话产品不会重新上传并覆盖云端产品。

工作区配置使用独立的 `workspace` 对象，内部 `schemaVersion: 1`，不提升 JSON 或云端配置的顶层版本。`panels` 必须完整包含 `account`、`order`、`dock`、`replay`、`status` 五个布尔值，默认均为true，其中后两项仅用于旧存档兼容，界面始终显示回放和状态；`chartHeight` 和 `mobileChartHeight` 分别保存桌面与手机图表高度，`null` 表示自动适配，手动高度只接受 280–1600 的整数；`dockHeight` 是旧版持仓高度兼容字段，继续校验并原样存档，默认 220，只接受 160–480 的整数。当前持仓区使用固定的自适应尺寸，仅在回放会话内根据 `panels.dock` 显示。各屏幕的自动显示计算不应反写另一屏幕的尺寸。工作区设置经统一入口保存后刷新可恢复；使用“应用配置”或“全部数据”导出可携带到其他浏览器，GitHub 勾选“应用配置”时会参与比较、上传与拉取。手动恢复后同样按提示刷新，使布局与其他配置一起从存储加载，避免活动页面旧状态覆盖恢复值。

旧 JSON／云端存档缺少整个 `workspace` 时保留目标浏览器已有布局；目标没有本地布局时由读取入口使用上述默认值。提供 `workspace` 时必须包含全部对象字段，不接受部分补丁、`null` 对象、缺失面板、错误布尔类型或越界／小数高度；所有字段在任何业务数据或配置写入前完整校验。面板的显式 `false`、两个高度的显式 `null` 均原样恢复。账户、下单和持仓的 `false` 收起正文，界面原位保留展开条或下单窄轨；`true` 展开正文。旧replay/status值仅原样往返，不再参与显隐。该交互沿用现有字段和 schema，无需迁移旧存档；手机当前打开哪个抽屉仍为临时状态，同一底栏入口可反复展开／收起。本地损坏布局会整体回退默认值，保存及导入则严格拒绝无效值。Token、设备请求保护和行情缓存不进入该对象。

KC 与 TTM Squeeze 不增加顶层配置字段或版本。`KC.calcParams` 依次为 EMA 周期、ATR 倍数、ATR 周期（默认 `[20, 1.5, 20]`），`TTM_SQUEEZE.calcParams` 依次为共同周期、BB 标准差倍数、KC ATR 倍数（默认 `[20, 2, 1.5]`）。两者必须恰有三个有限正数，周期还须为整数；错误类型、缺少参数、0 或负倍数在本地保存及任何存档恢复写入前拒绝，不影响其他旧指标的参数兼容性。指标可见性 `false`、合法样式数值 `0` 和主／副图空列表仍原样保留。KC 的三轨颜色保存于 `styles.lines`；TTM 四色柱与两种状态点颜色保存于 `styles.bars`、`styles.circles`，选择、参数、颜色与副图高度一并参与 JSON 和 GitHub 配置往返。旧存档无这两个指标时不自动加入；缺少整个 `chartIndicators` 时保留目标浏览器原值，无本地配置时继续使用现有默认指标。

窄屏下的主图／副图最小显示高度属于自适应布局计算，不是新增用户配置。`ProChartAdapter.layoutSubPanes()` 根据可用空间临时压缩副图；手机自动适配时将副图合计限制为屏幕高度约22%。副图放不下时，手动增高图表可恢复副图期望高度并在图表内滚动。`getIndicatorPreferences()` 仍返回原始存档高度，避免切换设备后把手机显示尺寸写回桌面布局。只有用户主动拖动分隔线或调整副图滑杆时更新相关副图的存档高度，继续通过 `chartIndicators.sub[].height` 导出、上传和恢复，不另建存储键。

TTM Wave 使用三个独立名称 `TTM_WAVE_A`、`TTM_WAVE_B`、`TTM_WAVE_C`。各自 calcParams 是三个严格递增的正整数周期（快线、慢线一、慢线二）；默认分别为 `[8, 34, 55]`、`[8, 89, 144]`、`[8, 233, 377]`。周期数量、类型、取值或顺序非法均在存档写入前拒绝。两组波形零线上方／下方颜色分别存在 `styles.bars[].positiveColor`／`negativeColor`，接受统一校验支持的颜色与透明度；非法值在写入前拒绝。旧单色 `noChangeColor` 保留并作为缺少 positiveColor 时的上方回退色；缺少 negativeColor 时使用对应波形的默认红／橙红色，不擅自填字段覆盖旧存档。零轴样式存在 `styles.lines`，其余可见性、布局和兼容语义沿用 chartIndicators。配置／完整 JSON 和 GitHub 应用配置覆盖全部三个指标及四种颜色；缺字段保留、空列表清空、false 与样式 0 原样恢复，恢复后需刷新。不新增顶层字段、存储键或版本，不改动设备保护或凭据。

Wave 配色升级：A/B/C 共享绿／红的零轴方向含义，仅有轻微色调差异；两组波形使用深浅与宽窄区分。统一配置校验入口会在克隆后的样式中，将各版本已发布默认色（最初 ABC 固定配色及后续统一的 `#26a69a/#66bb6a`、`#ef5350/#ff8a65`）映射为各指标当前默认色；其他自定义色、false、样式 0 和缺失字段不变，不修改传入存档对象。迁移可重复执行，适用于本地读取、JSON 配置／完整存档和云端解析恢复，无需提高 schemaVersion；刷新后图表生效。宽窄比例为绘制规则，不是新增用户设置。

Pivots 配置保持 `PIVOTS` 名称，沿用 calcParams 前 30 项以兼容旧版开关与存档；旧版每线颜色保留在隐藏位置，绘图改用新增的 P/R/S 分组颜色（索引 30–32）。索引 33 是“当前周期显示上期线”布尔开关，34–36 是上期 P/R/S 颜色。旧 30 项存档经统一校验后迁移为 37 项：P/R1/S1 作为三组颜色来源，旧默认橙色分别使用当前 P 橙、R 红、S 绿，恢复时缺少的上期线开关及三种颜色保留目标浏览器已有值，无已有设置时才使用 false 与默认颜色；其余字段和各级开关原样保留，不修改输入对象。37 项的新开关、分组颜色、原有类型、周期、线宽及各级开关全部严格校验；不接受部分新增字段、null、数字代替布尔值或非法颜色。配置／完整 JSON 与 GitHub 应用配置包含完整 37 项；false 必须原样恢复，缺少 chartIndicators 时仍保留本地设置，恢复后刷新生效。不新增顶层字段或存储键。

## 验收与回归

蜡烛图类型使用可选字段 `candleType`，支持 `candle_solid`、`candle_stroke`、`candle_up_stroke`、`candle_down_stroke`、`ohlc`、`area`、`heikin_ashi`、收盘价折线 `line` 和纽约现金时段 `new_york_cash`，默认全实心。选择经统一入口保存。配置／全部 JSON 导出及 GitHub“应用配置”的比较、上传与拉取均包含该字段。继续使用顶层 Schema 1。旧本地／云端存档缺少字段时保留目标已有类型，无本地设置时使用默认值。显式普通类型会恢复普通图，`null`、空字符串、布尔值、数字、数组、对象及未知枚举均在任何数据写入前拒绝，本地损坏值则回退默认。自动配置恢复随图表重建生效，手动导入或拉取后按提示刷新，未操作的旧图表不会反写刚恢复的类型。

`new_york_cash` 只保存图表类型。盘内 K 线和相应的成交量指标随画面及回放游标重新计算。K 线的原时间位置保留，盘外位置留空，跨越时段边界的 K 线用盘内细周期行情重算。底层行情和模拟成交记录仍按原始数据存档。

Heikin Ashi 仅影响蜡烛、可见高低标记和价格轴范围，不改原始行情、提示框、指标、最新价及模拟成交价格。首根 HA 开盘为首根原始开收均值，其余使用上一根 HA 开收均值；仅从当前已加载且回放可见的历史向前递推。实时末根更新重新计算该根，新根延续前值；向左补历史及切换产品、周期或回放重置后重建缓存。新增历史会改变起算点，靠近历史左边界的 HA 值可能随之变化；不读取未来行情，不将合成行情写入业务存档。

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

顶部工具菜单的展开状态仅保留在当前页面内存，刷新默认折叠。紧凑价格轴、提示边距和字体以及副图显示预算由视口大小决定。工作区和指标设置继续按配置清单保存。

手机主图按自动／手动模式分配滚动手势、透明内置右侧价格轴及右对齐是设备自适应规则，不新增可迁移偏好。自动／手动价格模式仍为当前图表临时状态；纵向平移只在手动模式生效，不改变已存档指标、样式、参数和布局。原本地、JSON与GitHub配置格式及兼容语义不变。

回放控制和状态栏改为双端常驻后，workspace.panels.replay/status仅作为Schema 1兼容字段保留。统一入口仍严格校验并原样保存两项布尔值（包括false），配置／完整JSON与GitHub完整往返继续覆盖它们；UI不再依据其值隐藏这两块，也不再提供对应显隐入口。“显示全部面板”仅更改三个活动开关，保留兼容字段；“恢复默认布局”仍可显式恢复完整默认对象。整个workspace缺失、显式空值与非法值的既有语义不变。固定底栏的实际高度和软键盘避让属于运行时测量，不写入存档。

价格轴顶部的 A 开关与计价单位标签、主图与副图交界处的时间轴是双端统一布局，不新增用户配置或存档字段；既有本地、JSON 和 GitHub 配置的覆盖范围及兼容语义不变。
