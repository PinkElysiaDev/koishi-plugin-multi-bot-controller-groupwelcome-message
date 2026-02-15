# koishi-plugin-multi-bot-controller-groupwelcome-message

群组欢迎/退群消息插件 - 配合 [multi-bot-controller](https://github.com/koishijs/multi-bot-controller) 为多个 Bot 管理群组欢迎和退群消息。

## 功能特性

- 🤖 **多 Bot 支持**：配合 multi-bot-controller 为不同 Bot 配置独立的欢迎/退群消息
- ⏱️ **延迟合并发送**：短时间内的多条入群/退群事件可合并为一条消息，避免刷屏
- 💬 **丰富的消息变量**：支持用户昵称、头像、群信息、时间、一言等多种变量
- 📊 **Table 表格配置**：可视化配置界面，按群组管理消息

## 安装

\`\`\`bash
npm install koishi-plugin-multi-bot-controller-groupwelcome-message
\`\`\`

## 配置示例

在插件配置界面中：

1. 选择要使用的 Bot（从 multi-bot-controller 已配置的 Bot 中选择）
2. 为每个 Bot 配置入群欢迎消息和退群消息：

### 入群欢迎消息配置

| 群组/频道 ID | 入群欢迎消息 | 延迟发送时间（秒） |
|-------------|-------------|------------------|
| 123456789 | 欢迎 {user} 加入群组！当前人数 {group_count} | 5 |
| 987654321 | 欢迎 {user}、{avatar} | 0 |

### 退群提醒消息配置

| 群组/频道 ID | 退群提醒消息 | 延迟发送时间（秒） |
|-------------|-------------|------------------|
| 123456789 | {user} 离开了群组 | 3 |

## 消息变量

| 变量 | 说明 | 示例 |
|------|------|------|
| {user} | 用户昵称 | 张三 |
| {id} | 用户 ID | 123456789 |
| {at} | @该用户 | @123456789 |
| {avatar} | 用户头像 | ![avatar](url) |
| {group} | 群组名称 | 测试群 |
| {group_id} | 群组 ID | 123456789 |
| {group_count} | 群组人数 | 100 |
| {time} | 当前时间 | 2026/02/14 20:00:00 |
| {hitokoto} | 一言 | 这一生，我仅为我自己而活。 |

## 延迟合并发送

设置 `延迟发送时间` 大于 0 时，会启用延迟合并功能：

- **0 秒**：立即发送消息（默认）
- **大于 0**：等待指定秒数后，将该时间段内的多条入群/退群事件合并为一条消息发送

**合并时变量处理规则：**
- {user}、{id}：用顿号（、）分隔全部列出
- {at}：为每个用户生成 @ 元素
- {avatar}：每个用户头像换行显示
- {group_count}：取最新群人数
- {time}：取最后事件的时间
- {hitokoto}：只获取一次

**示例：** 设置延迟 5 秒，3 个用户在 5 秒内陆续加入群组，只会发送一条合并消息，包含 3 个用户的信息。

## 依赖项

- [koishi](https://github.com/koishijs/koishi) >= 4.18.7
- [koishi-plugin-multi-bot-controller](https://github.com/koishijs/multi-bot-controller) >= 1.0.6
- [koishi-plugin-markdown](https://github.com/koishijs/plugin-markdown) >= 1.1.1

## License

MIT
