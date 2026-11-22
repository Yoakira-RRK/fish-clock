// 小鱼钟（fish-clock）—— DSH 插件，宿主半边。
//
// 干什么：按时刻表叫大肥鱼主动开口。她平时只在有人跟她说话时才动；
// 这个插件到点往她那条 QQ 会话里塞一句「你自己心里冒出来的念头」，
// DSH 照常开一轮 —— 人格、历史、工具、记忆全是她自己的，等于她自己起个话头。
//
// 为什么单独写一个、不去改 dsh-speak-up：那个插件只有「固定间隔 + 概率」，
// 没有时刻表；而这个插件会被换成 npm 上游版本，改源码迟早被覆盖。
//
// 时刻表（写死在 fish-clock.json 里，改完下一轮就生效，不用重启）：
//   · 固定窗口：每天 09:30~10:00、14:00~14:30、19:30~20:00 各一次，窗口内随机挑一分钟，必发
//   · 额外：白天 09:00~23:00 里再随机 1~2 次，避开固定窗口前后 20 分钟
//   · 安静：23:00~09:00 一条都不发
//
// 失败兜底：找不到活着的 agent（会话没挂起来）、她正在忙、followup 抛错 —— 都只写日志，
// 不重试太久；固定窗口错过 20 分钟、随机的错过 40 分钟就不再补，免得半夜补发一串。

