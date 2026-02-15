// src/types.ts

/** 延迟模式 */
export type DelayMode = 'sliding' | 'fixed'

/** 欢迎消息配置 */
export interface WelcomeMessageConfig {
  guildId: string        // 群组/频道 ID
  message: string        // 欢迎消息
  delaySeconds: number   // 延迟发送时间（秒），0 表示立即发送
}

/** 离开消息配置 */
export interface LeaveMessageConfig {
  guildId: string        // 群组/频道 ID
  message: string        // 离开消息
  delaySeconds: number   // 延迟发送时间（秒），0 表示立即发送
}

/** 单个 Bot 的配置 */
export interface BotConfig {
  botId: string                          // Bot ID (platform:selfId)
  delayMode: DelayMode                   // 延迟模式：sliding（滑动窗口）或 fixed（固定窗口）
  welcomeMessages: WelcomeMessageConfig[]   // 欢迎消息列表 (table 展示)
  leaveMessages: LeaveMessageConfig[]      // 离开消息列表 (table 展示)
}

/** 插件配置 */
export interface Config {
  bots: BotConfig[]
  debug: boolean                          // 是否输出调试日志
  verboseLogging: boolean                  // 显示详细日志
}

/** 单条入群事件数据（用于延迟发送） */
export interface WelcomeEventData {
  userId: string
  userName: string
  timestamp: number
}

/** 单条退群事件数据（用于延迟发送） */
export interface LeaveEventData {
  userId: string
  userName: string
  timestamp: number
}
