# 通用云端存储仓库

## 已创建的存储目标

- 公共仓库：https://github.com/q761505855/personal-cloud-storage
- 默认分支：`main`
- 当前项目 ID：`crypto-contract-workstation`
- 当前项目根目录：`projects/crypto-contract-workstation`

这是多个个人应用共用的存储仓库，不是本项目代码仓库的替代，也不只用于交易工作站。

## 通用目录约定

```text
storage.json
projects/
  <project-id>/
    README.md
    manifest.json
    config/
    data/
```

`storage.json` 使用 `personal-cloud-storage-registry` 类型、版本 `1`，登记项目 ID、名称、根目录、清单路径，以及相对根目录的配置和数据目录。项目 ID 使用稳定的小写文本，不随界面名称变化。

每个项目维护自己的数据格式和 manifest。清单内文件路径相对该项目根目录，不相对整个仓库。任何项目写入时只修改自身命名空间；增加注册项时保留其他项目的注册信息。不能以本项目的清单替换仓库顶层注册表，也不能删除其他项目的配置、历史数据或元信息。

## 当前项目的目录

- 用户配置：`projects/crypto-contract-workstation/config/`
- 历史行情：`projects/crypto-contract-workstation/data/market-history/`
- 图表绘图：`projects/crypto-contract-workstation/data/chart-drawings/archive.json`
- 项目清单：`projects/crypto-contract-workstation/manifest.json`
- 新分钟行情的目标路径：`data/market-history/{symbol}/1m/{year}/{month}.json.gz`，相对项目根目录。

## cTrader 实验版

`codex/ctrader-only` 的云端根目录固定为 `projects/crypto-contract-workstation/experiments/ctrader/`。手动与自动同步都使用该目录下的清单、应用配置、会话、交易和绘图。默认仓库和分支可以按构建设置选择，实验目录固定。配置与会话上传沿用校验和、原子提交及冲突处理，拉取在同一个提交下验证各文件后再恢复。生产目录、原有市场行情分片、顶层注册信息与其他项目各自保留。

实验版的 K 线由浏览器访问 cTrader，短期缓存留在内存。GitHub 同步跳过旧清单中的行情条目并保留相应文件。JSON 旧备份里的行情必须通过校验，随后跳过恢复。应用配置、会话、交易和绘图仍可使用 JSON 与云端存档，连接 cTrader 的配置和 GitHub 凭据留在应用存档之外。

## 主分支行情存档

历史行情统一使用普通成交价格；新月分片只包含 `tradeCandles` 和可选的 `symbolInfo`，不写 `markCandles`。上传局部日期时应保留同月已有普通价格和其他月份。清单记录文件大小、SHA-256 等信息，恢复必须在写入前完成结构与校验和验证，并沿用现有冲突检测规则。

旧分片或 JSON 备份中的 `markCandles` 仍严格校验，之后忽略，不导入本地；旧 IndexedDB 表保留兼容但不再读写或导出。自动上传触及含旧字段的月份时，即使普通价格未变化，也会原子重写该月分片及对应清单，清除旧字段。旧模拟持仓的 `markPrice` 仅在缺少 `lastPrice` 时作迁移回退，新账户快照和云端交易文件仅保存 `lastPrice`；活动会话按当前普通 K 线重估。配置字段、空值与缺失值语义保持原有规则。

初始化创建目录占位文件和空清单，后续由应用上传实际配置和历史行情。`.gitkeep` 不属于业务数据，不登记到清单。

绘图存档独立保存，包含格式版本、数据字节数和 SHA-256。拉取后先验证校验和及全部绘图对象，再应用到界面。写入使用固定提交快照及非强制分支更新，保留项目清单、应用配置和其他数据。绘图单独使用存档文件，旧版项目清单解析器可以继续读取行情和配置。正常启动、联网、窗口聚焦和页面可见时的定期检查都会拉取绘图。修改先保存到浏览器，连续操作合并后自动上传。同一绘图在不同设备被修改时保留本机版本并提示处理，不同绘图可以自动合并。

