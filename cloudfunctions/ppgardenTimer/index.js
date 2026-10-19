// 云函数：ppgardenTimer
// 云上花匠（ppgarden.top）花园托管定时调度（按花园配置时段版）
//
// 调度模型：
//   - 网站同一账号同时只能托管一个花园（并发位=1），多个花园按小时错峰轮换
//   - 每个「花园」独立配置每小时托管时段，如 [{start:0,stop:4},{start:30,stop:34}]
//     表示每小时的 00~04 分、30~34 分托管该花园，其余时间暂停
//   - 某小时可单独配置「专属时段」（hourWindows，如 21~22 点）：
//     该小时使用专属时段替代整体每小时时段，其余小时仍沿用整体时段
//     取用规则见 effectiveWindows()；专属时段为空等同未配置（沿用整体时段）
//   - 同一账号下不同花园的时段不允许重叠（保存校验 + 运行时守卫，按小时比较「有效时段」），
//     支持一键随机错峰分配（时段 4~5 分钟、间隔 25~30 分钟随机）；
//     各托管账号相互独立，跨账号时段不构成冲突
//   - 每个花园有独立的定时托管开关
//   - 执行启停前先查询网站实际托管状态：已处于目标状态的操作直接跳过，避免冗余接口调用
//
// 登录策略：
//   每个网站账号每天只登录一次（会话 Cookie 缓存到数据库），当天复用；
//   Cookie 失效(401)自动重登；每天首次登录成功后自动加载网站内花园列表。
//
// 手动模式（管理端小程序调用，需 token）：
//   action: list / add / update / delete / logs / status
//           loadGardens / setGardenConfig / autoAssignAll
//           startGarden / pauseGarden / setMaster / runSchedule / siteActivity / gardenActivity
//
// 手动启动：手动启动的花园运行 MANUAL_RUN_MINUTES 分钟后由每分钟定时器自动暂停
//   （日志 trigger = 'auto'，不受定时任务总开关影响）

const cloud = require('wx-server-sdk')
const https = require('https')
const crypto = require('crypto')
const { requireAuth } = require('./auth')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

// ==================== 配置 ====================
const PPG_HOST = 'ppgarden.top'
const ACCOUNTS_COLL = 'ppgarden_accounts' // 账号、花园时段配置与会话缓存
const LOGS_COLL = 'ppgarden_logs'         // 执行日志集合
const STATE_COLL = 'ppgarden_state'       // 全局开关（单文档 global）
const STATE_DOC_ID = 'global'
const TIMER_NAME = 'ppgarden-timer-minute'
const STATUS_COLL = 'ppgarden_status'     // 花园状态（含 todayOutput.flowerLevels.flowers 的花朵 ID→名称映射）
const FLOWER_CACHE_COLL = 'ppgarden_flower_names' // 花朵 ID → 名称 全局映射缓存
const STOCK_COLL = 'ppgarden_stock'       // 各花园库存快照（按账号+花园，弹窗时刷新）

// sell-quote 报价内存缓存（requestId -> { at, sellers }），避免 5 秒自动刷新反复调用
const _quoteCache = {}
const QUOTE_TTL_MS = 60 * 1000

// 时段自动分配参数（随机区间）
const MIN_WINDOW_MIN = 4    // 单时段最短（分钟）
const MAX_WINDOW_MIN = 5    // 单时段最长（分钟）
const MIN_GAP_MIN = 25      // 同花园两时段间隔最短（分钟）
const MAX_GAP_MIN = 30      // 同花园两时段间隔最长（分钟）
const MIN_CROSS_GAP_MIN = 3 // 同一账号内与其它花园时段的最小间距（分钟）
const START_TOLERANCE_MIN = 2 // 错过整点后，start 分钟起 2 分钟内仍可补启动
const STOP_TOLERANCE_MIN = 2  // 错过整点后，stop 分钟起 2 分钟内仍可补暂停

const MAX_WINDOWS_PER_GARDEN = 6
const MIN_WINDOW_DURATION = 2 // 手动设置时单时段最短时长（分钟）

const MANUAL_RUN_MINUTES = 3 // 手动启动的花园运行多少分钟后自动暂停

const TZ_OFFSET_MS = 8 * 3600 * 1000 // 东八区（Asia/Shanghai）
const HTTP_TIMEOUT_MS = 20000
const DB_BATCH_SIZE = 100
const LOG_RETENTION_DAYS = 14

// 托管状态中文映射（对应网站 API 的 state 字段）
const STATE_TEXT = {
  paused: '已暂停',
  armed: '已就绪',
  managed: '托管中',
  running: '运行中',
  schedule_wait: '等待定时',
  finishing: '收尾中',
  blocked: '受阻'
}

// ==================== 基础工具 ====================
function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

function randInt(min, max) {
  // 含首尾的随机整数
  return min + Math.floor(Math.random() * (max - min + 1))
}

function nowCST() {
  return new Date(Date.now() + TZ_OFFSET_MS)
}

// 由于已把时间戳 +8h，用 UTC 方法取值即为东八区时间
function cstDateStr(d) {
  return d.toISOString().slice(0, 10)
}

// 小时槽位：'YYYYMMDDHH'（东八区），用于每小时去重
function hourSlotOf(d) {
  return cstDateStr(d).replace(/-/g, '') + pad2(d.getUTCHours())
}

function uuidv4() {
  if (crypto.randomUUID) return crypto.randomUUID()
  const b = crypto.randomBytes(16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = b.toString('hex')
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20)
}

function windowsText(windows) {
  return (windows || []).map(w => pad2(w.start) + '~' + pad2(w.stop)).join('、')
}

// 某小时的「有效时段」：优先取该小时的专属时段 cfg.hourWindows[hour]（如 21~22 点单独设置），
// 未配置该小时专属时段时回退到整体每小时时段 cfg.windows。
// 注意：专属时段为空数组等同未配置（仍沿用整体时段）
function effectiveWindows(cfg, hour) {
  if (!cfg) return []
  const hw = cfg.hourWindows
  const list = hw && hw[String(hour)]
  if (Array.isArray(list) && list.length) return list
  return Array.isArray(cfg.windows) ? cfg.windows : []
}

// ==================== 数据库工具 ====================
// 获取集合全部文档（先 count 再并发分页）
async function getAllDocs(collectionName) {
  const countRes = await db.collection(collectionName).count()
  const total = countRes.total || 0
  if (total === 0) return []

  const batchTimes = Math.ceil(total / DB_BATCH_SIZE)
  const tasks = []
  for (let i = 0; i < batchTimes; i++) {
    tasks.push(
      db.collection(collectionName)
        .skip(i * DB_BATCH_SIZE)
        .limit(DB_BATCH_SIZE)
        .get()
    )
  }
  const results = await Promise.all(tasks)
  return results.reduce((acc, r) => acc.concat(r.data || []), [])
}

// 确保集合存在（TCB 不会自动建集合）
let _collectionsReady = null
function ensureCollections() {
  if (!_collectionsReady) {
    _collectionsReady = (async () => {
      for (const name of [ACCOUNTS_COLL, LOGS_COLL, STATE_COLL, FLOWER_CACHE_COLL, STOCK_COLL]) {
        try {
          await db.createCollection(name)
          console.log('[PPGarden] 已创建集合:', name)
        } catch (e) {
          // 已存在时会抛错，忽略
        }
      }
    })().catch(e => {
      console.error('[PPGarden] 初始化集合失败:', e.message)
      _collectionsReady = null
    })
  }
  return _collectionsReady
}

async function saveLog(entry) {
  try {
    await db.collection(LOGS_COLL).add({ data: entry })
  } catch (e) {
    console.error('[PPGarden] 写日志失败:', e.message)
  }
}

// 全局开关（单文档）
async function getGlobalState() {
  try {
    const res = await db.collection(STATE_COLL).doc(STATE_DOC_ID).get()
    return res.data || null
  } catch (e) {
    return null
  }
}

async function ensureGlobalState() {
  let st = await getGlobalState()
  if (st) return st
  try {
    const initData = {
      _id: STATE_DOC_ID,
      masterEnabled: true, // 定时任务总开关
      updatedAt: db.serverDate()
    }
    await db.collection(STATE_COLL).add({ data: initData })
    st = initData
  } catch (e) {
    st = await getGlobalState()
  }
  return st || { masterEnabled: true }
}

// ==================== ppgarden.top HTTP 客户端 ====================
function httpRequest({ method = 'GET', path, body = null, cookie = null, timeoutMs = HTTP_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null
    // 请求头与浏览器保持一致（站点在 Cloudflare 后面，头不一致可能被 bot 检测拦截）
    const headers = {
      'accept': 'application/json',
      'accept-language': 'zh-CN,zh;q=0.9',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
      'referer': 'https://' + PPG_HOST + '/',
      'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not(A:Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin'
    }
    if (postData) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = Buffer.byteLength(postData)
    }
    if (cookie) headers['cookie'] = cookie

    const req = https.request({
      hostname: PPG_HOST,
      port: 443,
      path,
      method,
      headers,
      timeout: timeoutMs
    }, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        let json = null
        try {
          json = data ? JSON.parse(data) : null
        } catch (e) {
          json = null
        }
        resolve({ status: res.statusCode, headers: res.headers, json, raw: data })
      })
    })

    req.on('timeout', () => {
      req.destroy(new Error('请求超时（' + (timeoutMs / 1000) + 's）'))
    })
    req.on('error', reject)
    if (postData) req.write(postData)
    req.end()
  })
}

// 把 Set-Cookie 响应头解析为 'k1=v1; k2=v2' 形式
function parseSetCookies(res) {
  const list = (res.headers && res.headers['set-cookie']) || []
  const jar = {}
  for (const line of list) {
    const pair = String(line).split(';')[0]
    const eq = pair.indexOf('=')
    if (eq > 0) {
      jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
    }
  }
  return Object.keys(jar).map(k => k + '=' + jar[k]).join('; ')
}

// 强制重新登录（不使用缓存），成功后更新库内 Cookie
async function forceLogin(acc) {
  const res = await httpRequest({
    method: 'POST',
    path: '/api/auth/login',
    body: { username: acc.username, password: acc.password, remember: true }
  })
  if (res.status !== 200) {
    const msg = (res.json && res.json.message) ? res.json.message : ('HTTP ' + res.status)
    const err = new Error('登录失败：' + msg)
    err.status = res.status
    err.isLogin = true
    throw err
  }
  const cookie = parseSetCookies(res)
  if (!cookie) {
    const err = new Error('登录成功但未返回会话 Cookie')
    err.isLogin = true
    throw err
  }
  const today = cstDateStr(nowCST())
  await db.collection(ACCOUNTS_COLL).doc(acc._id).update({
    data: { cookie, lastLoginDate: today, loginErrorDate: null, updatedAt: db.serverDate() }
  }).catch(() => {})
  return cookie
}

// 获取可用会话：当天已登录则复用缓存 Cookie，否则登录一次
async function ensureSession(acc) {
  const today = cstDateStr(nowCST())
  if (acc.cookie && acc.lastLoginDate === today) return acc.cookie
  return forceLogin(acc)
}

// 会话包装：401 时自动重新登录并重试一次
async function withSession(acc, fn) {
  let cookie = await ensureSession(acc)
  try {
    return await fn(cookie)
  } catch (err) {
    if (err && err.status === 401) {
      cookie = await forceLogin(acc)
      return await fn(cookie)
    }
    throw err
  }
}

// 已持有 cookie 的会话包装（供工作循环使用，避免同一周期内重复登录）
async function ppWithRetry(acc, cookie, fn) {
  try {
    return await fn(cookie)
  } catch (err) {
    if (err && err.status === 401) {
      const fresh = await forceLogin(acc)
      return await fn(fresh)
    }
    throw err
  }
}

// 批量启动/暂停托管（enabled: true 启动 / false 暂停；gardenIds 为空表示全部花园）
async function ppBulkHosting(cookie, enabled, gardenIds) {
  const body = {
    enabled,
    operationId: uuidv4()
  }
  if (Array.isArray(gardenIds) && gardenIds.length) {
    body.gardenIds = gardenIds.slice().sort()
  }

  let res = await httpRequest({
    method: 'POST',
    path: '/api/hosting/bulk',
    body,
    cookie
  })

  // 新用户首次开启托管需确认试用条款，自动带上 trialConsent 重试一次
  if (res.status === 409 && res.json && res.json.error === 'trial_consent_required') {
    body.trialConsent = true
    res = await httpRequest({
      method: 'POST',
      path: '/api/hosting/bulk',
      body,
      cookie
    })
  }

  if (res.status === 401) {
    const err = new Error('会话已失效')
    err.status = 401
    throw err
  }
  if (res.status !== 200 || !res.json) {
    const msg = (res.json && res.json.message) ? res.json.message : ('HTTP ' + res.status)
    throw new Error('托管操作失败：' + msg)
  }
  return res.json
}

// 托管总览（每个花园的托管状态）
async function ppHostingSummary(cookie) {
  const res = await httpRequest({ path: '/api/hosting-summary', cookie })
  // 打印接口原始返回（完整数据，便于排查有哪些字段可用）
  console.log('[PPGarden] /api/hosting-summary 原始响应, status:', res.status,
    'body:', JSON.stringify(res.json, null, 2))
  if (res.status === 401) {
    const err = new Error('会话已失效')
    err.status = 401
    throw err
  }
  if (res.status !== 200 || !res.json) throw new Error('查询托管状态失败：HTTP ' + res.status)
  return res.json
}

// 查询各花园当前托管状态，返回 { gardenId: state } 映射（state 取值见 STATE_TEXT）
async function ppGardenStateMap(cookie) {
  const json = await ppHostingSummary(cookie)
  const map = {}
  for (const g of (json && json.gardens) || []) {
    map[g.gardenId] = g.state
  }
  return map
}

// 钱包信息：GET /api/wallet
// 返回 { serverTime, paidMs, pendingMs, effectiveMs(剩余时长/毫秒), lockedMs, display, ... }
async function ppWallet(cookie) {
  const res = await httpRequest({ path: '/api/wallet', cookie })
  console.log('[PPGarden] /api/wallet 原始响应, status:', res.status,
    'body:', JSON.stringify(res.json))
  if (res.status === 401) {
    const err = new Error('会话已失效')
    err.status = 401
    throw err
  }
  if (res.status !== 200 || !res.json) throw new Error('查询钱包失败：HTTP ' + res.status)
  return res.json
}

