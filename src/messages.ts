// src/messages.ts
import { Context, h, Session } from 'koishi'
import { transform } from 'koishi-plugin-markdown'
import type { WelcomeEventData, LeaveEventData } from './types'

/**
 * 格式化消息，替换变量并转换为 Koishi 消息元素
 * 支持的变量：
 * - {user}: 用户昵称
 * - {id}: 用户 ID
 * - {group_id}: 群组 ID
 * - {group}: 群组名称
 * - {time}: 当前时间
 * - {at}: @该用户
 * - {avatar}: 用户头像
 * - {group_count}: 群组人数
 * - {hitokoto}: 一言
 */
export async function formatMessage(
  ctx: Context,
  session: Session,
  markdownText: string,
): Promise<h[]> {
  const guildId = session.event.guild?.id ?? session.guildId
  const userId = session.author?.id ?? session.event.user?.id ?? session.userId

  // 获取群组名称
  const groupName =
    (await session.bot.getGuild(guildId))?.name ??
    session.event.guild?.name ??
    ''

  // 获取群组成员列表（用于计算人数）
  const groupMemberList = await session.bot.getGuildMemberList(guildId)
  let groupMemberCount: number

  // 兼容旧版本
  if (groupMemberList instanceof Array) {
    groupMemberCount = groupMemberList.length
  } else {
    groupMemberCount = groupMemberList.data?.length || 0
  }

  // 获取用户昵称
  let userName = getNotEmptyText(
    userId,
    session.event?.member?.nick,
    session.event?.member?.name,
    session.event?.user?.nick,
    session.event?.user?.name,
    session.author?.nick,
    session.author?.name,
    session.username,
  )

  // 如果用户名就是 ID，尝试获取群成员详情
  if (userName === userId) {
    try {
      userName = await session.bot
        .getGuildMember(guildId, userId)
        .then((member) => {
          return getNotEmptyText(
            userId,
            member.nick,
            member.name,
            member.user?.nick,
            member.user?.name,
          )
        })
    } catch (e) {
      // 获取失败，使用默认
    }
  }

  // 获取用户头像
  const avatar =
    (session.bot.platform === 'onebot' || session.bot.platform === 'red') &&
    userId != null
      ? `https://q.qlogo.cn/headimg_dl?dst_uin=${userId}&spec=640`
      : session.author.avatar

  // 替换变量
  markdownText = markdownText
    .replace(/{user}/g, userName)
    .replace(/{group}/g, groupName)
    .replace(/{time}/g, new Date().toLocaleString())
    .replace(/{avatar}/g, `![avatar](${avatar ?? ''})`)
    .replace(/{id}/g, userId ?? '')
    .replace(/{group_id}/g, guildId ?? '')
    .replace(/{group_count}/g, groupMemberCount.toString())
    .replace(/{hitokoto}/g, await hitokoto(ctx))

  // 使用 koishi-plugin-markdown 转换
  const transformed = transform(markdownText)

  const finalElements: h[] = []

  // 处理 {at} 变量
  for (const element of transformed) {
    transformElements(session, element, finalElements)
  }

  return finalElements
}

/**
 * 批量格式化消息，用于延迟合并发送
 *
 * 变量处理规则：
 * - {user}: 合并所有用户名，用顿号分隔
 * - {id}: 合并所有用户ID，用顿号分隔
 * - {at}: 合并所有 @ 元素
 * - {avatar}: 合并所有用户头像（换行分隔）
 * - {group_count}: 获取最新群人数
 * - {time}: 使用最后事件的时间
 * - {group}: 获取群组名称
 * - {group_id}: 群组ID
 * - {hitokoto}: 只获取一次
 *
 * @param ctx Context
 * @param session 最后一个事件的 session（用于获取 bot 和群组信息）
 * @param markdownText 消息模板
 * @param events 事件列表（入群或退群）
 * @param eventType 事件类型 'welcome' | 'leave'
 */
