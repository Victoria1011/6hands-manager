// pages/customer-service-chat/customer-service-chat.js
const app = getApp()

Page({
  data: {
    openid: '',
    messages: [],
    inputContent: '',
    scrollToBottom: false,
    loading: false,
    showActionSheet: false,
    activeTab: 'chat',
    userInfo: {
      openid: '',
      registerTime: '',
      coins: 0
    },
    blacklistReason: '',
    logs: [],
    logsLoading: false,
    orders: [],
    ordersLoading: false
  },

  onLoad(options) {
    // 检查登录状态
    if (!this.checkIsLoggedIn()) return

    const { openid } = options
    if (!openid) {
      wx.showToast({
        title: '参数错误',
        icon: 'none'
      })
      setTimeout(() => {
        wx.navigateBack()
      }, 1500)
      return
    }

    this.setData({
      openid,
      'userInfo.openid': openid
    })
    this.getMessages()
    this.getUserInfo()
  },

  onShow() {
    // 每次显示页面时刷新消息，但需要先检查登录状态
    if (!this.checkIsLoggedIn()) return

    // 每次显示页面时刷新消息
    if (this.data.openid) {
      this.getMessages()
    }
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
        const messages = res.result.data.messages || []
        console.log('[CustomerServiceChat] 获取消息成功，消息数量:', messages.length)
        // 打印每条消息的 type 字段并格式化时间
        messages.forEach((msg, index) => {
          console.log(`[CustomerServiceChat] 消息 ${index + 1}:`, {
            type: msg.type,
            msg_type: msg.msg_type,
            content: msg.content ? msg.content.substring(0, 50) : '',
            created_at: msg.created_at
          })
          // 添加格式化后的时间字段
          msg.formattedTime = this.formatTime(msg.created_at)
        })
        this.setData({
          messages: messages,
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

    const now = new Date().toISOString()
    // 先在界面上显示发送中的消息
    const tempMessage = {
      type: 'customer_to_user',
      msg_type: 'text',
      content: content,
      created_at: now,
      formattedTime: this.formatTime(now),
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
        // 发送成功，更新临时消息状态为已发送
        const messages = this.data.messages.map(msg => {
          if (msg.sending && msg.content === content) {
            return { ...msg, sending: false }
          }
          return msg
        })

        this.setData({ messages })

        // 重新获取最新消息列表以同步服务器状态
        await this.getMessages()
      } else {
        // 发送失败，移除临时消息
        const messages = this.data.messages.filter(msg => !msg.sending)
        this.setData({ messages })
        wx.showToast({
          title: res.result.message || '发送失败',
          icon: 'none'
        })
      }
    } catch (err) {
      console.error('发送消息失败:', err)
      // 移除发送中的临时消息
      const messages = this.data.messages.filter(msg => !msg.sending)
      this.setData({ messages })
      wx.showToast({
        title: '发送失败',
        icon: 'none'
      })
    }
  },

  // 选择图片
  async chooseImage() {
    this.setData({ showActionSheet: false })

    try {
      const res = await wx.chooseImage({
        count: 1,
        sizeType: ['compressed'],
        sourceType: ['album']
      })

      if (res.tempFilePaths.length > 0) {
        const tempFilePath = res.tempFilePaths[0]
        await this.sendImageMessage(tempFilePath)
      }
    } catch (err) {
      console.error('选择图片失败:', err)
      if (err.errMsg && !err.errMsg.includes('cancel')) {
        wx.showToast({
          title: '选择图片失败',
          icon: 'none'
        })
      }
    }
  },

  // 发送购买元宝消息
  async sendPurchaseCoins() {
    this.setData({ showActionSheet: false })

    const content = `点击下方套餐购买元宝：
<a href="http://www.qq.com" data-miniprogram-appid="wx126d0f048410f694" data-miniprogram-path="pages/purchase/purchase?productId=1">入门套餐 ¥1 (1万元宝)</a>
<a href="http://www.qq.com" data-miniprogram-appid="wx126d0f048410f694" data-miniprogram-path="pages/purchase/purchase?productId=2">标准套餐 ¥10 (10万元宝 + 赠送 1 万元宝)</a>
<a href="http://www.qq.com" data-miniprogram-appid="wx126d0f048410f694" data-miniprogram-path="pages/purchase/purchase?productId=3">畅享套餐 ¥100 (100万元宝 + 赠送 15 万元宝)</a>`

    const now = new Date().toISOString()
    const tempMessage = {
      type: 'customer_to_user',
      msg_type: 'text',
      content: content,
      created_at: now,
      formattedTime: this.formatTime(now),
      sending: true
    }

    this.setData({
      messages: [...this.data.messages, tempMessage],
      scrollToBottom: true
    })

    try {
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
        const messages = this.data.messages.map(msg => {
          if (msg.sending && msg.content === content) {
            return { ...msg, sending: false }
          }
          return msg
        })

        this.setData({ messages })
        await this.getMessages()
      } else {
        const messages = this.data.messages.filter(msg => !msg.sending)
        this.setData({ messages })
        wx.showToast({
          title: res.result.message || '发送失败',
          icon: 'none'
        })
      }
    } catch (err) {
      console.error('发送购买元宝失败:', err)
      const messages = this.data.messages.filter(msg => !msg.sending)
      this.setData({ messages })
      wx.showToast({
        title: '发送失败',
        icon: 'none'
      })
    }
  },

  // 切换快捷功能菜单
  toggleActionSheet() {
    this.setData({
      showActionSheet: !this.data.showActionSheet
    })
  },

  // 阻止事件冒泡
  stopPropagation() {
    // 空函数，用于阻止点击事件冒泡
  },

  // 发送图片消息
  async sendImageMessage(filePath) {
    wx.showLoading({
      title: '发送中...'
    })

    try {
      const now = new Date().toISOString()
      // 先在界面上显示发送中的消息
      const tempMessage = {
        type: 'customer_to_user',
        msg_type: 'image',
        image_url: filePath,
        created_at: now,
        formattedTime: this.formatTime(now),
        sending: true
      }

      this.setData({
        messages: [...this.data.messages, tempMessage],
        scrollToBottom: true
      })

      // 上传图片到云存储
      const uploadRes = await app.globalData.cloud.uploadFile({
        cloudPath: `customer-service/${Date.now()}.jpg`,
        filePath: filePath
      })

      console.log('[Chat] 图片上传成功:', uploadRes)

      const fileID = uploadRes.fileID

      // 获取图片的 media_id（这里需要调用临时素材接口）
      // 暂时使用临时图片链接，实际使用时需要转换为 media_id
      // 发送消息
      const token = app.getToken()

      const res = await app.globalData.cloud.callFunction({
        name: 'sendCustomerMessage',
        data: {
          openid: this.data.openid,
          msgtype: 'image',
          token: token,
          msgData: {
            // 注意：客服消息的图片需要 media_id，这里使用临时方案
            // 实际项目中应该先将图片上传到微信临时素材获取 media_id
            media_id: fileID // 临时使用 fileID，需要后续完善
          }
        }
      })

      if (res.result.code === 0 && res.result.data.success) {
        // 发送成功，更新临时消息状态为已发送
        const messages = this.data.messages.map(msg => {
          if (msg.sending && msg.image_url === filePath) {
            return { ...msg, sending: false }
          }
          return msg
        })

        this.setData({ messages })
        wx.hideLoading()

        // 重新获取最新消息列表以同步服务器状态
        await this.getMessages()
      } else {
        // 发送失败，移除临时消息
        const messages = this.data.messages.filter(msg => !msg.sending)
        this.setData({ messages })
        wx.hideLoading()
        wx.showToast({
          title: res.result.message || '发送失败',
          icon: 'none'
        })
      }
    } catch (err) {
      console.error('发送图片失败:', err)
      // 移除发送中的临时消息
      const messages = this.data.messages.filter(msg => !msg.sending)
      this.setData({ messages })
      wx.hideLoading()
      wx.showToast({
        title: '发送失败',
        icon: 'none'
      })
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
  },

  // 切换 Tab
  async switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    this.setData({ activeTab: tab })

    // 根据tab加载数据
    if (tab === 'user') {
      await this.checkBlacklistStatus()
    } else if (tab === 'logs') {
      this.showLogs()
    } else if (tab === 'orders') {
      this.showOrders()
    }
  },

  // 获取用户信息
  async getUserInfo() {
    try {
      const token = app.getToken()

      if (!app.globalData.cloud) {
        wx.showToast({
          title: '云开发未初始化',
          icon: 'none'
        })
        return
      }

      // 调用 managerGetCoins 云函数获取元宝和注册时间
      const coinsRes = await app.globalData.cloud.callFunction({
        name: 'managerGetCoins',
        data: {
          openid: this.data.openid,
          token: token
        }
      })
      console.log('[Chat] 获取用户信息:', coinsRes)
      if (coinsRes.result.code === 0) {
        const coinsData = coinsRes.result.data || {}
        const createdAt = coinsData.created_at || ''
        const balance = coinsData.balance || 0

        // 格式化注册时间
        let formattedTime = ''
        if (createdAt) {
          const date = new Date(createdAt)
          const year = date.getFullYear()
          const month = (date.getMonth() + 1).toString().padStart(2, '0')
          const day = date.getDate().toString().padStart(2, '0')
          const hours = date.getHours().toString().padStart(2, '0')
          const minutes = date.getMinutes().toString().padStart(2, '0')
          formattedTime = `${year}-${month}-${day} ${hours}:${minutes}`
        }

        this.setData({
          'userInfo.openid': this.data.openid,
          'userInfo.registerTime': formattedTime,
          'userInfo.coins': balance
        })
      }
    } catch (err) {
      console.error('获取用户信息失败:', err)
    }
  },

  // 黑名单开关变化
  onBlacklistChange(e) {
    this.setData({
      'userInfo.isBlacklist': e.detail.value
    })
  },

  // 黑名单原因输入
  onReasonInput(e) {
    this.setData({
      blacklistReason: e.detail.value
    })
  },



  // 检查黑名单状态
  async checkBlacklistStatus() {
    try {
      const token = app.getToken()

      if (!app.globalData.cloud) {
        return
      }

      const res = await app.globalData.cloud.callFunction({
        name: 'managerGetBlacklist',
        data: {
          openid: this.data.openid,
          token: token
        }
      })
      console.log('检查黑名单状态结果:', res)

      if (res.result.code === 0) {
        this.setData({
          'userInfo.isBlacklist': res.result.data.isInBlacklist || false,
          'userInfo.blacklistReason': res.result.data.blacklistData?.reason || ''
        })
      }
    } catch (err) {
      console.error('检查黑名单状态失败:', err)
    }
  },

  // 保存用户设置
  async saveUserSettings() {
    try {
      wx.showLoading({
        title: '保存中...'
      })

      const token = app.getToken()

      if (!app.globalData.cloud) {
        wx.hideLoading()
        wx.showToast({
          title: '云开发未初始化',
          icon: 'none'
        })
        return
      }

      // 处理黑名单
      if (this.data.userInfo.isBlacklist) {
        // 添加到黑名单
        if (!this.data.blacklistReason || this.data.blacklistReason.trim() === '') {
          wx.hideLoading()
          wx.showToast({
            title: '请输入黑名单原因',
            icon: 'none'
          })
          return
        }

        const addRes = await app.globalData.cloud.callFunction({
          name: 'managerAddBlacklist',
          data: {
            openid: this.data.openid,
            token: token,
            reason: this.data.blacklistReason.trim()
          }
        })
        console.log('添加黑名单结果:', addRes)
        if (addRes.result.code !== 0) {
          wx.hideLoading()
          wx.showToast({
            title: addRes.result.message || '添加黑名单失败',
            icon: 'none'
          })
          return
        }
      } else {
        // 从黑名单移除
        const removeRes = await app.globalData.cloud.callFunction({
          name: 'managerRemoveBlacklist',
          data: {
            openid: this.data.openid,
            token: token
          }
        })
        console.log('移除黑名单结果:', removeRes)
        if (removeRes.result.code !== 0) {
          wx.hideLoading()
          wx.showToast({
            title: removeRes.result.message || '移除黑名单失败',
            icon: 'none'
          })
          return
        }
      }

      wx.hideLoading()
      wx.showToast({
        title: '保存成功',
        icon: 'success'
      })
    } catch (err) {
      wx.hideLoading()
      console.error('保存用户设置失败:', err)
      wx.showToast({
        title: '保存失败',
        icon: 'none'
      })
    }
  },

  // 显示日志查询
  async showLogs() {
    this.setData({ logsLoading: true })

    try {
      const token = app.getToken()

      if (!app.globalData.cloud) {
        this.setData({ logsLoading: false })
        wx.showToast({
          title: '云开发未初始化',
          icon: 'none'
        })
        return
      }

      const res = await app.globalData.cloud.callFunction({
        name: 'managerGetLogs',
        data: {
          openid: this.data.openid,
          token: token
        }
      })
      console.log('日志查询结果:', res)
      this.setData({ logsLoading: false })

      if (res.result.code === 0) {
        const logs = (res.result.data.logs || []).map(log => ({
          ...log,
          formattedTime: this.formatLogTime(log.created_at),
          formattedType: this.formatLogType(log.type)
        }))
        this.setData({ logs })
      } else {
        wx.showToast({
          title: res.result.message || '查询失败',
          icon: 'none'
        })
      }
    } catch (err) {
      this.setData({ logsLoading: false })
      console.error('查询日志失败:', err)
      wx.showToast({
        title: '查询失败',
        icon: 'none'
      })
    }
  },

  // 显示订单信息
  async showOrders() {
    this.setData({ ordersLoading: true })

    try {
      const token = app.getToken()

      if (!app.globalData.cloud) {
        this.setData({ ordersLoading: false })
        wx.showToast({
          title: '云开发未初始化',
          icon: 'none'
        })
        return
      }

      const res = await app.globalData.cloud.callFunction({
        name: 'managerGetRechargeOrders',
        data: {
          openid: this.data.openid,
          token: token
        }
      })
      console.log('订单查询完整结果:', JSON.stringify(res))

      this.setData({ ordersLoading: false })

      if (res.result && res.result.code === 0) {
        const orders = (res.result.data.orders || []).map(order => {
          console.log('订单原始数据:', order)
          const formattedOrder = {
            ...order,
            formattedCreatedTime: this.formatOrderTime(order.created_at),
            formattedPaidTime: this.formatOrderTime(order.paid_at),
            formattedRefundedTime: this.formatOrderTime(order.refunded_at),
            formattedStatus: this.formatOrderStatus(order.status)
          }
          console.log('订单格式化后:', formattedOrder)
          return formattedOrder
        })
        console.log('所有订单:', orders)
        this.setData({ orders })
      } else {
        console.log('查询失败或返回数据格式错误')
        wx.showToast({
          title: res.result?.message || '查询失败',
          icon: 'none'
        })
      }
    } catch (err) {
      this.setData({ ordersLoading: false })
      console.error('查询订单失败:', err)
      wx.showToast({
        title: '查询失败',
        icon: 'none'
      })
    }
  },

  // 格式化订单时间
  formatOrderTime(timeStr) {
    console.log('格式化订单时间:', timeStr)
    if (!timeStr) return ''
    try {
      const date = new Date(timeStr)
      if (isNaN(date.getTime())) {
        console.log('无效时间:', timeStr)
        return timeStr
      }
      const year = date.getFullYear()
      const month = (date.getMonth() + 1).toString().padStart(2, '0')
      const day = date.getDate().toString().padStart(2, '0')
      const hours = date.getHours().toString().padStart(2, '0')
      const minutes = date.getMinutes().toString().padStart(2, '0')
      const formatted = `${year}-${month}-${day} ${hours}:${minutes}`
      console.log('时间格式化:', timeStr, '->', formatted)
      return formatted
    } catch (err) {
      console.error('时间格式化失败:', err)
      return timeStr || ''
    }
  },

  // 格式化订单状态
  formatOrderStatus(status) {
    const statusMap = {
      'pending': '待支付',
      'paid': '已支付',
      'completed': '已完成',
      'cancelled': '已取消',
      'failed': '支付失败',
      'refunded': '已退款',
      'refund_failed': '退款失败'
    }
    return statusMap[status] || status
  },

  // 复制订单号
  copyOrderNo(e) {
    const orderNo = e.currentTarget.dataset.orderNo
    wx.setClipboardData({
      data: orderNo,
      success: () => {
        wx.showToast({
          title: '订单号已复制',
          icon: 'success'
        })
      }
    })
  },

  // 格式化日志时间
  formatLogTime(timeStr) {
    if (!timeStr) return ''
    try {
      const date = new Date(timeStr)
      if (isNaN(date.getTime())) {
        return timeStr
      }
      const year = date.getFullYear()
      const month = (date.getMonth() + 1).toString().padStart(2, '0')
      const day = date.getDate().toString().padStart(2, '0')
      const hours = date.getHours().toString().padStart(2, '0')
      const minutes = date.getMinutes().toString().padStart(2, '0')
      return `${year}-${month}-${day} ${hours}:${minutes}`
    } catch (err) {
      return timeStr || ''
    }
  },

  // 格式化日志类型
  formatLogType(type) {
    const typeMap = {
      'tts_clone': '语音克隆',
      'text_to_speech': '文字转语音',
      'audio_generation': '音频生成',
      'voice_conversion': '语音转换',
      'voice_clone': '声音克隆'
    }
    return typeMap[type] || type || '未知类型'
  }
})
