// src/config.ts
import { Context, Schema } from 'koishi'

// Schema 动态 key - 与 satori-ai-charon 一致的命名格式
export const SCHEMA_KEY_BOT_ID = 'mbc-gwm.botId'

/**
 * 更新 botId 选择选项
 * 此函数由 index.ts 在运行时调用
 */
export function updateBotIdOptions(ctx: Context, botIds: string[]) {
  // 占位符始终放在最前面，作为默认选项
  const placeholder = Schema.const('').description('无')

  if (botIds.length === 0) {
    ctx.schema.set(SCHEMA_KEY_BOT_ID, Schema.union([
      placeholder,
    ]))
    return
  }

  const options = [
    placeholder,
    ...botIds.map(botId => Schema.const(botId).description(botId))
  ]

  ctx.schema.set(SCHEMA_KEY_BOT_ID, Schema.union(options))
}

/**
 * 创建欢迎消息 Schema (table 展示)
 * 支持延迟发送配置
 */
const createWelcomeMessagesSchema = () => {
  return Schema.array(
    Schema.object({
      guildId: Schema.string().description('群组/频道 ID'),
      message: Schema.string().role('textarea').description('入群欢迎消息'),
      delaySeconds: Schema.natural()
        .min(0)
        .max(300)
        .default(0)
        .description('延迟发送时间（秒），0 表示立即发送'),
    })
  ).default([]).role('table')
}

/**
 * 创建离开消息 Schema (table 展示)
 * 支持延迟发送配置
 */
const createLeaveMessagesSchema = () => {
  return Schema.array(
    Schema.object({
      guildId: Schema.string().description('群组/频道 ID'),
      message: Schema.string().role('textarea').description('退群提醒消息'),
      delaySeconds: Schema.natural()
        .min(0)
        .max(300)
        .default(0)
        .description('延迟发送时间（秒），0 表示立即发送'),
    })
  ).default([]).role('table')
}

/**
 * 创建单个 Bot 配置 Schema
 */
export const createBotConfigSchema = () => {
  return Schema.intersect([
    // Bot 选择
    Schema.object({
      botId: Schema.dynamic(SCHEMA_KEY_BOT_ID)
        .description('**Bot ID**<br>从 multi-bot-controller 已配置的 Bot 中选择')
        .required(),
      delayMode: Schema.union([
        Schema.const('sliding' as const).description('滑动窗口 - 每个新事件重置定时器，最大化合并效果'),
        Schema.const('fixed' as const).description('固定窗口 - 第一个事件触发后不再重置，延迟时间可预测'),
      ])
        .description('延迟模式')
        .default('sliding'),
    }),

    // 入群消息配置
    Schema.object({
      welcomeMessages: createWelcomeMessagesSchema(),
    }),

    // 退群消息配置
    Schema.object({
      leaveMessages: createLeaveMessagesSchema(),
    }),
  ])
}

/**
 * 创建插件配置 Schema
 */
export const createConfig = (ctx: Context) => {
  // 初始化默认 Schema
  updateBotIdOptions(ctx, [])

  return Schema.intersect([
    Schema.object({
      bots: Schema.array(createBotConfigSchema())
        .role('list')
        .default([])
        .description('**Bot 欢迎消息配置列表**\n\n添加 Bot 后，每个 Bot 将拥有独立的群组欢迎/退群消息配置'),
    }),

    Schema.object({
      debug: Schema.boolean()
        .description('是否输出调试日志')
        .default(false),
      verboseLogging: Schema.boolean()
        .description('显示详细日志（关闭后只输出关键信息）')
        .default(false),
    }).description('日志设置'),
  ])
}

/**
 * 静态导出（用于配置界面）
 */
export const ConfigSchema = Schema.intersect([
  Schema.object({
    bots: Schema.array(createBotConfigSchema())
      .role('list')
      .default([])
      .description('**Bot 欢迎消息配置列表**\n\n添加 Bot 后，每个 Bot 将拥有独立的群组欢迎/退群消息配置'),
  }),
  Schema.object({
    debug: Schema.boolean()
      .description('是否输出调试日志')
      .default(false),
    verboseLogging: Schema.boolean()
      .description('显示详细日志（关闭后只输出关键信息）')
      .default(false),
  }).description('日志设置'),
])

export const name = 'multi-bot-controller-groupwelcome-message'
