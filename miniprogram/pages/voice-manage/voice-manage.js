// voice-manage.js
const app = getApp()

Page({
  data: {
    voiceList: [],
    allVoiceList: [], // 所有音色列表（用于账号过滤）
    loading: false,
    savedVoiceCount: 0,
    currentType: 'clone', // 当前音色类型：clone(声音克隆) 或 design(声音设计)
    currentAccount: 'all', // 当前账号：all(全部), main(主账号), v(V账号), w(W账号)
    currentListTab: 'all', // 当前列表标签：all(全部) 或 suggest(建议清理)
    accountStats: { main: 0, v: 0, w: 0 }, // 各账号音色数量统计
    accountNames: { main: '主账号', v: 'V账号', w: 'W账号' }, // 账号名称映射
    batchMode: false, // 批量操作模式
    selectedVoices: {}, // 已选择的音色: {voice: true/false}
    selectedCount: 0, // 已选择数量
    suggestDeleteList: [], // 建议删除的音色列表
    suggestDeleteCount: 0, // 建议删除数量
    suggestDeleteStats: { main: 0, v: 0, w: 0 } // 各账号建议删除数量统计
  },

  onLoad() {
    console.log('[VoiceManage] 页面加载完成')
    if (!this.checkIsLoggedIn()) return
    this.loadVoiceList()
  },

  onShow() {
    if (!this.checkIsLoggedIn()) return
    this.loadVoiceList()
  },

  // 切换账号
  switchAccount(e) {
    const account = e.currentTarget.dataset.account
    if (account === this.data.currentAccount) return

    console.log('[VoiceManage] 切换账号:', account)
    this.setData({ currentAccount: account })
    this.applyFilterAndRender()
  },

  // 切换列表标签（全部 / 建议清理）
  switchListTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab === this.data.currentListTab) return

    console.log('[VoiceManage] 切换列表标签:', tab)
    this.setData({
      currentListTab: tab,
      voiceList: [],
      batchMode: false,
      selectedVoices: {},
      selectedCount: 0
    })
    this.applyFilterAndRender()
  },

  // 根据当前条件过滤并渲染列表
  applyFilterAndRender() {
    const { allVoiceList, suggestDeleteList, currentAccount, currentListTab } = this.data

    // 选择数据源
    let sourceList = currentListTab === 'suggest' ? suggestDeleteList : allVoiceList

    // 按账号过滤
    let filteredList = sourceList
    if (currentAccount !== 'all') {
      filteredList = sourceList.filter(voice => voice.account_type === currentAccount)
    }

    const savedVoiceCount = (currentListTab === 'all'
      ? filteredList
      : [] // 建议清理列表中没有已保存的
    ).filter(voice => voice.user_info && voice.user_info.type === 'saved').length

    this.setData({
      savedVoiceCount: savedVoiceCount,
      voiceList: []
    })

    this.renderListInBatches(filteredList)
  },

  // 检查是否已登录
  checkIsLoggedIn() {
    const token = app.getToken()
    const userInfo = app.getUserInfo()

    if (!token || !userInfo) {
      wx.showToast({ title: '请先登录', icon: 'none' })
      setTimeout(() => { wx.reLaunch({ url: '/pages/index/index' }) }, 1500)
      return false
    }
    return true
  },

  // 格式化时间（兼容 iOS）
  formatTime(time) {
    if (!time) return ''
    let timestamp = time

    if (typeof time === 'string') {
      const normalized = time.replace(' ', 'T')
      const parsed = Date.parse(normalized)
      if (!isNaN(parsed)) {
        timestamp = parsed
      } else {
        return time
      }
    }

    const date = new Date(timestamp)
    if (isNaN(date.getTime())) return String(time)

    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    const seconds = String(date.getSeconds()).padStart(2, '0')

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
  },

  // 加载音色列表
  async loadVoiceList() {
    if (this.data.loading) return
    this.setData({ loading: true })

    try {
      const token = app.getToken()
      console.log('[VoiceManage] 开始获取音色列表，类型:', this.data.currentType)

      const res = await app.globalData.cloud.callFunction({
        name: 'managerVoiceManage',
        data: {
          token: token,
          action: 'list',
          voice_type: this.data.currentType
        }
      })

      if (res.result.code === 0) {
        const allVoiceList = (res.result.data.voice_list || []).map(voice => ({
          ...voice,
          last_used_time: voice.last_used_time ? this.formatTime(voice.last_used_time) : null
        }))
        allVoiceList.sort((a, b) => {
          const timeA = a.gmt_create ? new Date(String(a.gmt_create).replace(' ', 'T')).getTime() || 0 : 0
          const timeB = b.gmt_create ? new Date(String(b.gmt_create).replace(' ', 'T')).getTime() || 0 : 0
          return timeA - timeB
        })
        const accountStats = res.result.data.account_stats || { main: 0, v: 0, w: 0 }
        console.log('[VoiceManage] 获取音色数量:', allVoiceList.length)

        // 计算建议删除列表
        const suggestData = this._computeSuggestDelete(allVoiceList)

        // 选择数据源
        let sourceList = this.data.currentListTab === 'suggest' ? suggestData.list : allVoiceList

        // 按账号过滤
        let filteredList = sourceList
        if (this.data.currentAccount !== 'all') {
          filteredList = sourceList.filter(voice => voice.account_type === this.data.currentAccount)
        }

        const savedVoiceCount = filteredList.filter(voice => voice.user_info && voice.user_info.type === 'saved').length

        this.setData({
          allVoiceList: allVoiceList,
          voiceList: [],
          savedVoiceCount: savedVoiceCount,
          accountStats: accountStats,
          loading: false,
          suggestDeleteList: suggestData.list,
          suggestDeleteCount: suggestData.count,
          suggestDeleteStats: suggestData.stats
        })

        this.renderListInBatches(filteredList)
      } else {
        wx.showToast({ title: res.result.message || '查询失败', icon: 'none' })
        this.setData({ loading: false })
      }
    } catch (err) {
      console.error('[VoiceManage] 查询失败:', err)
      wx.showToast({ title: '查询失败，请稍后重试', icon: 'none' })
      this.setData({ loading: false })
    }
  },

  // 纯函数：计算建议删除的音色列表（未保存 + 超过 20 天未使用）
  _computeSuggestDelete(allVoiceList) {
    const now = Date.now()
    const DAY_MS = 24 * 60 * 60 * 1000
    const THRESHOLD_DAYS = 20

    let savedCount = 0
    let neverUsedCount = 0
    let recentUsedCount = 0
    let oldUnusedCount = 0

    const suggestList = allVoiceList.filter((voice) => {
      if (voice.user_info && voice.user_info.type === 'saved') {
        savedCount++
        return false
      }

      if (!voice.last_used_time) {
        neverUsedCount++
        return true
      }

      const lastUsedTime = new Date(voice.last_used_time).getTime()
      if (isNaN(lastUsedTime)) {
        neverUsedCount++
        return true
      }

      const daysDiff = (now - lastUsedTime) / DAY_MS
      if (daysDiff > THRESHOLD_DAYS) {
        oldUnusedCount++
        return true
      } else {
        recentUsedCount++
        return false
      }
    })

    console.log('[VoiceManage] ===== 建议删除统计 =====')
    console.log('[VoiceManage] 已保存(排除):', savedCount)
    console.log('[VoiceManage] 从未使用(建议删除):', neverUsedCount)
    console.log('[VoiceManage] 超过20天未用(建议删除):', oldUnusedCount)
    console.log('[VoiceManage] 20天内使用过(排除):', recentUsedCount)
    console.log('[VoiceManage] 建议删除总计:', suggestList.length)
    console.log('[VoiceManage] =========================')

    const stats = { main: 0, v: 0, w: 0 }
    suggestList.forEach(v => {
      if (v.account_type && stats.hasOwnProperty(v.account_type)) {
        stats[v.account_type]++
      }
    })

    return { list: suggestList, count: suggestList.length, stats }
  },

  // 分批渲染列表
  renderListInBatches(fullList) {
    const BATCH_SIZE = 50
    let index = 0

    const renderNext = () => {
      if (index >= fullList.length) return
      const batch = fullList.slice(index, index + BATCH_SIZE)
      const currentList = this.data.voiceList
      this.setData({
        voiceList: currentList.concat(batch)
      })
      index += BATCH_SIZE
      if (index < fullList.length) {
        setTimeout(renderNext, 30)
      }
    }

    renderNext()
  },

  // 切换音色类型
  switchType(e) {
    const type = e.currentTarget.dataset.type
    if (type === this.data.currentType) return

    this.setData({
      currentType: type,
      voiceList: [],
      allVoiceList: [],
      savedVoiceCount: 0,
      suggestDeleteList: [],
      suggestDeleteCount: 0,
      currentListTab: 'all',
      batchMode: false,
      selectedVoices: {},
      selectedCount: 0
    }, () => {
      this.loadVoiceList()
    })
  },

  // 刷新列表
  onRefresh() {
    this.setData({
      voiceList: [],
      allVoiceList: [],
      savedVoiceCount: 0,
      suggestDeleteList: [],
      suggestDeleteCount: 0,
      batchMode: false,
      selectedVoices: {},
      selectedCount: 0
    })
    this.loadVoiceList()
  },

  // 复制音色名称
  onCopyVoice(e) {
    const voice = e.currentTarget.dataset.voice
    wx.setClipboardData({
      data: voice,
      success: () => {
        wx.showToast({ title: '复制成功', icon: 'success' })
      }
    })
  },

  // 点击 OpenID 跳转到客服聊天页面
  onTapOpenid(e) {
    const openid = e.currentTarget.dataset.openid
    wx.navigateTo({
      url: `/pages/customer-service-chat/customer-service-chat?openid=${openid}&tab=logs`
    })
  },

  // 删除音色
  async onDeleteVoice(e) {
    const voice = e.currentTarget.dataset.voice
    const creatorOpenid = e.currentTarget.dataset.creatorOpenid || ''
    const accountType = e.currentTarget.dataset.accountType || 'main'

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
    wx.showLoading({ title: '删除中...' })

    try {
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
        wx.showToast({ title: '删除成功', icon: 'success' })
        await this.loadVoiceList()
      } else {
        wx.showToast({ title: res.result.message || '删除失败', icon: 'none' })
      }
    } catch (err) {
      console.error('[VoiceManage] 删除失败:', err)
      wx.hideLoading()
      wx.showToast({ title: '删除失败，请稍后重试', icon: 'none' })
    }
  },

  // 切换批量模式
  toggleBatchMode() {
    const newMode = !this.data.batchMode
    this.setData({
      batchMode: newMode,
      selectedVoices: {},
      selectedCount: 0
    })
  },

  // 选择/取消选择音色
  onSelectVoice(e) {
    const voice = e.currentTarget.dataset.voice
    const selectedVoices = { ...this.data.selectedVoices }
    selectedVoices[voice] = !selectedVoices[voice]

    const selectedCount = Object.keys(selectedVoices).filter(key => selectedVoices[key]).length

    this.setData({ selectedVoices, selectedCount })
    console.log('[VoiceManage] 选择音色:', voice, '已选择数:', selectedCount)
  },

  // 全选/取消全选
  toggleSelectAll() {
    const voiceList = this.data.voiceList
    const selectedVoices = {}

    voiceList.forEach(voice => {
      if (!voice.user_info || voice.user_info.type !== 'saved') {
        selectedVoices[voice.voice] = !this.data.selectedCount || this.data.selectedCount < voiceList.filter(v => !v.user_info || v.user_info.type !== 'saved').length
      }
    })

    const selectedCount = Object.keys(selectedVoices).filter(key => selectedVoices[key]).length
    this.setData({ selectedVoices, selectedCount })
  },

  // 批量删除
  onBatchDelete() {
    const selectedCount = this.data.selectedCount
    if (selectedCount === 0) {
      wx.showToast({ title: '请选择要删除的音色', icon: 'none' })
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
    wx.showLoading({ title: '删除中...' })

    const selectedVoices = this.data.selectedVoices
    const voiceList = this.data.voiceList
    const token = app.getToken()

    let successCount = 0
    let failCount = 0

    const voicesToDelete = voiceList
      .filter(voice => selectedVoices[voice.voice] && (!voice.user_info || voice.user_info.type !== 'saved'))
      .map(voice => ({
        voice: voice.voice,
        creatorOpenid: voice.user_info ? voice.user_info.openid : '',
        accountType: voice.account_type || 'main'
      }))

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

    if (failCount === 0) {
      wx.showToast({ title: `成功删除 ${successCount} 个音色`, icon: 'success' })
    } else {
      wx.showModal({
        title: '批量删除完成',
        content: `成功删除 ${successCount} 个音色，失败 ${failCount} 个`,
        showCancel: false
      })
    }

    this.setData({ batchMode: false, selectedVoices: {}, selectedCount: 0 })
    await this.loadVoiceList()
  },

  // 一键清理建议删除的音色
  onSuggestBatchDelete() {
    const count = this.data.suggestDeleteCount
    if (count === 0) return

    wx.showModal({
      title: '确认批量清理',
      content: `确定要删除 ${count} 个建议清理的音色吗？（未保存且超过20天未使用）`,
      confirmText: '全部删除',
      confirmColor: '#ff4d4f',
      success: async (res) => {
        if (res.confirm) {
          await this.executeSuggestBatchDelete()
        }
      }
    })
  },

  // 执行建议列表批量删除
  async executeSuggestBatchDelete() {
    const suggestList = this.data.suggestDeleteList
    const token = app.getToken()

    let successCount = 0
    let failCount = 0

    wx.showLoading({ title: '批量删除中...' })

    for (const item of suggestList) {
      try {
        const res = await app.globalData.cloud.callFunction({
          name: 'managerVoiceManage',
          data: {
            token: token,
            action: 'delete',
            voice_type: this.data.currentType,
            voice: item.voice,
            creator_openid: item.user_info ? item.user_info.openid : '',
            account_type: item.account_type || 'main'
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

    if (failCount === 0) {
      wx.showToast({ title: `成功删除 ${successCount} 个音色`, icon: 'success' })
    } else {
      wx.showModal({
        title: '批量删除完成',
        content: `成功删除 ${successCount} 个音色，失败 ${failCount} 个`,
        showCancel: false
      })
    }

    this.setData({ currentListTab: 'all' })
    await this.loadVoiceList()
  }
})
