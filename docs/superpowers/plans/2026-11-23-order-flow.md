# 订单流图表与设置

## 图表设计

足迹图从指标列表开启。开启后，加宽主图时间格并缩窄烛身，在烛身旁用真实逐笔成交绘制价位矩阵。原始 K 线、时间索引、回放游标、画线锚点和其他副图继续共用现有数据。若做成蜡烛图类型，可用单一开关切换整套显示，但会把足迹的显隐和蜡烛类型绑在一起。若插入额外数据点，会改变图表导航、指标计算和绘图坐标。主图指标可以和用户已有的蜡烛样式组合。

指标列表顶部增加订单流分组，包含足迹图、大单气泡、Profile 和累计成交量差 CVD。每行提供设置入口。Profile 仍从绘图工具框选区间，修改设置后对现有选区生效。CVD 使用独立副图，支持 UTC 日切或按已加载区段连续累计，缺口处断线。

足迹图支持 Bid / Ask、总量、增量、增量与总量，支持色块或横条、自动或手动价位合并、成交量或成交笔数、成交额筛选、成交量 POC 和对角失衡高亮。气泡沿用逐笔／聚合及买卖配色，增加最大金额、形状、尺寸、空心和数值标签。Profile 增加展示方式、分档、宽度、价值区、POC、价格线和配色。

## 实施与验收

1. 为订单流参数定义同一套默认值、校验规则和设置控件。设置随现有指标档案保存，用户在关闭指标时也能保留设置。Schema 1 旧档缺少的新设置沿用本机值，当前已有的大单门槛和配色仍兼容。
2. 让足迹和 CVD 复用现有逐笔切片、来源选择、缓存和回放边界。足迹按可见 K 线计算且缓存在对应的成交切片上，CVD 以已加载数据为基准，平移不会改变同一根 K 线的累积值。对缺失成交数据给出提示，回放不读取游标及之后的数据。
3. 让 Profile 设置影响绘制和重新分档，气泡的显示与悬停采用相同的筛选和尺寸。图表库改动限定于足迹宽度及指标列表接入。
4. 运行配置往返、非法输入、逐笔聚合和回放测试。用 Playwright 验证指标入口、设置保存与导入恢复，最后运行 `npm run check`。

参考 [Deep Print](https://www.deepcharts.com/helpcenter/article/deep-print)、[Big Trades](https://www.deepcharts.com/helpcenter/article/big-trades)、[Deep Profile](https://www.deepcharts.com/helpcenter/article/deep-profile) 和 [CVD](https://www.deepcharts.com/helpcenter/deepdom/article/cumulative-volume-delta)。
