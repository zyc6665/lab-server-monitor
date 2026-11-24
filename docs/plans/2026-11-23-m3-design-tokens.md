# M3 设计令牌表（草案 v0.1）

负责：混元 ｜ 状态：草案，待 kimi/DS 过目后定稿
范围：`servermanage/web/static/`（style.css / settings-wizard.css / terminal.css），不改 DOM 与 JS。

## 现状

- `style.css` 147KB，存在 **两个 `:root`**（第 6 行旧版、1866 行 v0.7.0 重构版，后者覆盖前者）+ 一段 `html[data-theme="dark"]` 变量块（2290 行）。
- 约 368 处硬编码色值；另有约 200 条 `html[data-theme="dark"] ...` 逐选择器覆盖规则（v0.1.228 已开始收敛为语义 token，但未完成）。
- 主题切换机制：`html[data-theme="dark"]`，保留不变。

## 第一步：清理入口（不换色值，纯去重）

1. 删除第 6 行旧 `:root` 中已被 1866 行覆盖的重复项（保留 1866 版为唯一 light palette）。
2. dark 块与 light 块使用**同一组令牌名**，缺的一律补齐（见下表）。

## 令牌表（light / dark）

### 颜色
| 令牌 | Light | Dark | 说明 |
|---|---|---|---|
| `--bg` | `#f2f4f7` | `#0b111c` | 页面底色 |
| `--card-bg` | `#ffffff` | `#141d2c` | 卡片 |
| `--surface-nav` | `#ffffff` | `#111c2e` | 侧栏/导航 |
| `--surface-raised` | `#ffffff` | `#1b2739` | 浮层/弹窗 |
| `--surface-sunken` | `#f7f8fa` | `#101827` | 内嵌区域 |
| `--surface-deep` | `#ffffff` | `#141c2b` | 输入框/筛选条 |
| `--surface-hover` | `#f1f5f9` | `#16202f` | 悬停态 |
| **新增** `--surface-muted` | `#f5f7fb` | `#1b2029` | 展开行/骨架屏底色（v0.1 原为未定义变量裸奔 fallback） |
| **新增** `--panel-bg` / `--warn-bg` / `--code-bg` / `--accent-contrast` | 见 style.css `:root` | 见 dark 块 | 批次四补定义的未定义变量；`--surface` 与 `--input-bg` 经审计分别与 `--card-bg`、`--surface-deep` 重复，**改引用后删除，不新增**（GLM5.4 去重规则） |
| `--border` | `#e6e8ef` | `#24303f` | 常规描边 |
| `--border-soft` | `#e5e9f2` | `#26344c` | 发丝分隔 |
| `--border-strong` | `#d5dae4` | `#35445a` | 强调描边 |
| `--track` | `#e8ecf4` | `#2b3a52` | 进度条/滑轨 |
| `--text` | `#101828` | `#e6edf6` | 正文 |
| `--text-secondary` | **新增** `#475569` | `#b6c2d4` | 次级文字（现硬编码 #475569/#334155/#5b6472） |
| `--text-muted` | `#667085` | `#93a1b5` | 弱化文字 |
| `--text-faint` | **新增** `#94a3b8` | `#64748b` | 占位/禁用 |
| `--accent` | `#2c5cf6` | `#6f9dff` | 主色 |
| `--accent-hover` | `#1f47d6` | `#8fb3ff` | |
| `--accent-soft` | `#eef2ff` | `#1b2b45` | 主色底 |
| `--info` | `#2c5cf6` | `#60a5fa` | 与 accent 同源，保留兼容 |
| `--info-soft` | `#dbeafe` | `#1e3a5f` | |
| `--success` | **新增** `#16a34a` | `#4ade80` | 收敛 #15803d/#16a34a/#047857 |
| `--success-soft` | **新增** `#dcfce7` | `#153426` | |
| `--warn` | `#c2410c` | `#fb923c` | |
| `--warn-text` | `#b45309` | `#fbbf24` | 收敛 #d97706/#f59e0b/#92400e |
| `--warn-soft` | `#ffedd5` | `#3d2a1b` | |
| `--danger` | `#dc2626` | `#f87171` | 收敛硬编码 #dc2626（26 处）/#b91c1c |
| `--danger-soft` | `#fee2e2` | `#451a1a` | |