import { readFileSync, writeFileSync, renameSync, appendFileSync, existsSync, unlinkSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

/** 宿主按这个认插件；inject 声明了要用的服务，少写一个 ctx 上就取不到。 */
export const name = 'fish-clock'
export const inject = ['agents', 'sessions', 'timer', 'webServer']

/** 设置面板用的本机接口前缀（网页半边 lib/client.js 按这个读写）。 */
const 路由前缀 = '/fish-clock'

/**
 * 配置文件、日志、onebot 的会话映射都跟着 DSH 账户目录走，换台机器也能用：
 *   FISH_CLOCK_CONFIG   显式指定配置文件（最高优先级）
 *   DSH_HOME            DSH 的账户目录，默认 ~/.dsh
 * 老版本把配置放在工作区里，这里留了一条兼容路径，找不到新位置时回退。
 */
const 账户目录 = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
const 候选配置 = [
  process.env.FISH_CLOCK_CONFIG,
  join(账户目录, 'fish-clock.json'),
  join(账户目录, '..', 'DSH WORK', 'fish', 'fish-clock.json'),
].filter((p) => typeof p === 'string' && p !== '')

const 配置文件 = 候选配置.find((p) => existsSync(p)) || 候选配置[1]
const 日志文件 = process.env.FISH_CLOCK_LOG || join(账户目录, 'fish-clock.log')
const 映射文件 = process.env.FISH_CLOCK_MAP || join(账户目录, 'media', 'onebot', 'chat-sessions.json')

/**
 * 当天的表落一次盘：重启 DSH 不会把整天的钟点重新摇一遍（否则早上错过的那格
 * 下午又冒出来一个，节奏就乱了）。文件里只存「日期 + 几条钟点」。
 */
const 计划文件 = process.env.FISH_CLOCK_PLAN || join(账户目录, 'fish-clock-plan.json')

/**
 * 手动触发：往这个路径放一个空文件，最多 30 秒后她就收到一条 —— 不开网页也能试。
 * 用完自动删掉。
 */
const 触发文件 = process.env.FISH_CLOCK_TRIGGER || join(账户目录, 'fish-clock.trigger')

/** 写进会话日志的来源标记：一眼能看出这条不是他打的。 */
const 源标记 = 'fish-clock'

const 默认配置 = {
  总开关: true,
  会话键: '', // 换成你自己的：私聊 private:<QQ号>，群聊 group:<群号>
  固定窗口: [
    ['09:30', '10:00'],
    ['14:00', '14:30'],
    ['19:30', '20:00'],
  ],
  额外次数: [1, 2],
  额外时段: ['09:00', '23:00'],
  额外避开分钟: 20,
  安静起: 23,
  安静止: 9,
  固定宽限分钟: 20,
  额外宽限分钟: 40,
  触发文案: '（心里有点别扭）该主动找他说句话了。挑点眼下的事聊，别查岗。',
}

export function 记日志(文本) {
  try {
    appendFileSync(日志文件, `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${String(文本)}\n`, 'utf8')
  } catch (error) {
    /* 日志写不进去也不能影响主流程 */
  }
}

export function 读配置() {
  try {
    const 来 = JSON.parse(readFileSync(配置文件, 'utf8'))
    return { ...默认配置, ...(来 && typeof 来 === 'object' ? 来 : {}) }
  } catch (error) {
    return 默认配置
  }
}

/** 读日志尾部若干行，给设置面板显示「最近发生了什么」。 */
export function 读日志(行数 = 40) {
  try {
    const 全部 = readFileSync(日志文件, 'utf8').split(/\r?\n/).filter((x) => x.trim() !== '')
    return 全部.slice(-行数)
  } catch (error) {
    return []
  }
}

/** 写配置：先写临时文件再改名，免得写一半断电把配置写坏。 */
export function 写配置(配置) {
  const 文本 = JSON.stringify(配置, null, 2) + String.fromCharCode(10)
  const 临时 = 配置文件 + '.tmp'
  writeFileSync(临时, 文本, 'utf8')
  renameSync(临时, 配置文件)
  return 配置
}

function 整(值, 小, 大, 兜) {
  const n = Math.round(数(值, 兜))
  return 夹(Number.isFinite(n) ? n : 兜, 小, 大)
}

/** 把面板传上来的东西收拾成一份能用的配置；错的字段退回默认值。 */
export function 规范配置(来) {
  const 新 = { ...默认配置, ...(来 && typeof 来 === 'object' ? 来 : {}) }

  新.总开关 = 新.总开关 !== false

  const 窗们 = Array.isArray(新.固定窗口) ? 新.固定窗口 : []
  const 干净窗 = []
  for (const 窗 of 窗们) {
    if (!Array.isArray(窗) || 窗.length < 2) continue
    const 起 = 时分数(窗[0])
    const 止 = 时分数(窗[1])
    if (起 === undefined || 止 === undefined || 起 === 止) continue
    干净窗.push([分钟转字(起), 分钟转字(止)])
  }
  新.固定窗口 = 干净窗

  const 次 = Array.isArray(新.额外次数) ? 新.额外次数 : [新.额外次数, 新.额外次数]
  const 低 = 整(次[0], 0, 6, 1)
  const 高 = 整(次[1] ?? 次[0], 0, 6, 低)
  新.额外次数 = [Math.min(低, 高), Math.max(低, 高)]

  const 段 = Array.isArray(新.额外时段) ? 新.额外时段 : 默认配置.额外时段
  const 段起 = 时分数(段[0]) ?? 540
  const 段止 = 时分数(段[1]) ?? 1380
  新.额外时段 = [分钟转字(段起), 分钟转字(段止)]
  新.额外避开分钟 = 整(新.额外避开分钟, 0, 180, 20)

  新.安静起 = 整(新.安静起, 0, 23, 23)
  新.安静止 = 整(新.安静止, 0, 23, 9)
  新.固定宽限分钟 = 整(新.固定宽限分钟, 1, 180, 20)
  新.额外宽限分钟 = 整(新.额外宽限分钟, 1, 180, 40)

  新.会话键 = String(新.会话键 == null ? 默认配置.会话键 : 新.会话键).trim() || 默认配置.会话键
  新.触发文案 = String(新.触发文案 == null ? 默认配置.触发文案 : 新.触发文案).slice(0, 600)
  if (新.触发文案.trim() === '') 新.触发文案 = 默认配置.触发文案
  return 新
}

function 数(值, 兜) {
  const n = Number(值)
  return Number.isFinite(n) ? n : 兜
}

function 夹(值, 小, 大) {
  return Math.min(大, Math.max(小, 值))
}

/** 'HH:MM' → 当天第几分钟；写错返回 undefined。 */
export function 时分数(文本) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(文本 == null ? '' : 文本).trim())
  if (!m) return undefined
  const 时 = Number(m[1])
  const 分 = Number(m[2])
  if (!Number.isFinite(时) || !Number.isFinite(分)) return undefined
  if (时 < 0 || 时 > 24 || 分 < 0 || 分 > 59) return undefined
  return 时 * 60 + 分
}

function 分钟转字(分钟) {
  const 时 = Math.floor(分钟 / 60)
  const 分 = 分钟 % 60
  return `${String(时).padStart(2, '0')}:${String(分).padStart(2, '0')}`
}