// 交易记录：GET /api/trade/orders?role=sell|buy
// 返回数组，元素含 { id, orderId, kind, role, flowerId, quality, groups, pricePerGroup,
//   feePerGroup, status, createdAt, updatedAt, settledAt, legs:[{ sellerGardenId, groups, ... }] }
async function ppOrders(cookie, role) {
  const r = role === 'buy' ? 'buy' : 'sell'
  const res = await httpRequest({ path: '/api/trade/orders?role=' + r, cookie })
  console.log('[PPGarden] /api/trade/orders?role=' + r + ' 原始响应, status:', res.status,
    'body:', JSON.stringify(res.json).slice(0, 2000))
  if (res.status === 401) {
    const err = new Error('会话已失效')
    err.status = 401
    throw err
  }
  if (res.status !== 200 || !res.json) throw new Error('查询交易记录失败：HTTP ' + res.status)
  // 兼容数组或 { items/orders/list: [] } 两种返回结构
  if (Array.isArray(res.json)) return res.json
  for (const k of ['items', 'orders', 'list', 'data']) {
    if (Array.isArray(res.json[k])) return res.json[k]
  }
  return []
}

// 求购列表：GET /api/trade/requests?channel=official
// 返回数组，元素含 { id, orderId, flowerId, quality, groups, pricePerGroup, sellPrice?, deadlineAt, ... }
// 兼容数组或 { items/requests/list: [] }
async function ppTradeRequests(cookie) {
  const res = await httpRequest({ path: '/api/trade/requests?channel=official', cookie })
  console.log('[PPGarden] /api/trade/requests 原始响应, status:', res.status,
    'body:', JSON.stringify(res.json).slice(0, 1500))
  if (res.status === 401) {
    const err = new Error('会话已失效')
    err.status = 401
    throw err
  }
  if (res.status !== 200 || !res.json) throw new Error('查询求购列表失败：HTTP ' + res.status)
  if (Array.isArray(res.json)) return res.json
  for (const k of ['items', 'requests', 'list', 'data']) {
    if (Array.isArray(res.json[k])) return res.json[k]
  }
  return []
}

// 「只看我能卖的」：GET /api/trade/sellable-stock?channel=official
// 返回 { items: [{ flowerId, quality, sellableGroups }] }，表示当前账号可卖的花朵及组数
async function ppSellableStock(cookie) {
  const res = await httpRequest({ path: '/api/trade/sellable-stock?channel=official', cookie })
  console.log('[PPGarden] /api/trade/sellable-stock 原始响应, status:', res.status,
    'body:', JSON.stringify(res.json).slice(0, 800))
  if (res.status === 401) {
    const err = new Error('会话已失效')
    err.status = 401
    throw err
  }
  if (res.status !== 200 || !res.json) throw new Error('查询可卖库存失败：HTTP ' + res.status)
  if (Array.isArray(res.json)) return res.json
  for (const k of ['items', 'stocks', 'list', 'data']) {
    if (Array.isArray(res.json[k])) return res.json[k]
  }
  return []
}

// 花园货架（库存）：GET /api/trade/listings?gardenId={gardenId}
// 返回该花园的库存明细，关键字段：
//   summary: { count, sellableGroups, totalGroups, buyingGroups, lastSaleAt, lastAt }
//   items: [{ flowerId, quality, count, groups, sellableGroups, sellGroups,
//             sellPricePerGroup, pricePerGroup, sellCapMin, sellCapMax, hasSellRange, enabled }]
async function ppGardenListings(cookie, gardenId) {
  const res = await httpRequest({
    path: '/api/trade/listings?gardenId=' + encodeURIComponent(gardenId),
    cookie,
    timeoutMs: 12000
  })
  if (res.status === 401) {
    const err = new Error('会话已失效')
    err.status = 401
    throw err
  }
  const s = res.json && res.json.summary
  console.log('[PPGarden][库存] /api/trade/listings gardenId:', gardenId,
    'status:', res.status,
    'summary:', JSON.stringify(s),
    'items数:', Array.isArray(res.json && res.json.items) ? res.json.items.length : (res.json && res.json.items === undefined ? 'items字段缺失' : typeof (res.json || {}).items),
    'body顶层字段:', JSON.stringify(res.json && typeof res.json === 'object' && !Array.isArray(res.json) ? Object.keys(res.json) : typeof res.json),
    'body前600字符:', JSON.stringify(res.json).slice(0, 600))
  if (res.status !== 200 || !res.json) throw new Error('查询花园库存失败：HTTP ' + res.status)
  return res.json
}

// 卖花报价：GET /api/trade/requests/{requestId}/sell-quote
// 返回 { requestId, pricePerGroup, sellerGetsPerGroup, remainingGroups,
//        sellers: [{ gardenId, haveCount, sellableGroups, groups, blockCode, blockText }],
//        mode: 'direct_sell' }
// 这是网页点击「卖给他」时用来判断各账号可卖几组的接口。
async function ppSellQuote(cookie, requestId, quiet) {
  const paths = [
    '/api/trade/requests/' + encodeURIComponent(requestId) + '/sell-quote',
    '/api/trade/requests/' + encodeURIComponent(requestId) + '/self-quote'
  ]
  let lastErr = null
  for (const p of paths) {
    const res = await httpRequest({ path: p, cookie, timeoutMs: 12000 })
    if (!quiet) {
      console.log('[PPGarden] sell-quote 原始响应', p, 'status:', res.status,
        'body:', JSON.stringify(res.json).slice(0, 800))
    }
    if (res.status === 401) {
      const err = new Error('会话已失效')
      err.status = 401
      throw err
    }
    if (res.status === 200 && res.json) return res.json
    lastErr = new Error('查询卖花报价失败：HTTP ' + res.status)
  }
  throw lastErr || new Error('查询卖花报价失败')
}

// 接单卖花：POST /api/trade/requests/{requestId}/accept
// 请求体（站点白名单校验，只能含这三个字段）：
//   { sellerGardenId, groups, expect: { pricePerGroup, targetCount } }
async function ppAcceptRequest(cookie, requestId, groups, pricePerGroup, gardenId, targetCount) {
  const path = '/api/trade/requests/' + encodeURIComponent(requestId) + '/accept'
  const body = {
    sellerGardenId: gardenId,
    groups,
    expect: {
      pricePerGroup: Number(pricePerGroup) || 0,
      targetCount: Number(targetCount) || 0
    }
  }
  const res = await httpRequest({ method: 'POST', path, body, cookie, timeoutMs: 12000 })
  console.log('[PPGarden] 接单响应 status:', res.status,
    '请求体:', JSON.stringify(body),
    'body:', JSON.stringify(res.json).slice(0, 600))
  if (res.status === 401) {
    const err = new Error('会话已失效')
    err.status = 401
    throw err
  }
  if (res.status !== 200 || !res.json) {
    const msg = (res.json && (res.json.message || res.json.error)) ? (res.json.message || res.json.error) : ('HTTP ' + res.status)
    throw new Error('接单失败：' + msg)
  }
  return res.json
}

// 汇总一条求购的可卖情况：合计组数 / 是否可接单 / 每个花园是否可接单
// 注意：groups 变化（如用 sell-quote 覆盖）后需要重新调用一次
function finalizeRequestItem(it) {
  const list = Array.isArray(it.gardenStockList) ? it.gardenStockList : []
  const totalGroups = list.reduce((n, x) => n + (Number(x.groups) > 0 ? Number(x.groups) : 0), 0)
  it.sellableGroups = totalGroups
  it.sellableText = totalGroups > 0 ? ('可卖 ' + totalGroups + ' 组') : ''
  it.hasStockGardens = list.filter(x => Number(x.groups) > 0).length

  // 不可接单的原因（按优先级）：非开放 > 买家排队已满 > 买家游戏中 > 暂停 > 无可卖组数
  let reason = ''
  if (it.status !== 'open') {
    reason = '求购已结束'
  } else if (it.buyerQueueFull) {
    reason = '对方排队已满'
  } else if (it.buyerPlaying) {
    reason = '对方正在游戏'
  } else if (it.pausedReason) {
    reason = it.pausedText || '求购已暂停'
  } else if (!totalGroups) {
    reason = '无可卖库存'
  }
  it.blockReason = reason
  it.canAccept = !reason && totalGroups > 0
  list.forEach(x => {
    x.canAcceptGarden = !reason && (Number(x.groups) || 0) > 0
  })
}

// 批量拉取 sell-quote，用站点实时可卖组数覆盖各花园的 groups
// 每条求购一次请求，按并发 6 批处理；超出上限的条目保持原值
async function attachSellQuotes(acc, items, maxItems) {
  // 只对「有库存、可能能接」的花朵请求报价，无库存的直接跳过
  const candidates = items.filter(it =>
    (it.gardenStockList || []).some(x => (Number(x.count) || 0) > 0))
  const list = candidates.slice(0, maxItems || candidates.length)
  if (!list.length) return 0
  const CONCURRENCY = 6
  const now = Date.now()
  let ok = 0
  let hit = 0
  // 简单清理过期缓存，防止内存无限增长
  if (Object.keys(_quoteCache).length > 500) {
    for (const k of Object.keys(_quoteCache)) {
      if (now - _quoteCache[k].at >= QUOTE_TTL_MS) delete _quoteCache[k]
    }
  }
  for (let i = 0; i < list.length; i += CONCURRENCY) {
    const batch = list.slice(i, i + CONCURRENCY)
    await Promise.all(batch.map(async it => {
      if (it.requestId == null) return
      try {
        // 60 秒内复用同一条求购的报价，避免 5 秒自动刷新反复打接口
        const cached = _quoteCache[it.requestId]
        let sellers
        if (cached && now - cached.at < QUOTE_TTL_MS) {
          sellers = cached.sellers
          hit++
        } else {
          const quote = await withSession(acc, c => ppSellQuote(c, it.requestId, true))
          sellers = (quote && (quote.sellers || quote.sellerLegs)) || []
          _quoteCache[it.requestId] = { at: now, sellers }
        }
        if (!sellers.length) return
        const byId = {}
        sellers.forEach(s => { if (s && s.gardenId) byId[s.gardenId] = s })
        ;(it.gardenStockList || []).forEach(x => {
          const leg = byId[x.gardenId]
          if (!leg) return
          const g = Number(leg.groups)
          x.groups = Number.isFinite(g) ? g : (Number(leg.sellableGroups) || 0)
          x.sellableGroups = Number(leg.sellableGroups) || x.groups
          if (leg.haveCount != null) x.count = Number(leg.haveCount) || 0
          if (leg.blockText) x.blockText = leg.blockText
          x.hasStock = x.groups > 0
        })
        it.quoteLoaded = true
        ok++
      } catch (e) {
        // 单条失败忽略，保留原有组数
      }
    }))
  }
  list.forEach(finalizeRequestItem)
  console.log('[PPGarden][报价] sell-quote 覆盖完成:', ok, '/', list.length, '缓存命中:', hit)
  return ok
}

// ==================== 花园库存（各花园 × 各花朵 可卖组数） ====================
// 拉取当前账号下每个花园的货架库存并写入 ppgarden_stock（每次调用刷新一次），
// 返回结构：
//   {
//     gardens: [{ gardenId, gardenName, sellableGroups, totalGroups, summary }],
//     flowers: { "<flowerId>_<quality>": { "<gardenId>": sellableGroups } },
//     byFlower: { "<flowerId>": { "<gardenId>": sellableGroups } },
//     updatedAt
//   }
async function refreshAccountStock(acc) {
  const gardens = Array.isArray(acc.gardenList) ? acc.gardenList : []
  console.log('[PPGarden][库存] 账号:', acc.remark || acc.username, '_id:', acc._id,
    'gardenList 长度:', gardens.length,
    'gardenList:', JSON.stringify(gardens))
  const gardensOut = []
  // flowersByKey: "flowerId_quality" -> { gardenId: sellableGroups }（只记录有库存的花园）
  const flowersByKey = {}
  // flowersByFlower: "flowerId" -> { gardenId: sellableGroups }
  const flowersByFlower = {}
  // gardenFlowerStock: gardenId -> { "flowerId_quality": { sellableGroups, count, enabled, sellCapMax, ... } }
  // 记录该花园所有花（含可卖为 0 的），用于展示「哪个花园有多少可卖」
  const gardenFlowerStock = {}

  const CONCURRENCY = 4
  for (let i = 0; i < gardens.length; i += CONCURRENCY) {
    const batch = gardens.slice(i, i + CONCURRENCY)
    await Promise.all(batch.map(async g => {
      try {
        const listing = await withSession(acc, c => ppGardenListings(c, g.id))
        // 兼容多种返回形态：{items|listings|list|data: []} 或直接是数组
        let list = []
        if (Array.isArray(listing)) list = listing
        else if (listing) {
          for (const k of ['items', 'listings', 'list', 'data']) {
            if (Array.isArray(listing[k])) { list = listing[k]; break }
          }
        }
        const summary = (listing && !Array.isArray(listing) && listing.summary) || null
        console.log('[PPGarden] 花园库存原始响应:', g.name || g.id,
          'summary:', JSON.stringify(summary),
          'items数:', list.length,
          '样本:', JSON.stringify(list.slice(0, 2)))
        let gardenStockTotal = 0
        const perFlower = {}
        for (const li of list) {
          if (!li) continue
          const fid = String(li.flowerId != null ? li.flowerId : (li.id != null ? li.id : ''))
          if (!fid) continue
          const quality = li.quality || 0
          const key = fid + '_' + quality
          // 库存数量直接取 count（花朵朵数），不做组数换算
          const qty = Number(li.count) || 0
          const prev = perFlower[key]
          perFlower[key] = {
            count: (prev ? prev.count : 0) + qty,
            enabled: prev && prev.enabled ? true : !!li.enabled,
            hasSellRange: li.hasSellRange !== undefined ? !!li.hasSellRange : (prev ? prev.hasSellRange : null),
            sellCapMax: li.sellCapInputMax != null ? li.sellCapInputMax : (li.sellCapMax != null ? li.sellCapMax : null),
            sellPricePerGroup: li.sellPricePerGroup != null ? li.sellPricePerGroup : (prev ? prev.sellPricePerGroup : null)
          }
          if (qty) {
            flowersByKey[key] = flowersByKey[key] || {}
            flowersByKey[key][g.id] = (flowersByKey[key][g.id] || 0) + qty
            flowersByFlower[fid] = flowersByFlower[fid] || {}
            flowersByFlower[fid][g.id] = (flowersByFlower[fid][g.id] || 0) + qty
            gardenStockTotal += qty
          }
        }
        gardenFlowerStock[g.id] = perFlower
        // 诊断：逐花园打印解析结果（key -> 库存数量 / 是否启用）
        const perFlowerBrief = {}
        Object.keys(perFlower).forEach(k => {
          const v = perFlower[k]
          perFlowerBrief[k] = { count: v.count, enabled: v.enabled }
        })
        console.log('[PPGarden][库存] 花园解析结果:', g.name || g.id, 'gardenId:', g.id,
          '库存合计:', gardenStockTotal, '明细:', JSON.stringify(perFlowerBrief))
        gardensOut.push({
          gardenId: g.id,
          gardenName: g.name || g.id,
          stockCount: gardenStockTotal,
          totalGroups: summary ? summary.totalGroups : null,
          listedKinds: summary ? summary.listedKinds : null,
          summary
        })
      } catch (e) {
        console.error('[PPGarden][库存] 查询花园库存失败:', g.name || g.id, 'gardenId:', g.id, e.message)
        gardenFlowerStock[g.id] = {}
        gardensOut.push({
          gardenId: g.id,
          gardenName: g.name || g.id,
          stockCount: 0,
          error: e.message || '查询失败'
        })
      }
    }))
  }

  const snapshot = {
    accountId: acc._id,
    accountName: acc.remark || acc.username,
    gardens: gardensOut,
    flowers: flowersByKey,
    byFlower: flowersByFlower,
    gardenFlowerStock,
    updatedAt: db.serverDate()
  }

  // 写入数据库（每账号一条，用 accountId 作为 _id 便于覆盖）
  // 注意：db.update 是「字段合并」，若卡片字段类型变化（如 gardenFlowerStock 由数字变对象）会报
  // Cannot create field 'count' in element {...}；这里用 set 整份覆盖写入，语义更安全。
  try {
    const docId = 'acc_' + acc._id
    const coll = db.collection(STOCK_COLL)
    await coll.doc(docId).set({
      data: Object.assign({ _id: docId }, snapshot)
    }).catch(async () => {
      // 兼容部分环境 doc.set 不支持：退化为「先删后加」
      await coll.doc(docId).remove().catch(() => {})
      await coll.add({ data: Object.assign({ _id: docId }, snapshot) })
    })
  } catch (e) {
    console.error('[PPGarden] 写入库存快照失败（忽略）:', e.message)
  }

  return {
    gardens: gardensOut,
    flowers: flowersByKey,
    byFlower: flowersByFlower,
    gardenFlowerStock,
    updatedAt: Date.now()
  }
}