### 尺寸 / 圆角 / 阴影 / 字体
| 令牌 | 值 |
|---|---|
| `--radius` / `--radius-sm` / **新增** `--radius-pill: 999px` | 16px / 10px / 999px |
| `--shadow` / `--shadow-raised` | 沿用现值（light/dark 各自定义） |
| `--gutter` / `--row-gap` / `--sidebar-width` / `--titlebar-height` | 沿用现值 |
| `--font` / `--mono` | 沿用现值 |

## 最终令牌清单（自 style.css 实测，非累计推算）

定义总数 **45 个**：37 个 light/dark 成对 + 8 个主题中性（仅 light 定义）。

**Light/Dark 成对（37）**：`--bg` `--card-bg` `--panel-bg` `--surface-nav` `--surface-raised` `--surface-sunken` `--surface-deep` `--surface-hover` `--surface-muted` `--border` `--border-soft` `--border-strong` `--track` `--text` `--text-secondary` `--text-muted` `--text-faint` `--accent` `--accent-hover` `--accent-soft` `--accent-contrast` `--info` `--info-soft` `--success` `--success-soft` `--success-text` `--warn` `--warn-soft` `--warn-text` `--warn-bg` `--danger` `--danger-soft` `--danger-text` `--code-bg` `--shadow` `--shadow-raised` `--gutter`

**主题中性（8，仅 light 定义）**：`--radius` `--radius-sm` `--radius-pill` `--row-gap` `--sidebar-width` `--titlebar-height` `--font` `--mono`

## 硬编码 → 令牌映射（第二步批量替换用）

| 硬编码（出现次数） | 替换为 |
|---|---|
| `#dc2626`(26) `#b91c1c` | **按用途区分**：文字色→`var(--danger-text)`，背景/边框→`var(--danger)`（避免暗色下文字对比度掉） |
| `#e2e8f0`(23) | `var(--border-soft)` |
| `#fff`(22) `#ffffff`(10) | `var(--card-bg)` 或 `var(--surface-raised)`（按语境） |
| `#d97706`(13) `#f59e0b`(8) `#92400e`(5) | 文字色→`var(--warn-text)`，背景/边框→`var(--warn)` / `var(--warn-soft)` |
| `#2563eb`(11) | `var(--accent)` |
| `#64748b`(10) | `var(--text-muted)`（dark 语境下为 `--text-faint` 值，统一后按主题自动切换） |
| `#94a3b8`(9) | `var(--text-faint)` |
| `#7aa2ff`(8) | `var(--accent)` |
| `#5b6472`(8) `#475569`(4) `#334155`(4) | `var(--text-secondary)` |
| `#15803d`(8) `#16a34a`(6) `#047857`(5) | `var(--success)` |
| `#cbd5e1`(8) | `var(--text-muted)` |
| `#fca5a5`(6) | `var(--danger-text)` 或 `var(--danger)` |
| `#0f172a`(6) | `var(--text)` |
| `#f8fafc`(5) `#eef2f7`(5) | `var(--surface-hover)` / `var(--surface-sunken)` |
| `#1d4ed8`(4) | `var(--accent-hover)` |
| `rgba(217,119,6,…) rgba(44,92,246,…) rgba(251,191,36,…)` 等 | 对应 `--*-soft` 或新增 alpha 变体（必要时补 `--accent-a16` 等少量透明度令牌） |

> 完成映射后，`html[data-theme="dark"]` 的约 200 条逐选择器覆盖可分批删除。**删除门槛（定稿约束）**：
> 1. 该选择器用到的颜色已 100% 走令牌，才允许删；
> 2. 每批删完做一次「亮 → 暗 → 亮」切换目测；
> 3. `grep` 确认删除范围内不再有 `#`/`rgb(` 字面量；
> 4. 纯布局类覆盖（间距/尺寸）保留。
>
> **最终目标状态**：`html[data-theme="dark"]` 下只重定义令牌值，不再出现逐选择器覆盖——新增组件只引用令牌即可适配双主题。

