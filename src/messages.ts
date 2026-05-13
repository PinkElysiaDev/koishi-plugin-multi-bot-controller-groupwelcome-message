// src/messages.ts
import { Context, h, Session } from 'koishi'
import { transform } from 'koishi-plugin-markdown'
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { WelcomeEventData, LeaveEventData, ResourceConfig } from './types'

/** 匹配 {imageURL="..."} 标签的正则 */
const IMAGE_TAG_REGEX = /\{imageURL=(["'])(.*?)\1\}/gi

/** http/https URL 正则 */
const REMOTE_URL_REGEX = /^https?:\/\//i

/** file:// URL 正则 */
const FILE_URL_REGEX = /^file:\/\//i

/** 用于标记图片插入位置的占位符前缀 */
const IMAGE_PLACEHOLDER_PREFIX = '\x00MBWGWM_IMAGE_'

/**
 * 解析 {imageURL="..."} 标签，从文本中提取图片并替换为占位符
 * 返回处理后的文本和按顺序排列的图片元素数组
 */
function parseImageTags(
  text: string,
  resourceConfig?: ResourceConfig,
): { processedText: string; imageElements: Array<{ placeholder: string; element: h }> } {
  const imageElements: Array<{ placeholder: string; element: h }> = []
  let processedText = text
  let counter = 0

  // 重置正则的 lastIndex
  IMAGE_TAG_REGEX.lastIndex = 0

  // 收集所有匹配（因为 replace 中无法很好地返回异步结果，先收集再替换）
  const matches: Array<{ match: string; url: string }> = []
  for (const m of text.matchAll(IMAGE_TAG_REGEX)) {
    matches.push({ match: m[0], url: m[2] })
  }

  // 按顺序替换
  for (const { match, url } of matches) {
    const placeholder = `${IMAGE_PLACEHOLDER_PREFIX}${counter}`
    const element = resolveImageElement(url, resourceConfig)
    imageElements.push({ placeholder, element })
    processedText = processedText.replace(match, placeholder)
    counter++
  }

  return { processedText, imageElements }
}

/**
 * 解析图片 URL 并创建对应的 h 元素
 * 参考 chime 插件的 resolveResourceUrl 实现
 */
function resolveImageElement(rawUrl: string, resourceConfig?: ResourceConfig): h {
  const trimmed = rawUrl.trim()

  if (!trimmed) {
    return h.text('[图片URL为空]')
  }

  try {
    // HTTP/HTTPS URL - 直接使用
    if (REMOTE_URL_REGEX.test(trimmed)) {
      return h.image(trimmed)
    }

    // file:// URL
    if (FILE_URL_REGEX.test(trimmed)) {
      if (!resourceConfig?.allowLocalResources) {
        return h.text(`[本地图片已禁用: ${trimmed}]`)
      }
      const localPath = fileURLToPath(trimmed)
      if (!existsSync(localPath)) {
        return h.text(`[本地文件不存在: ${trimmed}]`)
      }
      return h.image(trimmed)
    }

    // 本地路径
    if (!resourceConfig?.allowLocalResources) {
      return h.text(`[本地图片已禁用: ${trimmed}]`)
    }
    const resolvedPath = isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed)
    if (!existsSync(resolvedPath)) {
      return h.text(`[本地文件不存在: ${trimmed}]`)
    }
    return h.image(pathToFileURL(resolvedPath).href)
  } catch (error) {
    return h.text(`[图片加载失败: ${trimmed}]`)
  }
}

/**
 * 在 h[] 数组中查找并替换占位符为图片元素
 * 递归处理元素树中的所有文本节点
 */
function replaceImagePlaceholders(
  elements: h[],
  imageElements: Array<{ placeholder: string; element: h }>,
): h[] {
  const result: h[] = []

  for (const element of elements) {
    if (element.type === 'text') {
      const text = element.attrs.content as string
      if (!text.includes(IMAGE_PLACEHOLDER_PREFIX)) {
        result.push(element)
        continue
      }

      // 切分文本，将占位符替换为图片元素
      let remaining = text
      while (remaining.length > 0) {
        const idx = remaining.indexOf(IMAGE_PLACEHOLDER_PREFIX)
        if (idx === -1) {
          result.push(h.text(remaining))
          break
        }

        // 添加占位符之前的文本
        if (idx > 0) {
          result.push(h.text(remaining.slice(0, idx)))
        }

        // 提取占位符编号
        const afterPrefix = remaining.slice(idx + IMAGE_PLACEHOLDER_PREFIX.length)
        const numMatch = afterPrefix.match(/^(\d+)/)
        if (numMatch) {
          const num = parseInt(numMatch[1], 10)
          const placeholder = `${IMAGE_PLACEHOLDER_PREFIX}${num}`
          const imageEntry = imageElements.find((e) => e.placeholder === placeholder)
          if (imageEntry) {
            result.push(imageEntry.element)
          } else {
            result.push(h.text(placeholder))
          }
          remaining = afterPrefix.slice(numMatch[1].length)
        } else {
          // 无法解析，保留原样
          result.push(h.text(IMAGE_PLACEHOLDER_PREFIX))
          remaining = afterPrefix
        }
      }
    } else {
      // 非文本元素，递归处理子元素
      const newElement: h = h.jsx(element.type, element.attrs)
      newElement.children = replaceImagePlaceholders(element.children, imageElements)
      newElement.source = element.source
      result.push(newElement)
    }
  }

  return result
}

/**
 * 获取第一个非空文本
 */
function getNotEmptyText(defaultName: string | undefined, ...texts: (string | undefined)[]): string {
  for (const text of texts) {
    if (text != null && text.length > 0 && text !== defaultName) {
      return text
    }
  }
  return defaultName ?? ''
}

/**
 * 获取一言
 */
async function hitokoto(ctx: Context): Promise<string> {
  for (let i = 0; i < 3; i++) {
    try {
      const response = await ctx.http.get('https://v1.hitokoto.cn')
      return response.hitokoto
    } catch (e) {
      if (i === 2) {
        // 失败时返回空字符串，不抛出错误
        return ''
      }
    }
  }
  return ''
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
    if (session.userId) {
      parent.push(h.at(session.userId))
    }

    text = after
  }
  parent.push(h.text(text))
}

/**
 * 处理批量消息中的 {at} 变量，为每个用户生成 at 元素
 */
function transformBatchElements(
  _session: Session,
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
      transformBatchElements(_session, events, child, resultElement.children)
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
 * - {br}: 换行符
 * - {imageURL="..."}: 插入图片，支持本地路径、file URL、http(s) URL
 */
export async function formatMessage(
  ctx: Context,
  session: Session,
  markdownText: string,
  resourceConfig?: ResourceConfig,
): Promise<h[]> {
  const guildId = session.event.guild?.id ?? session.guildId ?? ''
  const userId = session.author?.id ?? session.event.user?.id ?? session.userId ?? ''

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
    (session.bot.platform === 'onebot' || session.bot.platform === 'red') && userId
      ? `https://q.qlogo.cn/headimg_dl?dst_uin=${userId}&spec=640`
      : session.author.avatar ?? ''

  // 检查是否需要获取一言
  const hasHitokoto = markdownText.includes('{hitokoto}')
  const hitokotoText = hasHitokoto ? await hitokoto(ctx) : ''

  // 替换变量（在执行图片标签解析之前）
  markdownText = markdownText
    .replace(/{user}/g, userName)
    .replace(/{group}/g, groupName)
    .replace(/{time}/g, new Date().toLocaleString())
    .replace(/{avatar}/g, `![avatar](${avatar})`)
    .replace(/{id}/g, userId)
    .replace(/{group_id}/g, guildId)
    .replace(/{group_count}/g, groupMemberCount.toString())
    .replace(/{hitokoto}/g, hitokotoText)
    .replace(/{br}/g, '\n')

  // 解析 {imageURL="..."} 标签，将图片提取为元素并用占位符替换
  const { processedText, imageElements } = parseImageTags(markdownText, resourceConfig)

  // 对剩余文本使用 koishi-plugin-markdown 转换
  const transformed = transform(processedText)

  const finalElements: h[] = []

  // 处理 {at} 变量
  for (const element of transformed) {
    transformElements(session, element, finalElements)
  }

  // 替换占位符为实际的图片元素
  return replaceImagePlaceholders(finalElements, imageElements)
}

/**
 * 批量格式化消息，用于延迟合并发送
 *
 * 变量处理规则：
 * - {user}: 合并所有用户名，用顿号分隔（退群事件中若同时存在{id}则忽略此项）
 * - {id}: 合并所有用户ID，用顿号分隔
 * - {at}: 合并所有 @ 元素
 * - {avatar}: 合并所有用户头像（换行分隔）
 * - {group_count}: 获取最新群人数
 * - {time}: 使用最后事件的时间
 * - {group}: 获取群组名称
 * - {group_id}: 群组ID
 * - {hitokoto}: 只获取一次
 * - {br}: 换行符
 * - {imageURL="..."}: 插入图片（不做特殊合并，与单条消息行为一致）
 *
 * @param ctx Context
 * @param session 最后一个事件的 session（用于获取 bot 和群组信息）
 * @param markdownText 消息模板
 * @param events 事件列表（入群或退群）
 * @param isLeaveEvent 是否为退群事件
 * @param resourceConfig 资源访问配置
 */
export async function formatBatchMessage(
  ctx: Context,
  session: Session,
  markdownText: string,
  events: (WelcomeEventData | LeaveEventData)[],
  isLeaveEvent: boolean,
  resourceConfig?: ResourceConfig,
): Promise<h[]> {
  const guildId = session.event.guild?.id ?? session.guildId ?? ''
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
  const userNames = events.map((e) => e.userName).join('、')

  // 合并用户ID（用顿号分隔）
  const userIds = events.map((e) => e.userId).join('、')

  // 使用最后事件的时间
  const time = new Date(lastEvent.timestamp).toLocaleString()

  // 合并用户头像（每行一个）
  const avatars = events
    .map((e) => {
      if ((session.bot.platform === 'onebot' || session.bot.platform === 'red') && e.userId) {
        return `![avatar](https://q.qlogo.cn/headimg_dl?dst_uin=${e.userId}&spec=640)`
      }
      return ''
    })
    .filter((a) => a)
    .join('\n')

  // 检查消息中是否包含需要特殊处理的变量
  const hasUser = markdownText.includes('{user}')
  const hasId = markdownText.includes('{id}')
  const hasHitokoto = markdownText.includes('{hitokoto}')
  // 退群事件中，若同时存在 {user} 和 {id}，则忽略 {user}（因为退群时无法获取用户昵称）
  const shouldIgnoreUser = isLeaveEvent && hasUser && hasId

  // 获取一言（只获取一次，且仅在需要时）
  const hitokotoText = hasHitokoto ? await hitokoto(ctx) : ''

  // 替换变量（在执行图片标签解析之前）
  markdownText = markdownText
    .replace(/{user}/g, shouldIgnoreUser ? '' : userNames)
    .replace(/{id}/g, userIds)
    .replace(/{group}/g, groupName)
    .replace(/{time}/g, time)
    .replace(/{avatar}/g, avatars)
    .replace(/{group_id}/g, guildId)
    .replace(/{group_count}/g, groupMemberCount.toString())
    .replace(/{hitokoto}/g, hitokotoText)
    .replace(/{br}/g, '\n')

  // 解析 {imageURL="..."} 标签，将图片提取为元素并用占位符替换
  const { processedText, imageElements } = parseImageTags(markdownText, resourceConfig)

  // 对剩余文本使用 koishi-plugin-markdown 转换
  const transformed = transform(processedText)

  const finalElements: h[] = []

  // 处理 {at} 变量 - 为每个用户生成 at 元素
  for (const element of transformed) {
    transformBatchElements(session, events, element, finalElements)
  }

  // 替换占位符为实际的图片元素
  return replaceImagePlaceholders(finalElements, imageElements)
}
