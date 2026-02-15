// src/index.ts
import { Context } from 'koishi'
import { createConfig, updateBotIdOptions, SCHEMA_KEY_BOT_ID } from './config'
import type { Config, BotConfig, WelcomeEventData, LeaveEventData } from './types'
import { formatMessage, formatBatchMessage } from './messages'

export { name, ConfigSchema as Config } from './config'
export * from './types'

// 声明服务依赖
export const inject = {
  required: ['multi-bot-controller'],
}

export const usage = `
## 群组欢迎/退群消息插件

配合 multi-bot-controller 为多个 Bot 管理群组欢迎和退群消息。

### 配置方法

1. 在插件配置中选择要使用的 Bot
2. 选择**延迟模式**：
   - **滑动窗口**：每个新事件重置定时器，最大化合并效果（默认）
   - **固定窗口**：第一个事件触发后不再重置，延迟时间可预测
3. 为每个 Bot 配置入群欢迎消息和退群消息：
   - **群组/频道 ID**：目标群组 ID
   - **入群欢迎消息**：支持变量 {user} {id} {at} {avatar} {group} {group_id} {group_count} {time} {hitokoto}
   - **延迟发送时间**：0 表示立即发送，大于 0 表示等待该秒数后合并多条消息一起发送
   - **退群提醒消息**：同上

### 消息变量

- {user} - 用户昵称
- {id} - 用户 ID
- {at} - @该用户
- {avatar} - 用户头像
- {group} - 群组名称
- {group_id} - 群组 ID
- {group_count} - 群组人数
- {time} - 当前时间
- {hitokoto} - 一言

### 延迟合并发送

设置延迟时间后，短时间内的多条入群/退群事件会合并为一条消息发送：
- 用户名、ID、@、头像会全部列出
- 群人数取最新值
- 时间取最后事件的时间

**延迟模式对比（延迟 5 秒）：**
- 滑动窗口：0s、2s、4s 各有一人加入 → 9s 发送合并消息（每次重置定时器）
- 固定窗口：0s、2s、4s 各有一人加入 → 5s 发送合并消息（第一次触发后不重置）
`

// 声明 Koishi 类型扩展
declare module 'koishi' {
  interface Events {
    /** bot 配置更新事件 */
    'multi-bot-controller/bots-updated'(bots: { platform: string; selfId: string; enabled: boolean }[]): void
  }
}

// 延迟发送管理器 - 按群组 ID 管理待发送的事件
interface DelayManager {
  // key: guildId, value: { events: WelcomeEventData[]; timer: NodeJS.Timeout; groupConfig: WelcomeMessageConfig; botId: string }
  welcome: Map<string, {
    events: WelcomeEventData[]
    timer: NodeJS.Timeout
    groupConfig: any
    botId: string
    session: any
  }>
  // key: guildId, value: { events: LeaveEventData[]; timer: NodeJS.Timeout; groupConfig: LeaveMessageConfig; botId: string }
  leave: Map<string, {
    events: LeaveEventData[]
    timer: NodeJS.Timeout
    groupConfig: any
    botId: string
    session: any
  }>
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('mbc-gwm')

  // 创建延迟管理器
  const delayManager: DelayManager = {
    welcome: new Map(),
    leave: new Map(),
  }

  // 日志辅助函数
  const debugLog = (...args: unknown[]) => {
    if (config.debug) {
      logger.debug(args.join(' '))
    }
  }

  const verboseLog = (...args: unknown[]) => {
    if (config.verboseLogging) {
      logger.info(args.join(' '))
    }
  }

  logger.info(`Plugin loaded, ${(config.bots || []).length} bots configured`)
  debugLog('Debug logging enabled')
  verboseLog('Verbose logging enabled')

  // 输出当前配置状态（在插件加载时）
  verboseLog('=== Current Bot Configurations ===')
  for (const bot of config.bots) {
    const welcomeGuilds = bot.welcomeMessages.map(m => m.guildId).join(', ')
    const leaveGuilds = bot.leaveMessages.map(m => m.guildId).join(', ')
    verboseLog(`Bot: ${bot.botId}`)
    verboseLog(`  Welcome guilds: [${welcomeGuilds || 'none'}]`)
    verboseLog(`  Leave guilds: [${leaveGuilds || 'none'}]`)
  }
  verboseLog('====================================')

  const getBotId = (platform: string, selfId: string): string => {
    return `${platform}:${selfId}`
  }

  const getBotConfig = (botId: string): BotConfig | undefined => {
    return config.bots.find(bot => bot.botId === botId)
  }