“一键清空绘图”和包含绘图的完整 JSON 恢复会建立新存档版本，已经使用过旧版本的设备不会把旧画线带回。统计中的云端大小是上次校验成功或提交成功的实际文件字节数。清空后仍会保留一个空存档文件来同步清空操作，Git 历史里的历史版本仍存在。绘图与默认仓库的其他数据一样可公开读取。

## 构建与发布配置

仓库信息已有默认值。本地开发可以用 `.env.local` 覆盖这些值：

```dotenv
VITE_GITHUB_OWNER=q761505855
VITE_GITHUB_REPOSITORY=personal-cloud-storage
VITE_GITHUB_BRANCH=main
VITE_GITHUB_STORAGE_ROOT=projects/crypto-contract-workstation
```

`.env.local` 已被 Git 忽略。凭据不提交到代码或存储仓库，不进入 JSON 备份、云端配置、项目注册表或日志。

本地开发和线上页面每次启动都从 `https://q761505855.github.io/crypto_contract_workstation/cloud-connection.json` 读取默认凭据，再创建云端客户端。连接文件使用 `{ schemaVersion: 1, project: "crypto-contract-workstation", token }`，随 Pages 公开发布。项目、版本和 Token 类型必须有效，读取禁用 HTTP 缓存，5 秒超时或旧部署缺少文件时回退公开读取，界面仍可启动。读取结果只在当前页面内存使用。重新部署后刷新本地或线上页面即可取得新 Token。

云端读取默认可使用公开访问，取得远端连接凭据后可自动上传历史月份及修改后的应用配置。关闭数据管理或刷新无需重新填表。配置修改合并约一秒后自动上传，失败保存设备待同步状态并自动退避重试；启动先检查云端，无待上传修改就恢复配置再初始化界面，有待上传修改则三方比较并合并无冲突字段，同字段冲突保留本地并提示处理。联网和重新聚焦时也会检查。配置同步只读取项目清单和两个配置文件，不读取行情或会话；完整校验后才应用，原子提交保留清单中其他类别、其他项目和顶层注册表。设备基线及待同步标记不进入任何存档。原有手动配置比较、上传和拉取使用默认项目连接；其他仓库仍支持旧根目录格式。同一共享仓库即使修改分支或名称大小写，也始终保留当前项目命名空间。

日常发布直接推送 `main`。Pages 工作流通过构建进程的 `CLOUD_STORAGE_TOKEN` 读取同名 Actions Secret，凭据只写入连接文件。首次设置或更换 Token 时更新该 Secret，再运行 Deploy GitHub Pages 工作流即可。GitHub 会自动撤销推送到公开仓库的有效个人访问 Token。可选命令 `npm run publish:pages` 等待对应提交部署完成并检查线上 Token 能否通过 GitHub 认证，整个过程只输出状态。浏览器测试用专用假凭据模拟连接文件及 GitHub 请求。

历史下载先完成本地校验和缓存，云端上传在后台进行。失败月份的引用保存在本设备 `marketData.pendingCloudUploads.v1` 队列，刷新后可在数据管理中重试；页脚持续显示待上传月份数，点击即可打开数据管理，成功上传后提示消失。队列不属于可迁移用户设置，不进入任何存档。自动上传使用固定提交快照和原子分支更新，保留其他月份及其他项目。恢复行情仅按所需月份读取，不会顺便恢复用户配置或会话。

GitHub API 请求跳过浏览器 HTTP 缓存，确保连续上传时读取最新分支及文件 SHA，避免 GitHub 的 60 秒缓存让后续月份基于旧提交而产生假冲突。真正的并发变更仍沿用冲突检测，不强制覆盖远端数据。

手动上传同样使用固定快照准备业务文件与清单，一次原子提交；中途失败不会留下分片和清单校验和脱节。冲突策略允许时，最多按最新快照重建一次，仅用真实本地行情覆盖对应远端行，保留本地未持有的远端修正。旧路径和新路径重叠时新路径优先，同名冲突副本不会覆盖。

