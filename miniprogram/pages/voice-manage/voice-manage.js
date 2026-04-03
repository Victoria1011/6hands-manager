// voice-manage.js
const app = getApp()

Page({
  data: {
    voiceList: [],
    allVoiceList: [], // 所有账号的音色列表
    loading: false,
    pageIndex: 0,
    pageSize: 50,
    savedVoiceCount: 0,
    currentType: 'clone', // 当前音色类型：clone(声音克隆) 或 design(声音设计)
    currentAccount: 'all', // 当前账号：all(全部), main(主账号), v(V账号), w(W账号)
    accountStats: { main: 0, v: 0, w: 0 }, // 各账号音色数量统计
    accountNames: { main: '主账号', v: 'V账号', w: 'W账号' }, // 账号名称映射
    batchMode: false, // 批量操作模式
    selectedVoices: {}, // 已选择的音色: {voice: true/false}
    selectedCount: 0 // 已选择数量
  },

  onLoad() {
    console.log('[VoiceManage] 页面加载完成')
    // 检查登录状态
    if (!this.checkIsLoggedIn()) return
    this.loadVoiceList()
  },

  onShow() {
    // 页面显示时刷新列表，但需要先检查登录状态
    if (!this.checkIsLoggedIn()) return
    this.loadVoiceList()
  },

  // 切换账号
  switchAccount(e) {
    const account = e.currentTarget.dataset.account
    if (account === this.data.currentAccount) return

    console.log('[VoiceManage] 切换账号:', account)
    this.setData({
      currentAccount: account
    })

    // 根据账号过滤音色列表
    this.filterVoiceList()
  },

  // 根据当前选择的账号过滤音色列表
  filterVoiceList() {
    const allVoiceList = this.data.allVoiceList
    const currentAccount = this.data.currentAccount

    let filteredList = []
    if (currentAccount === 'all') {
      filteredList = allVoiceList
    } else {
      filteredList = allVoiceList.filter(voice => voice.account_type === currentAccount)
    }

    // 计算已保存的音色数量
    const savedVoiceCount = filteredList.filter(voice => voice.user_info && voice.user_info.type === 'saved').length

    this.setData({
      voiceList: filteredList,
      savedVoiceCount: savedVoiceCount
    })

    console.log('[VoiceManage] 账号过滤完成，当前账号:', currentAccount, '音色数量:', filteredList.length)
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

  // 加载音色列表
  async loadVoiceList() {
    if (this.data.loading) return

    this.setData({
      loading: true
    })

    try {
      // 获取 token
      const token = app.getToken()
      console.log('[VoiceManage] 开始获取音色列表，类型:', this.data.currentType)
      console.log('[VoiceManage] Token:', token ? '存在' : '不存在')

      const res = await app.globalData.cloud.callFunction({
        name: 'managerVoiceManage',
        data: {
          token: token,
          action: 'list',
          voice_type: this.data.currentType,
          page_index: this.data.pageIndex,
          page_size: this.data.pageSize
        }
      })

      console.log('[VoiceManage] 查询结果:', res.result)

      if (res.result.code === 0) {
        const voiceList = res.result.data.voice_list || []
        const accountStats = res.result.data.account_stats || { main: 0, v: 0, w: 0 }

        console.log('[VoiceManage] 音色列表详情:', JSON.stringify(voiceList, null, 2))
        console.log('[VoiceManage] 账号统计:', accountStats)

        // 保存完整的音色列表
        const allVoiceList = voiceList

        // 根据当前选择的账号过滤
        let filteredList = []
        if (this.data.currentAccount === 'all') {
          filteredList = allVoiceList
        } else {
          filteredList = allVoiceList.filter(voice => voice.account_type === this.data.currentAccount)
        }

        // 计算已保存的音色数量（type === 'saved'）
        const savedVoiceCount = filteredList.filter(voice => voice.user_info && voice.user_info.type === 'saved').length

        this.setData({
          allVoiceList: allVoiceList,
          voiceList: filteredList,
          savedVoiceCount: savedVoiceCount,
          accountStats: accountStats
        })
      } else {
        wx.showToast({
          title: res.result.message || '查询失败',
          icon: 'none'
        })
      }
    } catch (err) {
      console.error('[VoiceManage] 查询失败:', err)
      wx.showToast({
        title: '查询失败，请稍后重试',
        icon: 'none'
      })
    } finally {
      this.setData({
        loading: false
      })
    }
  },

  // 切换音色类型
  switchType(e) {
    const type = e.currentTarget.dataset.type
    if (type === this.data.currentType) return

    console.log('[VoiceManage] 切换音色类型:', type)
    this.setData({
      currentType: type,
      voiceList: [],
      allVoiceList: [],
      savedVoiceCount: 0,
      pageIndex: 0 // 重置页码
    })

    // 重新加载音色列表
    this.loadVoiceList()
  },

  // 刷新列表
  onRefresh() {
    console.log('[VoiceManage] 刷新列表')
    this.loadVoiceList()
  },

  // 复制音色名称
  onCopyVoice(e) {
    const voice = e.currentTarget.dataset.voice
    wx.setClipboardData({
      data: voice,
      success: () => {
        wx.showToast({
          title: '复制成功',
          icon: 'success'
        })
      }
    })
  },

  // 复制 OpenID
  onCopyOpenid(e) {
    const openid = e.currentTarget.dataset.openid
    wx.setClipboardData({
      data: openid,
      success: () => {
        wx.showToast({
          title: 'OpenID 已复制',
          icon: 'success'
        })
      }
    })
  },

  // 删除音色
  async onDeleteVoice(e) {
    const voice = e.currentTarget.dataset.voice
    const creatorOpenid = e.currentTarget.dataset.creatorOpenid || ''
    const accountType = e.currentTarget.dataset.accountType || 'main'

    // 确认删除
    wx.showModal({
      title: '确认删除',
      content: '确定要删除这个音色吗？删除后无法恢复。',
      confirmText: '删除',
      confirmColor: '#ff4d4f',
      success: async (res) => {
        if (res.confirm) {
          await this.deleteVoice(voice, creatorOpenid, accountType)
        }
      }
    })
  },

  // 执行删除
  async deleteVoice(voice, creatorOpenid, accountType = 'main') {
    wx.showLoading({
      title: '删除中...'
    })

    try {
      // 获取 token
      const token = app.getToken()
      console.log('[VoiceManage] 开始删除音色:', voice, 'creator_openid:', creatorOpenid, '类型:', this.data.currentType, '账号:', accountType)

      const res = await app.globalData.cloud.callFunction({
        name: 'managerVoiceManage',
        data: {
          token: token,
          action: 'delete',
          voice_type: this.data.currentType,
          voice: voice,
          creator_openid: creatorOpenid,
          account_type: accountType
        }
      })

      console.log('[VoiceManage] 删除结果:', res.result)

      wx.hideLoading()

      if (res.result.code === 0) {
        wx.showToast({
          title: '删除成功',
          icon: 'success'
        })
        // 刷新列表
        await this.loadVoiceList()
      } else {
        wx.showToast({
          title: res.result.message || '删除失败',
          icon: 'none'
        })
      }
    } catch (err) {
      console.error('[VoiceManage] 删除失败:', err)
      wx.hideLoading()
      wx.showToast({
        title: '删除失败，请稍后重试',
        icon: 'none'
      })
    }
  },

  // 切换批量模式
  toggleBatchMode() {
    console.log('[VoiceManage] toggleBatchMode 被调用')
    console.log('[VoiceManage] 当前 batchMode:', this.data.batchMode)

    const newMode = !this.data.batchMode

    this.setData({
      batchMode: newMode,
      selectedVoices: {},
      selectedCount: 0
    }, () => {
      console.log('[VoiceManage] 批量模式切换完成，新状态:', newMode)
    })
  },

  // 选择/取消选择音色
  onSelectVoice(e) {
    const voice = e.currentTarget.dataset.voice
    const selectedVoices = { ...this.data.selectedVoices }
    selectedVoices[voice] = !selectedVoices[voice]

    const selectedCount = Object.keys(selectedVoices).filter(key => selectedVoices[key]).length

    this.setData({
      selectedVoices,
      selectedCount
    })

    console.log('[VoiceManage] 选择音色:', voice, '已选择数:', selectedCount)
  },

  // 全选/取消全选
  toggleSelectAll() {
    const voiceList = this.data.voiceList
    const selectedVoices = {}

    // 只能选择未保存的音色
    voiceList.forEach(voice => {
      if (!voice.user_info || voice.user_info.type !== 'saved') {
        selectedVoices[voice.voice] = !this.data.selectedCount || this.data.selectedCount < voiceList.filter(v => !v.user_info || v.user_info.type !== 'saved').length
      }
    })

    const selectedCount = Object.keys(selectedVoices).filter(key => selectedVoices[key]).length

    this.setData({
      selectedVoices,
      selectedCount
    })

    console.log('[VoiceManage] 全选操作，已选择数:', selectedCount)
  },

  // 批量删除
  onBatchDelete() {
    const selectedCount = this.data.selectedCount

    if (selectedCount === 0) {
      wx.showToast({
        title: '请选择要删除的音色',
        icon: 'none'
      })
      return
    }

    wx.showModal({
      title: '确认批量删除',
      content: `确定要删除选中的 ${selectedCount} 个音色吗？删除后无法恢复。`,
      confirmText: '删除',
      confirmColor: '#ff4d4f',
      success: async (res) => {
        if (res.confirm) {
          await this.executeBatchDelete()
        }
      }
    })
  },

  // 执行批量删除
  async executeBatchDelete() {
    wx.showLoading({
      title: '删除中...'
    })

    const selectedVoices = this.data.selectedVoices
    const voiceList = this.data.voiceList
    const token = app.getToken()

    let successCount = 0
    let failCount = 0

    // 获取需要删除的音色列表（只删除未保存的）
    const voicesToDelete = voiceList
      .filter(voice => selectedVoices[voice.voice] && (!voice.user_info || voice.user_info.type !== 'saved'))
      .map(voice => ({
        voice: voice.voice,
        creatorOpenid: voice.user_info ? voice.user_info.openid : '',
        accountType: voice.account_type || 'main'
      }))

    console.log('[VoiceManage] 准备批量删除音色:', voicesToDelete)

    // 逐个删除
    for (const item of voicesToDelete) {
      try {
        const res = await app.globalData.cloud.callFunction({
          name: 'managerVoiceManage',
          data: {
            token: token,
            action: 'delete',
            voice_type: this.data.currentType,
            voice: item.voice,
            creator_openid: item.creatorOpenid,
            account_type: item.accountType
          }
        })

        if (res.result.code === 0) {
          successCount++
        } else {
          failCount++
          console.error('[VoiceManage] 删除音色失败:', item.voice, res.result.message)
        }
      } catch (err) {
        failCount++
        console.error('[VoiceManage] 删除音色异常:', item.voice, err)
      }
    }

    wx.hideLoading()

    // 显示结果
    if (failCount === 0) {
      wx.showToast({
        title: `成功删除 ${successCount} 个音色`,
        icon: 'success'
      })
    } else {
      wx.showModal({
        title: '批量删除完成',
        content: `成功删除 ${successCount} 个音色，失败 ${failCount} 个`,
        showCancel: false
      })
    }

    // 退出批量模式并刷新列表
    this.setData({
      batchMode: false,
      selectedVoices: {},
      selectedCount: 0
    })
    await this.loadVoiceList()
  }
})