  /**
   * 检查 bot 配置是否有效（有任何消息配置）
   */
  const isBotConfigValid = (botConfig: BotConfig): boolean => {
    const hasWelcome = botConfig.welcomeMessages && botConfig.welcomeMessages.length > 0
    const hasLeave = botConfig.leaveMessages && botConfig.leaveMessages.length > 0
    return hasWelcome || hasLeave
  }

  /**
   * 获取用户名
   */
  const getUserName = async (session: any): Promise<string> => {
    const userId = session.userId
    // 尝试从多个来源获取用户名
    const name = session.username ||
                 session.author?.nick ||
                 session.author?.name ||
                 session.event?.member?.nick ||
                 session.event?.member?.name ||
                 session.event?.user?.nick ||
                 session.event?.user?.name ||
                 userId

    // 如果只获取到 userId，尝试获取群成员详情
    if (name === userId) {
      try {
        const member = await session.bot.getGuildMember(session.guildId, userId)
        return member?.nick || member?.name || userId
      } catch {
        return userId
      }
    }
    return name
  }

  const sendMessage = async (session: any, message: any) => {
    if (session.channelId) {
      await session.send(message)
    } else {
      await session.bot.sendMessage(session.guildId, message)
    }
  }

  /**
   * 处理延迟的欢迎消息发送
   */
  const processDelayedWelcome = async (guildId: string) => {
    const pending = delayManager.welcome.get(guildId)
    if (!pending) return

    // 清除定时器并从 Map 中移除
    clearTimeout(pending.timer)
    delayManager.welcome.delete(guildId)

    const { events, groupConfig, botId, session } = pending

    if (events.length === 0) return

    try {
      let message: any

      if (events.length === 1) {
        // 只有一个事件，使用单条消息格式化
        verboseLog(`[${botId}] Sending single welcome message for guild ${guildId}`)
        message = await formatMessage(ctx, session, groupConfig.message)
      } else {
        // 多个事件，使用批量消息格式化
        verboseLog(`[${botId}] Sending batch welcome message for guild ${guildId}, ${events.length} users`)
        message = await formatBatchMessage(ctx, session, groupConfig.message, events)
      }

      await sendMessage(session, message)
      logger.info(`[${botId}] Welcome message sent for guild ${guildId} (${events.length} user${events.length > 1 ? 's' : ''})`)
      verboseLog(`[${botId}] Message template: ${groupConfig.message}`)
    } catch (error) {
      logger.error(`[${botId}] Failed to send welcome message:`, error)
    }
  }

  /**
   * 处理延迟的离开消息发送
   */
  const processDelayedLeave = async (guildId: string) => {
    const pending = delayManager.leave.get(guildId)
    if (!pending) return

    // 清除定时器并从 Map 中移除
    clearTimeout(pending.timer)
    delayManager.leave.delete(guildId)

    const { events, groupConfig, botId, session } = pending

    if (events.length === 0) return

    try {
      let message: any

      if (events.length === 1) {
        // 只有一个事件，使用单条消息格式化
        verboseLog(`[${botId}] Sending single leave message for guild ${guildId}`)
        message = await formatMessage(ctx, session, groupConfig.message)
      } else {
        // 多个事件，使用批量消息格式化
        verboseLog(`[${botId}] Sending batch leave message for guild ${guildId}, ${events.length} users`)
        message = await formatBatchMessage(ctx, session, groupConfig.message, events)
      }

      await sendMessage(session, message)
      logger.info(`[${botId}] Leave message sent for guild ${guildId} (${events.length} user${events.length > 1 ? 's' : ''})`)
      verboseLog(`[${botId}] Message template: ${groupConfig.message}`)
    } catch (error) {
      logger.error(`[${botId}] Failed to send leave message:`, error)
    }
  }