// 查询/刷新某账号库存（action: gardenStock）
async function handleGardenStock(event) {
  const _id = event._id
  if (!_id) return { code: 400, message: '缺少 _id' }
  let acc
  try {
    const res = await db.collection(ACCOUNTS_COLL).doc(_id).get()
    acc = res.data
  } catch (e) {
    return { code: 404, message: '账号不存在' }
  }
  if (!acc) return { code: 404, message: '账号不存在' }

  try {
    const stock = await refreshAccountStock(acc)
    const nameMap = await getFlowerNameMap()
    // 汇总各花园可卖总数 + 每个有库存的花朵明细（含名称）
    const flowers = []
    const keySet = Object.keys(stock.flowers)
    for (const key of keySet) {
      const parts = key.split('_')
      const fid = parts[0]
      const quality = Number(parts[1]) || 0
      const perGarden = stock.flowers[key]
      const total = Object.keys(perGarden).reduce((n, gid) => n + perGarden[gid], 0)
      if (!total) continue
      flowers.push({
        flowerId: fid,
        flowerName: nameMap[fid] || ('花朵 ' + fid),
        quality,
        perGarden: Object.keys(perGarden).map(gid => ({
          gardenId: gid,
          gardenName: (acc.gardenList || []).find(x => x.id === gid) ? (acc.gardenList || []).find(x => x.id === gid).name : gid,
          count: perGarden[gid]
        })),
        total
      })
    }
    flowers.sort((a, b) => b.total - a.total)

    console.log('[PPGarden][库存] gardenStock 返回:', 'accountId:', _id,
      'gardens:', JSON.stringify(stock.gardens.map(x => ({ name: x.gardenName, count: x.stockCount, err: x.error || '' }))),
      '有库存花朵数:', flowers.length,
      '花朵明细:', JSON.stringify(flowers.slice(0, 5)))

    return {
      code: 0,
      message: 'success',
      data: {
        accountId: _id,
        gardens: stock.gardens,
        flowers,
        updatedAt: stock.updatedAt
      }
    }
  } catch (err) {
    console.error('[PPGarden] 刷新库存失败:', err.message)
    return { code: 500, message: err.message || '刷新库存失败' }
  }
}

// ==================== 花朵 ID → 名称 映射 ====================
// 数据来源：ppgarden_status 集合里的花朵列表（主路径：根级 flowers[]
// 形如 [{ flowerId: 23078, name: '星河映蕊', quality: 5, ... }]；
// 兼容 status.flowerLevels.flowers 与任意嵌套层级），聚合成全局映射并缓存，
// 供交易列表/求购列表按 flowerId 显示花朵名称。
async function getFlowerNameMap() {
  // 1) 先读已有缓存（单文档 global），作为基线（历史累计，避免花朵换季/轮作后名称丢失）
  let map = {}
  try {
    const cached = await db.collection(FLOWER_CACHE_COLL).doc('global').get()
    map = Object.assign({}, (cached.data && cached.data.map) || {})
  } catch (e) { /* 缓存不存在，继续重新聚合 */ }

  // 2) 从 ppgarden_status 聚合补充（合并进基线，不覆盖已有名称）
  let added = 0
  let flowerCount = 0
  try {
    const countRes = await db.collection(STATUS_COLL).count()
    console.log('[PPGarden] ppgarden_status 文档数(count):', countRes.total)
    const docs = await getAllDocs(STATUS_COLL)
    console.log('[PPGarden] ppgarden_status 实际读取文档数:', docs.length)
    let sampleLogged = false

    // 兜底：从任意对象里递归找出所有形如 { flowerId, name } 的花卉项（兼容任意嵌套层级/字段名）
    const collectFlowers = (node, depth) => {
      if (!node || depth > 6) return
      if (Array.isArray(node)) {
        for (const it of node) collectFlowers(it, depth + 1)
        return
      }
      if (typeof node === 'string') {
        // 可能是被序列化的 JSON 字符串
        const s = node.trim()
        if (s && (s[0] === '{' || s[0] === '[')) {
          try { collectFlowers(JSON.parse(s), depth + 1) } catch (e) { /* 非 JSON，忽略 */ }
        }
        return
      }
      if (typeof node !== 'object') return
      // 命中花卉项：同时有 flowerId 和 name
      if (node.flowerId != null && node.name) {
        flowerCount++
        const id = String(node.flowerId)
        if (map[id] !== node.name) { map[id] = node.name; added++ }
        if (!sampleLogged) {
          console.log('[PPGarden] 花朵样本:', JSON.stringify(node))
          sampleLogged = true
        }
        return
      }
      for (const k of Object.keys(node)) collectFlowers(node[k], depth + 1)
    }

    for (const doc of docs) {
      // 主路径：根级 flowers[]（{ flowerId, name, quality, goldNeededPerGroup, hasSellRange }）
      if (Array.isArray(doc && doc.flowers)) {
        for (const f of doc.flowers) {
          if (f && f.flowerId != null && f.name) {
            flowerCount++
            const id = String(f.flowerId)
            if (map[id] !== f.name) { map[id] = f.name; added++ }
          }
        }
      }
      // 兼容旧路径：status.flowerLevels.flowers
      const levels = (doc && doc.status && doc.status.flowerLevels) || null
      const levelFlowers = (levels && Array.isArray(levels.flowers)) ? levels.flowers : []
      for (const f of levelFlowers) {
        if (f && f.flowerId != null && f.name) {
          flowerCount++
          const id = String(f.flowerId)
          if (map[id] !== f.name) { map[id] = f.name; added++ }
        }
      }
      // 兜底：递归扫描任意层级
      collectFlowers(doc, 0)
    }

    if (!sampleLogged && docs.length) {
      const d0 = docs[0] || {}
      console.log('[PPGarden] ppgarden_status 文档字段样本:', JSON.stringify(Object.keys(d0)))
      console.log('[PPGarden] 根级 flowers 长度:', Array.isArray(d0.flowers) ? d0.flowers.length : 0)
    }
    console.log('[PPGarden] 本次扫描到花朵条目数:', flowerCount)
  } catch (e) {
    console.error('[PPGarden] 聚合花朵名称失败:', e.message)
  }

  console.log('[PPGarden] 花朵名称映射数量:', Object.keys(map).length, '本次新增/更新:', added)
  // 3) 有新数据才写回缓存（失败不影响返回）
  if (added > 0) {
    try {
      const exists = await db.collection(FLOWER_CACHE_COLL).doc('global').get().then(() => true).catch(() => false)
      if (exists) {
        await db.collection(FLOWER_CACHE_COLL).doc('global').update({
          data: { map, updatedAt: db.serverDate() }
        })
      } else {
        await db.collection(FLOWER_CACHE_COLL).add({
          data: { _id: 'global', map, updatedAt: db.serverDate() }
        })
      }
    } catch (e) {
      console.error('[PPGarden] 缓存花朵名称映射失败（忽略）:', e.message)
    }
  }
  return map
}

// ==================== 网站动态（最新动态日志） ====================
// 花园「动态」日志：GET /api/activity?gardenId=xxx&limit=n
// 返回 { gardenId, activity: [{ id, occurredAt(毫秒时间戳), summary(日志文本), detail(结构化详情) }] }
async function ppActivityList(cookie, gardenId, limit) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 50)
  let path = '/api/activity?limit=' + n
  if (gardenId) path += '&gardenId=' + encodeURIComponent(gardenId)
  const res = await httpRequest({ path, cookie })
  if (res.status === 401) {
    const err = new Error('会话已失效')
    err.status = 401
    throw err
  }
  if (res.status !== 200 || !res.json) throw new Error('查询网站动态失败：HTTP ' + res.status)
  return res.json
}

// 东八区时间文本（MM-DD HH:mm）
function fmtCstMs(ms) {
  const d = new Date(ms + TZ_OFFSET_MS)
  return pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes())
}

// 把网站动态接口的返回归一化为 [{ id, timeMs, text, kind }]
function normalizeSiteActivity(json) {
  let list = []
  if (Array.isArray(json)) {
    list = json
  } else if (json && typeof json === 'object') {
    for (const key of ['activity', 'activities', 'items', 'logs', 'records', 'events', 'data', 'list']) {
      if (Array.isArray(json[key])) { list = json[key]; break }
    }
  }

  return list.map(it => {
    if (!it || typeof it !== 'object') return { id: '', timeMs: null, text: String(it), kind: '' }

    const rawTime = it.occurredAt || it.createdAt || it.created_at || it.time || it.timestamp
    let timeMs = null
    if (typeof rawTime === 'number') timeMs = rawTime < 1e12 ? rawTime * 1000 : rawTime
    else if (typeof rawTime === 'string' && rawTime) {
      const t = Date.parse(rawTime)
      if (!isNaN(t)) timeMs = t
    }

    const text = it.summary || it.message || it.text || it.content || ''
    const d = it.detail
    return {
      id: it.id == null ? '' : String(it.id),
      timeMs,
      text: String(text || (d && typeof d === 'object' ? JSON.stringify(d).slice(0, 200) : '')),
      kind: d && typeof d === 'object' ? String(d.kind || '') : ''
    }
  })
}

// 网站内添加的花园列表（仅刷新名称信息，不影响各花园的时段配置）
async function loadAndCacheGardens(acc, cookie) {
  const res = await httpRequest({ path: '/api/gardens', cookie })
  // 打印接口原始返回（完整数据，便于排查有哪些字段可用）
  console.log('[PPGarden] /api/gardens 原始响应，账号:', acc.remark || acc.username,
    'status:', res.status, 'body:', JSON.stringify(res.json, null, 2))
  if (res.status === 401) {
    const err = new Error('会话已失效')
    err.status = 401
    throw err
  }
  if (res.status !== 200 || !res.json || !Array.isArray(res.json.gardens)) {
    throw new Error('加载花园列表失败：HTTP ' + res.status)
  }
  // 打印每个花园的完整原始对象（看到的字段都是网站返回的，未做任何裁剪）
  res.json.gardens.forEach((g, i) => {
    console.log('[PPGarden] 花园原始数据[' + i + ']:', JSON.stringify(g, null, 2))
  })
  const gardens = res.json.gardens.map(g => ({
    id: g.id,
    name: (g.alias && g.alias.trim()) || g.nickname || g.gameUid || g.id,
    channel: g.channel || '',
    gameUid: g.gameUid || ''
  }))
  await db.collection(ACCOUNTS_COLL).doc(acc._id).update({
    data: { gardenList: gardens, gardenLoadDate: cstDateStr(nowCST()), gardenListUpdatedAt: db.serverDate() }
  }).catch(() => {})
  console.log('[PPGarden] 花园列表已缓存（裁剪后）:', JSON.stringify(gardens, null, 2))
  return gardens
}

// 把 bulk 接口的 summary 转成可读文本
function summarizeBulk(json, enabled) {
  const s = (json && json.summary) || {}
  const parts = []
  if (s.started) parts.push('启动 ' + s.started)
  if (s.armed) parts.push('排队 ' + s.armed)
  if (s.scheduleWait) parts.push('等待定时 ' + s.scheduleWait)
  if (s.finishing) parts.push('收尾 ' + s.finishing)
  if (s.alreadyPaused) parts.push('已暂停 ' + s.alreadyPaused)
  if (s.blocked) parts.push('受阻 ' + s.blocked)
  if (s.failed) parts.push('失败 ' + s.failed)
  let text = parts.length ? parts.join('，') : '无变化'

  // 启动请求全部因并发位已满被拒 → 说明当前已有花园在托管中，给出友好提示
  if (enabled && s.blocked && !s.started && !s.armed) {
    const results = (json && json.results) || []
    const byConcurrency = results.some(r => r && r.status === 'blocked' && r.reason === 'concurrency_limit')
    if (byConcurrency) {
      text += '（并发托管位已满：当前已有花园在托管中）'
    }
  }
  return text
}

// ==================== 时段校验与分配 ====================
// 校验单花园时段：整数分钟 0~59、start<stop、时长≥2、互不重叠、数量上限
function validateWindows(windows) {
  if (!Array.isArray(windows) || !windows.length) return { ok: true }
  if (windows.length > MAX_WINDOWS_PER_GARDEN) {
    return { ok: false, error: '每个花园最多 ' + MAX_WINDOWS_PER_GARDEN + ' 个时段' }
  }
  const seen = []
  for (const w of windows) {
    const s = Number(w.start)
    const e = Number(w.stop)
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e > 59 || e - s < MIN_WINDOW_DURATION) {
      return { ok: false, error: '时段无效：分钟须为 0~59 的整数，且时长至少 ' + MIN_WINDOW_DURATION + ' 分钟' }
    }
    for (const p of seen) {
      if (s < p.stop && p.start < e) {
        return { ok: false, error: '同一花园的时段不能重叠（' + pad2(s) + '~' + pad2(e) + ' 与 ' + pad2(p.start) + '~' + pad2(p.stop) + '）' }
      }
    }
    seen.push({ start: s, stop: e })
  }
  return { ok: true }
}

