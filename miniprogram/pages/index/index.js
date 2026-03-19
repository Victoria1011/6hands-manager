// index.js
const app = getApp()

Page({
  data: {
    loading: false,
    showLoginModal: false
  },

  onLoad() {
    this.checkLoginStatus()
  },

  // 检查登录状态
  checkLoginStatus() {
    const token = app.getToken()
    const userInfo = app.getUserInfo()

    if (token && userInfo) {
      console.log('[Index] 已登录，直接显示页面')
      this.setData({
        loading: false,
        showLoginModal: false
      })
    } else {
      console.log('[Index] 未登录，显示登录弹窗')
      this.setData({
        loading: false,
        showLoginModal: true
      })
    }
  },

  // 点击登录按钮
  async handleLogin() {
    this.setData({
      showLoginModal: false,
      loading: true
    })

    // 等待云开发初始化完成
    console.log('[Index] 等待云开发初始化...')
    let waitCount = 0
    while (!app.globalData.cloud && waitCount < 100) {
      await new Promise(resolve => setTimeout(resolve, 100))
      waitCount++
    }

    if (!app.globalData.cloud) {
      console.error('[Index] 云开发初始化超时')
      wx.showToast({
        title: '云开发初始化失败',
        icon: 'none'
      })
      this.setData({
        loading: false,
        showLoginModal: true
      })
      return
    }

    console.log('[Index] 云开发初始化完成，开始登录')
    const result = await app.login()
    
    this.setData({ loading: false })

    if (result.success) {
      console.log('[Index] 登录成功')
      wx.showToast({
        title: '登录成功',
        icon: 'success'
      })
    } else {
      console.error('[Index] 登录失败:', result.message)
      wx.showToast({
        title: result.message || '登录失败',
        icon: 'none'
      })
      // 登录失败，重新显示登录弹窗
      this.setData({ showLoginModal: true })
    }
  },

  // 用户查询
  onUserQuery() {
    wx.showToast({
      title: '用户查询功能',
      icon: 'none'
    });
  },

  // 客服消息
  onCustomerService() {
    wx.navigateTo({
      url: '/pages/customer-service-list/customer-service-list'
    });
  },

  // 发票开具
  onInvoice() {
    wx.showToast({
      title: '发票开具功能',
      icon: 'none'
    });
  }
});
