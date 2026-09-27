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

Page({
  data: {
    loading: false,
    accounts: [],
    logs: [],
    showLogs: false,
    logsLoading: false,
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
    autoAssigning: false
  },

  onLoad() {
    this.checkIsLoggedIn()
  },

  onShow() {
    this.checkIsLoggedIn()
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

  // ===== 云函数调用封装 =====
  callApi(action, extra = {}) {
    return app.globalData.cloud.callFunction({
      name: 'ppgardenTimer',
      data: Object.assign({ token: app.getToken(), action }, extra)
    }).then(res => {
      return res.result || { code: 500, message: '空响应' }
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

    const gardenRows = gardenList.map(g => {
      const cfg = configs[g.id] || {}
      const windows = Array.isArray(cfg.windows) ? cfg.windows : []
      return {
        gardenId: g.id,
        name: g.name || g.id,
        channelText: CHANNEL_TEXT[g.channel] || '',
        schedEnabled: cfg.schedEnabled !== false,
        windowsText: windows.map(w => pad(w.start) + '~' + pad(w.stop)).join('、'),
        hasWindows: windows.length > 0,
        busyStart: false,
        busyPause: false
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
      statusUpdatedAtText: hc && hc.updatedAtMs ? fmtShort(hc.updatedAtMs) : ''
    })
  },

  onRefresh() {
    this.loadAccounts()
    if (this.data.showLogs) this.loadLogs()
  },

  // 查看正在托管的花园
  onHostingNow() {
    wx.navigateTo({ url: '/pages/ppgarden-hosting/ppgarden-hosting' })
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

  // ===== 一键分配：为全部花园随机错峰生成每小时时段 =====
  async onAutoAssignAll(e) {
    const index = e.currentTarget.dataset.index
    const acc = this.data.accounts[index]
    if (!acc || this.data.autoAssigning) return

    this.setData({ autoAssigning: true })
    try {
      const res = await this.callApi('autoAssignAll', { _id: acc._id })
      if (res.code !== 0) throw new Error(res.message || '分配失败')
      wx.showModal({ title: '分配完成', content: res.message, showCancel: false })
      this.loadAccounts()
    } catch (err) {
      wx.showModal({ title: '自动分配失败', content: err.message || '请稍后重试', showCancel: false })
    } finally {
      this.setData({ autoAssigning: false })
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
      this.setData({
        ['accounts[' + index + '].statusSummary']: res.data.summaryText,
        ['accounts[' + index + '].states']: res.data.gardens || [],
        ['accounts[' + index + '].statusLoading']: false,
        ['accounts[' + index + '].statusUpdatedAtText']: fmtShort(Date.now())
      })
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

  // ===== 执行日志 =====
  async onToggleLogs() {
    const show = !this.data.showLogs
    this.setData({ showLogs: show })
    if (show) this.loadLogs()
  },

  async loadLogs() {
    this.setData({ logsLoading: true })
    try {
      const res = await this.callApi('logs', { limit: 50 })
      if (res.code !== 0) throw new Error(res.message || '加载失败')
      const logs = ((res.data && res.data.logs) || []).map(l => Object.assign({}, l, {
        timeText: fmtShort(l.createdAtMs),
        actionText: l.action === 'start' ? '启动托管' : l.action === 'pause' ? '暂停托管' : '登录',
        triggerText: l.trigger === 'timer' ? '定时' : '手动',
        targetText: l.gardenName ? '「' + l.gardenName + '」' : ''
      }))
      this.setData({ logs, logsLoading: false })
    } catch (err) {
      this.setData({ logsLoading: false })
      wx.showToast({ title: err.message || '日志加载失败', icon: 'none' })
    }
  }
})