// 两个时段在 0~60 分钟环上的间隔（分钟）
function circularGap(a, b) {
  const g1 = (b.start - a.stop + 60) % 60
  const g2 = (a.start - b.stop + 60) % 60
  return Math.min(g1, g2)
}

// 收集同一托管账号下其它花园在「某小时」已占用的有效时段 [{start, stop, ownerName}]（可排除某花园）
// 网站的并发托管位按账号独立计算，各托管账号相互独立，跨账号时段不构成冲突
function collectOccupied(acc, exceptGardenId, hour) {
  const occupied = []
  if (!acc || acc.enabled === false) return occupied
  const gardens = Array.isArray(acc.gardenList) ? acc.gardenList : []
  const configs = acc.gardenConfigs || {}
  for (const g of gardens) {
    if (g.id === exceptGardenId) continue
    const cfg = configs[g.id]
    if (!cfg) continue
    for (const w of effectiveWindows(cfg, hour)) {
      occupied.push({ start: w.start, stop: w.stop, ownerName: g.name || g.id })
    }
  }
  return occupied
}

// 收集其它花园的「全部」时段（整体时段 + 各小时专属时段），供一键随机分配使用：
// 生成的整体时段需避开这些占用，避免与 21~22 点等专属时段撞车
function collectOccupiedAll(acc, exceptGardenId) {
  const occupied = []
  if (!acc || acc.enabled === false) return occupied
  const gardens = Array.isArray(acc.gardenList) ? acc.gardenList : []
  const configs = acc.gardenConfigs || {}
  const push = (list, ownerName) => {
    for (const w of (Array.isArray(list) ? list : [])) {
      occupied.push({ start: w.start, stop: w.stop, ownerName })
    }
  }
  for (const g of gardens) {
    if (g.id === exceptGardenId) continue
    const cfg = configs[g.id]
    if (!cfg) continue
    const ownerName = g.name || g.id
    push(cfg.windows, ownerName)
    const hw = cfg.hourWindows || {}
    for (const h of Object.keys(hw)) push(hw[h], ownerName)
  }
  return occupied
}

// 跨花园冲突检查：只有时段「真正重叠」才算冲突（首尾相接、仅差 1 分钟均不算重叠）
function checkCrossConflict(occupied, windows) {
  let conflictName = null
  for (const w of windows) {
    for (const o of occupied) {
      if (w.start < o.stop && o.start < w.stop) {
        if (!conflictName) conflictName = o.ownerName
      }
    }
  }
  return { conflictName }
}

// 逐小时检查某花园的新配置是否与同账号其它花园冲突
// （21~22 点等专属时段可能与其它花园的整体时段撞车，必须按小时比较「有效时段」）
// 返回 { conflictHour, conflictName }
function findCrossConflict(acc, gardenId, cfg) {
  let conflictHour = null
  let conflictName = null

  for (let h = 0; h < 24; h++) {
    const mine = effectiveWindows(cfg, h)
    if (!mine.length) continue
    const occupied = collectOccupied(acc, gardenId, h)
    if (!occupied.length) continue
    const r = checkCrossConflict(occupied, mine)
    if (r.conflictName && conflictHour === null) {
      conflictHour = h
      conflictName = r.conflictName
    }
  }

  return { conflictHour, conflictName }
}

// 为一个花园随机生成「每小时两个时段」：时段 4~5 分钟、间隔 25~30 分钟，
// 避开已占用时段并尽量保持安全间距。拥挤时逐步放宽间距要求。
function generateWindows(occupied) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const relax = Math.floor(attempt / 125) // 0,1,2,3
    const minCrossGap = Math.max(1, MIN_CROSS_GAP_MIN - relax)
    const gMin = Math.max(20, MIN_GAP_MIN - relax * 2)

    const d1 = randInt(MIN_WINDOW_MIN, MAX_WINDOW_MIN)
    const d2 = randInt(MIN_WINDOW_MIN, MAX_WINDOW_MIN)
    const g1 = randInt(gMin, MAX_GAP_MIN)
    const g2 = 60 - d1 - g1 - d2 // 环绕间隔（下一小时的第一个时段之前）
    if (g2 < gMin || g2 > MAX_GAP_MIN) continue

    const s1 = randInt(0, 59 - d1)
    const s2 = (s1 + d1 + g1) % 60
    if (s2 + d2 > 59) continue

    const w1 = { start: s1, stop: s1 + d1 }
    const w2 = { start: s2, stop: s2 + d2 }

    let ok = true
    let minGapSeen = Infinity
    for (const w of [w1, w2]) {
      for (const o of occupied) {
        if (w.start < o.stop && o.start < w.stop) { ok = false; break } // 重叠
        const gap = circularGap(w, o)
        if (gap < minGapSeen) minGapSeen = gap
      }
      if (!ok) break
    }
    if (!ok) continue
    if (minGapSeen < minCrossGap) continue
    return [w1, w2]
  }
  return null
}

// ==================== 工作循环 ====================
// 同一账号下其它花园是否正在托管：时段覆盖当前分钟、本小时已执行过启动、且尚未执行暂停
// （并发托管位按账号独立计算，只需检查同一账号内的其它花园）
function isPeerHosting(acc, exceptGardenId, minuteOfHour, hourSlot, hour) {
  const gardens = Array.isArray(acc.gardenList) ? acc.gardenList : []
  const configs = acc.gardenConfigs || {}
  return gardens.some(g => {
    if (g.id === exceptGardenId) return false
    const cfg = configs[g.id]
    if (!cfg || cfg.schedEnabled === false) return false
    // 该花园当前小时的有效时段（21~22 点可能使用专属时段）
    const wins = effectiveWindows(cfg, hour)
    return wins.some((w, wi) => {
      if (!(minuteOfHour >= w.start && minuteOfHour <= w.stop)) return false
      const key = g.id + '_' + wi
      const started = (acc.doneStart || {})[key] === hourSlot
      const stopped = (acc.doneStop || {})[key] === hourSlot
      return started && !stopped
    })
  })
}

// 记录某花园某时段本小时已完成（每小时去重）
async function markSlotDone(acc, field, key, hourSlot) {
  try {
    await db.collection(ACCOUNTS_COLL).doc(acc._id).update({
      data: { [field + '.' + key]: hourSlot }
    })
  } catch (e) {
    // 兜底：整体写对象
    const obj = Object.assign({}, acc[field] || {})
    obj[key] = hourSlot
    await db.collection(ACCOUNTS_COLL).doc(acc._id).update({
      data: { [field]: obj }
    }).catch(() => {})
  }
}

// 执行一次某花园的启动/暂停并写日志
async function executeGardenAction(acc, garden, action, wi, w, cookie, ctx, hourSlot) {
  const enabled = action === 'start'
  const actionText = enabled ? '启动托管' : '暂停托管'
  const slotText = '花园「' + garden.name + '」' + pad2(w.start) + '~' + pad2(w.stop) + '分'
  const key = garden.id + '_' + wi
  try {
    const json = await ppWithRetry(acc, cookie, c => ppBulkHosting(c, enabled, [garden.id]))
    const message = actionText + '完成：' + summarizeBulk(json, enabled) + ' [' + slotText + ']'

    await saveLog({
      accountId: acc._id,
      username: acc.username,
      remark: acc.remark || '',
      gardenId: garden.id,
      gardenName: garden.name || '',
      action,
      trigger: 'timer',
      success: true,
      message,
      detail: (json && json.summary) || null,
      createdAt: db.serverDate()
    })

    // 先同步内存快照（同轮后续花园的冲突守卫需要看到），再写库
    const memField = enabled ? 'doneStart' : 'doneStop'
    if (!acc[memField] || typeof acc[memField] !== 'object') acc[memField] = {}
    acc[memField][key] = hourSlot
    await markSlotDone(acc, memField, key, hourSlot)

    // 定时暂停了手动启动的花园 → 清除自动暂停标记，避免到点重复暂停
    if (!enabled && acc.manualStart && acc.manualStart.gardenId === garden.id) {
      acc.manualStart = null
      await db.collection(ACCOUNTS_COLL).doc(acc._id).update({
        data: { manualStart: null }
      }).catch(() => {})
    }

    ctx.results.push({
      username: acc.username,
      remark: acc.remark || '',
      gardenName: garden.name || '',
      action,
      success: true,
      message
    })
    console.log('[PPGarden] ' + (acc.remark || acc.username) + ' ' + message)
  } catch (err) {
    const message = actionText + '失败：' + (err.message || '未知错误') + ' [' + slotText + ']'
    console.error('[PPGarden] ' + (acc.remark || acc.username) + ' ' + message)
    await saveLog({
      accountId: acc._id,
      username: acc.username,
      remark: acc.remark || '',
      gardenId: garden.id,
      gardenName: garden.name || '',
      action,
      trigger: 'timer',
      success: false,
      message,
      detail: null,
      createdAt: db.serverDate()
    })
    ctx.results.push({
      username: acc.username,
      remark: acc.remark || '',
      gardenName: garden.name || '',
      action,
      success: false,
      message
    })
  }
}

// 处理单个账号：确保会话 → 加载花园 → 按各花园时段执行启动/暂停
async function processAccount(acc, ctx) {
  const { today, nowC, results } = ctx
  const minuteOfHour = nowC.getUTCMinutes()
  const hourOfDay = nowC.getUTCHours()
  const hourSlot = hourSlotOf(nowC)

  // 打印账号当前缓存的完整花园与时段配置（定位「专属时段是否还在库里」时最有用）
  console.log('[PPGarden] 账号数据, 账号:', acc.remark || acc.username,
    'gardenList:', JSON.stringify(acc.gardenList || []),
    'gardenConfigs:', JSON.stringify(acc.gardenConfigs || {}))

  // 1. 会话：每天登录一次
  let cookie
  try {
    cookie = await ensureSession(acc)
  } catch (err) {
    // 登录失败每天只记一次日志，避免每分钟刷屏
    if (acc.loginErrorDate !== today) {
      await db.collection(ACCOUNTS_COLL).doc(acc._id).update({
        data: { loginErrorDate: today }
      }).catch(() => {})
      await saveLog({
        accountId: acc._id,
        username: acc.username,
        remark: acc.remark || '',
        action: 'login',
        trigger: 'timer',
        success: false,
        message: err.message || '登录失败',
        detail: null,
        createdAt: db.serverDate()
      })
    }
    results.push({
      username: acc.username,
      remark: acc.remark || '',
      action: 'login',
      success: false,
      message: err.message || '登录失败'
    })
    return
  }

  // 2. 每天首次登录后加载网站内花园列表（仅名称缓存，时段配置在 gardenConfigs 不受影响）
  const needLoadGardens = acc.lastLoginDate !== today ||
    (!Array.isArray(acc.gardenList) || !acc.gardenList.length) && acc.gardenLoadDate !== today
  if (needLoadGardens) {
    try {
      await ppWithRetry(acc, cookie, c => loadAndCacheGardens(acc, c))
    } catch (e) {
      console.error('[PPGarden] 加载花园列表失败:', acc.username, e.message)
      // 失败也记录尝试日期，避免当天每分钟重试；需要时可在管理页手动刷新
      await db.collection(ACCOUNTS_COLL).doc(acc._id).update({
        data: { gardenLoadDate: today }
      }).catch(() => {})
    }
  }

  // 3. 每花园每小时时段任务（先统一处理暂停，再处理启动，减少撞车窗口）
  //    时段按「当前小时」取有效时段：21~22 点若单独配置了专属时段，则用专属时段替代整体时段
  const gardens = Array.isArray(acc.gardenList) ? acc.gardenList : []
  const configs = acc.gardenConfigs || {}
  const activeGardens = gardens
    .map(g => ({ g, cfg: configs[g.id] }))
    .filter(x => x.cfg && x.cfg.schedEnabled !== false)
    .map(x => ({ g: x.g, cfg: x.cfg, windows: effectiveWindows(x.cfg, hourOfDay) }))
    .filter(x => x.windows.length)

  if (!activeGardens.length) return { cookie }

  // 收集本分钟到期的启停任务
  const duePauses = []
  const dueStarts = []
  for (const { g, windows } of activeGardens) {
    for (let wi = 0; wi < windows.length; wi++) {
      const w = windows[wi]
      const key = g.id + '_' + wi
      if ((acc.doneStop || {})[key] !== hourSlot &&
          minuteOfHour >= w.stop && minuteOfHour < w.stop + STOP_TOLERANCE_MIN) {
        duePauses.push({ g, wi, w, key })
      }
      if ((acc.doneStart || {})[key] !== hourSlot &&
          minuteOfHour >= w.start && minuteOfHour < w.start + START_TOLERANCE_MIN) {
        dueStarts.push({ g, wi, w, key })
      }
    }
  }

  // 有到期任务时先查一次实际托管状态：已处于目标状态的操作直接跳过，不再调用启停接口
  let stateMap = null
  if (duePauses.length || dueStarts.length) {
    try {
      stateMap = await ppWithRetry(acc, cookie, c => ppGardenStateMap(c))
    } catch (e) {
      console.error('[PPGarden] 查询托管状态失败，将直接执行启停:', acc.username, e.message)
    }
  }

  // 先统一处理暂停：实际已是暂停状态（如本小时启动未执行/未成功）则只做标记，不调接口
  for (const { g, wi, w, key } of duePauses) {
    if (stateMap && stateMap[g.id] === 'paused') {
      console.log('[PPGarden] 花园已是暂停状态，跳过暂停:', acc.username, g.name)
      if (!acc.doneStop || typeof acc.doneStop !== 'object') acc.doneStop = {}
      acc.doneStop[key] = hourSlot
      await markSlotDone(acc, 'doneStop', key, hourSlot)
      continue
    }
    await executeGardenAction(acc, g, 'pause', wi, w, cookie, ctx, hourSlot)
  }
  // 再处理启动：实际已在托管/排队中（受阻除外）则只做标记，不调接口
  for (const { g, wi, w, key } of dueStarts) {
    // 运行时守卫：同一账号下其它花园本小时已在其时段内启动且尚未暂停 → 本次跳过，下分钟重试
    if (isPeerHosting(acc, g.id, minuteOfHour, hourSlot, hourOfDay)) {
      console.log('[PPGarden] 同账号其它花园托管进行中，本次跳过启动:', acc.username, g.name)
      continue
    }
    const curState = stateMap ? stateMap[g.id] : null
    if (curState && curState !== 'paused' && curState !== 'blocked') {
      console.log('[PPGarden] 花园已在托管中，跳过启动:', acc.username, g.name, curState)
      if (!acc.doneStart || typeof acc.doneStart !== 'object') acc.doneStart = {}
      acc.doneStart[key] = hourSlot
      await markSlotDone(acc, 'doneStart', key, hourSlot)
      continue
    }
    await executeGardenAction(acc, g, 'start', wi, w, cookie, ctx, hourSlot)
  }

  return { cookie }
}

