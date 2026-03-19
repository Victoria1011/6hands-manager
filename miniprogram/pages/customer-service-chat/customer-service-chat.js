// pages/customer-service-chat/customer-service-chat.js
const app = getApp()

Page({
  data: {
    openid: '',
    messages: [],
    inputContent: '',
    scrollToBottom: false,
    loading: false
  },

  onLoad(options) {
    const { openid } = options
    if (!openid) {
      wx.showToast({
        title: '参数错误',
        icon: 'none'
      })
      return
    }

    this.setData({ openid })
    this.getMessages()
  },

  onShow() {
    // 每次显示页面时刷新消息
    if (this.data.openid) {
      this.getMessages()
    }
  },

  // 获取聊天记录
  async getMessages() {
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
        name: 'getCustomerServiceMessages',
        data: {
          openid: this.data.openid,
          token: token
        }
      })

      if (res.result.code === 0) {
        this.setData({
          messages: res.result.data.messages || [],
          scrollToBottom: true
        })
      } else {
        wx.showToast({
          title: res.result.message || '获取失败',
          icon: 'none'
        })
      }
    } catch (err) {
      console.error('获取聊天记录失败:', err)
      wx.showToast({
        title: '获取失败',
        icon: 'none'
      })
    } finally {
      this.setData({ loading: false })
    }
  },

  // 输入框内容变化
  onInput(e) {
    this.setData({
      inputContent: e.detail.value
    })
  },

  // 发送消息
  async sendMessage() {
    const content = this.data.inputContent.trim()
    if (!content) {
      return
    }

    // 先在界面上显示发送中的消息
    const tempMessage = {
      type: 'customer_to_user',
      msg_type: 'text',
      content: content,
      created_at: new Date().toISOString(),
      sending: true
    }

    this.setData({
      messages: [...this.data.messages, tempMessage],
      inputContent: '',
      scrollToBottom: true
    })

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
        name: 'sendCustomerMessage',
        data: {
          openid: this.data.openid,
          msgtype: 'text',
          content: content,
          token: token
        }
      })

      if (res.result.code === 0 && res.result.data.success) {
        // 发送成功，移除发送中的临时消息
        const messages = this.data.messages.filter(msg => !msg.sending)
        
        // 重新获取最新消息列表
        await this.getMessages()
      } else {
        // 发送失败
        wx.showToast({
          title: res.result.message || '发送失败',
          icon: 'none'
        })
        // 移除发送中的临时消息
        const messages = this.data.messages.filter(msg => !msg.sending)
        this.setData({ messages })
      }
    } catch (err) {
      console.error('发送消息失败:', err)
      wx.showToast({
        title: '发送失败',
        icon: 'none'
      })
      // 移除发送中的临时消息
      const messages = this.data.messages.filter(msg => !msg.sending)
      this.setData({ messages })
    }
  },

  // 滚动到底部
  scrollToBottom() {
    this.setData({
      scrollToBottom: true
    })
  },

  // 格式化时间
  formatTime(timeStr) {
    if (!timeStr) return ''
    const date = new Date(timeStr)
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    
    // 如果是今天，只显示时间
    if (date.toDateString() === now.toDateString()) {
      const hours = date.getHours().toString().padStart(2, '0')
      const minutes = date.getMinutes().toString().padStart(2, '0')
      return `${hours}:${minutes}`
    }
    
    // 如果是昨天
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    if (date.toDateString() === yesterday.toDateString()) {
      const hours = date.getHours().toString().padStart(2, '0')
      const minutes = date.getMinutes().toString().padStart(2, '0')
      return `昨天 ${hours}:${minutes}`
    }
    
    // 其他情况显示完整日期
    const month = (date.getMonth() + 1).toString().padStart(2, '0')
    const day = date.getDate().toString().padStart(2, '0')
    const hours = date.getHours().toString().padStart(2, '0')
    const minutes = date.getMinutes().toString().padStart(2, '0')
    return `${month}月${day}日 ${hours}:${minutes}`
  },

  // 下拉刷新
  onPullDownRefresh() {
    this.getMessages().then(() => {
      wx.stopPullDownRefresh()
    })
  }
})