2026-11-05 已对当前项目既有 32 个月分片完成普通价格迁移与逐月读回验证：[迁移提交 cf6339fa](https://github.com/q761505855/personal-cloud-storage/commit/cf6339fa9782f7a945696d7b528c8ee153b363a0)。1,365,921 根普通分钟线原样保留，878,400 根旧标记价格被移除，压缩文件大小、SHA-256 与普通行情内容均已核验，其他文件保持原样。

Git 月分片可能尚未覆盖整月；创建、恢复回放先复用普通价格月数据，再只补实际缺口。近 30 个 UTC 自然日内缺失的官方归档可用受限分钟 API 修补，随后合并上传同一月份，保留原数据。回放重置不清空短期月查询缓存；归档 404 结果去重 60 秒，网络错误不记为归档不存在。

这些值属于构建部署信息，不增加浏览器可修改的用户设置；不会在 `BackupPreferences` 中复制 Token。如果后续支持用户修改并记住仓库目标，必须遵守配置存档约定，完成配置的全部本地、JSON 与 GitHub 往返链路。

## OKX 逐笔成交缓存

下载界面使用 UTC 日期。点击下载后，已结束的日期优先复用 Git 中的 OKX 日档。缺档时，OKX 历史逐笔接口能覆盖的日期直接分页读取，结果保留在当前页面。较早的日期走 Git 日档。需要创建日档时，网页提交 `projects/crypto-contract-workstation/experiments/ctrader/data/okx-requests/<品种>/<UTC日期>.json`，并触发工作流。OKX 官方逐笔归档按 UTC+8 切日，后台验证覆盖对应 UTC 日的两份源日档，按 UTC 小时编排并校验 gzip 分片，发布到同一项目的 `data/okx-trades/<品种>/<UTC日期>/`。黄金更名日同时读取旧代码和新代码的文件。手动加载的日期优先读取已发布的 OKX 分片，也兼容浏览器里已有的 OKX 旧版缓存。

OKX 完整覆盖对应 UTC 日后，工作流在发布的同一 Git 提交中清理同品种同日的 Bybit 分片及清单。映射有歧义、OKX 上市首日、源日档缺失或校验失败时保留 Bybit 日档。清理只涉及缓存目录，Git 的旧提交可用于恢复。OKX 日档、Bybit 日档、近期回补及映射都属于行情数据，与用户配置及 JSON 存档独立。旧归档仍由顶部按钮按需申请。

## Bybit 逐笔成交缓存

Bybit 归档按 UTC 日获取。用户从图表顶部打开「下载成交数据」后，以最右侧可见 K 线的开盘时间所在 UTC 日为默认锚点，往前和往后天数默认各 1 天。下载包含锚点当天，范围截止到当前 UTC 日期。对使用 Bybit 来源且未缓存的已结束日期，网页通过现有云端连接在 `projects/crypto-contract-workstation/experiments/ctrader/data/bybit-requests/<品种>/<UTC日期>.json` 写入带 `requestedManually: true` 的请求。同品种同日共用一个请求。页面写入请求后直接触发 GitHub Actions，定时扫描和临时失败重试只处理明确手动申请的日期。旧自动请求保留在原处，点击同日时可转为手动请求。后台使用现有 `CLOUD_STORAGE_TOKEN` 下载并发布，归档就绪后主图刷新对应日期的成交量指标。图表浏览、框选和回放使用手动加载的日期及 WebSocket 实时成交。

归档只写入 `projects/crypto-contract-workstation/experiments/ctrader/data/bybit-trades/<品种>/<UTC日期>/`。原始数据按成交时间排序后转存为保留交易 ID、方向、时间、价格、数量的 gzip 分片。分片按小时读取，大文件进一步拆分，并由当天清单记录每个分片的笔数、大小和 SHA-256。完整归档与请求移除在同一 Git 提交发布，非强制推送。网页通过 GitHub Raw 读取，刚发布的归档以同一个提交读取清单和分片，避开分支地址暂时缓存的 404。日档和下载请求属于行情缓存运行数据，独立于配置、存档、会话和旧行情清单。无云端写权限时仍可读取已有公开缓存。