// ==================== 手动启动自动暂停 ====================
// 遍历账号，把手动启动且已运行超过 MANUAL_RUN_MINUTES 分钟的花园暂停（由每分钟定时器调用）
async function autoPauseExpiredManualStarts(accounts) {
  const results = []
  const now = Date.now()
  for (const acc of accounts) {
    if (acc.enabled === false) continue
    const ms = acc.manualStart
    if (!ms || !ms.gardenId || !ms.startAtMs) continue
    const startAt = Number(ms.startAtMs) || 0
    if (!startAt || now - startAt < MANUAL_RUN_MINUTES * 60 * 1000) continue

    const name = ms.gardenName || gardenNameOf(acc, ms.gardenId) || '花园'
    const runMinutes = Math.round((now - startAt) / 60000)

    let success = true
    let message = ''
    try {
      // 先查实际状态：已是暂停状态则无需再调接口，直接清除标记
      const stateMap = await withSession(acc, c => ppGardenStateMap(c))
      if (stateMap[ms.gardenId] === 'paused') {
        message = '手动启动的花园「' + name + '」已是暂停状态，无需自动暂停'
      } else {
        const json = await withSession(acc, c => ppBulkHosting(c, false, [ms.gardenId]))
        message = '手动启动的花园「' + name + '」已运行 ' + runMinutes + ' 分钟，自动暂停完成：' + summarizeBulk(json, false)
      }
    } catch (err) {
      success = false
      message = '手动启动的花园「' + name + '」自动暂停失败：' + (err.message || '未知错误')
    }

    console.log('[PPGarden] ' + (acc.remark || acc.username) + ' ' + message)
    await saveLog({
      accountId: acc._id,
      username: acc.username,
      remark: acc.remark || '',
      gardenId: ms.gardenId,
      gardenName: name,
      action: 'pause',
      trigger: 'auto',
      success,
      message,
      detail: null,
      createdAt: db.serverDate()
    })
    results.push({
      username: acc.username,
      remark: acc.remark || '',
      gardenName: name,
      action: 'pause',
      success,
      message
    })

    // 失败时保留标记下一分钟重试，连续 3 次失败则放弃并清除标记
    const retries = (ms.retries || 0) + (success ? 0 : 1)
    if (success || retries >= 3) {
      await db.collection(ACCOUNTS_COLL).doc(acc._id).update({
        data: { manualStart: null, updatedAt: db.serverDate() }
      }).catch(() => {})
    } else {
      await db.collection(ACCOUNTS_COLL).doc(acc._id).update({
        data: { 'manualStart.retries': retries }
      }).catch(() => {})
    }
  }
  return results
}

// 一次工作循环：遍历所有启用账号（可传入已加载的账号列表避免重复读取）
async function runCycle(preloadedAccounts) {
  const nowC = nowCST()
  const today = cstDateStr(nowC)

  let accounts = preloadedAccounts
  if (!accounts) {
    try {
      accounts = await getAllDocs(ACCOUNTS_COLL)
    } catch (e) {
      console.error('[PPGarden] 读取账号集合失败:', e.message)
      return []
    }
  }

  const results = []
  const ctx = { today, nowC, results }
  for (const acc of accounts) {
    if (acc.enabled === false) continue
    try {
      await processAccount(acc, ctx)
    } catch (err) {
      console.error('[PPGarden] 账号处理异常:', acc.username, err.message)
    }
  }

  // 顺带清理过期日志（每小时整点执行一次即可）
  if (nowC.getUTCMinutes() === 0) {
    try {
      await db.collection(LOGS_COLL).where({
        createdAt: _.lt(new Date(Date.now() - LOG_RETENTION_DAYS * 86400 * 1000))
      }).remove()
    } catch (e) {
      // 清理失败不影响主流程
    }
  }

  return results
}

// 定时触发入口：每分钟一次，按分钟匹配各花园时段任务
async function handleTimerTick() {
  await ensureCollections()
  const state = await ensureGlobalState()

  // 先加载账号：手动启动的自动暂停检查不受总开关影响
  let accounts = null
  try {
    accounts = await getAllDocs(ACCOUNTS_COLL)
  } catch (e) {
    console.error('[PPGarden] 读取账号集合失败:', e.message)
  }
  const autoResults = await autoPauseExpiredManualStarts(accounts || [])

  if (state.masterEnabled === false) {
    return { skipped: 'master_disabled', results: autoResults }
  }

  const results = await runCycle(accounts)
  return { results: autoResults.concat(results) }
}

// ==================== 手动操作处理 ====================
function maskAccount(acc) {
  return {
    _id: acc._id,
    username: acc.username,
    remark: acc.remark || '',
    enabled: acc.enabled !== false,
    gardenList: Array.isArray(acc.gardenList) ? acc.gardenList : [],
    gardenConfigs: acc.gardenConfigs || {},
    lastLoginDate: acc.lastLoginDate || null,
    loginErrorDate: acc.loginErrorDate || null,
    hostingCache: acc.hostingCache || null,
    createdAt: acc.createdAt || null
  }
}

async function handleList() {
  await ensureCollections()
  const accounts = await getAllDocs(ACCOUNTS_COLL)
  const state = await ensureGlobalState()
  const list = accounts.map(maskAccount)
  for (const item of list) {
    if (item.hostingCache && item.hostingCache.updatedAt) {
      item.hostingCache.updatedAtMs = new Date(item.hostingCache.updatedAt).getTime()
    }
  }
  list.sort((a, b) => (a.remark || a.username).localeCompare(b.remark || b.username))
  return {
    code: 0,
    message: 'success',
    data: {
      masterEnabled: state.masterEnabled !== false,
      accounts: list
    }
  }
}

async function handleAdd(event) {
  await ensureCollections()

  const username = (event.username || '').trim()
  const password = (event.password || '').trim()
  const remark = (event.remark || '').trim()

  if (!username || !password) {
    return { code: 400, message: '账号和密码不能为空' }
  }

  const dup = await db.collection(ACCOUNTS_COLL).where({ username }).count()
  if (dup.total > 0) {
    return { code: 400, message: '该账号已存在' }
  }

  const addRes = await db.collection(ACCOUNTS_COLL).add({
    data: {
      username,
      password,
      remark,
      enabled: true,
      // 会话与花园数据（时段配置按花园存放在 gardenConfigs）
      cookie: '',
      lastLoginDate: null,
      loginErrorDate: null,
      gardenList: [],
      gardenLoadDate: null,
      gardenConfigs: {},
      hostingCache: null,
      // 手动启动自动暂停标记 { gardenId, gardenName, startAtMs, retries }
      manualStart: null,
      // 每小时去重标记（key = gardenId_时段序号）
      doneStart: {},
      doneStop: {},
      createdAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  })

  return {
    code: 0,
    message: '添加成功，请在卡片中加载花园并为每个花园配置每小时时段',
    data: { _id: addRes._id }
  }
}

async function handleUpdate(event) {
  const _id = event._id
  if (!_id) return { code: 400, message: '缺少 _id' }

  const update = { updatedAt: db.serverDate() }
  if (event.username !== undefined) update.username = String(event.username).trim()
  if (event.password) {
    // 密码变更后旧会话作废，强制重新登录
    update.password = String(event.password).trim()
    update.cookie = ''
    update.lastLoginDate = null
  }
  if (event.remark !== undefined) update.remark = String(event.remark).trim()

  await db.collection(ACCOUNTS_COLL).doc(_id).update({ data: update })
  return { code: 0, message: '保存成功' }
}

async function handleDelete(event) {
  const _id = event._id
  if (!_id) return { code: 400, message: '缺少 _id' }
  await db.collection(ACCOUNTS_COLL).doc(_id).remove()
  return { code: 0, message: '删除成功' }
}

// 全局定时任务总开关（停止/恢复定时启停）
async function handleSetMaster(event) {
  const enabled = !!event.enabled
  await ensureCollections()
  await ensureGlobalState()
  await db.collection(STATE_COLL).doc(STATE_DOC_ID).update({
    data: { masterEnabled: enabled, updatedAt: db.serverDate() }
  })
  return { code: 0, message: enabled ? '定时任务已开启' : '定时任务已停止' }
}

// 加载网站内添加的花园列表（登录成功后调用；不影响各花园已配置的时段）
async function handleLoadGardens(event) {
  const _id = event._id
  if (!_id) return { code: 400, message: '缺少 _id' }

  let acc
  try {
    const res = await db.collection(ACCOUNTS_COLL).doc(_id).get()
    acc = res.data
  } catch (e) {
    return { code: 404, message: '账号不存在' }
  }
  if (!acc) return { code: 404, message: '账号不存在' }

  try {
    const gardens = await withSession(acc, c => loadAndCacheGardens(acc, c))
    return { code: 0, message: '已加载 ' + gardens.length + ' 个花园', data: { gardens } }
  } catch (err) {
    return { code: 500, message: err.message || '加载花园列表失败' }
  }
}

// 保存单个花园的配置：每小时时段 / 定时开关
async function handleSetGardenConfig(event) {
  const _id = event._id
  const gardenId = event.gardenId
  console.log('[PPGarden] setGardenConfig 入参:', JSON.stringify({
    _id, gardenId,
    windows: event.windows,
    hourWindows: event.hourWindows,
    replaceHourWindows: event.replaceHourWindows,
    schedEnabled: event.schedEnabled
  }))
  if (!_id || !gardenId) return { code: 400, message: '缺少 _id 或 gardenId' }

  let acc
  try {
    const res = await db.collection(ACCOUNTS_COLL).doc(_id).get()
    acc = res.data
  } catch (e) {
    return { code: 404, message: '账号不存在' }
  }
  if (!acc) return { code: 404, message: '账号不存在' }

  const configs = Object.assign({}, acc.gardenConfigs || {})
  const cfg = Object.assign({ windows: [], schedEnabled: false }, configs[gardenId] || {})

  const gardenName = gardenNameOf(acc, gardenId) || '花园'

  // 整体时段或某小时专属时段（如 21~22 点）发生变化时，
  // 统一按小时做一次冲突校验，并清空本小时完成标记，避免旧标记阻塞新时段
  const saveConfigsWithReset = async () => {
    configs[gardenId] = cfg
    await db.collection(ACCOUNTS_COLL).doc(_id).update({
      data: {
        gardenConfigs: configs,
        doneStart: {},
        doneStop: {},
        updatedAt: db.serverDate()
      }
    })
  }

  // 解析并校验一组时段（空数组表示清空）
  const parseWindows = (raw) => {
    const windows = Array.isArray(raw)
      ? raw.map(w => ({ start: Number(w.start), stop: Number(w.stop) }))
      : []
    if (!windows.length) return { ok: true, windows }
    const v = validateWindows(windows)
    if (!v.ok) return { ok: false, error: v.error }
    return { ok: true, windows }
  }

  // 1) 整体每小时时段 + 某小时专属时段（可在同一次请求中一并提交，避免中间态）
  //    hourWindows 为整份映射，传 undefined 表示不改动；
  //    replaceHourWindows=true 时，即使传空映射也执行整份覆盖（用于清除全部专属时段）
  const hasWindows = event.windows !== undefined
  const hasHourWindows = event.hourWindows !== undefined || !!event.replaceHourWindows
  if (hasWindows || hasHourWindows) {
    let windows = null
    if (hasWindows) {
      const p = parseWindows(event.windows)
      if (!p.ok) return { code: 400, message: p.error }
      windows = p.windows
    }

    let hourWindows = null
    if (hasHourWindows) {
      const rawMap = event.hourWindows && typeof event.hourWindows === 'object' ? event.hourWindows : {}
      hourWindows = {}
      for (const h of Object.keys(rawMap)) {
        const hour = Number(h)
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
          return { code: 400, message: '专属时段的小时必须为 0~23 的整数（收到：' + h + '）' }
        }
        const p = parseWindows(rawMap[h])
        if (!p.ok) return { code: 400, message: hour + ' 点专属时段无效：' + p.error }
        if (!p.windows.length) continue // 空 = 未配置该小时专属时段
        hourWindows[String(hour)] = p.windows
      }
    }

    // 在内存中先合并出最终配置，再统一做冲突校验（确保校验的是保存后的结果）
    const nextCfg = Object.assign({}, cfg)
    if (windows !== null) nextCfg.windows = windows
    if (hourWindows !== null) nextCfg.hourWindows = hourWindows

    const c = findCrossConflict(acc, gardenId, nextCfg)
    if (c.conflictName) {
      return { code: 400, message: (c.conflictHour === null ? '' : c.conflictHour + ' 点') + '时段与本账号花园「' + c.conflictName + '」重叠，同一账号同一时间只能托管一个花园，请错开' }
    }

    cfg.windows = nextCfg.windows || []
    cfg.hourWindows = nextCfg.hourWindows || {}
    await saveConfigsWithReset()
    console.log('[PPGarden] setGardenConfig 已写入, gardenId=', gardenId,
      'windows=', JSON.stringify(cfg.windows),
      'hourWindows=', JSON.stringify(cfg.hourWindows))

    // 组装保存结果提示
    const parts = []
    if (windows !== null) {
      parts.push(windows.length ? '每小时 ' + windowsText(windows) + ' 分' : '整体时段已清空（不参与定时托管）')
    }
    if (hourWindows !== null) {
      const hours = Object.keys(hourWindows).map(Number).sort((a, b) => a - b)
      parts.push(hours.length
        ? '专属时段 ' + hours.map(h => h + '~' + (h + 1) + ' 点 ' + windowsText(hourWindows[String(h)]) + ' 分').join('；')
        : '专属时段已清空（全部小时沿用每小时时段）')
    }
    return { code: 0, message: '花园「' + gardenName + '」已保存：' + parts.join('；') }
  }

  if (event.schedEnabled !== undefined) {
    cfg.schedEnabled = !!event.schedEnabled
    configs[gardenId] = cfg
    await db.collection(ACCOUNTS_COLL).doc(_id).update({
      data: { gardenConfigs: configs, updatedAt: db.serverDate() }
    })
    return {
      code: 0,
      message: '花园「' + gardenName + '」定时托管已' + (cfg.schedEnabled ? '开启' : '关闭')
    }
  }

  return { code: 400, message: '未指定要修改的配置项' }
}

function gardenNameOf(acc, gardenId) {
  const gardens = Array.isArray(acc.gardenList) ? acc.gardenList : []
  const g = gardens.find(x => x.id === gardenId)
  return g ? g.name : ''
}

