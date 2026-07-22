// voice-manage.js
const app = getApp()

// 懒加载每页渲染数量：列表只渲染一个窗口，下滑到底再追加，
// 避免一次性渲染上千张卡片导致视图层卡死、页面无法点击。
const PAGE_SIZE = 30

Page({
  data: {
    voiceList: [], // 当前已渲染的窗口（非全量）
    allVoiceList: [], // 所有音色列表（用于账号过滤）
    hasMore: false, // 是否还有未渲染的音色（控制底部提示与上拉加载）
    loading: false,
    displayCount: 0, // 当前筛选条件下应展示的音色总数（稳定值，不受分批渲染影响）
    totalCount: 0, // 当前类型下所有账号的音色总数（"全部" 账号标签使用）
    savedVoiceCount: 0,
    currentType: '', // 当前音色类型：clone(声音克隆) 或 design(声音设计)，空表示未选择
    currentAccount: 'all', // 当前账号：all(全部), main(主账号), v(V账号), w(W账号)
    currentListTab: 'all', // 当前列表标签：all(全部) 或 suggest(建议清理)
    accountStats: { main: 0, v: 0, w: 0 }, // 各账号音色数量统计
    accountNames: { main: '主账号', v: 'V账号', w: 'W账号' }, // 账号名称映射
    batchMode: false, // 批量操作模式
    selectedVoices: {}, // 已选择的音色: {voice: true/false}
    selectedCount: 0, // 已选择数量
    suggestDeleteList: [], // 建议删除的音色列表
    suggestDeleteCount: 0, // 建议删除数量
    suggestDeleteStats: { main: 0, v: 0, w: 0 }, // 各账号建议删除数量统计
    currentPlayingAudioId: null // 当前正在播放的音频文件 ID
  },

  onLoad() {
    console.log('[VoiceManage] 页面加载完成')
    this.checkIsLoggedIn()
  },

  onShow() {
    this.checkIsLoggedIn()
  },

  // 页面滚动到底部：追加渲染下一页（懒加载）
  onReachBottom() {
    this.loadMore()
  },

  // 离开页面：停止并销毁音频，避免后台继续播放
  onHide() {
    this._destroyAudio()
  },

  onUnload() {
    this._destroyAudio()
  },

  _destroyAudio() {
    if (this.innerAudioContext) {
      try {
        this.innerAudioContext.stop()
        this.innerAudioContext.destroy()
      } catch (e) { /* ignore */ }
      this.innerAudioContext = null
    }
    if (this.data.currentPlayingAudioId) {
      this.setData({ currentPlayingAudioId: null })
    }
  },

  // 播放预览音频并复制临时链接（声音设计建议清理列表用）
  onPlayAudio(e) {
    const audioFileId = e.currentTarget.dataset.audioId
    if (!audioFileId) {
      wx.showToast({ title: '无音频文件', icon: 'none' })
      return
    }

    // 再次点击同一音频：停止
    if (this.data.currentPlayingAudioId === audioFileId) {
      this._destroyAudio()
      wx.showToast({ title: '已停止', icon: 'none' })
      return
    }

    // 切换音频：先停掉前一个
    this._destroyAudio()

    wx.showLoading({ title: '获取音频链接...', mask: true })
    app.globalData.cloud.getTempFileURL({ fileList: [audioFileId] })
      .then(res => {
        wx.hideLoading()
        const f = res.fileList && res.fileList[0]
        if (!f || f.status !== 0 || !f.tempFileURL) {
          wx.showToast({ title: '获取音频链接失败', icon: 'none' })
          return
        }
        const url = f.tempFileURL
        wx.setClipboardData({
          data: url,
          success: () => wx.showToast({ title: '链接已复制', icon: 'success' })
        })

        const ctx = wx.createInnerAudioContext()
        ctx.src = url
        ctx.play()
        ctx.onError(err => {
          console.error('[VoiceManage] 音频播放失败:', err)
          wx.showToast({ title: '播放失败', icon: 'none' })
          this._destroyAudio()
        })
        ctx.onEnded(() => {
          console.log('[VoiceManage] 音频播放结束')
          this._destroyAudio()
        })
        this.innerAudioContext = ctx
        this.setData({ currentPlayingAudioId: audioFileId })
      })
      .catch(err => {
        wx.hideLoading()
        console.error('[VoiceManage] 获取临时链接失败:', err)
        wx.showToast({ title: '获取音频失败', icon: 'none' })
      })
  },

  // 上传音色到 speakers_test（声音设计建议清理列表用）
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
      success: async (modalRes) => {
        if (!modalRes.confirm) return
        wx.showLoading({ title: '上传中...' })
        try {
          const token = app.getToken()
          const cloudRes = await app.globalData.cloud.callFunction({
            name: 'managerVoiceManage',
            data: { token, action: 'upload_speaker', voice_data: voiceData }
          })
          wx.hideLoading()
          if (cloudRes.result.code === 0) {
            wx.showToast({ title: '上传成功', icon: 'success' })
            // 本地标记为已上传：在过滤列表与已渲染窗口里同步更新该 voice
            const vid = voiceData.voice_id
            const markUploaded = (v) => v && v.voice === vid ? { ...v, isUploaded: true } : v
            if (Array.isArray(this._filteredList)) {
              this._filteredList = this._filteredList.map(markUploaded)
            }
            const voiceList = (this.data.voiceList || []).map(markUploaded)
            this.setData({ voiceList })
          } else {
            wx.showToast({ title: cloudRes.result.message || '上传失败', icon: 'none' })
          }
        } catch (err) {
          wx.hideLoading()
          console.error('[VoiceManage] 上传音色失败:', err)
          wx.showToast({ title: '上传失败', icon: 'none' })
        }
      }
    })
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
      displayCount: filteredList.length // 总数立即写入，不受懒加载窗口影响
    })

    this.renderFilteredList(filteredList)
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

  // 解析时间为毫秒时间戳（兼容 iOS 的 "YYYY-MM-DD HH:mm:ss" 字符串），无法解析返回 NaN
  _parseVoiceTime(value) {
    if (!value && value !== 0) return NaN
    if (typeof value === 'number') return value
    return Date.parse(String(value).replace(' ', 'T'))
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
        const totalCount = (accountStats.main || 0) + (accountStats.v || 0) + (accountStats.w || 0)

        this.setData({
          allVoiceList: allVoiceList,
          savedVoiceCount: savedVoiceCount,
          displayCount: filteredList.length,
          totalCount: totalCount,
          accountStats: accountStats,
          loading: false,
          suggestDeleteList: suggestData.list,
          suggestDeleteCount: suggestData.count,
          suggestDeleteStats: suggestData.stats
        })

        this.renderFilteredList(filteredList)

        // 若部分账号数据拉取不完整，明确提示用户数量可能偏少，可下拉/点击刷新重试
        if (res.result.data.incomplete) {
          const accs = (res.result.data.incomplete_accounts || [])
            .map(a => this.data.accountNames[a] || a)
            .join('、')
          wx.showModal({
            title: '数量可能不完整',
            content: `${accs} 的音色未全部获取成功（可能被限流或网络超时），当前数量可能偏少。请点击「刷新」重试。`,
            showCancel: false,
            confirmText: '知道了'
          })
        }
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

  // 纯函数：计算建议删除的音色列表（未保存 且 最近 30 天未使用，含从未使用过）
  _computeSuggestDelete(allVoiceList) {
    const now = Date.now()
    const DAY_MS = 24 * 60 * 60 * 1000
    const THRESHOLD_DAYS = 30

    let savedCount = 0
    let systemCount = 0    // 系统/预置音色：排除
    let recentCount = 0    // 最近30天内有活动（使用过或新建），排除
    let oldUnusedCount = 0 // 超过30天未使用且创建已超过30天，建议删除
    let unknownCount = 0   // 既无使用时间也无创建时间，无法判断，保守排除

    const suggestList = allVoiceList.filter((voice) => {
      // 已保存的音色：排除
      if (voice.user_info && voice.user_info.type === 'saved') {
        savedCount++
        return false
      }

      // 系统/预置音色（speakers_test 中）：永远不应建议清理
      if (voice.user_info && voice.user_info.type === 'system') {
        systemCount++
        return false
      }

      // 参考时间：优先用最近使用时间；从未使用过则退回创建时间(gmt_create)，
      // 避免把刚创建、尚未使用（也未关联到用户/使用记录）的新音色误判为建议清理。
      const lastUsedTime = this._parseVoiceTime(voice.last_used_time)
      const createTime = this._parseVoiceTime(voice.gmt_create)
      const refTime = !isNaN(lastUsedTime) ? lastUsedTime : createTime

      // 完全无法判断时间：保守起见不建议删除
      if (isNaN(refTime)) {
        unknownCount++
        return false
      }

      const daysDiff = (now - refTime) / DAY_MS
      if (daysDiff > THRESHOLD_DAYS) {
        oldUnusedCount++
        return true
      }
      recentCount++
      return false
    })

    console.log('[VoiceManage] ===== 建议删除统计 =====')
    console.log('[VoiceManage] 已保存(排除):', savedCount)
    console.log('[VoiceManage] 系统/预置(排除):', systemCount)
    console.log('[VoiceManage] 超过30天未使用/未活动(建议删除):', oldUnusedCount)
    console.log('[VoiceManage] 30天内有活动(排除):', recentCount)
    console.log('[VoiceManage] 无法判断时间(排除):', unknownCount)
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

  // 懒加载：完整过滤结果存在 this._filteredList（不进 data，避免大数组反复传给视图层），
  // data.voiceList 只保留已渲染的窗口。首屏只渲染第一页，其余下滑到底再追加。
  renderFilteredList(filteredList) {
    this._filteredList = filteredList || []
    const firstPage = this._filteredList.slice(0, PAGE_SIZE)
    this.setData({
      voiceList: firstPage,
      hasMore: this._filteredList.length > firstPage.length
    })
    // 切换账号/标签后回到顶部，避免停留在上一个列表的滚动位置
    wx.pageScrollTo({ scrollTop: 0, duration: 0 })
  },

  // 追加渲染下一页
  loadMore() {
    if (!this.data.hasMore) return
    const filteredList = this._filteredList || []
    const current = this.data.voiceList.length
    const next = filteredList.slice(current, current + PAGE_SIZE)
    if (next.length === 0) {
      this.setData({ hasMore: false })
      return
    }
    this.setData({
      voiceList: this.data.voiceList.concat(next),
      hasMore: current + next.length < filteredList.length
    })
  },

  // 切换音色类型
  switchType(e) {
    const type = e.currentTarget.dataset.type
    if (type === this.data.currentType) return

    this._filteredList = []
    this.setData({
      currentType: type,
      voiceList: [],
      allVoiceList: [],
      hasMore: false,
      savedVoiceCount: 0,
      displayCount: 0,
      totalCount: 0,
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
    if (!this.data.currentType) return
    this._filteredList = []
    this.setData({
      voiceList: [],
      allVoiceList: [],
      hasMore: false,
      savedVoiceCount: 0,
      displayCount: 0,
      totalCount: 0,
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

  // 全选/取消全选（针对当前筛选下的全部可删除音色，而非仅已渲染窗口）
  toggleSelectAll() {
    const list = this._filteredList || this.data.voiceList
    const selectable = list.filter(v => !v.user_info || v.user_info.type !== 'saved')
    const shouldSelectAll = this.data.selectedCount < selectable.length

    const selectedVoices = {}
    if (shouldSelectAll) {
      selectable.forEach(v => { selectedVoices[v.voice] = true })
    }

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
    const sourceList = this._filteredList || this.data.voiceList
    const token = app.getToken()

    let successCount = 0
    let failCount = 0

    const voicesToDelete = sourceList
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
      content: `确定要删除 ${count} 个建议清理的音色吗？（未保存且最近30天未使用）`,
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