export async function formatBatchMessage(
  ctx: Context,
  session: Session,
  markdownText: string,
  events: (WelcomeEventData | LeaveEventData)[],
): Promise<h[]> {
  const guildId = session.event.guild?.id ?? session.guildId
  const lastEvent = events[events.length - 1]

  // 获取群组名称
  const groupName =
    (await session.bot.getGuild(guildId))?.name ??
    session.event.guild?.name ??
    ''

  // 获取最新群人数
  const groupMemberList = await session.bot.getGuildMemberList(guildId)
  let groupMemberCount: number

  if (groupMemberList instanceof Array) {
    groupMemberCount = groupMemberList.length
  } else {
    groupMemberCount = groupMemberList.data?.length || 0
  }

  // 合并用户名（用顿号分隔）
  const userNames = events.map(e => e.userName).join('、')

  // 合并用户ID（用顿号分隔）
  const userIds = events.map(e => e.userId).join('、')

  // 使用最后事件的时间
  const time = new Date(lastEvent.timestamp).toLocaleString()

  // 合并用户头像（每行一个）
  const avatars = events
    .map(e => {
      if ((session.bot.platform === 'onebot' || session.bot.platform === 'red') && e.userId) {
        return `![avatar](https://q.qlogo.cn/headimg_dl?dst_uin=${e.userId}&spec=640)`
      }
      return ''
    })
    .filter(a => a)
    .join('\n')

  // 获取一言（只获取一次）
  const hitokotoText = await hitokoto(ctx)

  // 替换变量
  markdownText = markdownText
    .replace(/{user}/g, userNames)
    .replace(/{id}/g, userIds)
    .replace(/{group}/g, groupName)
    .replace(/{time}/g, time)
    .replace(/{avatar}/g, avatars)
    .replace(/{group_id}/g, guildId ?? '')
    .replace(/{group_count}/g, groupMemberCount.toString())
    .replace(/{hitokoto}/g, hitokotoText)

  // 使用 koishi-plugin-markdown 转换
  const transformed = transform(markdownText)

  const finalElements: h[] = []

  // 处理 {at} 变量 - 为每个用户生成 at 元素
  for (const element of transformed) {
    transformBatchElements(session, events, element, finalElements)
  }

  return finalElements
}

/**
 * 处理单个文本元素，将 {at} 替换为 at 元素（单条消息）
 */
function transformElement(session: Session, element: h, parent: h[]) {
  if (element.type !== 'text') {
    return
  }

  let text = element.attrs.content as string

  // 循环查找并替换 {at}
  while (true) {
    const index = text.indexOf('{at}')

    if (index === -1) {
      break
    }

    const before = text.slice(0, index)
    const after = text.slice(index + 4)

    parent.push(h.text(before))
    parent.push(h.at(session.userId))

    text = after
  }
  parent.push(h.text(text))
}

/**
 * 处理批量消息中的 {at} 变量，为每个用户生成 at 元素
 */
function transformBatchElements(
  session: Session,
  events: (WelcomeEventData | LeaveEventData)[],
  element: h,
  parent: h[],
) {
  if (element.type === 'text') {
    let text = element.attrs.content as string

    // 查找 {at} 标记
    const atIndex = text.indexOf('{at}')

    if (atIndex === -1) {
      // 没有 {at}，直接添加文本
      parent.push(element)
      return
    }

    // 有 {at}，为每个用户生成 at 元素
    const before = text.slice(0, atIndex)
    const after = text.slice(atIndex + 4)

    if (before) {
      parent.push(h.text(before))
    }

    // 为每个用户添加 at 元素
    for (let i = 0; i < events.length; i++) {
      parent.push(h.at(events[i].userId))
      if (i < events.length - 1) {
        parent.push(h.text(' '))
      }
    }

    if (after) {
      parent.push(h.text(after))
    }
  } else {
    // 非文本元素，递归处理子元素
    const resultElement: h = h.jsx(element.type, element.attrs)
    resultElement.children = []
    resultElement.source = element.source

    for (const child of element.children) {
      transformBatchElements(session, events, child, resultElement.children)
    }

    parent.push(resultElement)
  }
}

/**
 * 递归处理元素树（单条消息）
 */
function transformElements(session: Session, element: h, parent: h[]) {
  if (element.type === 'text') {
    transformElement(session, element, parent)
    return
  }

  const resultElement: h = h.jsx(element.type, element.attrs)
  resultElement.children = []
  resultElement.source = element.source

  for (const child of element.children) {
    transformElements(session, child, resultElement.children)
  }

  parent.push(resultElement)
}

/**
 * 获取第一个非空文本
 */
function getNotEmptyText(defaultName: string, ...texts: string[]) {
  for (const text of texts) {
    if (text != null && text.length > 0 && text !== defaultName) {
      return text
    }
  }
  return defaultName
}

/**
 * 获取一言
 */
async function hitokoto(ctx: Context) {
  for (let i = 0; i < 3; i++) {
    try {
      const response = await ctx.http.get('https://v1.hitokoto.cn')
      return response.hitokoto
    } catch (e) {
      if (i === 2) {
        throw e
      }
    }
  }
}
