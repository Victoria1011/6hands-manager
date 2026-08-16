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
  // 当前 tab=「建议清理」时，直接用云端预计算的 suggest_delete_list（已按账号过滤）
  // 当前 tab=「全部」时：
  //   - currentAccount='all' → 合并三个账号已加载列表
  //   - currentAccount=具体账号 → 仅该账号已加载列表
  applyFilterAndRender() {
    const { currentAccount, currentListTab } = this.data
    const suggestDeleteList = this._cachedSuggestDeleteList || []
    const suggestDeleteStats = this._cachedSuggestDeleteStats || { main: 0, v: 0, w: 0 }
    const suggestDeleteCount = this._cachedSuggestDeleteCount || 0
    const accountStats = this._cachedAccountStats || { main: 0, v: 0, w: 0 }

    if (currentListTab === 'suggest') {
      const filteredList = currentAccount === 'all'
        ? suggestDeleteList
        : suggestDeleteList.filter(v => v.account_type === currentAccount)

      this.setData({
        savedVoiceCount: 0, // 建议清理列表中不含已保存音色
        displayCount: filteredList.length,
        // suggestDeleteCount / suggestDeleteStats 在切账号时需展示对应账号的数量
        suggestDeleteCount: currentAccount === 'all'
          ? suggestDeleteCount
          : (suggestDeleteStats[currentAccount] || 0),
        suggestDeleteStats
      })
      this.renderFilteredList(filteredList)
      return
    }

    // tab='all'
    let filteredList = []
    if (currentAccount === 'all') {
      // 合并三个账号已加载列表，按 gmt_create 升序排序（与云端排序一致）
      filteredList = []
        .concat(this._accountLoaded.main || [], this._accountLoaded.v || [], this._accountLoaded.w || [])
        .sort((a, b) => {
          const ta = a.gmt_create ? new Date(String(a.gmt_create).replace(' ', 'T')).getTime() || 0 : 0
          const tb = b.gmt_create ? new Date(String(b.gmt_create).replace(' ', 'T')).getTime() || 0 : 0
          return ta - tb
        })
    } else {
      filteredList = (this._accountLoaded[currentAccount] || []).slice()
    }

    // 已保存音色数量：使用云端全量统计，避免分页加载导致本地统计偏少
    // （savedVoiceCount 由 loadVoiceList 在首页时一次性写入；切账号/标签时不重算）
    // 这里不再覆盖，保留 loadVoiceList 中设置的值

    this.setData({
      displayCount: this._computeDisplayCount(currentAccount, accountStats, suggestDeleteStats)
    })
    this.renderFilteredList(filteredList)
  },

  // 计算当前条件下应展示的音色总数（不受已加载页数影响，使用云端统计）
  _computeDisplayCount(currentAccount, accountStats, suggestDeleteStats) {
    if (this.data.currentListTab === 'suggest') {
      // 建议清理 tab 下，displayCount 已在 applyFilterAndRender 中按账号设置
      return this.data.displayCount
    }
    // 全部 tab：用云端账号统计
    if (currentAccount === 'all') {
      return (accountStats.main || 0) + (accountStats.v || 0) + (accountStats.w || 0)
    }
    return accountStats[currentAccount] || 0
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

  // 加载音色列表（云端分页协议）
  //
  // 为规避云函数单次返回 1MB 限制（errCode -501000）：
  //   - 「全部」标签下：按账号分页拉取（每个账号维护独立游标），UI 合并展示
  //   - 「建议清理」标签下：直接使用云端预计算的 suggest_delete_list（一次性返回，体积可控）
  //   - 统计信息 / 建议清理列表只在「首次拉取」时返回，避免每页重复传输
  async loadVoiceList() {
    if (this.data.loading) return
    this.setData({ loading: true })

    try {
      const token = app.getToken()
      const voiceType = this.data.currentType
      console.log('[VoiceManage] 开始获取音色列表，类型:', voiceType)

      // 重置分页游标（首次拉取）
      this._accountPageCursor = { main: 0, v: 0, w: 0 }
      this._accountHasMore = { main: true, v: true, w: true }
      this._accountLoaded = { main: [], v: [], w: [] }
      this._statsLoaded = false

      // 拉取首页：按账号分别拉第一页（避免合并分页与后续按账号分页不一致），
      // 同时只在第一个账号的请求中带 include_suggest=true 以获取统计与建议清理。
      // design 类型每条记录附带 creation_log（含 voice_prompt/preview_text 等大字段），
      // 用更小的页大小确保单次响应不超 1MB。
      const FIRST_PAGE_SIZE = voiceType === 'design' ? 80 : 200
      const ACCOUNTS = ['main', 'v', 'w']
      const responses = await Promise.all(
        ACCOUNTS.map((acc, idx) => {
          return this._callListFunction({
            token,
            voice_type: voiceType,
            page_index: 0,
            page_size: FIRST_PAGE_SIZE,
            account_type: acc,
            include_suggest: idx === 0 // 仅 main 账号请求中带统计/建议清理
          }).catch(err => {
            console.error(`[VoiceManage] 账号 ${acc} 首页拉取失败:`, err)
            return { _error: err, _account: acc }
          })
        })
      )

      // 解析每个账号的首页结果
      const accountStats = { main: 0, v: 0, w: 0 }
      const failedAccounts = []
      let suggestDeleteList = []
      let suggestDeleteCount = 0
      let suggestDeleteStats = { main: 0, v: 0, w: 0 }
      let savedVoiceCount = 0
      let incompleteAccounts = []
      let suggestTruncated = false

      ACCOUNTS.forEach((acc, idx) => {
        const res = responses[idx]
        if (res && res._error) {
          failedAccounts.push(acc)
          // 失败的账号视为无更多数据
          this._accountHasMore[acc] = false
          return
        }
        const result = res && res.result
        if (!result || result.code !== 0) {
          console.error(`[VoiceManage] 账号 ${acc} 返回异常:`, result)
          failedAccounts.push(acc)
          this._accountHasMore[acc] = false
          return
        }
        const data = result.data || {}
        const list = (data.voice_list || []).map(v => ({
          ...v,
          last_used_time: v.last_used_time ? this.formatTime(v.last_used_time) : null
        }))
        this._accountLoaded[acc] = list
        this._accountPageCursor[acc] = 1 // 已拉取第 0 页
        this._accountHasMore[acc] = !!data.has_more
        accountStats[acc] = (data.account_stats && data.account_stats[acc]) != null
          ? data.account_stats[acc]
          : list.length

        // 仅 main 账号响应中包含统计/建议清理
        if (idx === 0) {
          suggestDeleteList = (data.suggest_delete_list || []).map(v => ({
            ...v,
            last_used_time: v.last_used_time ? this.formatTime(v.last_used_time) : null
          }))
          suggestDeleteCount = data.suggest_delete_count != null ? data.suggest_delete_count : suggestDeleteList.length
          suggestDeleteStats = data.suggest_delete_stats || { main: 0, v: 0, w: 0 }
          savedVoiceCount = data.saved_voice_count || 0
          incompleteAccounts = data.incomplete_accounts || []
          suggestTruncated = !!data.suggest_delete_truncated
        }
      })

      const totalCount = (accountStats.main || 0) + (accountStats.v || 0) + (accountStats.w || 0)
      this._hasMoreAll = this._accountHasMore.main || this._accountHasMore.v || this._accountHasMore.w
      this._statsLoaded = true
      this._cachedAccountStats = accountStats
      this._cachedSuggestDeleteList = suggestDeleteList
      this._cachedSuggestDeleteCount = suggestDeleteCount
      this._cachedSuggestDeleteStats = suggestDeleteStats

      this.setData({
        accountStats,
        totalCount,
        savedVoiceCount,
        suggestDeleteList,
        suggestDeleteCount,
        suggestDeleteStats,
        loading: false
      })

      this.applyFilterAndRender()

      // 失败账号提示
      if (failedAccounts.length > 0) {
        const accs = failedAccounts.map(a => this.data.accountNames[a] || a).join('、')
        wx.showModal({
          title: '部分账号拉取失败',
          content: `${accs} 的音色拉取失败（可能数据量过大或网络超时），当前数量可能偏少。请点击「刷新」重试。`,
          showCancel: false,
          confirmText: '知道了'
        })
      } else if (incompleteAccounts.length > 0) {
        const accs = incompleteAccounts
          .map(a => this.data.accountNames[a] || a)
          .join('、')
        wx.showModal({
          title: '数量可能不完整',
          content: `${accs} 的音色未全部获取成功（可能被限流或网络超时），当前数量可能偏少。请点击「刷新」重试。`,
          showCancel: false,
          confirmText: '知道了'
        })
      } else if (suggestTruncated) {
        // 建议清理列表被截断：提示用户
        wx.showModal({
          title: '建议清理列表已截断',
          content: `建议清理的音色数量过多（共 ${suggestDeleteCount} 个），列表仅显示前 ${suggestDeleteList.length} 个。可先清理当前列表后再刷新查看剩余。`,
          showCancel: false,
          confirmText: '知道了'
        })
      }
    } catch (err) {
      console.error('[VoiceManage] 查询失败:', err)
      const errMsg = String((err && err.errMsg) || err || '')
      if (errMsg.indexOf('-501000') !== -1 || errMsg.indexOf('exceeded') !== -1) {
        wx.showModal({
          title: '数据量过大',
          content: '音色数量过多，单次返回超过限制。请点击「刷新」重试，系统会按账号分页拉取。',
          showCancel: false,
          confirmText: '知道了'
        })
      } else {
        wx.showToast({ title: '查询失败，请稍后重试', icon: 'none' })
      }
      this.setData({ loading: false })
    }
  },

  // 调用云函数 list action 的统一封装
  _callListFunction(params) {
    return app.globalData.cloud.callFunction({
      name: 'managerVoiceManage',
      data: Object.assign({
        token: app.getToken(),
        action: 'list'
      }, params)
    }).catch(err => {
      console.error('[VoiceManage] list 调用失败:', err)
      throw err
    })
  },

  // 建议删除的音色列表现由云端预计算返回（见 loadVoiceList 中的 suggest_delete_list），
  // 不再在前端本地计算，避免需要拉取全量数据导致单次响应超过 1MB 限制。

  // 懒加载：完整过滤结果存在 this._filteredList（不进 data，避免大数组反复传给视图层），
  // data.voiceList 只保留已渲染的窗口。首屏只渲染第一页，其余下滑到底再追加。
  renderFilteredList(filteredList) {
    this._filteredList = filteredList || []
    const firstPage = this._filteredList.slice(0, PAGE_SIZE)
    const hasMoreLocal = this._filteredList.length > firstPage.length
    this.setData({
      voiceList: firstPage,
      // hasMore 含义：本地还有未渲染的 OR 云端还有未拉取的下一页
      hasMore: hasMoreLocal || this._hasMoreRemote()
    })
    // 切换账号/标签后回到顶部，避免停留在上一个列表的滚动位置
    wx.pageScrollTo({ scrollTop: 0, duration: 0 })
  },

  // 当前条件下云端是否还有未拉取的下一页
  _hasMoreRemote() {
    if (this.data.currentListTab === 'suggest') return false // 建议清理一次性返回
    const acc = this.data.currentAccount
    if (acc === 'all') return !!this._hasMoreAll
    return !!(this._accountHasMore && this._accountHasMore[acc])
  },

  // 追加渲染下一页：先消耗本地已加载但未渲染的数据；
  // 本地用尽且云端还有更多时，触发云端分页拉取
  async loadMore() {
    if (this.data.loading) return

    const filteredList = this._filteredList || []
    const current = this.data.voiceList.length

    // 本地还有未渲染的：直接追加
    if (filteredList.length > current) {
      const next = filteredList.slice(current, current + PAGE_SIZE)
      const hasMoreLocal = current + next.length < filteredList.length
      this.setData({
        voiceList: this.data.voiceList.concat(next),
        hasMore: hasMoreLocal || this._hasMoreRemote()
      })
      return
    }

    // 本地已渲染完毕，但云端还有更多：触发云端拉取下一页
    if (this._hasMoreRemote()) {
      await this._loadNextPageFromCloud()
    } else {
      this.setData({ hasMore: false })
    }
  },

  // 从云端拉取当前账号的下一页
  async _loadNextPageFromCloud() {
    if (this.data.loading) return
    this.setData({ loading: true })

    try {
      const acc = this.data.currentAccount
      const voiceType = this.data.currentType
      const token = app.getToken()
      const PAGE_SIZE = voiceType === 'design' ? 80 : 200

      if (acc === 'all') {
        // 「全部」账号：并发为所有还有更多的账号拉取下一页
        const accounts = ['main', 'v', 'w'].filter(a => this._accountHasMore[a])
        if (accounts.length === 0) {
          this._hasMoreAll = false
          this.setData({ loading: false, hasMore: false })
          return
        }
        const responses = await Promise.all(
          accounts.map(a => {
            const pageIndex = this._accountPageCursor[a]
            return this._callListFunction({
              token,
              voice_type: voiceType,
              page_index: pageIndex,
              page_size: PAGE_SIZE,
              account_type: a,
              include_suggest: false
            }).catch(err => {
              console.error(`[VoiceManage] 账号 ${a} 第 ${pageIndex + 1} 页拉取失败:`, err)
              return { _error: err, _account: a }
            })
          })
        )
        responses.forEach((res, i) => {
          const a = accounts[i]
          if (res && res._error) {
            this._accountHasMore[a] = false
            return
          }
          const result = res && res.result
          if (!result || result.code !== 0) {
            this._accountHasMore[a] = false
            return
          }
          const list = (result.data && result.data.voice_list) || []
          const mapped = list.map(v => ({
            ...v,
            last_used_time: v.last_used_time ? this.formatTime(v.last_used_time) : null
          }))
          this._accountLoaded[a] = (this._accountLoaded[a] || []).concat(mapped)
          this._accountPageCursor[a] = (this._accountPageCursor[a] || 0) + 1
          this._accountHasMore[a] = !!(result.data && result.data.has_more)
        })
        this._hasMoreAll = this._accountHasMore.main || this._accountHasMore.v || this._accountHasMore.w
      } else {
        // 具体账号分页
        const pageIndex = this._accountPageCursor[acc] || 0
        const res = await this._callListFunction({
          token,
          voice_type: voiceType,
          page_index: pageIndex,
          page_size: PAGE_SIZE,
          account_type: acc,
          include_suggest: false
        })
        if (res && res.result && res.result.code === 0) {
          const list = (res.result.data && res.result.data.voice_list) || []
          const mapped = list.map(v => ({
            ...v,
            last_used_time: v.last_used_time ? this.formatTime(v.last_used_time) : null
          }))
          this._accountLoaded[acc] = (this._accountLoaded[acc] || []).concat(mapped)
          this._accountPageCursor[acc] = pageIndex + 1
          this._accountHasMore[acc] = !!(res.result.data && res.result.data.has_more)
        } else {
          this._accountHasMore[acc] = false
        }
      }

      this.setData({ loading: false })
      // 重新应用过滤并渲染（已包含追加的数据）
      this.applyFilterAndRender()
    } catch (err) {
      console.error('[VoiceManage] 加载下一页失败:', err)
      this.setData({ loading: false })
      const errMsg = String((err && err.errMsg) || err || '')
      if (errMsg.indexOf('-501000') !== -1 || errMsg.indexOf('exceeded') !== -1) {
        wx.showToast({ title: '数据量过大，请缩小单次范围', icon: 'none' })
      } else {
        wx.showToast({ title: '加载失败', icon: 'none' })
      }
    }
  },

  // 切换音色类型
  switchType(e) {
    const type = e.currentTarget.dataset.type
    if (type === this.data.currentType) return

    this._filteredList = []
    this._resetPagingState()
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
    this._resetPagingState()
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

  // 重置分页相关内部状态
  _resetPagingState() {
    this._accountPageCursor = { main: 0, v: 0, w: 0 }
    this._accountHasMore = { main: true, v: true, w: true }
    this._accountLoaded = { main: [], v: [], w: [] }
    this._hasMoreAll = false
    this._statsLoaded = false
    this._cachedAccountStats = { main: 0, v: 0, w: 0 }
    this._cachedSuggestDeleteList = []
    this._cachedSuggestDeleteCount = 0
    this._cachedSuggestDeleteStats = { main: 0, v: 0, w: 0 }
  },

  // 删除成功后本地移除已删除项 + 同步统计，避免重新拉取列表（提升体验）
  // @param {Array<string>} deletedVoices - 已成功删除的 voice id 列表
  // @param {Array<Object>} deletedItems - 已删除项的完整对象（用于获取 account_type 等）
  _removeDeletedVoicesLocally(deletedVoices, deletedItems) {
    if (!deletedVoices || deletedVoices.length === 0) return
    const deletedSet = new Set(deletedVoices)

    // 1. 从各账号已加载列表中移除
    const ACCOUNTS = ['main', 'v', 'w']
    const removedByAccount = { main: 0, v: 0, w: 0 }
    ACCOUNTS.forEach(acc => {
      const before = (this._accountLoaded[acc] || []).length
      this._accountLoaded[acc] = (this._accountLoaded[acc] || []).filter(v => !deletedSet.has(v.voice))
      removedByAccount[acc] = before - this._accountLoaded[acc].length
    })

    // 2. 从建议清理缓存中移除
    this._cachedSuggestDeleteList = (this._cachedSuggestDeleteList || []).filter(v => !deletedSet.has(v.voice))

    // 3. 更新账号统计（accountStats）- 各账号减少对应数量
    const accountStats = Object.assign({}, this._cachedAccountStats || { main: 0, v: 0, w: 0 })
    ACCOUNTS.forEach(acc => {
      accountStats[acc] = Math.max(0, (accountStats[acc] || 0) - removedByAccount[acc])
    })
    this._cachedAccountStats = accountStats

    // 4. 更新建议清理统计（按账号重新统计，更准确）
    const suggestDeleteStats = Object.assign({}, this._cachedSuggestDeleteStats || { main: 0, v: 0, w: 0 })
    ACCOUNTS.forEach(acc => {
      suggestDeleteStats[acc] = (this._cachedSuggestDeleteList || []).filter(v => v.account_type === acc).length
    })
    this._cachedSuggestDeleteStats = suggestDeleteStats
    this._cachedSuggestDeleteCount = this._cachedSuggestDeleteList.length

    // 5. 计算新的 totalCount 与 savedVoiceCount
    const totalCount = (accountStats.main || 0) + (accountStats.v || 0) + (accountStats.w || 0)
    // savedVoiceCount：从已加载列表中重算（已加载列表中 type=saved 的数量）
    // 注意：分页场景下本地 savedVoiceCount 可能比云端全量少，但删除后只需递减（如果删的是 saved）
    // 这里简单处理：保留原值，仅当删除的项是 saved 时递减
    let savedVoiceCount = this.data.savedVoiceCount || 0
    ;(deletedItems || []).forEach(item => {
      if (item.user_info && item.user_info.type === 'saved') {
        savedVoiceCount = Math.max(0, savedVoiceCount - 1)
      }
    })

    // 6. 同步 data（WXML 中 accountStats / suggestDeleteStats / suggestDeleteCount / totalCount 等）
    this.setData({
      accountStats,
      suggestDeleteStats,
      suggestDeleteCount: this._cachedSuggestDeleteCount,
      suggestDeleteList: this._cachedSuggestDeleteList,
      totalCount,
      savedVoiceCount
    })

    // 7. 重新应用过滤并渲染（自动从更新后的 _accountLoaded / _cachedSuggestDeleteList 切片）
    this.applyFilterAndRender()

    console.log('[VoiceManage] 本地移除已删除项:', deletedVoices.length, '个，账号统计:', accountStats, '建议清理统计:', suggestDeleteStats)
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
        // 本地移除已删除项，避免重新拉取列表（提升体验）
        this._removeDeletedVoicesLocally([voice], [{ voice, account_type: accountType }])
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
    const deletedVoices = [] // 已成功删除的 voice id
    const deletedItems = [] // 已成功删除的完整项（含 account_type / user_info）

    const voicesToDelete = sourceList
      .filter(voice => selectedVoices[voice.voice] && (!voice.user_info || voice.user_info.type !== 'saved'))
      .map(voice => ({
        voice: voice.voice,
        creatorOpenid: voice.user_info ? voice.user_info.openid : '',
        accountType: voice.account_type || 'main',
        // 保留完整对象用于本地移除时获取 account_type / user_info
        _raw: voice
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
          deletedVoices.push(item.voice)
          deletedItems.push(item._raw)
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
    // 本地移除已成功删除的项，避免重新拉取列表
    if (deletedVoices.length > 0) {
      this._removeDeletedVoicesLocally(deletedVoices, deletedItems)
    }
  },

  // 一键清理建议删除的音色
  onSuggestBatchDelete() {
    // 按当前账号过滤后的建议清理数量
    const acc = this.data.currentAccount
    const count = acc === 'all'
      ? this.data.suggestDeleteCount
      : (this.data.suggestDeleteStats[acc] || 0)
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
  // 根据当前账号过滤：currentAccount='all' 删全部，否则只删该账号的建议清理音色
  async executeSuggestBatchDelete() {
    const allSuggestList = this.data.suggestDeleteList
    const acc = this.data.currentAccount
    const suggestList = acc === 'all'
      ? allSuggestList
      : allSuggestList.filter(v => v.account_type === acc)
    const token = app.getToken()

    let successCount = 0
    let failCount = 0
    const deletedVoices = []
    const deletedItems = []

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
          deletedVoices.push(item.voice)
          deletedItems.push(item)
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

    // 切回「全部」标签，并本地移除已成功删除的项
    this.setData({ currentListTab: 'all' })
    if (deletedVoices.length > 0) {
      this._removeDeletedVoicesLocally(deletedVoices, deletedItems)
    } else {
      // 没有成功删除的项时，仍需重新应用过滤以反映 currentListTab 变化
      this.applyFilterAndRender()
    }
  }
})