- **批次五（收尾）**：删除 6 条纯重复 dark 规则（badge-online/offline/ok/missing/muted、rank-tab.active 旧规则）；settings-wizard.css 裸硬编码清零。dark 规则总行数 170 → **164**

## M3 验收残留清单（批次五后）

### dark 覆盖规则保留清单（style.css，164 行，无纯色值重复）
1. **令牌重定义块**：`html[data-theme="dark"] { … }`（目标状态本体，合规）
2. **设计意图保留**：v0.7.0 暗色精修块（topbar 半透明、sidebar 调色、滚动条、tab 激活色）、命令面板专属配色、my-badge-* 三色徽章暗色变体、heartbeat 状态点、user-host-card:hover 阴影加深、host-card-load/--surface-raised 语义增亮、user-row-missing 弱化红边框、disk-jump 专用透明色、alerts severity 行色、thermal/temp-chip、onboard/save-hint/collect-notice/skeleton 组件态
3. **多行动画/布局覆盖**：user-acct-scan.is-active、user-host-trend.is-pending、auth-main/auth-card

### 硬编码 hex 残留归属（非 dark 行）
- **白字**：`color: #fff`（主色按钮/激活 tab，主题中性）
- **fallback**：`var(--x, #hex)` 保护性 fallback（不生效）
- **设计意图**：`.logs-output` 终端控制台恒暗配色、heartbeat 绿点、命令面板蓝系、渐变装饰、rgba 透明度变体

### settings-wizard.css / terminal.css
- wizard：裸硬编码已清零
- terminal：`--terminal-bg` 令牌重定义（合规）+ fallback + vendor xterm（不动）

## 批次记录

- **批次一**：`:root` 去重 + 5 新令牌 + 声明级替换 96 处（style 84 / wizard 12）
- **批次二**：soft 底色/边框 + 裸 `background:#fff` 共 16 处 → `--danger-soft`/`--warn-soft`/`--danger`/`--card-bg`
- **批次三-1（alerts/筛选条域）**：删除 11 条 dark 覆盖规则（alert-search/severity-filter、alert-filter-count×2、alert-stat×2、is-expanded/detail-cell、alert-group-cell、alert-group-count、alert-more、alert-count-badge）；补定义 `--surface-muted`（light #f5f7fb / dark #1b2029）；light 侧 `.alert-filter.active .alert-filter-count` 的 `#e8efff` → `var(--accent-soft)`。- **批次三-2（hosts/users/disk 域）**：删除 17 条 dark 覆盖规则（user-host-card、my-host-card、disk-filter-toggle、disk-collapse:hover、disk-group-collapse:hover、disk-group-health is-warn/is-crit、host-alert-seg×4、disk-legend×2、disk-group-temp×2、user-acct-copy×2、host-card raised 保留）。dark 规则总行数 213 → 184。剩余需专项处理的：user-admin 块（`--input-bg`/`--accent-contrast` 未定义）、host-card-load 语义增亮、动画类多行规则
- **批次四（user-admin/auth 域 + 未定义变量清零）**：补定义 4 个新令牌 `--panel-bg`/`--accent-contrast`/`--warn-bg`/`--code-bg`（light+dark）；`--surface`/`--input-bg` 经查与 `--card-bg`/`--surface-deep` 重复，改引用后删除。删除 13 条 dark 覆盖规则（user-admin-dialog/hint/steps-code/fields-input×3、user-row-missing×2、user-acct、user-chip×2、auth-card input、user-confirm-dialog、confirm-dialog）；light 侧 `.user-row-missing td` `#fff5f5` → `var(--danger-soft)`。dark 规则总行数 184 → **170**。保留：`user-acct.user-row-missing` 暗色弱化红边框（设计意图）、disk-jump 警示条（专用透明色）

1. 清理重复 `:root`，补齐上表新增令牌（`--text-secondary` / `--text-faint` / `--success` / `--success-soft` / `--radius-pill`）
2. 按"高频→低频"替换 style.css 硬编码（danger/border-soft/白底三类占大头）
3. settings-wizard.css、terminal.css 同步收敛
4. 分批删除已完成收敛的 dark 覆盖规则，每批跑一次亮/暗主题目测回归
5. 定稿令牌表发群，kimi 按 class 引用，不再自造色值
