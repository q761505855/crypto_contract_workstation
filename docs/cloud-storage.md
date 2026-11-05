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
- 项目清单：`projects/crypto-contract-workstation/manifest.json`
- 新分钟行情的目标路径：`data/market-history/{symbol}/1m/{year}/{month}.json.gz`，相对项目根目录。

普通价格和标记价格需要明确区分；上传局部日期时应保留同月已有数据和其他月份。清单记录文件大小、SHA-256 等信息，恢复必须在写入前完成结构与校验和验证，并沿用现有冲突检测规则。

初始化创建目录占位文件和空清单，后续由应用上传实际配置和历史行情。`.gitkeep` 不属于业务数据，不登记到清单。

## 本地构建信息

按用户要求，仓库信息和写入凭据通过本地 `.env.local` 注入前端构建：

```dotenv
VITE_GITHUB_OWNER=q761505855
VITE_GITHUB_REPOSITORY=personal-cloud-storage
VITE_GITHUB_BRANCH=main
VITE_GITHUB_STORAGE_ROOT=projects/crypto-contract-workstation
VITE_GITHUB_TOKEN=<本机保存的写入凭据>
```

`.env.local` 已被 Git 忽略；凭据不提交到代码或存储仓库，不进入 JSON 备份、云端配置、项目注册表或日志。前端接入后，内置凭据会进入网页构建产物，这是用户明确选择的单人使用方式。

运行时已接入上述变量：默认公开读取，具有构建凭据时自动上传历史月份。关闭数据管理或刷新无需重新填表。手动配置比较、上传和拉取使用默认项目连接；其他仓库仍支持旧根目录格式。同一共享仓库即使修改分支或名称大小写，也始终保留当前项目命名空间。

当前代码仓库已配置 GitHub Actions Secret `CLOUD_STORAGE_TOKEN`，现有 Pages 工作流在最终生产构建时将其注入 `VITE_GITHUB_TOKEN`。浏览器测试先使用专用假凭据构建并拦截 GitHub 请求，再构建正式产物；不会将真实写入凭据用于测试请求。无需增加下载后台或另设数据生成工作流。

历史下载先完成本地校验和缓存，云端上传在后台进行。失败月份的引用保存在本设备 `marketData.pendingCloudUploads.v1` 队列，刷新后可在数据管理中重试；页脚持续显示待上传月份数，点击即可打开数据管理，成功上传后提示消失。队列不属于可迁移用户设置，不进入任何存档。自动上传使用固定提交快照和原子分支更新，保留其他月份及其他项目。恢复行情仅按所需月份读取，不会顺便恢复用户配置或会话。

GitHub API 请求跳过浏览器 HTTP 缓存，确保连续上传时读取最新分支及文件 SHA，避免 GitHub 的 60 秒缓存让后续月份基于旧提交而产生假冲突。真正的并发变更仍沿用冲突检测，不强制覆盖远端数据。

Git 月分片可能尚未覆盖整月或另一类价格；创建、恢复回放先复用月数据，再只补实际缺口。近 30 个 UTC 自然日内缺失的官方归档可用受限分钟 API 修补，随后合并上传同一月份，保留原数据。回放重置不清空短期月查询缓存；归档 404 结果去重 60 秒，网络错误不记为归档不存在。

这些值属于构建部署信息，不增加浏览器可修改的用户设置；不会在 `BackupPreferences` 中复制 Token。如果后续支持用户修改并记住仓库目标，必须遵守配置存档约定，完成配置的全部本地、JSON 与 GitHub 往返链路。
