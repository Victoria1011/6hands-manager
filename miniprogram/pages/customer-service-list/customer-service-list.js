// pages/customer-service-list/customer-service-list.js
const app = getApp()

Page({
  data: {
    messageList: [],
    loading: false
  },

  onLoad() {
    this.getMessageList()
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

      if (!app.globalData.cloud) {
        wx.showToast({
          title: '云开发未初始化',
          icon: 'none'
        })
        return
      }

      const res = await app.globalData.cloud.callFunction({
        name: 'getCustomerServiceList',
        data: {
          token: token
        }
      })

      if (res.result.code === 0) {
        this.setData({
          messageList: res.result.data || []
        })
      } else {
        wx.showToast({
          title: res.result.message || '获取失败',
          icon: 'none'
        })
      }
    } catch (err) {
      console.error('获取客服消息列表失败:', err)
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
