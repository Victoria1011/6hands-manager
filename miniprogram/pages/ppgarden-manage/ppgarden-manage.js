// ppgarden-manage.js
// 云上花匠（ppgarden.top）花园托管管理页
// 每个花园独立配置每小时时段（含 21~22 点专属时段）/ 独立定时开关 / 手动启动暂停
const app = getApp()

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

// 格式化时间戳为 MM-DD HH:mm
function fmtShort(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

// 今天的日期字符串（东八区，与云函数 lastLoginDate 格式一致）
function todayStr() {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  return d.toISOString().slice(0, 10)
}

const CHANNEL_TEXT = {
  official: '微信',
  alipay: '支付宝',
  douyin: '抖音'
}

// 默认需要单独配置时段的小时（21~22 点）；云函数支持任意小时 hourWindows
const SPECIAL_HOUR = 21

function hourLabel(h) {
  return pad(h) + '~' + pad(h + 1) + ' 点'
}

function windowsStr(list) {
  return (Array.isArray(list) ? list : []).map(w => pad(Number(w.start)) + '~' + pad(Number(w.stop))).join('、')
}

// 剩余时长（毫秒）→ 显示文本
// 小于 1 小时显示分钟，否则显示小时（保留 1 位小数），便于一眼看出还剩多久
function formatDuration(ms) {
  if (ms === null || ms === undefined || isNaN(ms)) return ''
  const n = Number(ms)
  if (n <= 0) return '已用完'
  const hours = n / 3600000
  if (hours < 1) return Math.round(n / 60000) + ' 分钟'
  return (Math.round(hours * 10) / 10) + ' 小时'
}

// 分钟数 → 展示文本：不足 1 小时显示分钟，否则显示小时（保留 1 位小数）
function formatMinutesText(min) {
  const m = Number(min) || 0
  if (m <= 0) return '0 分钟'
  if (m < 60) return m + ' 分钟'
  return (Math.round(m / 6) / 10) + ' 小时'
}

// 各花园「今日售卖」明细：卖出组数 + 获得时长（来源 listings 的 summary）
function buildTodayGardens(gardens) {
  return (Array.isArray(gardens) ? gardens : []).map(g => {
    const s = g.summary || {}
    const groups = Number(s.todaySoldGroups) || 0
    const minutes = Number(s.todayEarnedMinutes) || 0
    return {
      gardenId: g.gardenId,
      gardenName: g.gardenName || g.gardenId,
      groups,
      minutes,
      minutesText: formatMinutesText(minutes),
      hasSold: groups > 0
    }
  })
}

// 所有花园「今日售卖」合计
function sumToday(gardens) {
  const list = buildTodayGardens(gardens)
  const groups = list.reduce((n, x) => n + x.groups, 0)
  const minutes = list.reduce((n, x) => n + x.minutes, 0)
  return { groups, minutes, minutesText: formatMinutesText(minutes) }
}

// 归一化云端的 hourWindows：{ "21": [{start,stop}] }（仅保留非空且合法的小时）
function normalizeHourWindows(hourWindows) {
  const out = {}
  const hw = (hourWindows && typeof hourWindows === 'object') ? hourWindows : {}
  for (const k of Object.keys(hw)) {
    const hour = Number(k)
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue
    const list = Array.isArray(hw[k]) ? hw[k] : []
    if (!list.length) continue
    out[String(hour)] = list.map(w => ({ start: Number(w.start), stop: Number(w.stop) }))
  }
  return out
}

// 专属时段的展示文本，如「21~22 点 00~04 分」
function specialWindowsText(specialWindows) {
  const keys = Object.keys(specialWindows || {}).map(Number).sort((a, b) => a - b)
  return keys.map(h => hourLabel(h) + ' ' + windowsStr(specialWindows[String(h)]) + ' 分').join('；')
}

// 组装编辑器的专属时段列表：
// [{ hour, label, list }]，覆盖 DB 中已有的全部小时（含历史数据），
// 并把默认小时排在最前，便于直接设置
function buildEditorSpecials(specialWindows, defaultHour) {
  const hours = Object.keys(specialWindows || {}).map(Number)
  if (hours.indexOf(defaultHour) === -1) hours.push(defaultHour)
  hours.sort((a, b) => (a === defaultHour ? -1 : b === defaultHour ? 1 : a - b))
  return hours.map(h => ({
    hour: h,
    label: hourLabel(h),
    list: (specialWindows[String(h)] || []).map(w => ({ start: w.start, stop: w.stop }))
  }))
}

// 网站托管状态中代表「正在托管/排队」的状态（此时重复启动无意义）
const GARDEN_ACTIVE_STATES = ['armed', 'managed', 'running', 'schedule_wait', 'finishing']

// 网站托管状态 → 中文
const GARDEN_STATE_TEXT = {
  paused: '已暂停',
  armed: '已就绪',
  managed: '托管中',
  running: '运行中',
  schedule_wait: '等待定时',
  finishing: '收尾中',
  blocked: '受阻'
}

Page({
  data: {
    loading: false,
    accounts: [],
    // Tab：accounts 托管账号 / logs 执行日志（每个账号一张卡片）
    activeTab: 'accounts',
    panelLoading: false,
    panelError: '',
    panelAccounts: [],
    panelErrors: [],
    // 定时任务总开关（停止/恢复自动启停）
    masterEnabled: true,
    masterSwitching: false,
    // 添加/编辑账号表单
    formVisible: false,
    editingId: '',
    saving: false,
    form: { remark: '', username: '', password: '' },
    // 花园时段编辑器（同时只打开一个）：{ key: '账号下标_花园下标', accountId, gardenId, windows: [] }
    gardenEditor: null,
    savingGardenWindows: false,
    // 交易弹层（tab: orders 交易记录 / requests 求购大厅；打开期间每 10 秒自动刷新）
    tradeSheet: {
      visible: false, tab: 'orders', loading: false, refreshing: false, error: '', updatedAtText: '',
      accountId: '', accountName: '', role: 'sell',
      items: [], summary: { orders: 0, groups: 0, minutes: 0, minutesText: '' },
      todayGardens: [], todayTotal: { groups: 0, minutes: 0, minutesText: '' }
    },
    // 求购大厅（可接单列表）+ 各花园库存
    requestSheet: {
      loading: false, refreshing: false, error: '', updatedAtText: '', acceptableCount: 0, items: [],
      stockLoading: false, stockError: '', stockGardens: [], stockFlowers: [], stockUpdatedAt: '',
      onlySellable: true, // 默认只看我能卖的
      // 排序花园：id 为空表示按账号总库存排序
      sortGardens: [{ id: '', name: '全部花园' }], sortGardenIndex: 0, sortGardenId: '', sortGardenName: '全部花园'
    },
    // 自动接单日志弹层（该账号全部自动接单记录）
    logSheet: {
      visible: false, accountId: '', accountName: '', logs: [], loading: false, error: '',
      steps: [], running: false
    },
  },

  onLoad() {
    this.checkIsLoggedIn()
  },

  onShow() {
    if (!this.checkIsLoggedIn()) return
    // 每次进入页面都从服务端拉一次最新账号/花园配置，避免展示内存里的旧数据
    if (this.data.accounts.length && !this.data.loading) {
      this.loadAccounts()
    }
  },

  onHide() {
    this.stopLogsTimer()
    this.stopGardenLogTimer()
    this.stopTradeTimer()
  },

  onUnload() {
    this.stopLogsTimer()
    this.stopGardenLogTimer()
    this.stopTradeTimer()
  },

  checkIsLoggedIn() {
    const token = app.getToken()
    const userInfo = app.getUserInfo()

    if (!token || !userInfo) {
      wx.showToast({ title: '请先登录', icon: 'none' })
      setTimeout(() => { wx.reLaunch({ url: '/pages/index/index' }) }, 1500)
      return false
    }
    if (!this.data.accounts.length && !this.data.loading) {
      this.loadAccounts()
    }
    return true
  },

  // ===== 云函数调用封装（所有请求/响应均打印日志） =====
  callApi(action, extra = {}) {
    console.log('[请求] ppgardenTimer.' + action, JSON.stringify(extra || {}))
    return app.globalData.cloud.callFunction({
      name: 'ppgardenTimer',
      data: Object.assign({ token: app.getToken(), action }, extra)
    }).then(res => {
      const result = res.result || { code: 500, message: '空响应' }
      console.log(
        '[响应] ppgardenTimer.' + action,
        'code=' + result.code,
        JSON.stringify(result.data || result.message || '').slice(0, 500)
      )
      return result
    }).catch(err => {
      console.error('[请求异常] ppgardenTimer.' + action, err && err.message)
      throw err
    })
  },

  // ===== 账号列表 =====
  async loadAccounts() {
    if (!app.globalData.cloud) {
      wx.showToast({ title: '云开发未初始化', icon: 'none' })
      return
    }
    this.setData({ loading: true })
    try {
      const res = await this.callApi('list')
      if (res.code !== 0) throw new Error(res.message || '加载失败')

      const today = todayStr()
      const accounts = ((res.data && res.data.accounts) || []).map(a => this.decorateAccount(a, today))
      this.setData({
        accounts,
        masterEnabled: res.data && res.data.masterEnabled !== false,
        loading: false
      })
      // 常显数据自动补齐：无状态缓存的账号静默获取一次；花园列表为空的自动加载一次
      this.autoFillAccountData()
      // 正在托管的花园：自动拉取其动态日志并开启定时增量刷新（无需点击）
      this.loadHostingGardenLogs()
      this.startGardenLogTimer()
    } catch (err) {
      this.setData({ loading: false })
      console.error('[Ppgarden] 加载账号失败:', err)
      wx.showToast({ title: err.message || '加载失败', icon: 'none' })
    }
  },

  // 组装账号的展示字段
  decorateAccount(a, today) {
    const gardenList = Array.isArray(a.gardenList) ? a.gardenList : []
    const configs = a.gardenConfigs || {}
    const hc = a.hostingCache || null
    console.log('[Ppgarden] decorateAccount', a.remark || a.username, 'gardenConfigs=', JSON.stringify(configs))

    // 花园实时托管状态（用于启停按钮可用性；状态未知时两个按钮都可用）
    const stateMap = {}
    // 元宝数量映射：gardenId -> 元宝数（来自网站 hosting-summary 的 holdings.diamond）
    const diamondMap = {}
    if (hc && Array.isArray(hc.states)) {
      for (const s of hc.states) {
        if (!s || !s.gardenId) continue
        if (s.state) stateMap[s.gardenId] = s.state
        if (s.diamond !== undefined && s.diamond !== null) diamondMap[s.gardenId] = s.diamond
      }
    }

    const gardenRows = gardenList.map(g => {
      const cfg = configs[g.id] || {}
      const windows = Array.isArray(cfg.windows) ? cfg.windows : []
      const st = stateMap[g.id]
      const active = st ? GARDEN_ACTIVE_STATES.indexOf(st) !== -1 : null
      const specialWindows = normalizeHourWindows(cfg.hourWindows)
      const diamond = diamondMap[g.id]
      return {
        gardenId: g.id,
        name: g.name || g.id,
        channelText: CHANNEL_TEXT[g.channel] || '',
        schedEnabled: cfg.schedEnabled !== false,
        windowsText: windows.map(w => pad(w.start) + '~' + pad(w.stop)).join('、'),
        hasWindows: windows.length > 0,
        // 元宝数量
        diamond,
        diamondText: diamond === undefined ? '' : String(diamond),
        hasDiamond: diamond !== undefined,
        // 专属时段（如 19~20 点单独设置的时段）
        specialWindows,
        specialText: specialWindowsText(specialWindows),
        hasSpecial: Object.keys(specialWindows).length > 0,
        busyStart: false,
        busyPause: false,
        // 花园动态日志（行内直接展示）
        logs: null,
        logsLoading: false,
        logsError: '',
        logsCollapsed: false,
        // 正在托管 → 启动禁用/暂停可用；未托管 → 暂停禁用/启动可用；未知 → 都可用
        canStart: active === null ? true : !active,
        canPause: active === null ? true : active,
        // 实时托管状态文字（显示在花园卡片右上角）
        stateText: st ? (GARDEN_STATE_TEXT[st] || st) : ''
      }
    })

    const diamondTotal = Object.keys(diamondMap).reduce((sum, k) => sum + (Number(diamondMap[k]) || 0), 0)

    // 钱包：剩余时长（effectiveMs，毫秒）
    const w = (hc && hc.wallet) || null
    const remainMs = w && typeof w.effectiveMs === 'number' ? w.effectiveMs : null
    const remainText = remainMs === null ? '' : formatDuration(remainMs)

    return Object.assign({}, a, {
      gardenRows,
      sessionOk: a.lastLoginDate === today,
      loginError: a.loginErrorDate === today,
      statusLoading: false,
      // 剩余时长（钱包 effectiveMs）
      remainMs,
      remainText,
      hasRemain: remainMs !== null,
      walletDisplay: w ? (w.display || '') : '',
      runningGardens: w && typeof w.runningGardens === 'number' ? w.runningGardens : null,
      // 状态直接展示：优先用云端缓存，可手动/自动刷新
      states: hc && Array.isArray(hc.states) ? hc.states : [],
      statusSummary: hc ? hc.summaryText : '',
      statusUpdatedAtText: hc && hc.updatedAtMs ? fmtShort(hc.updatedAtMs) : '',
      // 账号级元宝合计（所有花园之和）
      diamondTotal,
      diamondTotalText: diamondTotal ? String(diamondTotal) : '',
      hasDiamondTotal: Object.keys(diamondMap).length > 0,
      // 账号级「托管中」标记：任一花园在托即生效（卡片加高亮描边）
      anyHosting: gardenRows.some(r => r.canStart === false),
      // 自动接单配置（兼容历史数据缺失字段）
      autoSellExpanded: !!(this._autoSellOpen && this._autoSellOpen[a._id]), // 配置面板是否展开（仅前端状态）
      autoSellEnabled: a.autoSellEnabled === true,
      autoSellMinPrice: a.autoSellMinPrice != null ? Number(a.autoSellMinPrice) : 40,
      // 检测间隔（分钟），默认 2
      autoSellIntervalMin: a.autoSellIntervalMin != null ? Number(a.autoSellIntervalMin) : 2,
      autoSellStartTime: a.autoSellStartTime || '01:30',
      autoSellEndTime: a.autoSellEndTime || '23:59',
      // 最近一次自动接单检查结果
      autoSellStatus: a.autoSellStatus
        ? {
          text: a.autoSellStatus.text || '',
          timeText: a.autoSellStatus.at ? fmtShort(a.autoSellStatus.at) : ''
        }
        : null
    })
  },

  onRefresh() {
    this.loadAccounts()
    if (this.data.activeTab === 'logs') this.loadPanel()
  },

  // ===== Tab 切换 =====
  onSwitchTab(e) {
    const tab = e.currentTarget.dataset.tab
    this.setData({ activeTab: tab })
    if (tab === 'logs') {
      this.loadPanel()
      this.startLogsTimer()
    } else {
      this.stopLogsTimer()
    }
  },

  // 拉取正在托管面板（按账号聚合：花园状态 + 日志首页）
  async loadPanel() {
    if (this.data.panelLoading) return
    this.setData({ panelLoading: true })
    try {
      const res = await this.callApi('accountPanel', { logsLimit: 10 })
      if (res.code !== 0) throw new Error(res.message || '加载失败')
      this.setData({
        panelAccounts: (res.data && res.data.accounts) || [],
        panelErrors: (res.data && res.data.errors) || [],
        panelError: ''
      })
    } catch (err) {
      console.error('[Ppgarden] 执行日志面板加载失败:', err)
      this.setData({ panelError: err.message || '加载失败' })
    } finally {
      this.setData({ panelLoading: false })
    }
  },

  // 卡片内日志上拉分页加载
  async onLoadMoreLogs(e) {
    const ai = e.currentTarget.dataset.ai
    const acc = this.data.panelAccounts[ai]
    if (!acc || acc.logsLoading || acc.logsComplete) return
    const cursor = acc.logs.length ? acc.logs[acc.logs.length - 1].ts : 0
    this.setData({ ['panelAccounts[' + ai + '].logsLoading']: true })
    try {
      const res = await this.callApi('accountLogs', { accountId: acc.accountId, before: cursor, limit: 10 })
      if (res.code !== 0) throw new Error(res.message || '加载失败')
      const more = (res.data && res.data.logs) || []
      const complete = !!(res.data && res.data.complete)
      this.setData({
        ['panelAccounts[' + ai + '].logs']: acc.logs.concat(more),
        ['panelAccounts[' + ai + '].logsComplete']: complete
      })
    } catch (err) {
      wx.showToast({ title: err.message || '加载失败', icon: 'none' })
    } finally {
      this.setData({ ['panelAccounts[' + ai + '].logsLoading']: false })
    }
  },

  // 日志动态刷新：正在托管的账号每 10 秒补拉最新日志
  startLogsTimer() {
    if (this._logsTimer) return
    this._logsTimer = setInterval(() => this.refreshNewLogs(), 10000)
  },

  stopLogsTimer() {
    if (this._logsTimer) {
      clearInterval(this._logsTimer)
      this._logsTimer = null
    }
  },

  // 只补拉「托管中」账号的新日志（按最新一条时间作游标），不翻动已有分页
  async refreshNewLogs() {
    const accounts = this.data.panelAccounts
    for (let ai = 0; ai < accounts.length; ai++) {
      const acc = accounts[ai]
      if (!acc.activeCount || acc.logsLoading) continue
      try {
        const after = acc.logs.length ? acc.logs[0].ts : 0
        const res = await this.callApi('accountLogs', { accountId: acc.accountId, after, limit: 20 })
        if (res.code !== 0) continue
        const newer = (res.data && res.data.logs) || []
        if (!newer.length) continue
        const cur = this.data.panelAccounts[ai]
        if (!cur || cur.accountId !== acc.accountId) continue
        const exist = {}
        for (const l of cur.logs) exist[l.id] = true
        const add = newer.filter(l => !exist[l.id])
        if (add.length) {
          this.setData({ ['panelAccounts[' + ai + '].logs']: add.concat(cur.logs) })
        }
      } catch (e) { /* 静默，下一轮再取 */ }
    }
  },

  // 页面加载后静默补齐常显数据（状态缓存 / 花园列表）
  async autoFillAccountData() {
    const accounts = this.data.accounts
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i]
      try {
        if (!acc.statusSummary) {
          await this.checkStatusRequest(acc._id, i, true)
        }
        const cur = this.data.accounts[i]
        if (cur && cur._id === acc._id && (!cur.gardenRows || !cur.gardenRows.length)) {
          await this.reloadGardens(i, true)
        }
      } catch (e) { /* 静默失败，可手动刷新 */ }
    }
  },

  // ===== 定时任务总开关 =====
  async onToggleMaster(e) {
    if (this.data.masterSwitching) return
    const enabled = e.detail.value
    this.setData({ masterSwitching: true, masterEnabled: enabled })
    try {
      const res = await this.callApi('setMaster', { enabled })
      if (res.code !== 0) throw new Error(res.message || '操作失败')
      wx.showToast({ title: res.message, icon: 'none' })
    } catch (err) {
      this.setData({ masterEnabled: !enabled })
      wx.showToast({ title: err.message || '操作失败', icon: 'none' })
    } finally {
      this.setData({ masterSwitching: false })
    }
  },

  // ===== 自动接单 =====
  // 展开/收起自动接单配置（默认只占一行）
  onToggleAutoSellPanel(e) {
    const index = Number(e.currentTarget.dataset.index)
    const acc = this.data.accounts[index]
    if (!acc) return
    const open = !acc.autoSellExpanded
    if (!this._autoSellOpen) this._autoSellOpen = {}
    if (open) this._autoSellOpen[acc._id] = true
    else delete this._autoSellOpen[acc._id]
    this.setData({ ['accounts[' + index + '].autoSellExpanded']: open })
  },

  async onToggleAutoSell(e) {
    const index = e.currentTarget.dataset.index
    const id = e.currentTarget.dataset.id
    const enabled = !!e.detail.value
    const acc = this.data.accounts[index]
    // 开启时云端会先刷新花园库存校验可卖组数，耗时稍长
    let loadingShown = false
    if (enabled) {
      wx.showLoading({ title: '校验库存中', mask: true })
      loadingShown = true
    }
    const hideLoading = () => {
      if (loadingShown) {
        wx.hideLoading()
        loadingShown = false
      }
    }
    this.setData({ ['accounts[' + index + '].autoSellEnabled']: enabled })
    try {
      const res = await this.callApi('setAutoSell', { _id: id, enabled })
      hideLoading()
      if (res.code !== 0) throw new Error(res.message || '操作失败')
      wx.showToast({ title: enabled ? '已开启自动接单' : '已关闭自动接单', icon: 'none' })
    } catch (err) {
      hideLoading()
      this.setData({ ['accounts[' + index + '].autoSellEnabled']: acc ? !!acc.autoSellEnabled : !enabled })
      const msg = err.message || '操作失败'
      if (enabled) {
        wx.showModal({ title: '无法开启自动接单', content: msg, showCancel: false })
      } else {
        wx.showToast({ title: msg, icon: 'none' })
      }
    }
  },

  async onAutoSellPriceBlur(e) {
    const index = e.currentTarget.dataset.index
    const id = e.currentTarget.dataset.id
    const acc = this.data.accounts[index]
    if (!acc) return
    const v = Number(e.detail.value)
    if (!Number.isFinite(v) || v <= 0) {
      this.setData({ ['accounts[' + index + '].autoSellMinPrice']: acc.autoSellMinPrice || 40 })
      wx.showToast({ title: '请输入大于 0 的数字', icon: 'none' })
      return
    }
    if (v === Number(acc.autoSellMinPrice)) return
    this.setData({ ['accounts[' + index + '].autoSellMinPrice']: v })
    try {
      const res = await this.callApi('setAutoSell', { _id: id, minPrice: v })
      if (res.code !== 0) throw new Error(res.message || '操作失败')
      wx.showToast({ title: '已保存', icon: 'none' })
    } catch (err) {
      this.setData({ ['accounts[' + index + '].autoSellMinPrice']: acc.autoSellMinPrice || 40 })
      wx.showToast({ title: err.message || '保存失败', icon: 'none' })
    }
  },

  // 检测间隔（分钟）：1 ~ 1440
  async onAutoSellIntervalBlur(e) {
    const index = e.currentTarget.dataset.index
    const id = e.currentTarget.dataset.id
    const acc = this.data.accounts[index]
    if (!acc) return
    const v = Math.round(Number(e.detail.value))
    if (!Number.isFinite(v) || v < 1 || v > 1440) {
      this.setData({ ['accounts[' + index + '].autoSellIntervalMin']: acc.autoSellIntervalMin || 2 })
      wx.showToast({ title: '检测间隔应为 1~1440 分钟', icon: 'none' })
      return
    }
    if (v === Number(acc.autoSellIntervalMin)) return
    this.setData({ ['accounts[' + index + '].autoSellIntervalMin']: v })
    try {
      const res = await this.callApi('setAutoSell', { _id: id, intervalMin: v })
      if (res.code !== 0) throw new Error(res.message || '操作失败')
      wx.showToast({ title: '已保存', icon: 'none' })
    } catch (err) {
      this.setData({ ['accounts[' + index + '].autoSellIntervalMin']: acc.autoSellIntervalMin || 2 })
      wx.showToast({ title: err.message || '保存失败', icon: 'none' })
    }
  },

  // ===== 自动接单日志弹层 =====
  async onOpenAutoSellLogs(e) {
    const index = Number(e.currentTarget.dataset.index)
    const acc = this.data.accounts[index]
    if (!acc) return
    this.setData({
      logSheet: {
        visible: true,
        accountId: acc._id,
        accountName: acc.remark || acc.username,
        logs: [],
        loading: true,
        error: '',
        steps: [],
        running: false
      }
    })
    await this.fetchAutoSellLogs(acc._id)
  },

  onCloseAutoSellLogs() {
    this.setData({ 'logSheet.visible': false })
  },

  onRefreshAutoSellLogs() {
    this.fetchAutoSellLogs(this.data.logSheet.accountId)
  },

  // 立即执行一次自动接单，并把每一步判定结果显示在弹窗里
  async onRunAutoSellCheck() {
    const accountId = this.data.logSheet.accountId
    if (!accountId || this.data.logSheet.running) return
    this.setData({ 'logSheet.running': true, 'logSheet.steps': ['检查中...'] })
    try {
      const res = await this.callApi('autoSellRun', { _id: accountId })
      const steps = (res.data && res.data.steps) || []
      this.setData({ 'logSheet.steps': steps.length ? steps : ['无诊断信息'] })
      if (res.code !== 0) wx.showToast({ title: res.message || '执行失败', icon: 'none' })
      await this.fetchAutoSellLogs(accountId)
    } catch (err) {
      this.setData({ 'logSheet.steps': ['检查失败：' + (err.message || '网络异常')] })
    } finally {
      this.setData({ 'logSheet.running': false })
    }
  },

  // 一次取回该账号全部自动接单日志
  async fetchAutoSellLogs(accountId) {
    if (!accountId) return
    this.setData({ 'logSheet.loading': true, 'logSheet.error': '' })
    try {
      const res = await this.callApi('accountLogs', { accountId, allAutoSell: true })
      if (res.code !== 0) throw new Error(res.message || '加载失败')
      this.setData({ 'logSheet.logs': (res.data && res.data.logs) || [] })
    } catch (err) {
      this.setData({ 'logSheet.error': err.message || '加载失败' })
    } finally {
      this.setData({ 'logSheet.loading': false })
    }
  },

  // 更新账号某字段：整数组替换，确保 wx:for 内绑定的值一定刷新
  setAccountField(index, field, value) {
    const accounts = this.data.accounts.slice()
    if (!accounts[index]) return
    accounts[index] = Object.assign({}, accounts[index], { [field]: value })
    this.setData({ accounts })
  },

  // 接单时段：时间选择器变更后立即保存
  async onAutoSellTimeChange(e) {
    const ds = e.currentTarget.dataset || {}
    const field = ds.field
    const id = ds.id
    let index = ds.index
    if (index === undefined || index === null || index === '') {
      index = this.data.accounts.findIndex(a => a._id === id)
    }
    index = Number(index)
    const acc = this.data.accounts[index]
    const v = e.detail.value
    console.log('[Ppgarden] 自动接单时段变更:', { index, field, value: v, old: acc && acc[field] })
    if (!acc || !field) return
    if (!v || v === acc[field]) return
    const old = acc[field]
    this.setAccountField(index, field, v)
    const payload = field === 'autoSellStartTime' ? { startTime: v } : { endTime: v }
    try {
      const res = await this.callApi('setAutoSell', Object.assign({ _id: id || acc._id }, payload))
      if (res.code !== 0) throw new Error(res.message || '保存失败')
      wx.showToast({ title: '已保存', icon: 'none' })
    } catch (err) {
      this.setAccountField(index, field, old)
      wx.showToast({ title: err.message || '保存失败', icon: 'none' })
    }
  },

  // ===== 添加 / 编辑账号 =====
  onAddTap() {
    this.setData({
      formVisible: true,
      editingId: '',
      form: { remark: '', username: '', password: '' }
    })
  },

  onEditTap(e) {
    const index = e.currentTarget.dataset.index
    const acc = this.data.accounts[index]
    if (!acc) return
    this.setData({
      formVisible: true,
      editingId: acc._id,
      form: {
        remark: acc.remark || '',
        username: acc.username || '',
        password: '' // 编辑模式留空表示不修改
      }
    })
  },

  onCancelForm() {
    this.setData({ formVisible: false, editingId: '', form: { remark: '', username: '', password: '' } })
  },

  noop() {},

  onFormInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ ['form.' + field]: e.detail.value })
  },

  async onSaveAccount() {
    if (this.data.saving) return
    const f = this.data.form
    const editing = !!this.data.editingId

    if (!f.username.trim()) {
      wx.showToast({ title: '请输入账号', icon: 'none' }); return
    }
    if (!editing && !f.password.trim()) {
      wx.showToast({ title: '请输入密码', icon: 'none' }); return
    }

    this.setData({ saving: true })
    try {
      const payload = {
        remark: f.remark.trim(),
        username: f.username.trim()
      }
      if (f.password.trim()) payload.password = f.password.trim()

      const res = await this.callApi(editing ? 'update' : 'add', editing
        ? Object.assign({ _id: this.data.editingId }, payload)
        : payload)

      if (res.code !== 0) throw new Error(res.message || '保存失败')

      wx.showToast({ title: '保存成功', icon: 'success' })
      this.onCancelForm()
      this.loadAccounts()
    } catch (err) {
      console.error('[Ppgarden] 保存失败:', err)
      wx.showModal({ title: '保存失败', content: err.message || '请稍后重试', showCancel: false })
    } finally {
      this.setData({ saving: false })
    }
  },

  // ===== 删除账号 =====
  onDeleteTap(e) {
    const id = e.currentTarget.dataset.id
    const name = e.currentTarget.dataset.name
    wx.showModal({
      title: '删除账号',
      content: '确定删除「' + (name || '该账号') + '」吗？删除后所有花园配置一并清除。',
      confirmColor: '#e64340',
      success: async res => {
        if (!res.confirm) return
        try {
          const r = await this.callApi('delete', { _id: id })
          if (r.code !== 0) throw new Error(r.message || '删除失败')
          wx.showToast({ title: '已删除', icon: 'success' })
          this.loadAccounts()
        } catch (err) {
          wx.showToast({ title: err.message || '删除失败', icon: 'none' })
        }
      }
    })
  },

  // ===== 从网站刷新花园列表 =====
  onReloadGardens(e) {
    this.reloadGardens(e.currentTarget.dataset.index)
  },

  async reloadGardens(index, silent) {
    const acc = this.data.accounts[index]
    if (!acc || acc.gardensLoading) return
    this.setData({ ['accounts[' + index + '].gardensLoading']: true })
    try {
      const res = await this.callApi('loadGardens', { _id: acc._id })
      if (res.code !== 0) throw new Error(res.message || '加载失败')
      // 防止等待期间账号列表刷新导致错位
      const cur = this.data.accounts[index]
      if (!cur || cur._id !== acc._id) return
      // 重新组装花园行（沿用当前已知配置；gardenList 以网站返回为准）
      const today = todayStr()
      const fresh = this.decorateAccount(Object.assign({}, cur, {
        gardenList: (res.data && res.data.gardens) || [],
        gardenConfigs: cur.gardenConfigs || {}
      }), today)
      this.setData({
        ['accounts[' + index + '].gardenList']: (res.data && res.data.gardens) || cur.gardenList || [],
        ['accounts[' + index + '].gardenRows']: fresh.gardenRows,
        ['accounts[' + index + '].gardensLoading']: false
      })
    } catch (err) {
      this.setData({ ['accounts[' + index + '].gardensLoading']: false })
      if (!silent) wx.showToast({ title: err.message || '加载花园列表失败', icon: 'none' })
    }
  },

  // ===== 花园定时开关 =====
  async onToggleGardenSched(e) {
    const { index, ri, id, gardenId } = e.currentTarget.dataset
    const enabled = e.detail.value
    const acc = this.data.accounts[index]
    if (!acc) return
    const row = acc.gardenRows && acc.gardenRows[ri]
    if (!row || row.gardenId !== gardenId) return

    this.setData({ ['accounts[' + index + '].gardenRows[' + ri + '].schedEnabled']: enabled })
    try {
      const res = await this.callApi('setGardenConfig', { _id: id, gardenId, schedEnabled: enabled })
      if (res.code !== 0) throw new Error(res.message)
      if (!enabled) return
      if (!row.hasWindows) {
        wx.showToast({ title: '已开启，请先为该花园设置时段', icon: 'none' })
      }
    } catch (err) {
      this.setData({ ['accounts[' + index + '].gardenRows[' + ri + '].schedEnabled']: !enabled })
      wx.showToast({ title: err.message || '修改失败', icon: 'none' })
    }
  },

  // ===== 手动启动 / 暂停某个花园 =====
  async onGardenRun(e) {
    await this.gardenAction(e, 'startGarden', 'start')
  },

  async onGardenPause(e) {
    await this.gardenAction(e, 'pauseGarden', 'pause')
  },

  async gardenAction(e, action, act) {
    const { index, ri, id, gardenId } = e.currentTarget.dataset
    const acc = this.data.accounts[index]
    if (!acc) return
    const row = acc.gardenRows && acc.gardenRows[ri]
    if (!row || row.gardenId !== gardenId) return
    const busyField = 'accounts[' + index + '].gardenRows[' + ri + '].' + (act === 'start' ? 'busyStart' : 'busyPause')
    const otherField = 'accounts[' + index + '].gardenRows[' + ri + '].' + (act === 'start' ? 'busyPause' : 'busyStart')
    if (row.busyStart || row.busyPause) return

    this.setData({ [busyField]: true, [otherField]: true })
    try {
      const res = await this.callApi(action, { _id: id, gardenId })
      if (res.code !== 0) throw new Error(res.message || '执行失败')
      wx.showToast({ title: res.message, icon: 'none' })
      // 启停后自动刷新状态展示
      this.checkStatusRequest(id, index)
    } catch (err) {
      wx.showModal({ title: '执行失败', content: err.message || '网络异常', showCancel: false })
    } finally {
      this.setData({ [busyField]: false, [otherField]: false })
    }
  },

  // ===== 花园时段编辑器（内联展开） =====
  onEditGardenWindows(e) {
    const { index, ri } = e.currentTarget.dataset
    const acc = this.data.accounts[index]
    if (!acc) return
    const row = acc.gardenRows && acc.gardenRows[ri]
    if (!row) return

    const key = index + '_' + ri
    // 再次点击收起
    if (this.data.gardenEditor && this.data.gardenEditor.key === key) {
      this.setData({ gardenEditor: null })
      return
    }
    // 从云端配置回填（row 里只有文本，取原始配置）
    const cfg = (acc.gardenConfigs || {})[row.gardenId] || {}
    const windows = (Array.isArray(cfg.windows) ? cfg.windows : []).map(w => ({ start: w.start, stop: w.stop }))
    const specialWindows = normalizeHourWindows(cfg.hourWindows)
    // 把全部小时的专属时段映射为可编辑列表（数组形式，便于 wx:for），
    // 默认小时（21 点）始终保留一项，便于直接添加；其余历史小时（如旧的 19 点）也展示出来，可删除
    const specials = buildEditorSpecials(specialWindows, SPECIAL_HOUR)
    this.setData({
      gardenEditor: {
        key,
        accountId: acc._id,
        accountIndex: index,
        rowIndex: ri,
        gardenId: row.gardenId,
        gardenName: row.name,
        windows,
        specials
      }
    })
  },

  onCancelGardenEditor() {
    this.setData({ gardenEditor: null })
  },

  noop() {},

  onEditorAdd() {
    const ed = this.data.gardenEditor
    if (!ed) return
    if (ed.windows.length >= 6) {
      wx.showToast({ title: '最多 6 个时段', icon: 'none' })
      return
    }
    let start = 0
    if (ed.windows.length) {
      const last = ed.windows[ed.windows.length - 1]
      start = Math.min(last.stop + 1, 57)
    }
    this.setData({ ['gardenEditor.windows']: ed.windows.concat([{ start, stop: Math.min(start + 4, 59) }]) })
  },

  onEditorRemove(e) {
    const ed = this.data.gardenEditor
    if (!ed) return
    const wi = e.currentTarget.dataset.wi
    const windows = ed.windows.slice()
    windows.splice(wi, 1)
    this.setData({ ['gardenEditor.windows']: windows })
  },

  onEditorInput(e) {
    const ed = this.data.gardenEditor
    if (!ed) return
    const { wi, field } = e.currentTarget.dataset
    // 只保留数字，最多 2 位，超过 59 自动收敛为 59；允许暂时为空（保存时统一校验）
    let v = String(e.detail.value == null ? '' : e.detail.value).replace(/[^\d]/g, '').slice(0, 2)
    const num = v === '' ? '' : Math.min(parseInt(v, 10), 59)
    this.setData({ ['gardenEditor.windows[' + wi + '].' + field]: num })
  },

  // ===== 专属时段（默认 21~22 点，可同时管理其它小时）编辑 =====
  onEditorSpecialAdd(e) {
    const ed = this.data.gardenEditor
    if (!ed) return
    const si = e.currentTarget.dataset.si
    const list = (ed.specials && ed.specials[si] && ed.specials[si].list) || []
    if (list.length >= 6) {
      wx.showToast({ title: '最多 6 个时段', icon: 'none' })
      return
    }
    let start = 0
    if (list.length) {
      const last = list[list.length - 1]
      start = Math.min(Number(last.stop) + 1 || 0, 57)
    }
    this.setData({ ['gardenEditor.specials[' + si + '].list']: list.concat([{ start, stop: Math.min(start + 4, 59) }]) })
  },

  onEditorSpecialRemove(e) {
    const ed = this.data.gardenEditor
    if (!ed) return
    const { si, wi } = e.currentTarget.dataset
    const list = ((ed.specials && ed.specials[si] && ed.specials[si].list) || []).slice()
    list.splice(wi, 1)
    // 全部删除 = 清除该小时专属时段，恢复沿用整体时段
    this.setData({ ['gardenEditor.specials[' + si + '].list']: list })
  },

  // 清除某个小时的全部专属时段（该小时恢复沿用整体时段）
  onEditorSpecialClear(e) {
    const si = e.currentTarget.dataset.si
    this.setData({ ['gardenEditor.specials[' + si + '].list']: [] })
  },

  onEditorSpecialInput(e) {
    const ed = this.data.gardenEditor
    if (!ed) return
    const { si, wi, field } = e.currentTarget.dataset
    let v = String(e.detail.value == null ? '' : e.detail.value).replace(/[^\d]/g, '').slice(0, 2)
    const num = v === '' ? '' : Math.min(parseInt(v, 10), 59)
    this.setData({ ['gardenEditor.specials[' + si + '].list[' + wi + '].' + field]: num })
  },

  validateWindowsList(windows, label) {
    const seen = []
    const prefix = label ? label + '：' : ''
    for (const w of windows) {
      const s = Number(w.start)
      const e2 = Number(w.stop)
      if (w.start === '' || w.stop === '' || !(s >= 0 && s <= 59) || !(e2 >= 0 && e2 <= 59) || e2 - s < 2) {
        return prefix + '时段无效：请输入 0~59 的分钟数，且时长至少 2 分钟'
      }
      for (const p of seen) {
        if (s < p.stop && p.start < e2) {
          return prefix + '同一花园的时段不能重叠（' + pad(s) + '~' + pad(e2) + '）'
        }
      }
      seen.push({ start: s, stop: e2 })
    }
    return ''
  },

  async onSaveGardenWindows() {
    const ed = this.data.gardenEditor
    if (!ed || this.data.savingGardenWindows) return

    const specials = ed.specials || []

    const winErr = this.validateWindowsList(ed.windows)
    if (winErr) {
      wx.showToast({ title: winErr, icon: 'none' }); return
    }
    for (const sp of specials) {
      const err = this.validateWindowsList(sp.list || [], sp.label)
      if (err) {
        wx.showToast({ title: err, icon: 'none' }); return
      }
    }

    // 专属时段：提交「整份映射」（含所有已展示的小时），
    // 时间段为空的小时不写入 => 该小时恢复沿用整体时段（可借此清除历史的 19 点等旧配置）
    const hourWindows = {}
    for (const sp of specials) {
      const list = (sp.list || []).filter(w => w.start !== '' && w.stop !== '')
      if (list.length) hourWindows[String(sp.hour)] = list
    }
    console.log('[Ppgarden] 保存时段，windows=', JSON.stringify(ed.windows), 'hourWindows=', JSON.stringify(hourWindows))

    this.setData({ savingGardenWindows: true })
    try {
      // 一次请求同时提交整体时段与专属时段（整份覆盖，避免两次调用产生中间态）
      const res = await this.callApi('setGardenConfig', {
        _id: ed.accountId,
        gardenId: ed.gardenId,
        windows: ed.windows,
        hourWindows,
        // 显式标记「本次提交是整份覆盖」，空映射时也确保云端执行覆盖（清除全部专属时段）
        replaceHourWindows: true
      })
      if (res.code !== 0) throw new Error(res.message || '保存失败')

      // 保存后回读校验：确认云端确实落库（若云函数未更新到支持 hourWindows 的版本，
      // 旧版会忽略该参数并返回成功，导致「显示保存成功但数据没变」，这里明确提示）
      const check = await this.callApi('list')
      if (check.code === 0) {
        const acc = ((check.data && check.data.accounts) || []).find(a => a._id === ed.accountId)
        const savedCfg = (acc && acc.gardenConfigs && acc.gardenConfigs[ed.gardenId]) || {}
        const savedHw = normalizeHourWindows(savedCfg.hourWindows)
        const expectHours = Object.keys(hourWindows).sort()
        const actualHours = Object.keys(savedHw).sort()
        if (expectHours.join(',') !== actualHours.join(',')) {
          wx.showModal({
            title: '保存未完全生效',
            content: '云端仍保留专属时段：' + (actualHours.length ? actualHours.map(h => h + ' 点').join('、') : '（无）') +
              '。请重新上传部署 ppgardenTimer 云函数（本次改动依赖新版本云函数）。',
            showCancel: false
          })
          return
        }
      }

      wx.showModal({ title: '保存成功', content: res.message, showCancel: false })
      this.setData({ gardenEditor: null })
      this.loadAccounts()
    } catch (err) {
      wx.showModal({ title: '保存失败', content: err.message || '请稍后重试', showCancel: false })
    } finally {
      this.setData({ savingGardenWindows: false })
    }
  },

  // ===== 刷新托管状态 =====
  onRefreshStatus(e) {
    const { id, index } = e.currentTarget.dataset
    const acc = this.data.accounts[index]
    if (!acc || acc.statusLoading) return
    this.checkStatusRequest(id, index)
  },

  async checkStatusRequest(id, index, silent) {
    const cur = this.data.accounts[index]
    if (!cur || cur._id !== id || cur.statusLoading) return
    this.setData({ ['accounts[' + index + '].statusLoading']: true })
    try {
      const res = await this.callApi('status', { _id: id })
      if (res.code !== 0) throw new Error(res.message || '查询失败')
      // 防止等待期间账号列表刷新导致错位
      const nowCur = this.data.accounts[index]
      if (!nowCur || nowCur._id !== id) return
      // 同步刷新花园行启停按钮可用性（不触碰 busy 标记）
      const stateMap = {}
      const diamondMap = {}
      for (const s of (res.data.gardens || [])) {
        if (!s || !s.gardenId) continue
        if (s.state) stateMap[s.gardenId] = s.state
        if (s.diamond !== undefined && s.diamond !== null) diamondMap[s.gardenId] = s.diamond
      }
      const patch = {
        ['accounts[' + index + '].statusSummary']: res.data.summaryText,
        ['accounts[' + index + '].states']: res.data.gardens || [],
        ['accounts[' + index + '].statusLoading']: false,
        ['accounts[' + index + '].statusUpdatedAtText']: fmtShort(Date.now())
      }
      const rows = (this.data.accounts[index] && this.data.accounts[index].gardenRows) || []
      rows.forEach((row, ri) => {
        const d = diamondMap[row.gardenId]
        if (d !== undefined) {
          patch['accounts[' + index + '].gardenRows[' + ri + '].diamond'] = d
          patch['accounts[' + index + '].gardenRows[' + ri + '].diamondText'] = String(d)
          patch['accounts[' + index + '].gardenRows[' + ri + '].hasDiamond'] = true
        }
        const st = stateMap[row.gardenId]
        if (!st) return
        const active = GARDEN_ACTIVE_STATES.indexOf(st) !== -1
        patch['accounts[' + index + '].gardenRows[' + ri + '].canStart'] = !active
        patch['accounts[' + index + '].gardenRows[' + ri + '].canPause'] = active
        patch['accounts[' + index + '].gardenRows[' + ri + '].stateText'] = GARDEN_STATE_TEXT[st] || st
      })
      // 账号级元宝合计
      const diamondTotal = Object.keys(diamondMap).reduce((sum, k) => sum + (Number(diamondMap[k]) || 0), 0)
      patch['accounts[' + index + '].diamondTotal'] = diamondTotal
      patch['accounts[' + index + '].diamondTotalText'] = diamondTotal ? String(diamondTotal) : ''
      // 钱包剩余时长
      const w = res.data && res.data.wallet
      if (w) {
        const remainMs = typeof w.effectiveMs === 'number' ? w.effectiveMs : null
        patch['accounts[' + index + '].remainMs'] = remainMs
        patch['accounts[' + index + '].remainText'] = remainMs === null ? '' : formatDuration(remainMs)
        patch['accounts[' + index + '].hasRemain'] = remainMs !== null
        patch['accounts[' + index + '].walletDisplay'] = w.display || ''
        patch['accounts[' + index + '].runningGardens'] = typeof w.runningGardens === 'number' ? w.runningGardens : null
      }
      // 账号级「托管中」标记（任一花园在托即生效）
      patch['accounts[' + index + '].anyHosting'] = rows.some(row => {
        const st = stateMap[row.gardenId]
        return st ? GARDEN_ACTIVE_STATES.indexOf(st) !== -1 : false
      })
      this.setData(patch)
      // 状态刷新后补拉正在托管花园的动态日志，并确保定时刷新已开启
      this.loadHostingGardenLogs()
      this.startGardenLogTimer()
    } catch (err) {
      const failCur = this.data.accounts[index]
      if (!failCur || failCur._id !== id) return
      this.setData({
        ['accounts[' + index + '].statusLoading']: false,
        ['accounts[' + index + '].statusSummary']: (silent ? '状态获取失败' : '查询失败：') + (silent ? '' : (err.message || '未知错误')),
        ['accounts[' + index + '].states']: []
      })
    }
  },

  // ===== 花园动态日志（在花园行内直接展示，无需点击） =====
  // 加载某个花园的动态（index/ri 定位到具体行），写入该行的 row.logs
  async loadGardenLogsInline(index, ri, id, gardenId) {
    const cur = this.data.accounts[index]
    if (!cur) return
    const row = cur.gardenRows && cur.gardenRows[ri]
    if (!row || row.gardenId !== gardenId) return
    if (row.logsLoading) return
    this.setData({ ['accounts[' + index + '].gardenRows[' + ri + '].logsLoading']: true })
    try {
      const res = await this.callApi('gardenActivity', { _id: id, gardenId, limit: 20 })
      if (res.code !== 0) throw new Error(res.message || '加载失败')
      // 防止等待期间列表已刷新导致错位
      const nowCur = this.data.accounts[index]
      if (!nowCur || nowCur._id !== cur._id) return
      if (!nowCur.gardenRows[ri] || nowCur.gardenRows[ri].gardenId !== gardenId) return
      this.setData({
        ['accounts[' + index + '].gardenRows[' + ri + '].logs']: (res.data && res.data.items) || [],
        ['accounts[' + index + '].gardenRows[' + ri + '].logsLoading']: false,
        ['accounts[' + index + '].gardenRows[' + ri + '].logsError']: ''
      })
    } catch (err) {
      const nowCur = this.data.accounts[index]
      if (!nowCur || !nowCur.gardenRows[ri]) return
      this.setData({
        ['accounts[' + index + '].gardenRows[' + ri + '].logsLoading']: false,
        ['accounts[' + index + '].gardenRows[' + ri + '].logsError']: err.message || '加载失败'
      })
    }
  },

  // 批量拉取「正在运行/托管中」花园的动态日志（页面加载与状态刷新后自动调用）
  async loadHostingGardenLogs() {
    const accounts = this.data.accounts
    for (let index = 0; index < accounts.length; index++) {
      const acc = accounts[index]
      const rows = acc.gardenRows || []
      for (let ri = 0; ri < rows.length; ri++) {
        const row = rows[ri]
        // 只自动加载「非暂停」状态的花园（running/managed/armed/finishing 等）
        if (!row.stateText || row.canStart === true) continue
        const curRow = this.data.accounts[index] && this.data.accounts[index].gardenRows[ri]
        if (!curRow || curRow.logs || curRow.logsLoading) continue
        await this.loadGardenLogsInline(index, ri, acc._id, row.gardenId)
      }
    }
  },

  // 手动点击「刷新动态」
  onRefreshGardenLogs(e) {
    const { index, ri, id, gardenId } = e.currentTarget.dataset
    this.loadGardenLogsInline(index, ri, id, gardenId)
  },

  startGardenLogTimer() {
    if (this._gardenLogTimer) return
    this._gardenLogTimer = setInterval(() => this.refreshInlineGardenLogs(), 5000)
  },

  stopGardenLogTimer() {
    if (this._gardenLogTimer) {
      clearInterval(this._gardenLogTimer)
      this._gardenLogTimer = null
    }
  },

  // 定时增量补拉「正在托管」花园的最新动态（合并去重，不打断已加载内容）
  async refreshInlineGardenLogs() {
    const accounts = this.data.accounts
    for (let index = 0; index < accounts.length; index++) {
      const acc = accounts[index]
      const rows = acc.gardenRows || []
      for (let ri = 0; ri < rows.length; ri++) {
        const row = rows[ri]
        if (!row.stateText || row.canStart === true || row.logsLoading) continue
        try {
          const res = await this.callApi('gardenActivity', { _id: acc._id, gardenId: row.gardenId, limit: 10 })
          if (res.code !== 0) continue
          const fresh = (res.data && res.data.items) || []
          const cur = this.data.accounts[index]
          if (!cur || cur._id !== acc._id) continue
          const curRow = cur.gardenRows && cur.gardenRows[ri]
          if (!curRow || curRow.gardenId !== row.gardenId) continue
          const exist = {}
          for (const it of (curRow.logs || [])) exist[it.id] = true
          const add = fresh.filter(it => !exist[it.id])
          if (add.length) {
            this.setData({
              ['accounts[' + index + '].gardenRows[' + ri + '].logs']:
                add.concat(curRow.logs || []).slice(0, 20)
            })
          }
        } catch (e) { /* 静默，下一轮再取 */ }
      }
    }
  },

  // 展开/收起某个花园的动态列表
  onToggleGardenLogs(e) {
    const { index, ri } = e.currentTarget.dataset
    const row = this.data.accounts[index] && this.data.accounts[index].gardenRows[ri]
    if (!row) return
    const collapsed = !row.logsCollapsed
    this.setData({ ['accounts[' + index + '].gardenRows[' + ri + '].logsCollapsed']: collapsed })
  },

  // ===== 交易弹层 =====
  // 打开交易弹层：按点击的按钮定位到对应子标签（交易记录 / 求购大厅）
  onOpenTrades(e) {
    const { index, id, tab } = e.currentTarget.dataset
    const acc = this.data.accounts[index]
    if (!acc) return
    const accountName = acc.remark || acc.username || ''
    const initialTab = tab === 'requests' ? 'requests' : 'orders'
    // 每次打开弹窗重置报价缓存：只在首次加载时调用 sell-quote
    this._quoteMap = {}
    this._quoteDone = false
    this.setData({
      tradeSheet: {
        visible: true, tab: initialTab,
        // 不在此预置 loading：交给 loadTrades / loadRequests 自己置位，
        // 否则 loadRequests 开头的并发保护会因 loading 已为 true 而直接 return
        loading: false, refreshing: false, error: '', updatedAtText: '',
        accountId: id, accountName, role: 'sell',
        items: [], summary: { orders: 0, groups: 0, minutes: 0, minutesText: '' },
        todayGardens: [], todayTotal: { groups: 0, minutes: 0, minutesText: '' }
      },
      requestSheet: {
        loading: false, refreshing: false, error: '', updatedAtText: '', acceptableCount: 0, items: [],
        stockLoading: false, stockError: '', stockGardens: [], stockFlowers: [], stockUpdatedAt: '',
        onlySellable: true // 默认只看我能卖的
      }
    })
    // 弹窗打开时先刷新一次「各花园库存」（写入数据库 ppgarden_stock），再加载对应标签的数据
    this.refreshGardenStock(id)
    if (initialTab === 'requests') this.loadRequests()
    else this.loadTrades(id, 'sell')
    this.startTradeTimer() // 每 5 秒自动刷新当前标签
  },

  // 刷新各花园库存（云端会写入 ppgarden_stock 集合并返回明细）
  async refreshGardenStock(accountId) {
    if (!accountId) return
    this.setData({ 'requestSheet.stockLoading': true, 'requestSheet.stockError': '' })
    try {
      const res = await this.callApi('gardenStock', { _id: accountId })
      if (!this.data.tradeSheet.visible) return
      if (res.code !== 0) throw new Error(res.message || '库存刷新失败')
      // 补充各花园今日「已卖组数 / 剩余可卖组数」（来自 listings 的 summary）
      const gardens = ((res.data && res.data.gardens) || []).map(g => {
        const s = g.summary || {}
        const sold = Number(s.todaySoldGroups) || 0
        const rest = Number(s.sellableGroups) || 0
        const earned = Number(s.todayEarnedMinutes) || 0
        const fullName = g.gardenName || g.gardenId || ''
        // 短名称：取「s1828.柒柒」中 . 后面的部分，一行放得下 3 个账号
        const shortName = fullName.indexOf('.') >= 0
          ? fullName.split('.').pop()
          : fullName.slice(-4)
        return Object.assign({}, g, {
          shortName,
          soldGroups: sold,
          restGroups: rest,
          earnedMinutes: earned,
          earnedText: formatMinutesText(earned)
        })
      })
      // 排序花园选项：全部花园 + 各花园（保留当前选择）
      const sortGardens = [{ id: '', name: '全部花园' }].concat(gardens.map(g => ({
        id: g.gardenId,
        name: g.shortName || g.gardenName || g.gardenId
      })))
      let sortIndex = sortGardens.findIndex(x => x.id === this.data.requestSheet.sortGardenId)
      if (sortIndex < 0) sortIndex = 0

      this.setData({
        'requestSheet.stockLoading': false,
        'requestSheet.stockError': '',
        'requestSheet.stockGardens': gardens,
        'requestSheet.stockFlowers': (res.data && res.data.flowers) || [],
        'requestSheet.stockUpdatedAt': fmtShort(Date.now()),
        'requestSheet.sortGardens': sortGardens,
        'requestSheet.sortGardenIndex': sortIndex,
        'requestSheet.sortGardenId': sortGardens[sortIndex].id,
        'requestSheet.sortGardenName': sortGardens[sortIndex].name,
        // 交易记录 tab 的「今日售卖」汇总：各花园今日卖出组数 / 获得时长
        'tradeSheet.todayGardens': buildTodayGardens(gardens),
        'tradeSheet.todayTotal': sumToday(gardens)
      })
      // 库存更新后，若当前在求购标签，重新匹配展示
      if (this.data.tradeSheet.tab === 'requests') this.loadRequests(true)
    } catch (err) {
      const msg = err && err.message ? err.message : '库存刷新失败'
      console.warn('[Ppgarden] 刷新库存失败:', msg)
      this.setData({
        'requestSheet.stockLoading': false,
        'requestSheet.stockError': /不支持的操作/.test(msg)
          ? '云函数未更新，请重新部署 ppgardenTimer'
          : msg
      })
    }
  },

  // 子标签切换（交易记录 / 求购大厅）
  onSwitchTradeTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (!tab || tab === this.data.tradeSheet.tab) return
    this.setData({ 'tradeSheet.tab': tab })
    if (tab === 'requests') {
      // 切到求购大厅时刷新一次库存，再加载列表
      this.refreshGardenStock(this.data.tradeSheet.accountId)
      if (!this.data.requestSheet.items.length && !this.data.requestSheet.loading) this.loadRequests()
    } else if (!this.data.tradeSheet.items.length) {
      this.loadTrades(this.data.tradeSheet.accountId, this.data.tradeSheet.role)
    }
  },

  async loadTrades(accountId, role, silent) {
    if (!silent) this.setData({ 'tradeSheet.loading': true, 'tradeSheet.error': '' })
    else this.setData({ 'tradeSheet.refreshing': true })
    try {
      const res = await this.callApi('gardenTrades', { _id: accountId, role, limit: 100 })
      if (!this.data.tradeSheet.visible) return
      if (res.code !== 0) throw new Error(res.message || '加载失败')
      this.setData({
        'tradeSheet.items': (res.data && res.data.items) || [],
        'tradeSheet.summary': (res.data && res.data.summary) || { orders: 0, groups: 0, minutes: 0, minutesText: '' },
        'tradeSheet.loading': false,
        'tradeSheet.refreshing': false,
        'tradeSheet.error': '',
        'tradeSheet.updatedAtText': fmtShort(Date.now())
      })
    } catch (err) {
      if (!this.data.tradeSheet.visible) return
      if (silent) {
        this.setData({ 'tradeSheet.refreshing': false })
      } else {
        this.setData({ 'tradeSheet.loading': false, 'tradeSheet.error': err.message || '加载失败' })
      }
    }
  },

  // 求购大厅：拉取求购列表（含各花园库存数量；silent=true 为定时静默刷新）
  async loadRequests(silent) {
    // 并发保护用实例标记，不依赖 data 状态（避免 loading 被预置后把自己挡住）
    if (this._requestsLoading) return
    this._requestsLoading = true
    if (silent) this.setData({ 'requestSheet.refreshing': true })
    else this.setData({ 'requestSheet.loading': true, 'requestSheet.error': '' })
    try {
      // 只在弹窗打开后的首次加载请求 sell-quote（withQuote），后续刷新复用缓存
      const withQuote = !silent && !this._quoteDone
      // 不传 limit：云端返回全部求购；onlySellable 为「只看我能卖的」筛选
      const res = await this.callApi('tradeRequests', {
        _id: this.data.tradeSheet.accountId,
        onlySellable: !!this.data.requestSheet.onlySellable,
        withQuote
      })
      if (!this.data.tradeSheet.visible) return
      if (res.code !== 0) throw new Error(res.message || '加载失败')
      if (withQuote) this._quoteDone = true
      const items = this.applyQuoteCache((res.data && res.data.items) || [], withQuote)
      this.setData({
        'requestSheet.items': items,
        'requestSheet.acceptableCount': items.filter(x => x.canAccept).length,
        'requestSheet.loading': false,
        'requestSheet.refreshing': false,
        'requestSheet.error': '',
        'requestSheet.updatedAtText': fmtShort(Date.now())
      })
    } catch (err) {
      if (!this.data.tradeSheet.visible) return
      console.error('[Ppgarden] 求购列表加载失败:', err)
      if (silent) {
        // 静默刷新失败：保留已有数据，只在控制台提示
        console.warn('[Ppgarden] 求购列表静默刷新失败:', err.message)
        this.setData({ 'requestSheet.refreshing': false })
      } else {
        this.setData({ 'requestSheet.loading': false, 'requestSheet.refreshing': false, 'requestSheet.error': err.message || '加载失败' })
      }
    } finally {
      this._requestsLoading = false
    }
  },

  // 报价缓存：首次加载时存下各花园可卖组数，后续刷新沿用，避免重复调用 sell-quote
  applyQuoteCache(items, save) {
    if (!this._quoteMap) this._quoteMap = {}
    const map = this._quoteMap
    items.forEach(it => {
      const list = it.gardenStockList || []
      list.forEach(gs => {
        const key = it.requestId + '_' + gs.gardenId
        if (save) {
          map[key] = { groups: Number(gs.groups) || 0, count: Number(gs.count) || 0 }
        } else if (map[key]) {
          gs.groups = map[key].groups
          gs.count = map[key].count
        }
      })
      // 按最新组数重算汇总与可接单状态（与云端口径一致）
      const totalGroups = list.reduce((n, x) => n + (Number(x.groups) > 0 ? Number(x.groups) : 0), 0)
      it.sellableGroups = totalGroups
      it.sellableText = totalGroups > 0 ? ('可卖 ' + totalGroups + ' 组') : ''
      let reason = ''
      if (it.status !== 'open') reason = '求购已结束'
      else if (it.buyerQueueFull) reason = '对方排队已满'
      else if (it.buyerPlaying) reason = '对方正在游戏'
      else if (it.pausedReason) reason = it.pausedText || '求购已暂停'
      else if (!totalGroups) reason = '无可卖库存'
      it.blockReason = reason
      it.canAccept = !reason && totalGroups > 0
      list.forEach(x => {
        x.canAcceptGarden = !reason && (Number(x.groups) || 0) > 0
      })
    })
    // 按所选花园（未选则按账号总库存）的可卖组数从多到少排序
    return this.sortRequestItems(items)
  },

  // 求购列表排序：库存组数降序，库存相同按价格降序
  sortRequestItems(items) {
    const gid = this.data.requestSheet.sortGardenId
    const stockOf = it => {
      if (!gid) return Number(it.sellableGroups) || 0
      const gs = (it.gardenStockList || []).find(x => x && x.gardenId === gid)
      return gs ? (Number(gs.groups) || 0) : 0
    }
    items.sort((a, b) =>
      (stockOf(b) - stockOf(a)) ||
      ((Number(b.pricePerGroup) || 0) - (Number(a.pricePerGroup) || 0)))
    return items
  },

  // 切换排序花园：立即按该花园库存重排当前列表（无需重新请求）
  onSortGardenChange(e) {
    const i = Number(e.detail.value) || 0
    const opt = this.data.requestSheet.sortGardens[i] || { id: '', name: '全部花园' }
    this.setData({
      'requestSheet.sortGardenIndex': i,
      'requestSheet.sortGardenId': opt.id || '',
      'requestSheet.sortGardenName': opt.name || '全部花园'
    })
    const items = this.sortRequestItems((this.data.requestSheet.items || []).slice())
    this.setData({ 'requestSheet.items': items })
  },

  // 接单：用指定花园卖出（组数取站点给出的该花园可卖组数）
  async onAcceptGardenStock(e) {
    const { index, gindex } = e.currentTarget.dataset
    const it = this.data.requestSheet.items[index]
    if (!it || it.requestId == null) return
    const gs = (it.gardenStockList || [])[gindex]
    if (!gs) return

    // 站点限制：单次接单最多 9 组
    const MAX_GROUPS_PER_ACCEPT = 9
    const maxGroups = Number(gs.groups) || 0
    const groups = Math.min(maxGroups, it.remainingGroups || maxGroups, MAX_GROUPS_PER_ACCEPT)
    if (!groups) {
      wx.showToast({ title: '该花园可卖不足 1 组', icon: 'none' })
      return
    }

    const busyKey = ['requestSheet.items[' + index + '].gardenStockList[' + gindex + '].accepting']
    if (gs.accepting) return

    wx.showModal({
      title: '确认接单',
      content: it.flowerName + '（' + gs.gardenName + '）\n卖出 ' + groups + ' 组 · ' + it.pricePerGroup + ' 分钟/组',
      confirmText: '确认接单',
      success: async res => {
        if (!res.confirm) return
        this.setData({ [busyKey[0]]: true })
        try {
          const r = await this.callApi('acceptRequest', {
            _id: this.data.tradeSheet.accountId,
            requestId: it.requestId,
            groups,
            pricePerGroup: it.pricePerGroup,
            targetCount: it.targetCount,
            flowerName: it.flowerName,
            gardenId: gs.gardenId,
            gardenName: gs.gardenName
          })
          if (r.code !== 0) throw new Error(r.message || '接单失败')
          wx.showToast({ title: '接单成功', icon: 'success' })
          // 该求购的库存已变化，清掉它的报价缓存，刷新时重新取数
          Object.keys(this._quoteMap || {}).forEach(k => {
            if (k.indexOf(it.requestId + '_') === 0) delete this._quoteMap[k]
          })
          this.loadRequests()
          this.loadTrades(this.data.tradeSheet.accountId, this.data.tradeSheet.role, true)
        } catch (err) {
          // 弹窗可能截断长文案，完整信息同时打到控制台
          console.error('[Ppgarden] 接单失败（完整信息）:', err && err.message)
          wx.showModal({ title: '接单失败', content: err.message || '网络异常', showCancel: false })
        } finally {
          const still = ((this.data.requestSheet.items[index] || {}).gardenStockList || [])[gindex]
          if (still) this.setData({ [busyKey[0]]: false })
        }
      }
    })
  },

  onManualRefreshTrades() {
    const s = this.data.tradeSheet
    if (!s.visible || !s.accountId) return
    if (s.tab === 'requests') this.loadRequests()
    else this.loadTrades(s.accountId, s.role)
  },

  onManualRefreshRequests() {
    if (!this.data.tradeSheet.visible) return
    this.loadRequests()
  },

  // 「只看我能卖的」开关：切换后立即按新条件重新拉取
  onToggleOnlySellable(e) {
    const onlySellable = !!(e.detail && e.detail.value)
    this.setData({ 'requestSheet.onlySellable': onlySellable })
    this.loadRequests()
  },

  // 交易弹层自动刷新：求购大厅 3 秒、交易记录 5 秒（静默，不打断已有展示）
  startTradeTimer() {
    if (this._tradeTimer) return
    const INTERVAL_REQUESTS = 3000
    const INTERVAL_ORDERS = 5000
    // 从当前时间起算，避免刚打开弹窗就立刻重复请求一次
    let lastOrders = Date.now()
    let lastRequests = Date.now()
    this._tradeTimer = setInterval(() => {
      const s = this.data.tradeSheet
      if (!s.visible || !s.accountId) return
      const now = Date.now()
      if (s.tab === 'requests') {
        if (now - lastRequests < INTERVAL_REQUESTS) return
        lastRequests = now
        this.loadRequests(true)
      } else {
        if (now - lastOrders < INTERVAL_ORDERS) return
        lastOrders = now
        this.loadTrades(s.accountId, s.role, true)
      }
    }, 1000)
  },

  // 已取消交易弹层的自动刷新（避免调用失败后反复请求刷屏）
  stopTradeTimer() {
    if (this._tradeTimer) {
      clearInterval(this._tradeTimer)
      this._tradeTimer = null
    }
  },

  onCloseTrades() {
    this.stopTradeTimer()
    this.setData({ 'tradeSheet.visible': false })
  }
})
