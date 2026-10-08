// ppgarden-manage.js
// 云上花匠（ppgarden.top）花园托管管理页
// 每个花园独立配置每小时时段 / 独立定时开关 / 手动启动暂停
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
    // 花园动态日志底部弹窗（auto = 托管中，打开期间每 2 秒自动刷新；refreshing = 刷新请求进行中）
    logSheet: { visible: false, loading: false, refreshing: false, gardenName: '', items: [], auto: false, accountId: '', gardenId: '' },
  },

  onLoad() {
    this.checkIsLoggedIn()
  },

  onShow() {
    this.checkIsLoggedIn()
  },

  onHide() {
    this.stopLogsTimer()
    this.stopGardenLogTimer()
  },

  onUnload() {
    this.stopLogsTimer()
    this.stopGardenLogTimer()
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

    // 花园实时托管状态（用于启停按钮可用性；状态未知时两个按钮都可用）
    const stateMap = {}
    if (hc && Array.isArray(hc.states)) {
      for (const s of hc.states) {
        if (s && s.gardenId && s.state) stateMap[s.gardenId] = s.state
      }
    }

    const gardenRows = gardenList.map(g => {
      const cfg = configs[g.id] || {}
      const windows = Array.isArray(cfg.windows) ? cfg.windows : []
      const st = stateMap[g.id]
      const active = st ? GARDEN_ACTIVE_STATES.indexOf(st) !== -1 : null
      return {
        gardenId: g.id,
        name: g.name || g.id,
        channelText: CHANNEL_TEXT[g.channel] || '',
        schedEnabled: cfg.schedEnabled !== false,
        windowsText: windows.map(w => pad(w.start) + '~' + pad(w.stop)).join('、'),
        hasWindows: windows.length > 0,
        busyStart: false,
        busyPause: false,
        // 正在托管 → 启动禁用/暂停可用；未托管 → 暂停禁用/启动可用；未知 → 都可用
        canStart: active === null ? true : !active,
        canPause: active === null ? true : active,
        // 实时托管状态文字（显示在花园卡片右上角）
        stateText: st ? (GARDEN_STATE_TEXT[st] || st) : ''
      }
    })

    return Object.assign({}, a, {
      gardenRows,
      sessionOk: a.lastLoginDate === today,
      loginError: a.loginErrorDate === today,
      statusLoading: false,
      // 状态直接展示：优先用云端缓存，可手动/自动刷新
      states: hc && Array.isArray(hc.states) ? hc.states : [],
      statusSummary: hc ? hc.summaryText : '',
      statusUpdatedAtText: hc && hc.updatedAtMs ? fmtShort(hc.updatedAtMs) : '',
      // 账号级「托管中」标记：任一花园在托即生效（卡片加高亮描边）
      anyHosting: gardenRows.some(r => r.canStart === false)
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
      // 重新组装花园行（保留云端已存配置）
      const today = todayStr()
      const fresh = this.decorateAccount(Object.assign({}, cur, {
        gardenList: (res.data && res.data.gardens) || [],
        gardenConfigs: cur.gardenConfigs || {}
      }), today)
      this.setData({
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
    this.setData({
      gardenEditor: {
        key,
        accountId: acc._id,
        accountIndex: index,
        rowIndex: ri,
        gardenId: row.gardenId,
        gardenName: row.name,
        windows
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

  validateWindowsList(windows) {
    const seen = []
    for (const w of windows) {
      const s = Number(w.start)
      const e2 = Number(w.stop)
      if (w.start === '' || w.stop === '' || !(s >= 0 && s <= 59) || !(e2 >= 0 && e2 <= 59) || e2 - s < 2) {
        return '时段无效：请输入 0~59 的分钟数，且时长至少 2 分钟'
      }
      for (const p of seen) {
        if (s < p.stop && p.start < e2) {
          return '同一花园的时段不能重叠（' + pad(s) + '~' + pad(e2) + '）'
        }
      }
      seen.push({ start: s, stop: e2 })
    }
    return ''
  },

  async onSaveGardenWindows() {
    const ed = this.data.gardenEditor
    if (!ed || this.data.savingGardenWindows) return

    const winErr = this.validateWindowsList(ed.windows)
    if (winErr) {
      wx.showToast({ title: winErr, icon: 'none' }); return
    }

    this.setData({ savingGardenWindows: true })
    try {
      const res = await this.callApi('setGardenConfig', {
        _id: ed.accountId,
        gardenId: ed.gardenId,
        windows: ed.windows
      })
      if (res.code !== 0) throw new Error(res.message || '保存失败')
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
      for (const s of (res.data.gardens || [])) {
        if (s && s.gardenId && s.state) stateMap[s.gardenId] = s.state
      }
      const patch = {
        ['accounts[' + index + '].statusSummary']: res.data.summaryText,
        ['accounts[' + index + '].states']: res.data.gardens || [],
        ['accounts[' + index + '].statusLoading']: false,
        ['accounts[' + index + '].statusUpdatedAtText']: fmtShort(Date.now())
      }
      const rows = (this.data.accounts[index] && this.data.accounts[index].gardenRows) || []
      rows.forEach((row, ri) => {
        const st = stateMap[row.gardenId]
        if (!st) return
        const active = GARDEN_ACTIVE_STATES.indexOf(st) !== -1
        patch['accounts[' + index + '].gardenRows[' + ri + '].canStart'] = !active
        patch['accounts[' + index + '].gardenRows[' + ri + '].canPause'] = active
        patch['accounts[' + index + '].gardenRows[' + ri + '].stateText'] = GARDEN_STATE_TEXT[st] || st
      })
      // 账号级「托管中」标记（任一花园在托即生效）
      patch['accounts[' + index + '].anyHosting'] = rows.some(row => {
        const st = stateMap[row.gardenId]
        return st ? GARDEN_ACTIVE_STATES.indexOf(st) !== -1 : false
      })
      this.setData(patch)
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

  // ===== 花园动态日志（底部弹窗） =====
  async onGardenLogs(e) {
    const { index, ri, id, gardenId, name } = e.currentTarget.dataset
    const acc = this.data.accounts[index]
    if (!acc) return
    const row = acc.gardenRows && acc.gardenRows[ri]
    if (!row || row.gardenId !== gardenId) return
    // 该花园正在托管中 → 弹窗打开期间每 2 秒自动刷新
    const auto = row.canStart === false
    this.setData({
      logSheet: { visible: true, loading: true, gardenName: name || row.name, items: [], auto, accountId: id, gardenId }
    })
    try {
      const res = await this.callApi('gardenActivity', { _id: id, gardenId, limit: 20 })
      if (res.code !== 0) throw new Error(res.message || '加载失败')
      // 防止等待期间弹窗已关闭
      if (!this.data.logSheet.visible) return
      this.setData({
        'logSheet.items': (res.data && res.data.items) || [],
        'logSheet.loading': false
      })
      if (auto) this.startGardenLogTimer()
    } catch (err) {
      if (!this.data.logSheet.visible) return
      this.setData({ 'logSheet.loading': false })
      wx.showToast({ title: err.message || '加载失败', icon: 'none' })
    }
  },

  onCloseGardenLogs() {
    this.stopGardenLogTimer()
    this.setData({ 'logSheet.visible': false })
  },

  startGardenLogTimer() {
    if (this._gardenLogTimer) return
    this._gardenLogTimer = setInterval(() => this.refreshGardenLogs(), 2000)
  },

  stopGardenLogTimer() {
    if (this._gardenLogTimer) {
      clearInterval(this._gardenLogTimer)
      this._gardenLogTimer = null
    }
  },

  // 弹窗内增量补拉最新动态（合并去重，不打断已加载内容）
  async refreshGardenLogs() {
    const sheet = this.data.logSheet
    if (!sheet.visible || sheet.loading || sheet.refreshing || !sheet.auto || !sheet.accountId) return
    this.setData({ 'logSheet.refreshing': true })
    try {
      const res = await this.callApi('gardenActivity', { _id: sheet.accountId, gardenId: sheet.gardenId, limit: 20 })
      if (res.code !== 0) return
      if (!this.data.logSheet.visible) return
      const fresh = (res.data && res.data.items) || []
      const cur = this.data.logSheet
      const exist = {}
      for (const it of cur.items) exist[it.id] = true
      const add = fresh.filter(it => !exist[it.id])
      if (add.length) {
        this.setData({ 'logSheet.items': add.concat(cur.items).slice(0, 50) })
      }
    } catch (e) { /* 静默，下一轮再取 */     } finally {
      if (this.data.logSheet.visible) this.setData({ 'logSheet.refreshing': false })
    }
  }
})