// 一键为账号下全部花园随机错峰分配每小时时段
async function handleAutoAssignAll(event) {
  const _id = event._id
  if (!_id) return { code: 400, message: '缺少 _id' }

  let acc
  try {
    const res = await db.collection(ACCOUNTS_COLL).doc(_id).get()
    acc = res.data
  } catch (e) {
    return { code: 404, message: '账号不存在' }
  }
  if (!acc) return { code: 404, message: '账号不存在' }

  const gardens = Array.isArray(acc.gardenList) ? acc.gardenList : []
  if (!gardens.length) {
    return { code: 400, message: '尚未加载花园列表，请先点击「刷新花园」从网站获取' }
  }

  // 已占用时段：本账号其它花园（本账号全部花园重新分配；各账号独立，跨账号不冲突）
  // 注意：这里把「整体时段」与「各小时专属时段」一并纳入占用，
  // 避免新分配的整体时段与已有 21~22 点等专属时段撞车
  const occupied = collectOccupiedAll(acc, null)

  const configs = Object.assign({}, acc.gardenConfigs || {})
  const assigned = []
  for (const g of gardens) {
    const w = generateWindows(occupied)
    if (!w) {
      return { code: 400, message: '花园较多，每小时 60 分钟放不下所有时段。可手动为部分花园设置更短的时段（最少 ' + MIN_WINDOW_DURATION + ' 分钟），或减少参与轮换的花园数量' }
    }
    const cfg = Object.assign({ schedEnabled: true }, configs[g.id] || {})
    cfg.windows = w
    cfg.schedEnabled = true
    cfg.hourWindows = cfg.hourWindows || {}
    configs[g.id] = cfg
    const special = Object.keys(cfg.hourWindows).map(Number).sort((a, b) => a - b)
      .map(h => h + '~' + (h + 1) + ' 点 ' + windowsText(cfg.hourWindows[String(h)]))
      .join('；')
    assigned.push('「' + (g.name || g.id) + '」' + windowsText(w) + (special ? '（专属 ' + special + '）' : ''))
    for (const x of w) occupied.push({ start: x.start, stop: x.stop, ownerName: g.name || g.id })
  }

  await db.collection(ACCOUNTS_COLL).doc(_id).update({
    data: {
      gardenConfigs: configs,
      doneStart: {},
      doneStop: {},
      updatedAt: db.serverDate()
    }
  })

  return {
    code: 0,
    message: '已为 ' + gardens.length + ' 个花园分配时段并开启定时：\n' + assigned.join('\n'),
    data: { gardenConfigs: configs }
  }
}

// 手动启动某个花园：暂停其它在托花园腾出托管位后启动指定花园
// （先查实际托管状态：目标已在托管中则不重复启动，只暂停确实非暂停状态的花园）
async function handleStartGarden(event) {
  const _id = event._id
  const gardenId = event.gardenId
  if (!_id || !gardenId) return { code: 400, message: '缺少 _id 或 gardenId' }

  let acc
  try {
    const res = await db.collection(ACCOUNTS_COLL).doc(_id).get()
    acc = res.data
  } catch (e) {
    return { code: 404, message: '账号不存在' }
  }
  if (!acc) return { code: 404, message: '账号不存在' }

  const name = gardenNameOf(acc, gardenId) || '花园'
  try {
    const result = await withSession(acc, async c => {
      // 先查实际托管状态，避免冗余启停调用
      let stateMap = null
      try {
        stateMap = await ppGardenStateMap(c)
      } catch (e) {
        stateMap = null // 状态未知时退回「暂停全部」的原逻辑
      }

      // 暂停其它在托花园，腾出唯一托管位（并发位=1）；只暂停确实非暂停状态的花园
      if (stateMap) {
        const busyOthers = Object.keys(stateMap).filter(id => id !== gardenId && stateMap[id] !== 'paused')
        if (busyOthers.length) await ppBulkHosting(c, false, busyOthers)
      } else {
        // 状态查询失败：暂停全部花园兜底（避免 concurrency_limit 受阻）
        await ppBulkHosting(c, false)
      }

      // 目标花园已在托管中（受阻状态除外）→ 不再重复启动
      const targetState = stateMap ? stateMap[gardenId] : null
      if (targetState && targetState !== 'paused' && targetState !== 'blocked') {
        return { alreadyActive: true, json: null }
      }
      const json = await ppBulkHosting(c, true, [gardenId])
      return { alreadyActive: false, json }
    })

    // 已在托管中：不重复调用启动，仅重置自动暂停计时
    if (result.alreadyActive) {
      const message = '花园「' + name + '」已在托管中，无需重复启动'
      await saveLog({
        accountId: acc._id,
        username: acc.username,
        remark: acc.remark || '',
        gardenId,
        gardenName: name,
        action: 'start',
        trigger: 'manual',
        success: true,
        message,
        detail: null,
        createdAt: db.serverDate()
      })
      await db.collection(ACCOUNTS_COLL).doc(acc._id).update({
        data: {
          manualStart: { gardenId, gardenName: name, startAtMs: Date.now(), retries: 0 },
          updatedAt: db.serverDate()
        }
      }).catch(() => {})
      return { code: 0, message }
    }

    const json = result.json
    const message = '启动花园「' + name + '」完成：' + summarizeBulk(json, true) + '，' + MANUAL_RUN_MINUTES + ' 分钟后自动暂停'

    await saveLog({
      accountId: acc._id,
      username: acc.username,
      remark: acc.remark || '',
      gardenId,
      gardenName: name,
      action: 'start',
      trigger: 'manual',
      success: true,
      message,
      detail: (json && json.summary) || null,
      createdAt: db.serverDate()
    })

    // 记录手动启动时间，由每分钟定时器在到期后自动暂停
    await db.collection(ACCOUNTS_COLL).doc(acc._id).update({
      data: {
        manualStart: { gardenId, gardenName: name, startAtMs: Date.now(), retries: 0 },
        updatedAt: db.serverDate()
      }
    }).catch(() => {})

    return {
      code: 0,
      message,
      data: { summary: (json && json.summary) || null, results: (json && json.results) || [] }
    }
  } catch (err) {
    const message = '启动花园「' + name + '」失败：' + (err.message || '未知错误')
    await saveLog({
      accountId: acc._id,
      username: acc.username,
      remark: acc.remark || '',
      gardenId,
      gardenName: name,
      action: 'start',
      trigger: 'manual',
      success: false,
      message,
      detail: null,
      createdAt: db.serverDate()
    })
    return { code: 500, message }
  }
}

// 手动暂停某个花园
async function handlePauseGarden(event) {
  const _id = event._id
  const gardenId = event.gardenId
  if (!_id || !gardenId) return { code: 400, message: '缺少 _id 或 gardenId' }

  let acc
  try {
    const res = await db.collection(ACCOUNTS_COLL).doc(_id).get()
    acc = res.data
  } catch (e) {
    return { code: 404, message: '账号不存在' }
  }
  if (!acc) return { code: 404, message: '账号不存在' }

  const name = gardenNameOf(acc, gardenId) || '花园'
  try {
    let skipped = false
    const json = await withSession(acc, async c => {
      // 先查实际状态：已是暂停状态则无需再调接口
      let stateMap = null
      try {
        stateMap = await ppGardenStateMap(c)
      } catch (e) {
        stateMap = null
      }
      if (stateMap && stateMap[gardenId] === 'paused') {
        skipped = true
        return null
      }
      return ppBulkHosting(c, false, [gardenId])
    })
    const message = skipped
      ? '花园「' + name + '」已是暂停状态，无需操作'
      : '暂停花园「' + name + '」完成：' + summarizeBulk(json, false)

    await saveLog({
      accountId: acc._id,
      username: acc.username,
      remark: acc.remark || '',
      gardenId,
      gardenName: name,
      action: 'pause',
      trigger: 'manual',
      success: true,
      message,
      detail: (json && json.summary) || null,
      createdAt: db.serverDate()
    })

    // 手动暂停后清除自动暂停标记
    if (acc.manualStart && acc.manualStart.gardenId === gardenId) {
      await db.collection(ACCOUNTS_COLL).doc(acc._id).update({
        data: { manualStart: null, updatedAt: db.serverDate() }
      }).catch(() => {})
    }

    return {
      code: 0,
      message,
      data: { summary: (json && json.summary) || null, results: (json && json.results) || [] }
    }
  } catch (err) {
    const message = '暂停花园「' + name + '」失败：' + (err.message || '未知错误')
    await saveLog({
      accountId: acc._id,
      username: acc.username,
      remark: acc.remark || '',
      gardenId,
      gardenName: name,
      action: 'pause',
      trigger: 'manual',
      success: false,
      message,
      detail: null,
      createdAt: db.serverDate()
    })
    return { code: 500, message }
  }
}

// 查询账号当前托管状态（复用缓存会话），并更新缓存
async function handleStatus(event) {
  const _id = event._id
  if (!_id) return { code: 400, message: '缺少 _id' }

  let acc
  try {
    const res = await db.collection(ACCOUNTS_COLL).doc(_id).get()
    acc = res.data
  } catch (e) {
    return { code: 404, message: '账号不存在' }
  }
  if (!acc) return { code: 404, message: '账号不存在' }

  try {
    const summary = await withSession(acc, c => ppHostingSummary(c))

    // 钱包信息（剩余时长 effectiveMs 等），失败不影响状态主流程
    let wallet = null
    try {
      wallet = await withSession(acc, c => ppWallet(c))
    } catch (e) {
      console.error('[PPGarden] 查询钱包失败（忽略）:', acc.username, e.message)
    }

    // 花园名称映射：优先用缓存的 gardenList，没有则现场拉取
    let nameMap = {}
    if (Array.isArray(acc.gardenList) && acc.gardenList.length) {
      for (const g of acc.gardenList) nameMap[g.id] = g.name
    } else {
      try {
        const gardens = await withSession(acc, c => loadAndCacheGardens(acc, c))
        for (const g of gardens) nameMap[g.id] = g.name
      } catch (e) { /* ignore */ }
    }

    const items = (summary.gardens || []).map(g => {
      const holdings = g.holdings || {}
      // 元宝数量：holdings.diamond（网站返回的元宝持有量）
      const diamond = typeof holdings.diamond === 'number' ? holdings.diamond : null
      return {
        gardenId: g.gardenId,
        name: nameMap[g.gardenId] || ('花园' + String(g.gardenId).slice(0, 8)),
        state: g.state,
        stateText: (STATE_TEXT[g.state] || g.state) + (g.credentialExpired ? '(凭证过期)' : ''),
        // 元宝 / 雇佣书
        diamond,
        diamondText: diamond === null ? '' : String(diamond),
        hireBook: typeof holdings.hireBook === 'number' ? holdings.hireBook : null
      }
    })

    const counts = summary.counts || {}
    const countParts = []
    if (counts.running) countParts.push('运行中 ' + counts.running)
    if (counts.managed) countParts.push('托管中 ' + counts.managed)
    if (counts.armed) countParts.push('已就绪 ' + counts.armed)
    if (counts.scheduleWait) countParts.push('等待定时 ' + counts.scheduleWait)
    if (counts.finishing) countParts.push('收尾 ' + counts.finishing)
    if (counts.paused) countParts.push('已暂停 ' + counts.paused)
    if (counts.blocked) countParts.push('受阻 ' + counts.blocked)
    const summaryText = '共 ' + (summary.total || items.length) + ' 个花园' + (countParts.length ? '：' + countParts.join('，') : '')

    // 钱包：剩余时长（毫秒）等
    const walletInfo = wallet ? {
      effectiveMs: typeof wallet.effectiveMs === 'number' ? wallet.effectiveMs : null,
      paidMs: typeof wallet.paidMs === 'number' ? wallet.paidMs : null,
      pendingMs: typeof wallet.pendingMs === 'number' ? wallet.pendingMs : null,
      lockedMs: typeof wallet.lockedMs === 'number' ? wallet.lockedMs : null,
      display: wallet.display || '',
      runningGardens: typeof wallet.runningGardens === 'number' ? wallet.runningGardens : null,
      maxConcurrent: typeof wallet.maxConcurrent === 'number' ? wallet.maxConcurrent : null,
      hasHostingPlan: !!wallet.hasHostingPlan,
      serverTime: typeof wallet.serverTime === 'number' ? wallet.serverTime : null
    } : null

    // 更新缓存（含逐花园状态 + 钱包信息，供管理页直接展示）
    await db.collection(ACCOUNTS_COLL).doc(_id).update({
      data: {
        hostingCache: {
          total: summary.total || 0,
          summaryText,
          counts,
          states: items,
          wallet: walletInfo,
          updatedAt: db.serverDate()
        }
      }
    }).catch(() => {})

    return {
      code: 0,
      message: 'success',
      data: {
        total: summary.total || items.length,
        summaryText,
        gardens: items,
        wallet: walletInfo,
        serverTime: summary.serverTime || null
      }
    }
  } catch (err) {
    console.error('[PPGarden] 查询状态失败:', err.message)
    return { code: 500, message: err.message || '查询状态失败' }
  }
}

async function handleLogs(event) {
  await ensureCollections()
  const limit = Math.min(Number(event.limit) || 50, 100)
  const res = await db.collection(LOGS_COLL)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get()

  const logs = (res.data || []).map(l => ({
    _id: l._id,
    username: l.username,
    remark: l.remark || '',
    gardenName: l.gardenName || '',
    action: l.action,
    trigger: l.trigger,
    success: l.success,
    message: l.message,
    createdAtMs: l.createdAt ? new Date(l.createdAt).getTime() : null
  }))

  return { code: 0, message: 'success', data: { logs } }
}

// 汇总所有账号当前正在托管（非暂停）的花园
const HOSTING_ACTIVE_STATES = ['running', 'managed', 'finishing']

async function handleHostingNow() {
  await ensureCollections()
  const accounts = await getAllDocs(ACCOUNTS_COLL)
  const hosting = [] // 正在托管
  const waiting = [] // 其它状态（已就绪/等待定时/受阻）
  const errors = []

  for (const acc of accounts) {
    if (acc.enabled === false) continue
    try {
      const summary = await withSession(acc, c => ppHostingSummary(c))
      let nameMap = {}
      if (Array.isArray(acc.gardenList) && acc.gardenList.length) {
        for (const g of acc.gardenList) nameMap[g.id] = g.name
      }
      for (const g of (summary.gardens || [])) {
        if (g.state === 'paused') continue
        const item = {
          accountId: acc._id,
          accountName: acc.remark || acc.username,
          gardenId: g.gardenId,
          gardenName: nameMap[g.gardenId] || ('花园' + String(g.gardenId).slice(0, 8)),
          state: g.state,
          stateText: (STATE_TEXT[g.state] || g.state) + (g.credentialExpired ? '(凭证过期)' : ''),
          active: HOSTING_ACTIVE_STATES.includes(g.state),
          busyPause: false
        }
        if (item.active) hosting.push(item)
        else waiting.push(item)
      }
    } catch (err) {
      errors.push({
        accountName: acc.remark || acc.username,
        message: err.message || '查询失败'
      })
    }
  }

  return {
    code: 0,
    message: 'success',
    data: { hosting, waiting, errors }
  }
}