  function setupBotSchemaService() {
    const knownBots: Set<string> = new Set()
    let debounceTimer: NodeJS.Timeout | null = null

    const scheduleScan = () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => scanFromMBC(), 200)
    }

    const scanFromMBC = () => {
      try {
        const mbcService = ctx['multi-bot-controller']
        if (!mbcService) {
          logger.warn('multi-bot-controller service not available')
          return
        }

        const bots = mbcService.getBots()
        const enabledBots = bots.filter((b: any) => b.enabled)
        const botIds = enabledBots.map((b: any) => `${b.platform}:${b.selfId}`).sort()

        const currentSet: Set<string> = new Set(botIds)
        if (setsEqual(knownBots, currentSet)) {
          debugLog('Bot list unchanged, skipping update')
          return
        }

        knownBots.clear()
        botIds.forEach((id: string) => knownBots.add(id))
        updateBotIdOptions(ctx, botIds)
        logger.info(`Bot list updated, ${botIds.length} available`)
        verboseLog('Available bots from MBC:', botIds.join(', '))
      } catch (error) {
        logger.warn('Failed to get bot list from mbc:', error)
      }
    }

    const setsEqual = (a: Set<string>, b: Set<string>): boolean => {
      if (a.size !== b.size) return false
      for (const item of a) {
        if (!b.has(item)) return false
      }
      return true
    }

    // 立即扫描一次
    const scanTimer = setTimeout(() => scanFromMBC(), 500)

    // 监听事件
    ctx.on('multi-bot-controller/bots-updated', () => scheduleScan())
    ctx.on('bot-added', () => scheduleScan())
    ctx.on('bot-removed', () => scheduleScan())
    ctx.on('ready', () => scheduleScan())
  }

  setupBotSchemaService()

  ctx.on('guild-member-added', async (session) => {
    // 在事件入口就记录详细信息
    verboseLog(`[EVENT] guild-member-added - selfId: ${session.selfId}, platform: ${session.platform}, guild: ${session.guildId}, user: ${session.userId}`)

    const botId = getBotId(session.platform || '', session.selfId || '')
    const botConfig = getBotConfig(botId)

    debugLog(`[${botId}] Processing guild-member-added event`)

    // 检查配置是否存在
    if (!botConfig) {
      verboseLog(`[${botId}] No config found for this bot in plugin`)
      return
    }

    // 检查配置有效性
    if (!isBotConfigValid(botConfig)) {
      verboseLog(`[${botId}] Config exists but no messages configured`)
      return
    }

    // 检查群组配置
    const groupConfig = botConfig.welcomeMessages.find(m => m.guildId === session.guildId)
    if (!groupConfig) {
      verboseLog(`[${botId}] No welcome config for guild ${session.guildId}`)
      return
    }

    if (!groupConfig.message) {
      verboseLog(`[${botId}] Welcome config exists for guild ${session.guildId} but message is empty`)
      return
    }

    // 收集事件数据
    const eventData: WelcomeEventData = {
      userId: session.userId,
      userName: await getUserName(session),
      timestamp: Date.now(),
    }

    // 检查是否启用延迟发送
    if (groupConfig.delaySeconds > 0) {
      verboseLog(`[${botId}] Delay enabled for guild ${session.guildId}, waiting ${groupConfig.delaySeconds}s`)

      // 检查是否已有待发送的队列
      const existing = delayManager.welcome.get(session.guildId)

      if (existing) {
        // 已有待发送队列，将新事件加入队列
        existing.events.push(eventData)
        debugLog(`[${botId}] Added to existing delay queue, now ${existing.events.length} events`)

        // 根据延迟模式决定是否重置定时器
        if (botConfig.delayMode === 'sliding') {
          // 滑动窗口：取消旧定时器，重新开始计时
          clearTimeout(existing.timer)
          existing.timer = setTimeout(() => processDelayedWelcome(session.guildId), groupConfig.delaySeconds * 1000)
          debugLog(`[${botId}] Sliding mode: timer reset`)
        }
        // fixed 模式：不重置定时器，保持原有的发送时间
      } else {
        // 创建新的延迟队列
        const timer = setTimeout(() => processDelayedWelcome(session.guildId), groupConfig.delaySeconds * 1000)
        delayManager.welcome.set(session.guildId, {
          events: [eventData],
          timer,
          groupConfig,
          botId,
          session,
        })
        debugLog(`[${botId}] Created new delay queue for guild ${session.guildId}`)
      }
    } else {
      // 不启用延迟，立即发送
      try {
        const message = await formatMessage(ctx, session, groupConfig.message)
        await sendMessage(session, message)
        logger.info(`[${botId}] Welcome message sent for guild ${session.guildId}`)
        verboseLog(`[${botId}] Message content: ${groupConfig.message}`)
      } catch (error) {
        logger.error(`[${botId}] Failed to send welcome message:`, error)
      }
    }
  })

  ctx.on('guild-member-removed', async (session) => {
    // 在事件入口就记录详细信息
    verboseLog(`[EVENT] guild-member-removed - selfId: ${session.selfId}, platform: ${session.platform}, guild: ${session.guildId}, user: ${session.userId}`)

    const botId = getBotId(session.platform || '', session.selfId || '')
    const botConfig = getBotConfig(botId)

    debugLog(`[${botId}] Processing guild-member-removed event`)

    // 检查配置是否存在
    if (!botConfig) {
      verboseLog(`[${botId}] No config found for this bot in plugin`)
      return
    }

    // 检查配置有效性
    if (!isBotConfigValid(botConfig)) {
      verboseLog(`[${botId}] Config exists but no messages configured`)
      return
    }

    // 检查群组配置
    const groupConfig = botConfig.leaveMessages.find(m => m.guildId === session.guildId)
    if (!groupConfig) {
      verboseLog(`[${botId}] No leave config for guild ${session.guildId}`)
      return
    }

    if (!groupConfig.message) {
      verboseLog(`[${botId}] Leave config exists for guild ${session.guildId} but message is empty`)
      return
    }

    // 收集事件数据
    const eventData: LeaveEventData = {
      userId: session.userId,
      userName: await getUserName(session),
      timestamp: Date.now(),
    }

    // 检查是否启用延迟发送
    if (groupConfig.delaySeconds > 0) {
      verboseLog(`[${botId}] Delay enabled for guild ${session.guildId}, waiting ${groupConfig.delaySeconds}s`)

      // 检查是否已有待发送的队列
      const existing = delayManager.leave.get(session.guildId)

      if (existing) {
        // 已有待发送队列，将新事件加入队列
        existing.events.push(eventData)
        debugLog(`[${botId}] Added to existing delay queue, now ${existing.events.length} events`)

        // 根据延迟模式决定是否重置定时器
        if (botConfig.delayMode === 'sliding') {
          // 滑动窗口：取消旧定时器，重新开始计时
          clearTimeout(existing.timer)
          existing.timer = setTimeout(() => processDelayedLeave(session.guildId), groupConfig.delaySeconds * 1000)
          debugLog(`[${botId}] Sliding mode: timer reset`)
        }
        // fixed 模式：不重置定时器，保持原有的发送时间
      } else {
        // 创建新的延迟队列
        const timer = setTimeout(() => processDelayedLeave(session.guildId), groupConfig.delaySeconds * 1000)
        delayManager.leave.set(session.guildId, {
          events: [eventData],
          timer,
          groupConfig,
          botId,
          session,
        })
        debugLog(`[${botId}] Created new delay queue for guild ${session.guildId}`)
      }
    } else {
      // 不启用延迟，立即发送
      try {
        const message = await formatMessage(ctx, session, groupConfig.message)
        await sendMessage(session, message)
        logger.info(`[${botId}] Leave message sent for guild ${session.guildId}`)
        verboseLog(`[${botId}] Message content: ${groupConfig.message}`)
      } catch (error) {
        logger.error(`[${botId}] Failed to send leave message:`, error)
      }
    }
  })

  ctx.on('ready', () => {
    logger.info('Plugin ready')
    debugLog('Plugin initialization complete')

    // 输出当前配置状态
    const configuredBots = config.bots.filter(b => isBotConfigValid(b))
    verboseLog('=== Plugin Configuration Summary ===')
    verboseLog(`Total configured bots: ${config.bots.length}`)
    verboseLog(`Active bots (with messages): ${configuredBots.length}`)

    for (const bot of config.bots) {
      verboseLog(`Bot: ${bot.botId}`)
      verboseLog(`  Welcome messages: ${bot.welcomeMessages.length}`)
      for (const msg of bot.welcomeMessages) {
        const preview = msg.message.length > 20 ? msg.message.substring(0, 20) + '...' : msg.message
        const delayInfo = msg.delaySeconds > 0 ? ` [delay: ${msg.delaySeconds}s]` : ''
        verboseLog(`    - Guild ${msg.guildId}: "${preview}"${delayInfo}`)
      }
      verboseLog(`  Leave messages: ${bot.leaveMessages.length}`)
      for (const msg of bot.leaveMessages) {
        const preview = msg.message.length > 20 ? msg.message.substring(0, 20) + '...' : msg.message
        const delayInfo = msg.delaySeconds > 0 ? ` [delay: ${msg.delaySeconds}s]` : ''
        verboseLog(`    - Guild ${msg.guildId}: "${preview}"${delayInfo}`)
      }
    }
    verboseLog('=====================================')
  })

  // 插件停用时清理所有定时器
  ctx.on('dispose', () => {
    logger.info('Cleaning up delay managers...')

    for (const pending of delayManager.welcome.values()) {
      clearTimeout(pending.timer)
    }
    delayManager.welcome.clear()

    for (const pending of delayManager.leave.values()) {
      clearTimeout(pending.timer)
    }
    delayManager.leave.clear()

    logger.info('Delay managers cleaned up')
  })
}
