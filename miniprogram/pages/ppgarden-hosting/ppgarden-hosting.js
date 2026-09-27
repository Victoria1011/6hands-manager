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
      this.setData({
        hosting: (res.data && res.data.hosting) || [],
        waiting: (res.data && res.data.waiting) || [],
        errors: (res.data && res.data.errors) || [],
        updatedAtText: fmtShort(Date.now()),
        loading: false
      })
    } catch (err) {
      this.setData({ loading: false })
      console.error('[PpgardenHosting] 加载失败:', err)
      wx.showToast({ title: err.message || '加载失败', icon: 'none' })
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
