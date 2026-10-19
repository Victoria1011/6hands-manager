// ppgarden-hosting.js
// 正在托管的花园汇总页
const app = getApp()

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

function fmtShort(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

Page({
  data: {
    loading: false,
    hosting: [],  // 正在托管
    waiting: [],  // 其它状态（已就绪/等待定时/受阻）
    errors: [],
    updatedAtText: ''
  },

  onLoad() {
    this.checkIsLoggedIn()
  },

  onShow() {
    this.checkIsLoggedIn()
    // 回到页面时恢复动态自动刷新
    if (this.data.hosting.length) this.startLogTimer()
  },

  onHide() {
    this.stopLogTimer()
  },

  onUnload() {
    this.stopLogTimer()
  },

  checkIsLoggedIn() {
    const token = app.getToken()
    const userInfo = app.getUserInfo()

    if (!token || !userInfo) {
      wx.showToast({ title: '请先登录', icon: 'none' })
      setTimeout(() => { wx.reLaunch({ url: '/pages/index/index' }) }, 1500)
      return false
    }
    if (!this.data.hosting.length && !this.data.waiting.length && !this.data.loading) {
      this.load()
    }
    return true
  },

  callApi(action, extra = {}) {
    return app.globalData.cloud.callFunction({
      name: 'ppgardenTimer',
      data: Object.assign({ token: app.getToken(), action }, extra)
    }).then(res => {
      return res.result || { code: 500, message: '空响应' }
    })
  },

  async load() {
    if (!app.globalData.cloud) {
      wx.showToast({ title: '云开发未初始化', icon: 'none' })
      return
    }
    this.setData({ loading: true })
    try {
      const res = await this.callApi('hostingNow')
      if (res.code !== 0) throw new Error(res.message || '加载失败')
      const hosting = ((res.data && res.data.hosting) || []).map(it => Object.assign({}, it, {
        logs: null,
        logsLoading: false,
        logsError: ''
      }))
      this.setData({
        hosting,
        waiting: (res.data && res.data.waiting) || [],
        errors: (res.data && res.data.errors) || [],
        updatedAtText: fmtShort(Date.now()),
        loading: false
      })
      // 每个正在托管的花园：账号下方直接展示其动态日志（无需点击）
      this.loadHostingLogs()
      this.startLogTimer()
    } catch (err) {
      this.setData({ loading: false })
      console.error('[PpgardenHosting] 加载失败:', err)
      wx.showToast({ title: err.message || '加载失败', icon: 'none' })
    }
  },

  // 逐个花园拉取动态日志，写入对应卡片（hosting[i].logs）
  async loadHostingLogs() {
    const hosting = this.data.hosting
    for (let i = 0; i < hosting.length; i++) {
      await this.loadOneLog(i)
    }
  },

  async loadOneLog(i) {
    const cur = this.data.hosting[i]
    if (!cur || cur.logsLoading) return
    this.setData({ ['hosting[' + i + '].logsLoading']: true })
    try {
      const res = await this.callApi('gardenActivity', {
        _id: cur.accountId, gardenId: cur.gardenId, limit: 20
      })
      if (res.code !== 0) throw new Error(res.message || '加载失败')
      // 防止等待期间列表刷新导致错位
      const now = this.data.hosting[i]
      if (!now || now.gardenId !== cur.gardenId) return
      this.setData({
        ['hosting[' + i + '].logs']: (res.data && res.data.items) || [],
        ['hosting[' + i + '].logsLoading']: false,
        ['hosting[' + i + '].logsError']: ''
      })
    } catch (err) {
      const now = this.data.hosting[i]
      if (!now || now.gardenId !== cur.gardenId) return
      this.setData({
        ['hosting[' + i + '].logsLoading']: false,
        ['hosting[' + i + '].logsError']: err.message || '加载失败'
      })
    }
  },

  // 每 5 秒增量补拉最新动态（合并去重，不打断已展示内容）
  startLogTimer() {
    if (this._logTimer) return
    this._logTimer = setInterval(() => this.refreshLogs(), 5000)
  },

  stopLogTimer() {
    if (this._logTimer) {
      clearInterval(this._logTimer)
      this._logTimer = null
    }
  },

  async refreshLogs() {
    const hosting = this.data.hosting
    for (let i = 0; i < hosting.length; i++) {
      const cur = this.data.hosting[i]
      if (!cur || cur.logsLoading) continue
      try {
        const res = await this.callApi('gardenActivity', {
          _id: cur.accountId, gardenId: cur.gardenId, limit: 10
        })
        if (res.code !== 0) continue
        const fresh = (res.data && res.data.items) || []
        const now = this.data.hosting[i]
        if (!now || now.gardenId !== cur.gardenId) continue
        const exist = {}
        for (const it of (now.logs || [])) exist[it.id] = true
        const add = fresh.filter(it => !exist[it.id])
        if (add.length) {
          this.setData({ ['hosting[' + i + '].logs']: add.concat(now.logs || []).slice(0, 20) })
        }
      } catch (e) { /* 静默，下一轮再取 */ }
    }
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  // 快捷暂停某个正在托管的花园
  async onPauseGarden(e) {
    const { accountId, gardenId, i } = e.currentTarget.dataset
    const item = this.data.hosting[i]
    if (!item || item.busyPause) return

    const cur = this.data.hosting[i]
    if (!cur || cur.gardenId !== gardenId) return

    this.setData({ ['hosting[' + i + '].busyPause']: true })
    try {
      const res = await this.callApi('pauseGarden', { _id: accountId, gardenId })
      if (res.code !== 0) throw new Error(res.message || '暂停失败')
      wx.showToast({ title: '已暂停', icon: 'success' })
      // 从正在托管列表移除
      const hosting = this.data.hosting.slice()
      if (hosting[i] && hosting[i].gardenId === gardenId) {
        hosting.splice(i, 1)
        this.setData({ hosting })
      }
    } catch (err) {
      wx.showModal({ title: '暂停失败', content: err.message || '网络异常', showCancel: false })
    } finally {
      const still = this.data.hosting[i]
      if (still && still.gardenId === gardenId) {
        this.setData({ ['hosting[' + i + '].busyPause']: false })
      }
    }
  }
})