function 当天零点(现在) {
  const d = new Date(现在)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function 随机次数(值) {
  if (Array.isArray(值) && 值.length > 0) {
    const 上 = 数(值[值.length - 1], 0)
    const 下 = 数(值[0], 上)
    const 低 = Math.floor(Math.min(下, 上))
    const 高 = Math.floor(Math.max(下, 上))
    if (高 <= 低) return 低
    return 低 + Math.floor(Math.random() * (高 - 低 + 1))
  }
  return 数(值, 0)
}

/**
 * 生成「今天」的时刻表。纯函数（只读配置 + 随机数），方便单测。
 * @returns {{at:number, 类:string, 窗:string, 分钟:number}[]} 按时间升序
 */
export function 今日计划(配置 = 默认配置, 现在 = new Date()) {
  const 零点 = 当天零点(现在)
  const 固定 = []

  for (const 窗 of Array.isArray(配置.固定窗口) ? 配置.固定窗口 : []) {
    if (!Array.isArray(窗) || 窗.length < 2) continue
    const 起 = 时分数(窗[0])
    const 止 = 时分数(窗[1])
    if (起 === undefined || 止 === undefined) continue
    const 低 = Math.min(起, 止)
    const 高 = Math.max(起, 止)
    const 分钟 = 夹(低 + Math.floor(Math.random() * (高 - 低 + 1)), 低, 高)
    固定.push({ at: 零点 + 分钟 * 60000, 类: '固定', 窗: `${窗[0]}-${窗[1]}`, 分钟 })
  }

  const 段 = Array.isArray(配置.额外时段) && 配置.额外时段.length >= 2 ? 配置.额外时段 : 默认配置.额外时段
  const 段起 = 时分数(段[0]) ?? 540
  const 段止 = 时分数(段[1]) ?? 1380
  const 避开 = Math.max(0, 数(配置.额外避开分钟, 20))
  const 次数 = 随机次数(配置.额外次数)

  const 额外 = []
  for (let 试 = 0; 试 < 200 && 额外.length < 次数; 试++) {
    const 分钟 = 段起 + Math.floor(Math.random() * Math.max(1, 段止 - 段起))
    if (分钟 < 段起 || 分钟 >= 段止) continue
    const 撞固定 = 固定.some((x) => Math.abs(x.分钟 - 分钟) < 避开)
    const 撞自己 = 额外.some((x) => Math.abs(x.分钟 - 分钟) < 15)
    if (撞固定 || 撞自己) continue
    额外.push({ at: 零点 + 分钟 * 60000, 类: '额外', 窗: '随机', 分钟 })
  }

  return [...固定, ...额外].sort((a, b) => a.at - b.at)
}

/** 这个小时算不算安静时段（支持跨午夜，起 === 止 表示不启用）。 */
export function 在安静时段(小时, 起, 止) {
  if (起 === 止) return false
  if (起 < 止) return 小时 >= 起 && 小时 < 止
  return 小时 >= 起 || 小时 < 止
}

/** 把「多久」说成一句人话：90 -> "1 小时 30 分钟"，45 -> "45 分钟"。 */
function 多久前(分钟) {
  const 分 = Math.max(0, Math.round(分钟))
  if (分 < 1) return '刚刚'
  if (分 < 60) return `${分} 分钟`
  const 时 = Math.floor(分 / 60)
  const 余 = 分 % 60
  return 余 === 0 ? `${时} 小时` : `${时} 小时 ${余} 分`
}

/**
 * 距「他上一次真的说话」过了多少分钟；查不到就返回 null（宁可不写，也不编）。
 * 两条路：① agent.session.events 里最后一条真人消息的时间；② 会话文件 mtime。
 */
function 距上次说话分钟(agent, 会话id) {
  try {
    const 事件 = agent?.session?.events
    if (Array.isArray(事件) && 事件.length > 0) {
      for (let i = 事件.length - 1; i >= 0; i -= 1) {
        const 一 = 事件[i]
        const 类 = String(一?.type || '')
        const 谁 = String(一?.data?.message?.role || '')
        const 源 = String(一?.data?.message?.source?.kind || '')
        const 是真人 = 谁 === 'user' && !/fish-clock|onebot|system-reminder/.test(源)
        if (是真人 && (类.includes('message') || 类 === 'user/message')) {
          const 时 = Number(一?.time)
          if (Number.isFinite(时) && 时 > 0) return (Date.now() - 时) / 60000
        }
      }
    }
  } catch (错误) {
    /* 事件结构变了也不影响发消息 */
  }
  try {
    const 根 = join(账户目录, 'sessions')
    for (const 工作区 of readdirSync(根)) {
      const 候选 = join(根, 工作区, String(会话id), 'session.v4.jsonl.zstd')
      if (existsSync(候选)) {
        const 秒 = statSync(候选).mtimeMs
        if (Number.isFinite(秒) && 秒 > 0) return (Date.now() - 秒) / 60000
      }
    }
  } catch (错误) {
    /* 没有会话目录就算了 */
  }
  return null
}

/** 现在这会儿是哪一段（说给模型听的）。 */
function 现在这行(现在) {
  const 时 = 现在.getHours()
  const 段名 = 时 < 5 ? '凌晨' : 时 < 9 ? '早上' : 时 < 12 ? '上午'
    : 时 < 13 ? '中午' : 时 < 18 ? '下午' : 时 < 20 ? '傍晚' : 时 < 23 ? '晚上' : '深夜'
  const 周 = '日一二三四五六'[现在.getDay()]
  const 分 = String(现在.getMinutes()).padStart(2, '0')
  return `（现在这会儿是 ${现在.getMonth() + 1} 月 ${现在.getDate()} 日 周${周} ${段名} ${时}:${分}，按这个点来想事、说话。）`
}

/**
 * 把她那句念头包好：明确「这是你自己冒出来的，不是对方发来的」。
 * 触发文案一个字不改（那是她在设置里定的口吻）。
 */
export function 框住内心话(文案, 现在 = new Date(), 距上次 = null) {
  const 原话 = String(文案 == null ? '' : 文案).trim()
  const 间隔行 = Number.isFinite(距上次)
    ? '（他上一次开口是 ' + 多久前(距上次) + '前，之后一直没理你。要不要提、怎么提由你自己拿主意。）'
    : ''
  return (
    '（下面这句是**你自己心里冒出来的念头**，不是对方说的话；' +
    '顺着它去做就行，别把它当成对方发来的消息、也不用回应它。）' +
    String.fromCharCode(10) +
    现在这行(现在) +
    (间隔行 === '' ? '' : String.fromCharCode(10) + 间隔行) +
    String.fromCharCode(10) +
    原话
  )
}

function 新id() {
  const 时 = Date.now().toString(36)
  const 随 = Math.random().toString(36).slice(2, 10)
  return `${源标记}-${时}-${随}`
}

/** 手搓一条 user 消息（形状照 @deepseek-ai/dsh-llm 的 createUserMessage 抄）。 */
function 造消息(文案) {
  return {
    id: 新id(),
    role: 'user',
    content: [{ type: 'text', text: String(文案) }],
    source: { kind: 源标记 },
  }
}

/** 从插件自己的映射文件里读「私聊 605062555」当前是哪条会话 —— /new 换 id 也能跟上。 */
export function 当前会话id(配置 = 默认配置) {
  try {
    const 表 = JSON.parse(readFileSync(映射文件, 'utf8'))
    const 值 = 表 && 表[配置.会话键]
    if (typeof 值 === 'string' && 值.trim() !== '') return 值.trim()
    if (值 && typeof 值 === 'object' && typeof 值.session === 'string' && 值.session.trim() !== '') return 值.session.trim()
  } catch (error) {
    /* 读不到就让调用方去兜底 */
  }
  return ''
}

/** 按 id 找活着的 agent，带不带 session- 前缀都认。 */
function 找agent(ctx, id) {
  const 原 = String(id == null ? '' : id).trim()
  if (原 === '') return undefined
  const 候选 = [原]
  if (原.startsWith('session-')) 候选.push(原.slice('session-'.length))
  else 候选.push('session-' + 原)
  for (const 一个 of 候选) {
    try {
      const a = ctx.agents.get(一个)
      if (a !== undefined) return a
    } catch (error) {
      /* agents 服务查不动 -> 当成没找到 */
    }
  }
  return undefined
}

/** 送一轮。返回 true = 已经交给她了；false = 这轮没送成（下一分钟还能再试）。 */
async function 发一轮(ctx, 配置, 项) {
  const 会话id = 当前会话id(配置)
  if (会话id === '') {
    记日志('没有拿到当前会话 id（chat-sessions.json 里没有这个键），这轮跳过')
    return false
  }
  const agent = 找agent(ctx, 会话id)
  if (agent === undefined) {
    记日志(`会话 ${会话id} 现在没挂起来（找不到 agent），这轮跳过`)
    return false
  }
  const 状态 = agent.status
  if (状态 !== undefined && 状态 !== 'idle') {
    记日志(`她正忙（status=${状态}），这轮等一等`)
    return false
  }
  const 距上次 = 距上次说话分钟(agent, 会话id)
  const 文案 = 框住内心话(配置.触发文案, new Date(), 距上次)
  try {
    await agent.followup(造消息(文案))
    记日志(`已送出（${项.类} ${分钟转字(项.分钟)}）：${String(配置.触发文案).slice(0, 40)}…`)
    try {
      if (ctx.sessions && typeof ctx.sessions.flush === 'function') await ctx.sessions.flush(agent.session)
    } catch (error) {
      /* 落盘没确认不算失败 */
    }
    return true
  } catch (error) {
    记日志(`followup 失败：${String((error && error.message) || error)}`)
    return false
  }
}

export function apply(ctx) {
  try {
    const 配置0 = 读配置()
    记日志(`装好了 v1.2.0｜固定窗口 ${JSON.stringify(配置0.固定窗口)}｜额外 ${JSON.stringify(配置0.额外次数)} 次（${JSON.stringify(配置0.额外时段)}，避开固定窗口前后 ${配置0.额外避开分钟} 分钟）｜安静 ${配置0.安静起}~${配置0.安静止} 点`)

    let 计划 = null
    let 日 = ''
    const 已发 = new Set()
    let 上次心跳 = 0

    /** 存盘的表 → 带 at 的条目；日期对不上或文件坏了就返回 null（重新摇）。 */
    const 读存盘计划 = (今天, 零点) => {
      try {
        const 存 = JSON.parse(readFileSync(计划文件, 'utf8'))
        if (!存 || 存.日期 !== 今天 || !Array.isArray(存.表)) return null
        const 表 = 存.表
          .filter((x) => x && Number.isFinite(Number(x.分钟)))
          .map((x) => ({
            类: String(x.类 || '固定'),
            窗: String(x.窗 || ''),
            分钟: Number(x.分钟),
            at: 零点 + Number(x.分钟) * 60000,
          }))
        // 守卫：配置里声明的固定窗口，存盘表里必须都在。少一条就说明这份表是用错的配置
        // （比如默认配置、或者测试脚本）算出来的，不能信，重摇（2026-11-15 19:42 就是这么丢的）。
        const 现存配置 = 读配置()
        const 固定应有 = Array.isArray(现存配置.固定窗口)
          ? 现存配置.固定窗口.filter((w) => Array.isArray(w) && w.length >= 2).length
          : 0
        const 固定实有 = 表.filter((x) => x.类 === '固定').length
        if (固定应有 !== 固定实有) return null
        return 表.length > 0 ? 表 : null
      } catch (error) {
        return null
      }
    }

    const 存计划 = (今天, 表) => {
      try {
        // 同样的守卫：配置里有几个固定窗口，表里就该有几个固定项，否则别把错表落盘。
        const 现存配置 = 读配置()
        const 固定应有 = Array.isArray(现存配置.固定窗口)
          ? 现存配置.固定窗口.filter((w) => Array.isArray(w) && w.length >= 2).length
          : 0
        const 固定实有 = 表.filter((x) => x.类 === '固定').length
        if (固定应有 !== 固定实有) {
          记日志(`计划里的固定项 ${固定实有} 条、配置要求 ${固定应有} 条，对不上，这次不存盘`)
          return
        }
        const 内容 = JSON.stringify({ 日期: 今天, 表: 表.map((x) => ({ 类: x.类, 窗: x.窗, 分钟: x.分钟 })) }, null, 2)
        writeFileSync(计划文件 + '.tmp', 内容)
        renameSync(计划文件 + '.tmp', 计划文件)
      } catch (error) {
        记日志(`计划存盘失败：${String((error && error.message) || error)}`)
      }
    }

    const 走一轮 = async () => {
      const 配置 = 读配置()
      if (!配置.总开关) return
      const 现在 = new Date()
      if (在安静时段(现在.getHours(), 数(配置.安静起, 23), 数(配置.安静止, 9))) return

      const 今天 = `${现在.getFullYear()}-${String(现在.getMonth() + 1).padStart(2, '0')}-${String(现在.getDate()).padStart(2, '0')}`
      if (日 !== 今天 || 计划 === null) {
        日 = 今天
        已发.clear()
        const 零点 = 当天零点(现在)
        计划 = 读存盘计划(今天, 零点)
        if (计划 === null) {
          计划 = 今日计划(配置, 现在)
          存计划(今天, 计划)
        }
        记日志('今天的表：' + 计划.map((x) => `${x.类} ${分钟转字(x.分钟)}`).join('、'))
      }

      // 每隔半小时留一行「还活着」，免得静默的时候分不清是没到点还是插件死了。
      if (现在.getTime() - 上次心跳 >= 30 * 60000) {
        上次心跳 = 现在.getTime()
        const 待发 = 计划.filter((x, i) => !已发.has(i) && 现在.getTime() <= x.at + 数(配置.固定宽限分钟, 20) * 60000)
        记日志(`还在跑｜今日 ${计划.length} 条，已发 ${已发.size}，待发 ${待发.length}${待发.length > 0 ? '：' + 待发.map((x) => 分钟转字(x.分钟)).join('、') : ''}`)
      }

      // 手动触发：放个空文件进来，这一轮就立刻发一条。
      if (existsSync(触发文件)) {
        try {
          unlinkSync(触发文件)
        } catch (error) {
          /* 删不掉也照发 */
        }
        const 分钟 = 现在.getHours() * 60 + 现在.getMinutes()
        记日志('手动触发：立刻发一条')
        await 发一轮(ctx, 配置, { 类: '手动', 窗: '手动', 分钟 })
      }

      for (let i = 0; i < 计划.length; i++) {
        if (已发.has(i)) continue
        const 项 = 计划[i]
        if (现在.getTime() < 项.at) continue
        const 宽限 = (项.类 === '固定' ? 数(配置.固定宽限分钟, 20) : 数(配置.额外宽限分钟, 40)) * 60000
        if (现在.getTime() > 项.at + 宽限) {
          已发.add(i)
          记日志(`错过了 ${分钟转字(项.分钟)}（${项.类}），已经超过宽限，不补`)
          continue
        }
        const 成 = await 发一轮(ctx, 配置, 项)
        if (成) 已发.add(i)
      }
    }

    // 30 秒看一眼表：够准（窗口最小 30 分钟），又不会频繁唤醒。
    if (typeof ctx.interval === 'function') {
      ctx.interval(() => {
        void 走一轮().catch((error) => 记日志(`这一轮出错：${String((error && error.message) || error)}`))
      }, 30000)
    } else {
      setInterval(() => {
        void 走一轮().catch((error) => 记日志(`这一轮出错：${String((error && error.message) || error)}`))
      }, 30000)
      记日志('ctx.interval 不在，用了全局 setInterval（插件卸载时可能收不干净，但不影响功能）')
    }

    // 面板要看的「现在是什么状态」
    const 取状态 = () => {
      const 配置 = 读配置()
      const 现在 = new Date()
      const 今天 = `${现在.getFullYear()}-${String(现在.getMonth() + 1).padStart(2, '0')}-${String(现在.getDate()).padStart(2, '0')}`
      const 表 = (计划 || []).map((x, i) => ({
        时间: 分钟转字(x.分钟),
        类: x.类,
        窗: x.窗,
        已发: 已发.has(i),
        已过: 现在.getTime() > x.at,
      }))
      const 下一个 = 表.filter((x, i) => !已发.has(i) && 计划[i].at >= 现在.getTime()).map((x) => x.时间)[0] || ''
      return {
        ok: true,
        版本: '1.2.0',
        配置,
        默认配置,
        计划: 表,
        哪天: 日 || 今天,
        现在: 分钟转字(现在.getHours() * 60 + 现在.getMinutes()),
        下一个: 下一个 || (表.length > 0 ? '今天没有了' : '还没排表'),
        安静中: 在安静时段(现在.getHours(), 数(配置.安静起, 23), 数(配置.安静止, 9)),
        会话id: 当前会话id(配置),
        日志: 读日志(40),
        配置文件,
        日志文件,
      }
    }

    // ── 设置面板用的本机接口 ────────────────────────────────────────────
    const 回 = (res, 对象) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(对象))
    }

    const 站内 = (req, res) => {
      let 拒
      try {
        const 连接 = ctx.get && ctx.get('connection')
        拒 = 连接 && typeof 连接.requestRejection === 'function' ? 连接.requestRejection(req) : undefined
      } catch (error) {
        拒 = undefined
      }
      if (拒 !== undefined) {
        res.writeHead(拒 || 403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(拒 === 401 ? 'unauthorized' : 'forbidden')
        return true
      }
      const 头 = req.headers || {}
      const 站 = String(头['sec-fetch-site'] || '').toLowerCase()
      const 源 = String(头.origin || '').trim()
      const 本机来源 = /^(?:dsh-app:|https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/?$)/i
      if (站 === 'cross-site' || (源 && !本机来源.test(源))) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden')
        return true
      }
      return false
    }

    const 读体 = async (req) => {
      let 体 = ''
      for await (const 块 of req) 体 += 块
      try {
        return JSON.parse(体 || '{}')
      } catch (error) {
        return {}
      }
    }

    const 路线 = (路径, 处理, 只收POST) =>
      ctx.effect(() =>
        ctx.webServer.register({
          kind: 'exact',
          path: 路径,
          handler: async (req, res) => {
            try {
              if (站内(req, res)) return
              if (只收POST && req.method !== 'POST') {
                res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'POST' })
                res.end(JSON.stringify({ ok: false, 说: '这条只接受 POST' }))
                return
              }
              await 处理(req, res)
            } catch (error) {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, 说: String((error && error.message) || error) }))
            }
          },
        }),
      )

    路线(路由前缀 + '/state', async (req, res) => 回(res, 取状态()), false)

    路线(
      路由前缀 + '/save',
      async (req, res) => {
        const 体 = await 读体(req)
        const 新配置 = 规范配置(体 && 体.配置 ? 体.配置 : 体)
        const 旧配置 = 读配置()
        写配置(新配置)
        // 改了表就当场重排（已经发过的今天不再补发，也不重复发）
        if (JSON.stringify(旧配置.固定窗口) !== JSON.stringify(新配置.固定窗口)
          || JSON.stringify(旧配置.额外次数) !== JSON.stringify(新配置.额外次数)
          || JSON.stringify(旧配置.额外时段) !== JSON.stringify(新配置.额外时段)
          || 旧配置.额外避开分钟 !== 新配置.额外避开分钟) {
          const 现在 = new Date()
          计划 = 今日计划(新配置, 现在)
          已发.clear()
          for (let i = 0; i < 计划.length; i++) {
            const 宽限 = (计划[i].类 === '固定' ? 新配置.固定宽限分钟 : 新配置.额外宽限分钟) * 60000
            if (现在.getTime() > 计划[i].at + 宽限) 已发.add(i)
          }
          存计划(`${现在.getFullYear()}-${String(现在.getMonth() + 1).padStart(2, '0')}-${String(现在.getDate()).padStart(2, '0')}`, 计划)
          记日志('设置页改了表，重排成：' + 计划.map((x) => `${x.类} ${分钟转字(x.分钟)}`).join('、'))
        }
        记日志(`设置页保存：总开关=${新配置.总开关 ? '开' : '关'}｜固定 ${新配置.固定窗口.length} 段｜额外 ${新配置.额外次数.join('~')} 次｜安静 ${新配置.安静起}~${新配置.安静止} 点`)
        回(res, 取状态())
      },
      true,
    )

    路线(
      路由前缀 + '/send',
      async (req, res) => {
        const 配置 = 读配置()
        const 现在 = new Date()
        const 项 = { 类: '手动', 窗: '手动', 分钟: 现在.getHours() * 60 + 现在.getMinutes(), at: 现在.getTime() }
        const 成 = await 发一轮(ctx, 配置, 项)
        回(res, { ok: 成, 说: 成 ? '已经交给她了，稍等一下' : '这轮没送成，看看下面的日志', 状态: 取状态() })
      },
      true,
    )

    // 起来就先算一次表（到点才发，不立刻发）
    void 走一轮().catch(() => {})
  } catch (error) {
    记日志(`apply 出错：${String((error && error.message) || error)}`)
  }
}