// 正在托管面板：按账号聚合（花园托管状态 + 执行日志首页）
async function handleAccountPanel(event) {
  await ensureCollections()
  const logsLimit = Math.min(Math.max(Number(event.logsLimit) || 10, 1), 50)
  const accounts = await getAllDocs(ACCOUNTS_COLL)

  const out = []
  const errors = []
  for (const acc of accounts) {
    if (acc.enabled === false) continue
    const item = {
      accountId: acc._id,
      accountName: acc.remark || acc.username,
      activeCount: 0,
      logs: [],
      logsComplete: false
    }
    // 该账号正在托管的花园数（用于「托管中」标记与日志动态刷新）
    try {
      const summary = await withSession(acc, c => ppHostingSummary(c))
      item.activeCount = (summary.gardens || []).filter(g => HOSTING_ACTIVE_STATES.includes(g.state)).length
    } catch (err) {
      errors.push({ accountId: acc._id, accountName: item.accountName, message: err.message || '查询失败' })
    }

    // 该账号执行日志（首页）
    try {
      const page = await loadAccountLogs(acc._id, 0, logsLimit)
      item.logs = page.logs
      item.logsComplete = page.complete
    } catch (e) { /* 日志读取失败不影响状态展示 */ }

    out.push(item)
  }

  // 有活跃花园的账号排前面，其余按名称排序
  out.sort((a, b) => {
    const aa = a.activeCount > 0 ? 0 : 1
    const bb = b.activeCount > 0 ? 0 : 1
    if (aa !== bb) return aa - bb
    return a.accountName.localeCompare(b.accountName)
  })

  return { code: 0, message: 'success', data: { accounts: out, errors } }
}

// 读取某账号执行日志（按时间倒序分页；beforeMs 向更早翻页，afterMs 拉取更新）
async function loadAccountLogs(accountId, beforeMs, limit, afterMs) {
  let cond = { accountId }
  if (beforeMs > 0) cond.createdAt = _.lt(new Date(beforeMs))
  else if (afterMs > 0) cond.createdAt = _.gt(new Date(afterMs))
  const res = await db.collection(LOGS_COLL)
    .where(cond)
    .orderBy('createdAt', 'desc')
    .limit(limit + 1)
    .get()
  const rows = (res.data || []).slice(0, limit)
  return {
    logs: rows.map(l => ({
      id: l._id,
      ts: l.createdAt ? new Date(l.createdAt).getTime() : 0,
      timeText: l.createdAt ? fmtCstMs(new Date(l.createdAt).getTime()) : '',
      actionText: l.action === 'start' ? '启动托管' : l.action === 'pause' ? '暂停托管' : '登录',
      triggerText: l.trigger === 'timer' ? '定时' : l.trigger === 'auto' ? '自动暂停' : l.trigger === 'redeem' ? '兑换码' : '手动',
      success: !!l.success,
      message: l.message || ''
    })),
    complete: (res.data || []).length <= limit
  }
}

// 分页加载某账号更早的执行日志
async function handleAccountLogs(event) {
  const accountId = event.accountId
  if (!accountId) return { code: 400, message: '缺少 accountId' }
  await ensureCollections()
  const limit = Math.min(Math.max(Number(event.limit) || 10, 1), 50)
  const beforeMs = Number(event.before) || 0
  const afterMs = Number(event.after) || 0
  try {
    const page = await loadAccountLogs(accountId, beforeMs, limit, afterMs)
    return { code: 0, message: 'success', data: page }
  } catch (err) {
    return { code: 500, message: err.message || '加载日志失败' }
  }
}

// 汇总所有账号「正在托管」花园的动态日志（网站动态接口按花园查询，先取托管状态再逐花园拉取）
async function handleSiteActivity(event) {
  await ensureCollections()
  const limit = Math.min(Number(event.limit) || 30, 100)
  const perGarden = Math.min(Number(event.perGarden) || 10, 20)
  const accounts = await getAllDocs(ACCOUNTS_COLL)

  const items = []
  const errors = []
  for (const acc of accounts) {
    if (acc.enabled === false) continue
    let stateMap = null
    try {
      stateMap = await withSession(acc, c => ppGardenStateMap(c))
    } catch (err) {
      errors.push({ accountName: acc.remark || acc.username, message: err.message || '查询失败' })
      continue
    }
    // 只拉非暂停状态花园的动态（通常并发位=1，每账号最多 1 个）
    const activeIds = Object.keys(stateMap).filter(id => stateMap[id] && stateMap[id] !== 'paused').slice(0, 3)
    for (const gid of activeIds) {
      try {
        const json = await withSession(acc, c => ppActivityList(c, gid, perGarden))
        for (const it of normalizeSiteActivity(json)) {
          items.push(Object.assign({}, it, {
            accountName: acc.remark || acc.username,
            gardenName: gardenNameOf(acc, gid) || ('花园' + String(gid).slice(0, 8))
          }))
        }
      } catch (e) { /* 单花园失败不影响其它 */ }
    }
  }

  items.sort((a, b) => (b.timeMs || 0) - (a.timeMs || 0))
  const trimmed = items.slice(0, limit)
  trimmed.forEach((it, i) => {
    it.idx = i
    it.timeText = it.timeMs ? fmtCstMs(it.timeMs) : ''
  })

  return { code: 0, message: 'success', data: { items: trimmed, errors } }
}

// 单个花园的网站「动态」日志（管理页「日志」按钮底部弹窗用）
async function handleGardenActivity(event) {
  const _id = event._id
  const gardenId = event.gardenId
  if (!_id || !gardenId) return { code: 400, message: '缺少 _id 或 gardenId' }

  let acc
  try {
    const res = await db.collection(ACCOUNTS_COLL).doc(_id).get()
    acc = res.data
  } catch (e) {
    return { code: 404, message: '账号不存在' }
  }
  if (!acc) return { code: 404, message: '账号不存在' }

  try {
    const limit = Math.min(Number(event.limit) || 20, 50)
    const json = await withSession(acc, c => ppActivityList(c, gardenId, limit))
    const items = normalizeSiteActivity(json)
    items.forEach((it, i) => {
      it.idx = i
      it.timeText = it.timeMs ? fmtCstMs(it.timeMs) : ''
    })
    return { code: 0, message: 'success', data: { items } }
  } catch (err) {
    return { code: 500, message: err.message || '查询动态失败' }
  }
}

// 某账号的交易记录（卖花列表）：GET /api/orders?role=sell
// 按花园拆分：一条订单的 legs 里可能包含多个花园（sellerGardenId），各自单独成行；
// 花朵名称由 flowerId 经 ppgarden_status 的花朵映射解析。
async function handleGardenTrades(event) {
  const _id = event._id
  if (!_id) return { code: 400, message: '缺少 _id' }

  let acc
  try {
    const res = await db.collection(ACCOUNTS_COLL).doc(_id).get()
    acc = res.data
  } catch (e) {
    return { code: 404, message: '账号不存在' }
  }
  if (!acc) return { code: 404, message: '账号不存在' }

  try {
    const limit = Math.min(Math.max(Number(event.limit) || 50, 1), 200)
    const role = event.role === 'buy' ? 'buy' : 'sell'
    const orders = await withSession(acc, c => ppOrders(c, role))
    const nameMap = await getFlowerNameMap()

    // 花园名称映射，便于按花园分组展示
    const gardenNameMap = {}
    for (const g of (acc.gardenList || [])) gardenNameMap[g.id] = g.name

    const QUALITY_TEXT = { 1: '普品', 2: '优品', 3: '珍品', 4: '极品' }
    // 诊断：列出订单里出现的花 id 及是否命中映射
    const idHits = {}
    for (const o of (orders || [])) {
      if (!o || o.flowerId == null) continue
      idHits[String(o.flowerId)] = nameMap[String(o.flowerId)] || null
    }
    console.log('[PPGarden] 交易花 id 命中情况:', JSON.stringify(idHits))
    if (orders && orders[0]) {
      console.log('[PPGarden] 交易订单样本(第一条):', JSON.stringify(orders[0]).slice(0, 800))
    }

    const items = []
    for (const o of orders) {
      if (!o) continue
      const flowerName = nameMap[String(o.flowerId)] || ('花朵 ' + o.flowerId)
      // 一条订单可能由多个花园各自卖出（legs），逐 leg 展开成独立记录
      const legs = Array.isArray(o.legs) && o.legs.length ? o.legs : [null]
      for (const leg of legs) {
        const gardenId = (leg && leg.sellerGardenId) || o.buyerGardenId || ''
        const groups = leg && leg.groups != null ? leg.groups : o.groups
        // 「得 N 分钟」= 单组卖家所得 × 组数（sellerGetsPerGroup 单位为分钟）
        const getsPerGroup = (leg && leg.sellerGetsPerGroup != null) ? leg.sellerGetsPerGroup : null
        const gainMinutes = getsPerGroup != null ? getsPerGroup * groups : null
        const status = (leg && leg.status) || o.status
        items.push({
          id: String(o.id) + (leg ? '_' + leg.id : ''),
          orderId: o.orderId,
          role: o.role || role,
          flowerId: o.flowerId,
          flowerName,
          quality: o.quality,
          qualityText: QUALITY_TEXT[o.quality] || (o.quality ? ('品质 ' + o.quality) : ''),
          groups,
          pricePerGroup: o.pricePerGroup,
          feePerGroup: o.feePerGroup,
          getsPerGroup,
          gainMinutes,
          gainText: gainMinutes == null ? '' : ('得 ' + gainMinutes + ' 分钟'),
          status,
          statusText: status === 'settled' ? '已完成' : (status || ''),
          settled: status === 'settled',
          across: (leg && leg.sellerName) || o.buyerName || '',
          acrossLabel: role === 'sell' ? '买家' : '卖家',
          gardenId,
          gardenName: gardenNameMap[gardenId] || '',
          createdAt: o.createdAt ? fmtCstMs(o.createdAt) : '',
          settledAt: (function () {
            const t = (leg && leg.settledAt) || o.settledAt
            return t ? fmtCstMs(t) : ''
          })()
        })
      }
    }

    // 按创建时间倒序，取前 limit 条
    items.sort((a, b) => (b.orderId || 0) - (a.orderId || 0))
    const sliced = items.slice(0, limit)

    // 汇总：单数（去重 orderId）、总组数、总时长（分钟）
    const orderIdSet = {}
    let totalGroups = 0
    let totalMinutes = 0
    for (const it of items) {
      orderIdSet[it.orderId] = true
      totalGroups += Number(it.groups) || 0
      totalMinutes += Number(it.gainMinutes) || 0
    }
    const summary = {
      orders: Object.keys(orderIdSet).length,
      groups: totalGroups,
      minutes: totalMinutes,
      minutesText: formatMinutes(totalMinutes)
    }

    return { code: 0, message: 'success', data: { items: sliced, summary, role } }
  } catch (err) {
    console.error('[PPGarden] 查询交易记录失败:', err.message)
    return { code: 500, message: err.message || '查询交易记录失败' }
  }
}

// 分钟数 → 中文文本（如 370 → '6 小时 10 分钟'）
function formatMinutes(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0))
  const h = Math.floor(m / 60)
  const mm = m % 60
  if (h && mm) return h + ' 小时 ' + mm + ' 分钟'
  if (h) return h + ' 小时'
  return mm + ' 分钟'
}

