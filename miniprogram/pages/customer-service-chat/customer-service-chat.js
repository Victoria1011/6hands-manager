// pages/customer-service-chat/customer-service-chat.js
const app = getApp()

Page({
  data: {
    openid: '',
    messages: [],
    inputContent: '',
    scrollIntoView: '', // 绑定 scroll-view 的 scroll-into-view，指向最后一条消息的 id
    loading: false,
    showActionSheet: false,
    activeTab: 'chat',
    userInfo: {
      openid: '',
      registerTime: '',
      coins: 0,
      deviceBrand: '' // device_info.brand，有则在注册时间后显示标签
    },
    deviceInfoList: [], // device_info 全部内容（弹窗用）：[{ key, value }]
    showDeviceModal: false, // 设备信息弹窗
    blacklistReason: '',
    logs: [],
    flatLogsList: [], // 扁平化的日志列表
    allFlatLogsList: [], // 完整原始列表（用于类型筛选）
    logFilterType: 'all', // all, clone, design, synthesize_mimo, synthesize
    logSubFilter: 'all', // all, qwen, mimo（克隆/设计的二级筛选）
    logFilterTabs: [
      { key: 'all', label: '全部' },
      { key: 'clone', label: '克隆' },
      { key: 'design', label: '设计' },
      { key: 'synthesize_mimo', label: 'Mimo合成' },
      { key: 'synthesize', label: 'Qwen合成' }
    ],
    logSubFilterTabs: [
      { key: 'all', label: '全部' },
      { key: 'qwen', label: 'Qwen' },
      { key: 'mimo', label: 'Mimo' }
    ],
    logsLoading: false,
    orders: [],
    ordersLoading: false,
    currentPlayingAudioId: null, // 当前正在播放的音频ID
    // 元宝明细
    coinTransactions: [],
    coinTransactionsLoading: false
  },

  onLoad(options) {
    // 检查登录状态
    if (!this.checkIsLoggedIn()) return

    const { openid, tab } = options
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
      activeTab: tab || 'chat',
      'userInfo.openid': openid
    })
    this.getMessages()
    this.getUserInfo()

    // 如果指定了 tab，自动加载对应数据
    if (tab === 'logs') {
      this.showLogs()
    } else if (tab === 'user') {
      this.checkBlacklistStatus()
    } else if (tab === 'orders') {
      this.showOrders()
    } else if (tab === 'coins') {
      this.showCoinTransactions()
    }
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
        
        // 处理图片消息，获取云存储文件的临时链接
        const imageMessages = messages.filter(msg => msg.msg_type === 'image' && msg.cloud_file_id)
        if (imageMessages.length > 0) {
          try {
            const fileIDs = imageMessages.map(msg => msg.cloud_file_id)
            const tempURLRes = await app.globalData.cloud.getTempFileURL({
              fileList: fileIDs
            })
            console.log('[CustomerServiceChat] 获取图片临时链接:', tempURLRes)
            
            if (tempURLRes.fileList) {
              tempURLRes.fileList.forEach(file => {
                const msg = messages.find(m => m.cloud_file_id === file.fileID)
                if (msg && file.status === 0 && file.tempFileURL) {
                  msg.image_url = file.tempFileURL
                }
              })
            }
          } catch (err) {
            console.error('[CustomerServiceChat] 获取图片临时链接失败:', err)
          }
        }
        
        // 打印每条消息的 type 字段并格式化时间
        messages.forEach((msg, index) => {
          console.log(`[CustomerServiceChat] 消息 ${index + 1}:`, {
            type: msg.type,
            msg_type: msg.msg_type,
            content: msg.content ? msg.content.substring(0, 50) : '',
            cloud_file_id: msg.cloud_file_id,
            image_url: msg.image_url,
            created_at: msg.created_at
          })
          // 添加格式化后的时间字段
          msg.formattedTime = this.formatTime(msg.created_at)
        })
        this.setData({
          messages: messages
        })
        this.scrollToBottom()
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
      inputContent: ''
    })
    this.scrollToBottom()

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
          
    <a href="weixin://dl/business/?appid=wx126d0f048410f694&path=pages/purchase/purchase&query=productId=1" >入门套餐 ¥1 (1万元宝)</a>
    
    <a href="weixin://dl/business/?appid=wx126d0f048410f694&path=pages/purchase/purchase&query=productId=2">标准套餐 ¥10 (10万元宝 + 赠送 1 万元宝)</a>
    
    <a href="weixin://dl/business/?appid=wx126d0f048410f694&path=pages/purchase/purchase&query=productId=3">畅享套餐 ¥100 (100万元宝 + 赠送 20 万元宝)</a>`

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
      messages: [...this.data.messages, tempMessage]
    })
    this.scrollToBottom()

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
        messages: [...this.data.messages, tempMessage]
      })
      this.scrollToBottom()

      // 上传图片到云存储
      const uploadRes = await app.globalData.cloud.uploadFile({
        cloudPath: `customer-service/${Date.now()}.jpg`,
        filePath: filePath
      })

      console.log('[Chat] 图片上传成功:', uploadRes)

      const fileID = uploadRes.fileID
      console.log('[Chat] 图片上传成功，fileID:', fileID)

      // 发送消息，将云存储的 fileID 传给云函数
      // 云函数会负责将 fileID 转换为微信临时素材的 media_id
      const token = app.getToken()

      const res = await app.globalData.cloud.callFunction({
        name: 'sendCustomerMessage',
        data: {
          openid: this.data.openid,
          msgtype: 'image',
          token: token,
          msgData: {
            file_id: fileID  // 传递云存储的 fileID，云函数会自动转换
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
  // scroll-into-view 仅在绑定值「发生变化」时才会滚动。新增消息时 id 会变（msg-N → msg-N+1），
  // 因此能正常触发；若目标 id 未变（如刷新后条数相同），先清空再设置以强制触发滚动。
  scrollToBottom() {
    const len = this.data.messages.length
    if (len === 0) return
    const id = 'msg-' + (len - 1)
    if (this.data.scrollIntoView === id) {
      this.setData({ scrollIntoView: '' })
      setTimeout(() => this.setData({ scrollIntoView: id }), 30)
    } else {
      this.setData({ scrollIntoView: id })
    }
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
    } else if (tab === 'coins') {
      this.showCoinTransactions()
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

        // 设备信息（users 集合中可能存在 device_info）
        const deviceInfo = coinsData.device_info || null
        const deviceBrand = deviceInfo ? (deviceInfo.brand || '') : ''
        const deviceInfoList = deviceInfo
          ? Object.keys(deviceInfo).map(key => ({ key, value: this.stringifyDeviceValue(deviceInfo[key]) }))
          : []

        this.setData({
          'userInfo.openid': this.data.openid,
          'userInfo.registerTime': formattedTime,
          'userInfo.coins': balance,
          'userInfo.deviceBrand': deviceBrand,
          deviceInfoList: deviceInfoList
        })
      }
    } catch (err) {
      console.error('获取用户信息失败:', err)
    }
  },

  // 将 device_info 的值转为可展示的字符串
  stringifyDeviceValue(val) {
    if (val === null || val === undefined) return '-'
    if (typeof val === 'object') {
      try {
        return JSON.stringify(val)
      } catch (e) {
        return String(val)
      }
    }
    return String(val)
  },

  // 显示设备信息弹窗
  onShowDeviceInfo() {
    if (!this.data.deviceInfoList.length) return
    this.setData({ showDeviceModal: true })
  },

  // 关闭设备信息弹窗
  onCloseDeviceInfo() {
    this.setData({ showDeviceModal: false })
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
    this.setData({ logsLoading: true, logFilterType: 'all', logSubFilter: 'all' })

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
        const logs = res.result.data.logs || []

        // 查询 speakers 和 speakers_test 获取已发布/已上传的音色ID
        var publishedVoiceIds = new Set()
        var uploadedVoiceIds = new Set()
        try {
          var speakersResults = await Promise.all([
            app.globalData.cloud.callFunction({
              name: 'managerVoiceManage',
              data: { token: token, action: 'check_speakers' }
            }),
            app.globalData.cloud.callFunction({
              name: 'managerVoiceManage',
              data: { token: token, action: 'check_upload_speakers' }
            })
          ])
          var speakersRes = speakersResults[0]
          var speakersTestRes = speakersResults[1]
          if (speakersRes.result.code === 0 && speakersRes.result.data) {
            publishedVoiceIds = new Set(speakersRes.result.data.voice_ids || [])
          }
          if (speakersTestRes.result.code === 0 && speakersTestRes.result.data) {
            uploadedVoiceIds = new Set(speakersTestRes.result.data.voice_ids || [])
          }
        } catch (err) {
          console.error('查询音色库状态失败:', err)
        }

        // 扁平化日志列表
        const flatLogs = logs.map((log, index) => {
          var apiSource = 'qwen'
          if (log.voice_id && typeof log.voice_id === 'string' && log.voice_id.toLowerCase().indexOf('mimo') === 0) {
            apiSource = 'mimo'
          }
          if (index < 5) {
            console.log('[showLogs] log target_model:', log.target_model, '-> api_source:', apiSource)
          }
          return {
            ...log,
            openid: this.data.openid,
            formattedTime: this.formatLogTime(log.created_at),
            formattedType: this.formatLogType(log.type),
            _logId: log._id || `${Date.now()}_${index}`,
            isPublished: log.voice_id ? publishedVoiceIds.has(log.voice_id) : false,
            isUploaded: log.voice_id ? uploadedVoiceIds.has(log.voice_id) : false,
            api_source: apiSource
          }
        }).sort(function(a, b) {
          const timeA = a.created_at ? (typeof a.created_at === 'number' ? a.created_at : new Date(a.created_at).getTime()) : 0
          const timeB = b.created_at ? (typeof b.created_at === 'number' ? b.created_at : new Date(b.created_at).getTime()) : 0
          return timeB - timeA
        })
        
        this.setData({ 
          logs,
          allFlatLogsList: flatLogs,
          flatLogsList: flatLogs,
          logSubFilter: 'all'
        })
      } else {
        this.setData({ logs: [], allFlatLogsList: [], flatLogsList: [] })
        wx.showToast({
          title: res.result.message || '查询失败',
          icon: 'none'
        })
      }
    } catch (err) {
      this.setData({ logsLoading: false, logs: [], allFlatLogsList: [], flatLogsList: [] })
      console.error('查询日志失败:', err)
      wx.showToast({
        title: '查询失败',
        icon: 'none'
      })
    }
  },

  // 日志类型筛选
  onLogFilterChange(e) {
    const filterType = e.currentTarget.dataset.type
    this.setData({
      logFilterType: filterType,
      logSubFilter: 'all'
    })
    this.applyLogFilter()
  },

  // 日志二级筛选（qwen/mimo）
  onLogSubFilterChange(e) {
    const subFilter = e.currentTarget.dataset.type
    this.setData({ logSubFilter: subFilter })
    this.applyLogFilter()
  },

  // 应用日志筛选（主筛选 + 二级筛选）
  applyLogFilter() {
    var filteredLogs = this.filterLogsByType(this.data.logFilterType)
    var subFilter = this.data.logSubFilter
    if (subFilter !== 'all') {
      filteredLogs = filteredLogs.filter(function(log) {
        return log.api_source === subFilter
      })
    }
    this.setData({ flatLogsList: filteredLogs })
  },

  // 根据类型筛选日志
  filterLogsByType(filterType) {
    const allLogs = this.data.allFlatLogsList
    if (filterType === 'all' || !filterType) {
      return allLogs
    }
    return allLogs.filter(log => log.type === filterType)
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

  // 显示元宝明细
  async showCoinTransactions() {
    this.setData({ coinTransactionsLoading: true })

    try {
      const token = app.getToken()

      if (!app.globalData.cloud) {
        this.setData({ coinTransactionsLoading: false })
        wx.showToast({
          title: '云开发未初始化',
          icon: 'none'
        })
        return
      }

      const res = await app.globalData.cloud.callFunction({
        name: 'managerGetCoins',
        data: {
          openid: this.data.openid,
          token: token,
          action: 'transactions'
        }
      })
      console.log('[Chat] 元宝明细查询结果:', res.result)

      this.setData({ coinTransactionsLoading: false })

      if (res.result.code === 0) {
        const transactions = (res.result.data?.transactions || []).map(item => ({
          ...item,
          formattedTime: this.formatCoinTime(item.created_at),
          formattedType: this.formatCoinTransactionType(item.type)
        }))

        this.setData({ coinTransactions: transactions })
      } else {
        this.setData({ coinTransactions: [] })
        wx.showToast({
          title: res.result.message || '查询失败',
          icon: 'none'
        })
      }
    } catch (err) {
      this.setData({ coinTransactionsLoading: false, coinTransactions: [] })
      console.error('[Chat] 查询元宝明细失败:', err)
      wx.showToast({
        title: '查询失败',
        icon: 'none'
      })
    }
  },

  // 格式化元宝明细时间
  formatCoinTime(timeStr) {
    if (!timeStr) return ''
    try {
      const date = new Date(timeStr)
      if (isNaN(date.getTime())) return timeStr
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

  // 格式化元宝交易类型
  formatCoinTransactionType(type) {
    const typeMap = {
      'consume': '消耗',
      'recharge': '充值',
      'gift': '赠送',
      'refund': '退款',
      'reward': '奖励'
    }
    return typeMap[type] || type
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

  // 预览图片（全屏查看）
  previewImage(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    
    wx.previewImage({
      current: url,
      urls: [url]
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
      'voice_clone': '声音克隆',
      'clone': '克隆',
      'design': '设计',
      'synthesize_mimo': 'Mimo合成',
      'synthesize': 'Qwen合成'
    }
    return typeMap[type] || type || '未知类型'
  },

  // 复制文本
  onCopyText(e) {
    const text = e.currentTarget.dataset.text
    if (!text) {
      wx.showToast({ title: '无内容可复制', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: String(text),
      success: () => {
        wx.showToast({ title: '已复制', icon: 'success' })
      },
      fail: () => {
        wx.showToast({ title: '复制失败', icon: 'none' })
      }
    })
  },

  // 播放音频并复制链接
  onPlayAudio(e) {
    const audioFileId = e.currentTarget.dataset.audioId
    if (!audioFileId) {
      wx.showToast({ title: '无音频文件', icon: 'none' })
      return
    }

    // 如果点击的是同一个音频，则停止播放
    if (this.data.currentPlayingAudioId === audioFileId) {
      if (this.innerAudioContext) {
        this.innerAudioContext.stop()
        this.innerAudioContext.destroy()
        this.innerAudioContext = null
      }
      this.setData({ currentPlayingAudioId: null })
      wx.showToast({ title: '已停止', icon: 'none' })
      return
    }

    // 停止之前的音频
    if (this.innerAudioContext) {
      this.innerAudioContext.stop()
      this.innerAudioContext.destroy()
      this.innerAudioContext = null
    }

    wx.showLoading({ title: '获取音频链接...', mask: true })

    // 获取临时链接
    app.globalData.cloud.getTempFileURL({
      fileList: [audioFileId]
    }).then(res => {
      wx.hideLoading()
      console.log('获取音频临时链接:', res)

      if (res.fileList && res.fileList[0] && res.fileList[0].status === 0 && res.fileList[0].tempFileURL) {
        const tempFileURL = res.fileList[0].tempFileURL
        console.log('音频临时链接:', tempFileURL)

        // 复制链接到剪贴板
        wx.setClipboardData({
          data: tempFileURL,
          success: () => {
            wx.showToast({ title: '链接已复制', icon: 'success' })
          }
        })

        // 播放音频
        this.innerAudioContext = wx.createInnerAudioContext()
        this.innerAudioContext.src = tempFileURL
        this.innerAudioContext.play()

        this.setData({ currentPlayingAudioId: audioFileId })

        this.innerAudioContext.onPlay(() => {
          console.log('开始播放音频')
        })

        this.innerAudioContext.onError((err) => {
          console.error('音频播放失败:', err)
          wx.showToast({ title: '播放失败', icon: 'none' })
          this.setData({ currentPlayingAudioId: null })
        })

        this.innerAudioContext.onEnded(() => {
          console.log('音频播放结束')
          this.setData({ currentPlayingAudioId: null })
          if (this.innerAudioContext) {
            this.innerAudioContext.destroy()
            this.innerAudioContext = null
          }
        })
      } else {
        wx.showToast({ title: '获取音频链接失败', icon: 'none' })
      }
    }).catch(err => {
      wx.hideLoading()
      console.error('获取音频临时链接失败:', err)
      wx.showToast({ title: '获取音频失败', icon: 'none' })
    })
  },

  // 上传音色到 speakers_test
  async onUploadVoice(e) {
    const dataset = e.currentTarget.dataset
    const voiceData = {
      voice_id: dataset.voiceId,
      voice_name: dataset.voiceName || '',
      voice_prompt: dataset.voicePrompt || '',
      used_api_key: dataset.usedApiKey || '',
      preview_text: dataset.previewText || '',
      preview_audio_file_id: dataset.previewAudioFileId || '',
      language: dataset.language || '',
      target_model: dataset.targetModel || '',
      type: dataset.type || ''
    }

    if (!voiceData.voice_id) {
      wx.showToast({ title: '缺少音色ID', icon: 'none' })
      return
    }

    wx.showModal({
      title: '确认上传',
      content: `确定将音色 ${voiceData.voice_id} 上传到测试音色库吗？`,
      success: async (res) => {
        if (!res.confirm) return

        wx.showLoading({ title: '上传中...' })
        try {
          const token = app.getToken()
          const cloudRes = await app.globalData.cloud.callFunction({
            name: 'managerVoiceManage',
            data: {
              token: token,
              action: 'upload_speaker',
              voice_data: voiceData
            }
          })
          wx.hideLoading()

          if (cloudRes.result.code === 0) {
            wx.showToast({ title: '上传成功', icon: 'success' })
            // 更新列表中该音色的上传状态
            const allLogs = this.data.allFlatLogsList.map(log => {
              if (log.voice_id === voiceData.voice_id) {
                return { ...log, isUploaded: true }
              }
              return log
            })
            const filteredLogs = this.filterLogsByType(this.data.logFilterType)
            this.setData({
              allFlatLogsList: allLogs,
              flatLogsList: allLogs.filter(log => {
                if (this.data.logFilterType === 'all' || !this.data.logFilterType) return true
                return log.type === this.data.logFilterType
              })
            })
          } else {
            wx.showToast({ title: cloudRes.result.message || '上传失败', icon: 'none' })
          }
        } catch (err) {
          wx.hideLoading()
          console.error('[UploadVoice] 上传失败:', err)
          wx.showToast({ title: '上传失败', icon: 'none' })
        }
      }
    })
  }
})
