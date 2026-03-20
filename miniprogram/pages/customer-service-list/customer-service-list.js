// pages/customer-service-list/customer-service-list.js
const app = getApp()

Page({
  data: {
    messageList: [],
    loading: false
  },

  onLoad() {
    // 检查登录状态
    if (!this.checkIsLoggedIn()) return
    this.getMessageList()
  },

  onShow() {
    // 每次显示页面时刷新列表，但需要先检查登录状态
    if (!this.checkIsLoggedIn()) return
    this.getMessageList()
  },

  // 检查是否已登录
  checkIsLoggedIn() {
    const token = app.getToken()
    const userInfo = app.getUserInfo()

    if (!token || !userInfo) {
      wx.showToast({
        title: '请先登录',
        icon: 'none'
      })
      // 跳转回首页
      setTimeout(() => {
        wx.reLaunch({
          url: '/pages/index/index'
        })
      }, 1500)
      return false
    }
    return true
  },

  onShow() {
    // 每次显示页面时刷新列表
    this.getMessageList()
  },

  // 获取客服消息列表
  async getMessageList() {
    this.setData({ loading: true })
    
    try {
      // 获取 token
      const token = app.getToken()
      console.log('[CustomerServiceList] ===== 开始获取客服消息列表 =====')
      console.log('[CustomerServiceList] Token:', token ? '存在' : '不存在')
      console.log('[CustomerServiceList] Token 长度:', token ? token.length : 0)

      if (!app.globalData.cloud) {
        console.error('[CustomerServiceList] 云开发未初始化')
        wx.showToast({
          title: '云开发未初始化',
          icon: 'none'
        })
        return
      }

      console.log('[CustomerServiceList] 调用云函数 getCustomerServiceList')
      const res = await app.globalData.cloud.callFunction({
        name: 'getCustomerServiceList',
        data: {
          token: token
        }
      })

      console.log('[CustomerServiceList] 云函数返回结果:', JSON.stringify(res.result))

      if (res.result.code === 0) {
        console.log('[CustomerServiceList] 获取成功，消息数量:', res.result.data?.length || 0)
        this.setData({
          messageList: res.result.data || []
        })
      } else {
        console.error('[CustomerServiceList] 云函数返回错误:', res.result.code, res.result.message)
        wx.showToast({
          title: res.result.message || '获取失败',
          icon: 'none'
        })
      }
    } catch (err) {
      console.error('[CustomerServiceList] 获取客服消息列表异常:', err)
      wx.showToast({
        title: '获取失败',
        icon: 'none'
      })
    } finally {
      this.setData({ loading: false })
    }
  },

  // 点击进入聊天
  goToChat(e) {
    const { openid } = e.currentTarget.dataset
    wx.navigateTo({
      url: `/pages/customer-service-chat/customer-service-chat?openid=${openid}`
    })
  },

  // 下拉刷新
  onPullDownRefresh() {
    this.getMessageList().then(() => {
      wx.stopPullDownRefresh()
    })
  }
})