// ==================== 求购列表 ====================
// 仅拉取求购大厅列表并展示（不查询各花园库存，接单流程待网页确认后再实现）
async function handleTradeRequests(event) {
  const _id = event._id
  if (!_id) return { code: 400, message: '缺少 _id' }

  let acc
  try {
    const res = await db.collection(ACCOUNTS_COLL).doc(_id).get()
    acc = res.data
  } catch (e) {
    return { code: 404, message: '账号不存在' }
  }
  if (!acc) return { code: 404, message: '账号不存在' }

  try {
    // 默认返回全部求购；仅在显式传入 limit（>0）时才截断
    const n = Number(event.limit)
    const limit = (Number.isFinite(n) && n > 0) ? Math.min(n, 500) : 0

    const raw = await withSession(acc, c => ppTradeRequests(c))
    const nameMap = await getFlowerNameMap()

    const QUALITY_TEXT = { 1: '普品', 2: '优品', 3: '珍品', 4: '极品' }
    // 求购状态文案（open 为进行中；其余状态原样透出，便于排查）
    const STATUS_TEXT = { open: '进行中', filled: '已成交', cancelled: '已取消', expired: '已过期', closed: '已关闭' }
    const items = raw.map(o => {
      const totalGroups = o.totalGroups != null ? o.totalGroups : o.groups
      const takenGroups = o.takenGroups != null ? o.takenGroups : 0
      const remainingGroups = o.remainingGroups != null
        ? o.remainingGroups
        : (totalGroups != null && takenGroups != null ? Math.max(0, totalGroups - takenGroups) : o.groups)
      return {
        requestId: o.requestId != null ? o.requestId : o.id,
        orderId: o.orderId,
        kind: o.kind || 'request',
        channel: o.channel || '',
        flowerId: o.flowerId,
        flowerName: nameMap[String(o.flowerId)] || ('花朵 ' + o.flowerId),
        quality: o.quality,
        qualityText: QUALITY_TEXT[o.quality] || (o.quality ? ('品质 ' + o.quality) : ''),
        groups: totalGroups,
        totalGroups,
        takenGroups,
        remainingGroups,
        pricePerGroup: o.pricePerGroup,
        sellerGetsPerGroup: o.sellerGetsPerGroup != null ? o.sellerGetsPerGroup : null,
        // 「得 N 分钟」= 单组卖家所得 × 剩余组数
        gainText: o.sellerGetsPerGroup != null && remainingGroups != null
          ? ('得 ' + (o.sellerGetsPerGroup * remainingGroups) + ' 分钟') : '',
        autoMatch: !!o.autoMatch,
        targetCount: o.targetCount != null ? o.targetCount : null,
        maxPricePerGroup: o.maxPricePerGroup != null ? o.maxPricePerGroup : null,
        buyerName: o.buyerName || '',
        status: o.status || '',
        statusText: STATUS_TEXT[o.status] || (o.status || '未知'),
        mine: !!o.mine,
        // 卖家是否可接单（部分接口会在顶层返回；legs 里也有同名字段）
        sellerCancelable: o.sellerCancelable !== undefined ? !!o.sellerCancelable : null,
        canSell: o.canSell !== undefined ? !!o.canSell : null,
        sellable: o.sellable !== undefined ? !!o.sellable : null,
        reasonCode: o.reasonCode || '',
        reasonText: o.reasonText || '',
        blockText: o.blockText || '',
        // 买家侧状态：排队是否已满 / 买家是否正在操作 / 前方排队人数 / 预计等待分钟
        buyerQueueFull: !!o.buyerQueueFull,
        buyerPlaying: !!o.buyerPlaying,
        queueAhead: o.queueAhead != null ? o.queueAhead : 0,
        queueEtaMinutes: o.queueEtaMinutes != null ? o.queueEtaMinutes : 0,
        // 展示用文案：这两个为 true 时无法交易
        queueText: o.buyerQueueFull ? '对方排队已满' : (Number(o.queueAhead) > 0 ? ('前方 ' + Number(o.queueAhead) + ' 人排队') : ''),
        playingText: o.buyerPlaying ? '对方游戏中' : '',
        autoMatchText: o.autoMatch ? '自动成交' : '非自动成交',
        pausedReason: o.pausedReason || '',
        pausedText: o.pausedText || '',
        // 站点直接返回的「各账号可卖腿」：每个花园的可卖组数（已扣除任务用花/上架次数等）
        sellerLegs: Array.isArray(o.sellerLegs) ? o.sellerLegs
          : (Array.isArray(o.sellers) ? o.sellers : []),
        mode: o.mode || '',
        createdAt: o.createdAt ? fmtCstMs(o.createdAt) : '',
        deadlineAt: o.expiresAt ? fmtCstMs(o.expiresAt) : (o.deadlineAt ? fmtCstMs(o.deadlineAt) : '')
      }
    })

    // 诊断：打印第一条求购的全部字段名，便于确认可接单判断应使用哪个字段
    if (raw.length) {
      console.log('[PPGarden] 求购字段样本:', JSON.stringify(raw[0]))
    }

    // 刷新并读取「当前账号」下各花园库存（写入 ppgarden_stock，并用于匹配求购）
    let stock = { gardens: [], flowers: {}, byFlower: {}, gardenFlowerStock: {} }
    if (event.withStock !== false) {
      try {
        stock = await refreshAccountStock(acc)
      } catch (e) {
        console.error('[PPGarden] 刷新库存失败（继续返回列表）:', e.message)
      }
      console.log('[PPGarden] 本账号花园库存:', JSON.stringify(stock.gardens.map(x => ({ g: x.gardenName, sell: x.sellableGroups }))))
    }
    const gardenList = Array.isArray(acc.gardenList) ? acc.gardenList : []
    const gardenNameById = {}
    for (const g of gardenList) gardenNameById[g.id] = g.name || g.id

    // 把库存匹配到每条求购：每个花园单独一行（含库存为 0 的花园）
    // 优先按 flowerId_quality 精确匹配，找不到再回退按 flowerId（同花不同品质）
    console.log('[PPGarden][库存] 开始匹配求购, 求购条数:', items.length,
      '花园数:', gardenList.length,
      'gardenFlowerStock 中的 gardenId:', JSON.stringify(Object.keys(stock.gardenFlowerStock || {})))
    let matchSampleLogged = 0
    items.forEach(it => {
      const fid = String(it.flowerId)
      const key = fid + '_' + (it.quality || 0)
      const gfs = stock.gardenFlowerStock || {}

      // 站点在求购里直接给出的各账号可卖腿（最准确）：gardenId -> { groups, haveCount, ... }
      const legById = {}
      const legs = Array.isArray(it.sellerLegs) ? it.sellerLegs : []
      for (const leg of legs) {
        if (leg && leg.gardenId) legById[leg.gardenId] = leg
      }
      const hasLegs = Object.keys(legById).length > 0

      it.gardenStockList = gardenList.map(g => {
        const perFlower = gfs[g.id] || {}
        let info = perFlower[key]
        let matchedKey = info ? key : ''
        if (!info) {
          // 回退：该花园同 flowerId 的任意品质
          const alt = Object.keys(perFlower).find(k => k.split('_')[0] === fid)
          if (alt !== undefined) { info = perFlower[alt]; matchedKey = alt }
        }
        let qty = info ? (Number(info.count) || 0) : 0
        const leg = legById[g.id]
        let groups = 0
        let blockText = ''
        if (leg) {
          // 优先用站点给的组数与数量
          if (leg.haveCount != null) qty = Number(leg.haveCount) || 0
          groups = Number(leg.groups) || 0
          blockText = leg.blockText || ''
        } else if (!hasLegs) {
          // 兼容老接口（无 sellerLegs）：按 1 组 = 25 朵 估算
          groups = Math.floor(qty / 25)
        }
        const fullName = g.name || g.id
        // 短名称：取「s1828.柒柒」中 . 后面的部分，横向排列时更紧凑
        const shortName = fullName.indexOf('.') >= 0
          ? fullName.split('.').pop()
          : fullName.slice(-4)
        return {
          gardenId: g.id,
          gardenName: fullName,
          shortName,
          count: qty,
          groups,
          sellableGroups: leg ? (Number(leg.sellableGroups) || 0) : groups,
          blockText,
          enabled: info ? !!info.enabled : false,
          matchedKey,
          hasStock: qty > 0
        }
      })
      // 诊断：前 5 条打印「求购 key vs 各花园该 key 是否存在」
      if (matchSampleLogged < 5) {
        matchSampleLogged++
        const brief = it.gardenStockList.map(x =>
          x.gardenName + '(cnt:' + x.count + ',groups:' + x.groups + ',key:' + (x.matchedKey || '-') + ')')
        console.log('[PPGarden][库存] 匹配样本 求购' + matchSampleLogged,
          'fl:', fid, 'q:', it.quality, '查找key:', key,
          'sellerLegs:', legs.length,
          '结果:', brief.join(' | '))
      }
      finalizeRequestItem(it)
    })

    // 「只看我能卖的」：用 sellable-stock 接口返回的可卖花朵集合过滤求购
    let filtered = items
    if (event.onlySellable) {
      let sellableMap = null
      try {
        const list = await withSession(acc, c => ppSellableStock(c))
        sellableMap = {}
        for (const s of list) {
          if (!s) continue
          const key = String(s.flowerId) + '_' + (s.quality || 0)
          sellableMap[key] = (sellableMap[key] || 0) + (Number(s.sellableGroups) || 0)
        }
        console.log('[PPGarden][筛选] sellable-stock 条目:', list.length,
          '可卖key数:', Object.keys(sellableMap).length)
      } catch (e) {
        // 查询失败时不筛选，避免整列表变空
        console.error('[PPGarden][筛选] 查询可卖库存失败（本次不筛选）:', e.message)
        sellableMap = null
      }
      if (sellableMap) {
        filtered = items.filter(it => {
          const key = String(it.flowerId) + '_' + (it.quality || 0)
          const n = sellableMap[key] || 0
          it.sellableStockGroups = n
          return n > 0
        })
        console.log('[PPGarden][筛选] 只看我能卖的:', items.length, '->', filtered.length)
      }
    }

    // limit 为 0 表示不截断，返回全部
    const outItems = limit > 0 ? filtered.slice(0, limit) : filtered

    // 用 sell-quote 覆盖各花园的可卖组数（网页点「卖给他」时用的就是这个接口）。
    // 仅在客户端首次加载时传 withQuote=true 才执行，避免定时刷新反复调用。
    if (event.withQuote === true) {
      try {
        await attachSellQuotes(acc, outItems, 100)
      } catch (e) {
        console.error('[PPGarden][报价] 批量报价失败（保持原有组数）:', e.message)
      }
    }

    console.log('[PPGarden][库存] 返回客户端 求购条数:', outItems.length,
      '（接口共 ' + items.length + ' 条，筛选后 ' + filtered.length + ' 条）',
      '有库存可接单条数:', outItems.filter(x => x.canAccept).length,
      'gardenStock:', JSON.stringify((stock.gardens || []).map(x => ({ name: x.gardenName, count: x.stockCount, err: x.error || '' }))),
      '第一条 gardenStockList:', JSON.stringify((outItems[0] && outItems[0].gardenStockList) || []))

    return {
      code: 0,
      message: 'success',
      data: {
        items: outItems,
        gardenStock: stock.gardens,
        updatedAt: stock.updatedAt || null
      }
    }
  } catch (err) {
    console.error('[PPGarden] 查询求购列表失败:', err.message)
    return { code: 500, message: err.message || '查询求购列表失败' }
  }
}

// 接单：POST /api/trade/requests/{requestId}/accept
// 入参：_id（账号）, requestId, groups, pricePerGroup, targetCount
//      gardenId / gardenName（指定用哪个花园接单）
async function handleAcceptRequest(event) {
  const _id = event._id
  const requestId = event.requestId
  // 站点限制：单次接单最多 9 组
  const MAX_GROUPS_PER_ACCEPT = 9
  const groups = Math.min(Number(event.groups) || 0, MAX_GROUPS_PER_ACCEPT)
  const pricePerGroup = Number(event.pricePerGroup)
  const targetCount = Number(event.targetCount) || 0
  const gardenId = event.gardenId || ''
  const gardenName = event.gardenName || ''
  if (!_id || requestId == null) return { code: 400, message: '缺少 _id 或 requestId' }
  if (!groups || groups <= 0) return { code: 400, message: '缺少有效的卖出组数' }

  let acc
  try {
    const res = await db.collection(ACCOUNTS_COLL).doc(_id).get()
    acc = res.data
  } catch (e) {
    return { code: 404, message: '账号不存在' }
  }
  if (!acc) return { code: 404, message: '账号不存在' }

  try {
    // 以 sell-quote 的实时可卖组数为准（网页也是用它判断能卖几组）
    let groupsFinal = groups
    let sellableGroups = 0
    try {
      const quote = await withSession(acc, c => ppSellQuote(c, requestId))
      const sellers = (quote && (quote.sellers || quote.sellerLegs)) || []
      const leg = sellers.find(x => x && x.gardenId === gardenId)
      if (leg) {
        sellableGroups = Number(leg.groups)
        if (!Number.isFinite(sellableGroups)) sellableGroups = Number(leg.sellableGroups) || 0
        groupsFinal = Math.min(groups, sellableGroups, MAX_GROUPS_PER_ACCEPT)
        console.log('[PPGarden] sell-quote 该花园可卖组数:', sellableGroups,
          '本次下单组数:', groupsFinal, 'gardenId:', gardenId)
      }
    } catch (e) {
      console.warn('[PPGarden] sell-quote 失败，沿用传入组数:', e.message)
    }
    if (groupsFinal <= 0) {
      return { code: 400, message: '该花园当前可卖 0 组（库存/上架次数不足）' }
    }

    const json = await withSession(acc, c => ppAcceptRequest(c, requestId, groupsFinal, pricePerGroup, gardenId, targetCount))
    // 站点返回 { orderId, groups, pricePerGroup }，记录真实订单号
    const newOrderId = json && json.orderId != null ? json.orderId : null
    console.log('[PPGarden] 接单成功，订单号:', newOrderId, '返回:', JSON.stringify(json).slice(0, 400))
    const flowerName = event.flowerName || ''
    const message = '接单成功：' + (flowerName ? flowerName + ' ' : '') + groupsFinal + ' 组 × ' + pricePerGroup + ' 分钟/组' +
      (gardenName ? '（' + gardenName + '）' : '')
    await saveLog({
      accountId: acc._id,
      username: acc.username,
      remark: acc.remark || '',
      gardenId,
      gardenName,
      action: 'sell',
      trigger: 'manual',
      success: true,
      message,
      detail: { requestId, orderId: newOrderId, groups: groupsFinal, sellableGroups, pricePerGroup, gardenId },
      createdAt: db.serverDate()
    })
    return { code: 0, message, data: json }
  } catch (err) {
    console.error('[PPGarden] 接单失败:', err.message)
    return { code: 500, message: err.message || '接单失败' }
  }
}

// ==================== 入口 ====================
exports.main = async (event, context) => {
  // ===== 定时触发器模式（每分钟唤醒，按花园时段调度） =====
  if (event.Type === 'Timer' || event.TriggerName === TIMER_NAME) {
    try {
      const r = await handleTimerTick()
      if (r.skipped) {
        console.log('[PPGarden] 跳过:', r.skipped)
      } else if (r.results && r.results.length) {
        console.log('[PPGarden] 本次执行:', JSON.stringify(r.results))
      }
      return { code: 0, message: 'ok', data: r }
    } catch (err) {
      console.error('[PPGarden] 定时任务失败:', err)
      return { code: 500, message: err.message || '定时任务执行失败' }
    }
  }

  // ===== 手动调用模式（管理端，需授权） =====
  const auth = requireAuth(event)
  if (!auth.success) {
    return { code: 401, message: '未授权，请先登录' }
  }

  const action = event.action

  try {
    switch (action) {
      case 'list':
        return await handleList()
      case 'add':
        return await handleAdd(event)
      case 'update':
        return await handleUpdate(event)
      case 'delete':
        return await handleDelete(event)
      case 'setMaster':
        return await handleSetMaster(event)
      case 'loadGardens':
        return await handleLoadGardens(event)
      case 'setGardenConfig':
        return await handleSetGardenConfig(event)
      case 'autoAssignAll':
        return await handleAutoAssignAll(event)
      case 'startGarden':
        return await handleStartGarden(event)
      case 'pauseGarden':
        return await handlePauseGarden(event)
      case 'status':
        return await handleStatus(event)
      case 'hostingNow':
        return await handleHostingNow()
      case 'accountPanel':
        return await handleAccountPanel(event)
      case 'accountLogs':
        return await handleAccountLogs(event)
      case 'siteActivity':
        return await handleSiteActivity(event)
      case 'gardenActivity':
        return await handleGardenActivity(event)
      case 'gardenTrades':
        return await handleGardenTrades(event)
      case 'tradeRequests':
        return await handleTradeRequests(event)
      case 'gardenStock':
        return await handleGardenStock(event)
      case 'acceptRequest':
        return await handleAcceptRequest(event)
      case 'logs':
        return await handleLogs(event)
      case 'runSchedule': {
        // 手动触发一次工作循环（调试用）
        await ensureCollections()
        const results = await runCycle()
        return { code: 0, message: '执行完成，共处理 ' + results.length + ' 项', data: results }
      }
      default:
        return { code: 400, message: '不支持的操作: ' + action }
    }
  } catch (err) {
    console.error('[PPGarden] 操作 ' + action + ' 失败:', err)
    return { code: 500, message: err.message || '操作失败' }
  }
}
