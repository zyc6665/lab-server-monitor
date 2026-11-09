# 0.2.1 容量预测与飞书通知设计

**状态**：已确认范围，开始实施
**日期**：2026-11-09

## 目标

1. 在概览页增加“容量预测”卡片，用最近 30 天的每日汇总数据估算内存、磁盘、GPU 显存的增长趋势和达到告警阈值的剩余天数。
2. 增加飞书（Feishu/Lark）机器人 Webhook 通知类型；企业微信和钉钉已有实现保持不变。

## 非目标

- 不做自动扩容、自动清理或自动迁移。
- 不改变现有告警的触发条件、冷却和恢复逻辑。
- 不预测 CPU 使用率（日均值波动大，不适合作为容量指标）。

## 容量预测规则

- 数据源：`host_daily_summary`（优先）经 `storage.fetch_host_history(range_key="30d")` 读取，最多 30 个自然日。
- 指标：`memory`、`disk`、`gpu_memory`。
- 最少数据点：5 个非空日值；不足时状态为 `insufficient_data`。
- 拟合：对 `(day_index, value)` 做最小二乘线性回归，得到 `slope_per_day`。
- 当前值：最后一个非空日值。
- 阈值：全局 `AlertThresholds`，若主机 `HostAlertRules` 覆盖对应指标则用主机值。
- `days_to_threshold = (threshold - current) / slope_per_day`，仅当 `slope_per_day > 0` 时计算。
- 状态：
  - `critical`：当前值 >= 阈值，或预计 <= 7 天达到阈值；
  - `warning`：预计 <= 30 天达到阈值；
  - `stable`：无增长或预计 > 30 天；
  - `insufficient_data`：有效点少于 5 个。
- 返回每个主机每个指标的 `current`、`slope_per_day`、`days_to_threshold`、`status`、`threshold`，保留 2 位小数。
- 不做告警，只在概览卡片展示；后续版本再考虑“预测性告警”。

## API

新增 `GET /api/overview/capacity?days=30`：

```json
{
  "days": 30,
  "thresholds": {"memory": 90, "disk": 90, "gpu_memory": 90},
  "hosts": [
    {
      "host_name": "gpu-01",
      "host": "10.0.0.1",
      "metrics": [
        {"key": "disk", "label": "磁盘", "current": 82.5, "slope_per_day": 0.42,
         "days_to_threshold": 17.86, "status": "warning", "threshold": 90}
      ]
    }
  ]
}
```

`days` 只接受 `7`、`30`、`90`，默认 `30`；非法值返回 400。

## 概览卡片

- 位置：概览页“资源占用排行”之后、“整体趋势”之前。
- 标题：“容量预测”，副标题“最近 30 天趋势 · 按告警阈值估算”。
- 只展示 `critical` / `warning` 项，按 `days_to_threshold` 升序，最多 5 项；无风险时显示“未来 30 天内无明显容量风险”。
- 每行显示：主机名、指标、当前百分比、每日增长、预计达到阈值的天数；可点击进入主机详情。
- 视觉：critical 红色、warning 橙色；窄屏隐藏“每日增长”辅助列。
- 前端使用 DOM/textContent，不使用 innerHTML。

## 飞书 Webhook

- `notify_webhook.build_webhook_payload("feishu", event)` 返回：
  `{"msg_type": "text", "content": {"text": "[severity] title\n主机: ...\n...\n时间: ..."}}`。
- `settings.html` 的 Webhook 类型下拉增加“飞书”选项。
- `send_webhook` 对飞书响应体做基本错误识别：HTTP 2xx 且 JSON 含 `code`/`StatusCode` 非 0 时返回 False（企业微信/钉钉现有行为保持兼容）。
- Webhook URL 仍只从密钥存储读取，不进入日志或 API 响应。

## 兼容性

- 旧配置、旧数据库、已有 Webhook 配置不变。
- 所有新增字段有默认值；未配置飞书时不改变现有通知。

## 测试

- 纯函数：上升趋势、平稳、下降、数据不足、达到/超过阈值。
- API：`/api/overview/capacity` 正常返回、非法 `days` 返回 400。
- 页面/JS/CSS：新卡片、渲染函数、空状态、无 innerHTML。
- 飞书：payload 结构、`settings.html` 选项、错误码识别。
- 全量 Python、Node 测试通过。
