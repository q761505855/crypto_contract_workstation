# Crypto Contract Replay Workstation

纯前端的币安 USDT 永续合约历史回放与实时行情工作站。

## 当前阶段

Phase 1 提供：

- Vite + React + TypeScript 静态应用；
- KLineChart Pro 图表；
- 交易对、周期、指标、画线、时区、截图和全屏能力；
- 历史模拟与实时只读的工作台布局；
- 确定性演示行情；
- GitHub Pages 部署。

Phase 1 不连接币安，也不执行模拟交易。相关能力将在后续阶段实现。

## 本地运行

```bash
npm ci
npm run dev
```

打开终端显示的本地地址。

## 验证

```bash
npm run check
npx playwright install chromium
npm run test:e2e
```

## 构建

```bash
npm run build
```

构建产物位于 `dist/`。

## GitHub Pages

`main` 分支通过 `.github/workflows/deploy-pages.yml` 构建并发布。仓库 Pages 路径固定为：

```text
/crypto_contract_workstation/
```

项目不需要后端，不接受币安 API Key，也不会发送真实订单。

## 文档

- [产品需求](./项目需求-v2.md)
- [批准的设计](./docs/superpowers/specs/2026-07-22-static-crypto-replay-workstation-design.md)
- [Phase 1 实施计划](./docs/superpowers/plans/2026-07-22-phase-1-static-chart-foundation.md)
