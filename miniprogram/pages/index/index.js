// index.js
const app = getApp()

Page({
  data: {
    openidInput: ''
  },

  onLoad() {
    console.log('[Index] 页面加载完成')
  },

  // 用户查询
  onUserQuery() {
    const openid = this.data.openidInput.trim();

    if (!openid) {
      wx.showToast({
        title: '请输入 openid',
        icon: 'none'
      });
      return;
    }

    wx.navigateTo({
      url: `/pages/customer-service-chat/customer-service-chat?openid=${openid}`
    });
  },

  // openid 输入
  onOpenidInput(e) {
    this.setData({
      openidInput: e.detail.value
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
