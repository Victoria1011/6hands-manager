// database-manage.js
const app = getApp()

Page({
    data: {
    collections: [],
    currentCollection: '',
    dataList: [],
    flatLogsList: [], // tts_clone_design_logs 扁平化的日志列表
    allFlatLogsList: [], // logs 完整原始列表（用于类型筛选）
    flatCoinsList: [], // coin_transactions 扁平化的交易列表
    allFlatCoinsList: [], // coins 完整原始列表（用于类型筛选）
    // coins 类型筛选
    coinFilterType: 'all', // all, checkin, video_ad, recharge, spend
    coinFilterTabs: [
      { key: 'all', label: '全部' },
      { key: 'checkin', label: '签到' },
      { key: 'video_ad', label: '看广告' },
      { key: 'recharge', label: '充值' },
      { key: 'spend', label: '消费' }
    ],
    loading: false,
    requesting: false, // 正在请求数据的标志
    pageIndex: 0,
    pageSize: 100,
    total: 0,
    hasMore: true,
    selectedItem: null,
    showEditModal: false,
    editData: {},
    searchField: '',
    searchValue: '',
    expandedItems: {}, // 记录展开的数据项 { _id: true }
    currentPlayingAudioId: null, // 当前正在播放的音频ID
    // tts_clone_design_logs 统计相关
    timeFilterType: 'today', // today, yesterday, last7days, last30days, custom
    customStartDate: '',
    customEndDate: '',
    // logs 类型筛选
    logFilterType: 'all', // all, clone, design, synthesize_mimo, synthesize
    logFilterTabs: [
      { key: 'all', label: '全部' },
      { key: 'clone', label: '克隆' },
      { key: 'design', label: '设计' },
      { key: 'synthesize_mimo', label: 'Mimo合成' },
      { key: 'synthesize', label: 'Qwen合成' }
    ],
    stats: {
      cloneCount: 0,
      designCount: 0,
      mimoChars: 0,
      qwenChars: 0,
      newUsersCount: 0,
      signCount: 0,
      adCount: 0,
      orderCount: 0
    },
    statsPeriodText: '',
    // api_key_usage 编辑相关
    showApiKeyEditModal: false,
    apiKeyEditIndex: -1,
    apiKeyEditUsage: '', // clone_usage 或 design_usage
    apiKeyEditField: '', // key_num, key_v_num, key_w_num
    apiKeyEditLabel: '',
    apiKeyEditValue: 0
  },

  onLoad() {
    console.log('[DatabaseManage] 页面加载完成')
    // 检查登录状态
    if (!this.checkIsLoggedIn()) return
    this.loadCollections()
  },

  onUnload() {
    // 页面卸载时停止播放并清理音频播放器
    this.stopAudio()
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

  // 加载集合列表
  async loadCollections() {
    this.setData({ loading: true })

    try {
      const token = app.getToken()
      wx.showLoading({
        title: '加载中...',
      })
      const res = await app.globalData.cloud.callFunction({
        name: 'managerDatabase',
        data: {
          token: token,
          action: 'collections'
        }
      })

      console.log('[DatabaseManage] 集合列表:', res.result)
      wx.hideLoading()
      if (res.result.code === 0) {
        this.setData({
          collections: res.result.data.collections
        })
      } else {
        wx.showToast({
          title: res.result.message || '加载失败',
          icon: 'none'
        })
      }
    } catch (err) {
      console.error('[DatabaseManage] 加载集合失败:', err)
      wx.showToast({
        title: '加载失败，请稍后重试',
        icon: 'none'
      })
    } finally {
      this.setData({ loading: false })
    }
  },

  // 选择集合
  onCollectionSelect(e) {
    const index = e.detail.value
    const collection = this.data.collections[index]
    console.log('[DatabaseManage] 选择集合:', collection, '索引:', index)

    this.setData({
      currentCollection: collection,
      dataList: [],
      flatLogsList: [],
      allFlatLogsList: [],
      flatCoinsList: [],
      allFlatCoinsList: [],
      pageIndex: 0,
      total: 0,
      hasMore: false,
      loading: true, // 立即显示 loading
      requesting: false, // 重置请求状态
      // 重置统计
      timeFilterType: 'today',
      customStartDate: '',
      customEndDate: '',
      logFilterType: 'all', // 重置 logs 筛选
      coinFilterType: 'all', // 重置 coins 筛选
      stats: {
        cloneCount: 0,
        designCount: 0,
        mimoChars: 0,
        qwenChars: 0,
        newUsersCount: 0,
        signCount: 0,
        adCount: 0,
        orderCount: 0
      }
    }, () => {
      // setData 完成后加载数据
      console.log('[DatabaseManage] onQuickSelect callback, collection:', collection, 'requesting:', this.data.requesting)
      this.loadData(collection)
    })
  },

  // 快捷选择集合
  onQuickSelect(e) {
    const collection = e.currentTarget.dataset.collection
    console.log('[DatabaseManage] 快捷选择集合:', collection)

    this.setData({
      currentCollection: collection,
      dataList: [],
      flatLogsList: [],
      allFlatLogsList: [],
      flatCoinsList: [],
      allFlatCoinsList: [],
      pageIndex: 0,
      total: 0,
      hasMore: false,
      loading: true, // 立即显示 loading
      requesting: false, // 重置请求状态
      // 重置统计
      timeFilterType: 'today',
      customStartDate: '',
      customEndDate: '',
      logFilterType: 'all', // 重置 logs 筛选
      coinFilterType: 'all', // 重置 coins 筛选
      stats: {
        cloneCount: 0,
        designCount: 0,
        mimoChars: 0,
        qwenChars: 0,
        newUsersCount: 0,
        signCount: 0,
        adCount: 0,
        orderCount: 0
      }
    }, () => {
      // setData 完成后加载数据
      console.log('[DatabaseManage] onQuickSelect callback, collection:', collection, 'requesting:', this.data.requesting)
      this.loadData(collection)
    })
  },

  // 加载数据
  async loadData(collection) {
    // 如果没有传入 collection 参数，使用当前选中的集合
    const targetCollection = collection || this.data.currentCollection
    console.log('[DatabaseManage] loadData 开始, targetCollection:', targetCollection, 'requesting:', this.data.requesting)
    if (this.data.requesting || !targetCollection) {
      console.log('[DatabaseManage] loadData 被阻止')
      return
    }

    // 设置请求中状态
    this.setData({ requesting: true })

    try {
      const token = app.getToken()

      // 构建查询条件
      let where = {}
      if (this.data.searchField && this.data.searchValue) {
        // 尝试数字类型
        const numValue = Number(this.data.searchValue)
        if (!isNaN(numValue)) {
          where = {
            [this.data.searchField]: numValue
          }
        } else {
          // 字符串类型
          where = {
            [this.data.searchField]: this.data.searchValue
          }
        }
      }

      // 构建时间范围参数（用于有大数据量集合的时间筛选）
      const timeRange = this.getTimeRangeForCloud()
      console.log('[DatabaseManage] 调用云函数, timeRange:', timeRange)

      wx.showLoading({
        title: '加载中...',
      })
      const res = await app.globalData.cloud.callFunction({
        name: 'managerDatabase',
        data: {
          token: token,
          action: 'query',
          collection: targetCollection,
          where: where,
          pageIndex: this.data.pageIndex,
          pageSize: this.data.pageSize,
          orderBy: this.getOrderByField(),
          timeRange: timeRange
        }
      })
      console.log('[DatabaseManage] 数据查询结果:', res.result)
      wx.showLoading({
        title: '过滤中...',
      })

      if (res.result.code === 0) {
        // 获取时间范围用于过滤数组字段
        const range = this.getTimeRange()
        
        // 过滤数组字段中符合时间条件的数据
        let rawList = res.result.data.list
        if (timeRange && targetCollection === 'tts_clone_design_logs') {
          // 过滤 logs 数组
          rawList = rawList.map(item => ({
            ...item,
            logs: (item.logs || []).filter(log => {
              if (!log.created_at) return false
              const logTime = typeof log.created_at === 'number' ? log.created_at : new Date(log.created_at).getTime()
              return logTime >= range.startTime && logTime <= range.endTime
            })
          })).filter(item => item.logs && item.logs.length > 0)
        } else if (timeRange && targetCollection === 'coin_transactions') {
          // 过滤 transactions 数组
          rawList = rawList.map(item => ({
            ...item,
            transactions: (item.transactions || []).filter(trans => {
              if (!trans.created_at) return false
              const transTime = typeof trans.created_at === 'number' ? trans.created_at : new Date(trans.created_at).getTime()
              return transTime >= range.startTime && transTime <= range.endTime
            })
          })).filter(item => item.transactions && item.transactions.length > 0)
        } else if (timeRange && targetCollection === 'users') {
          // 过滤 users（按 created_at）
          rawList = rawList.filter(item => {
            if (!item.created_at) return false
            const createdTime = typeof item.created_at === 'number' ? item.created_at : new Date(item.created_at).getTime()
            return createdTime >= range.startTime && createdTime <= range.endTime
          })
        }

        // 格式化数据（使用 targetCollection），获取扁平化日志列表和扁平化金币列表
        const { formattedList, flatLogs, flatCoins } = this.formatDataList(rawList, targetCollection)

        // 合并 dataList
        const newList = this.data.pageIndex === 0
          ? formattedList
          : [...this.data.dataList, ...formattedList]

        // 合并 flatLogsList（用于 logs 扁平化展示）
        const newFlatLogs = this.data.pageIndex === 0
          ? flatLogs
          : [...this.data.flatLogsList, ...flatLogs]

        // 合并 flatCoinsList（用于 coins 扁平化展示）
        const newFlatCoins = this.data.pageIndex === 0
          ? flatCoins
          : [...this.data.flatCoinsList, ...flatCoins]

        // 大数据量集合使用分页，但初始 pageSize 较小避免超限
        const largeCollections = ['tts_clone_design_logs', 'users', 'coin_transactions', 'upload_file_logs']
        // 所有集合都走正常分页逻辑，hasMore 由云函数返回决定
        const hasMore = res.result.data.hasMore

        // 第一次加载时设置 total，后续加载保持不变
        const total = this.data.pageIndex === 0 
          ? (res.result.data.limited ? 0 : res.result.data.total)
          : this.data.total

        // 应用 logs 类型筛选
        const filteredFlatLogs = this.filterLogsByType(newFlatLogs)

        // 应用 coins 类型筛选
        const filteredFlatCoins = this.filterCoinsByType(newFlatCoins)

        this.setData({
          dataList: newList,
          allFlatLogsList: newFlatLogs, // 保存完整原始列表
          flatLogsList: filteredFlatLogs,
          allFlatCoinsList: newFlatCoins, // 保存完整原始列表
          flatCoinsList: filteredFlatCoins,
          total: total,
          hasMore: hasMore,
          requesting: false, // 请求完成
          loading: false // 关闭 loading 显示
        })

        // 计算统计信息
        if (targetCollection === 'tts_clone_design_logs' || 
            targetCollection === 'users' || 
            targetCollection === 'coin_transactions') {
          this.calculateStats(newList)
        }
      } else {
        this.setData({ 
          requesting: false,
          loading: false 
        }) // 请求失败也要关闭状态
        wx.showToast({
          title: res.result.message || '查询失败',
          icon: 'none'
        })
      }
      wx.hideLoading()
    } catch (err) {
      wx.hideLoading()
      console.error('[DatabaseManage] 查询失败:', err)
      this.setData({ 
        requesting: false,
        loading: false 
      })
      wx.showToast({
        title: '查询失败，请稍后重试',
        icon: 'none'
      })
    }
  },

  // 格式化数据列表
  formatDataList(list, collection) {
    if (!list || !Array.isArray(list)) return { formattedList: [], flatLogs: [], flatCoins: [] }

    // 如果没有传入 collection 参数，使用当前选中的集合
    const targetCollection = collection || this.data.currentCollection
    let flatLogs = []
    let flatCoins = []

    // 根据不同集合类型进行格式化
    if (targetCollection === 'tts_clone_design_logs') {
      // 扁平化所有 logs，按时间排序
      list.forEach(item => {
        if (item.logs && Array.isArray(item.logs)) {
          item.logs.forEach(log => {
            flatLogs.push({
              ...log,
              openid: item.openid, // 保留 openid 信息
              formattedTime: this.formatTime(log.created_at),
              _logId: log._id || (Date.now() + Math.random()) // 生成唯一 ID
            })
          })
        }
      })
      // 按时间倒序排序
      flatLogs.sort((a, b) => {
        const timeA = a.created_at ? (typeof a.created_at === 'number' ? a.created_at : new Date(a.created_at).getTime()) : 0
        const timeB = b.created_at ? (typeof b.created_at === 'number' ? b.created_at : new Date(b.created_at).getTime()) : 0
        return timeB - timeA
      })
      
      // 返回原始列表（用于展开查看）
      const formattedList = list.map(item => {
        if (item.logs && Array.isArray(item.logs)) {
          item.logs = item.logs.map(log => ({
            ...log,
            formattedTime: this.formatTime(log.created_at)
          }))
        }
        return item
      })
      return { formattedList, flatLogs, flatCoins }
    } else if (collection === 'upload_file_logs') {
      return {
        formattedList: list.map(item => ({
          ...item,
          formattedTime: this.formatTime(item.date)
        })),
        flatLogs: [],
        flatCoins: []
      }
    } else if (collection === 'api_key_usage') {
      return {
        formattedList: list.map(item => ({
          ...item,
          updated_at_formatted: this.formatTime(item.updated_at),
          clone_usage: item.clone_usage || {},
          design_usage: item.design_usage || {}
        })),
        flatLogs: [],
        flatCoins: []
      }
    } else if (collection === 'coin_transactions') {
      // 扁平化所有 transactions
      list.forEach(item => {
        if (item.transactions && Array.isArray(item.transactions)) {
          item.transactions.forEach(trans => {
            flatCoins.push({
              ...trans,
              openid: item.openid, // 保留 openid 信息
              formattedTime: this.formatTime(trans.created_at),
              _transId: trans._id || (Date.now() + Math.random()) // 生成唯一 ID
            })
          })
        }
      })
      // 按时间倒序排序
      flatCoins.sort((a, b) => {
        const timeA = a.created_at ? (typeof a.created_at === 'number' ? a.created_at : new Date(a.created_at).getTime()) : 0
        const timeB = b.created_at ? (typeof b.created_at === 'number' ? b.created_at : new Date(b.created_at).getTime()) : 0
        return timeB - timeA
      })
      
      // 返回格式化列表（保留原始结构用于展开）
      const formattedList = list.map(item => ({
        ...item,
        updated_at_formatted: this.formatTime(item.updated_at),
        transactions: (item.transactions || []).map(trans => ({
          ...trans,
          formattedTime: this.formatTime(trans.created_at)
        }))
      }))
      return { formattedList, flatLogs: [], flatCoins }
    } else if (collection === 'users') {
      return {
        formattedList: list.map(item => ({
          ...item,
          created_at_formatted: this.formatTime(item.created_at),
          updated_at_formatted: this.formatTime(item.updated_at)
        })),
        flatLogs: [],
        flatCoins: []
      }
    } else {
      // 通用格式化：处理常见的时间字段
      const timeFields = ['created_at', 'updated_at', 'date', 'time', 'createTime', 'updateTime']
      return {
        formattedList: list.map(item => {
          const newItem = { ...item }
          timeFields.forEach(field => {
            if (newItem[field]) {
              newItem[field + '_formatted'] = this.formatTime(newItem[field])
            }
          })
          return newItem
        }),
        flatLogs: [],
        flatCoins: []
      }
    }
  },

  // 加载更多
  onLoadMore() {
    if (!this.data.hasMore || this.data.requesting) return

    this.setData({
      pageIndex: this.data.pageIndex + 1
    }, () => {
      this.loadData()
    })
  },

  // 搜索字段输入
  onSearchFieldInput(e) {
    this.setData({
      searchField: e.detail.value
    })
  },

  // 获取排序字段
  getOrderByField() {
    const collection = this.data.currentCollection

    // 特定集合使用特定字段排序
    if (collection === 'upload_file_logs') {
      return { field: 'date', order: 'desc' }
    } else if (collection === 'users') {
      return { field: 'created_at', order: 'desc' }
    } else if (collection === 'tts_clone_design_logs') {
      return { field: 'updated_at', order: 'desc' }
    } else if (collection === 'coin_transactions') {
      return { field: 'updated_at', order: 'desc' }
    } else {
      // 默认按 _id 降序
      return { field: '_id', order: 'desc' }
    }
  },

  // 搜索值输入
  onSearchValueInput(e) {
    this.setData({
      searchValue: e.detail.value
    })
  },

  // 执行搜索
  onSearch() {
    this.setData({
      pageIndex: 0,
      dataList: [],
      flatLogsList: [],
      allFlatLogsList: [],
      flatCoinsList: [],
      allFlatCoinsList: [],
      hasMore: false,
      loading: true
    }, () => {
      this.loadData()
    })
  },

  // 查看详情
  onViewItem(e) {
    const index = e.currentTarget.dataset.index
    const item = this.data.dataList[index]

    this.setData({
      selectedItem: item,
      showEditModal: true,
      editData: JSON.parse(JSON.stringify(item)) // 深拷贝
    })
  },

  // 编辑字段值
  onEditFieldInput(e) {
    const field = e.currentTarget.dataset.field
    const value = e.detail.value

    // 尝试解析为数字
    let parsedValue = value
    if (!isNaN(Number(value)) && value !== '') {
      parsedValue = Number(value)
    } else if (value === 'true') {
      parsedValue = true
    } else if (value === 'false') {
      parsedValue = false
    }

    this.setData({
      [`editData.${field}`]: parsedValue
    })
  },

  // 保存修改
  async onSave() {
    if (!this.data.selectedItem) return

    wx.showLoading({ title: '保存中...' })

    try {
      const token = app.getToken()
      const { _id, _openid, ...updateData } = this.data.editData
      wx.showLoading({ title: '保存中...' })
      const res = await app.globalData.cloud.callFunction({
        name: 'managerDatabase',
        data: {
          token: token,
          action: 'update',
          collection: this.data.currentCollection,
          docId: _id,
          data: updateData
        }
      })
      wx.hideLoading()
      console.log('[DatabaseManage] 更新结果:', res.result)

      wx.hideLoading()

      if (res.result.code === 0) {
        wx.showToast({
          title: '保存成功',
          icon: 'success'
        })

        // 更新列表中的数据
        const newDataList = [...this.data.dataList]
        const index = newDataList.findIndex(item => item._id === _id)
        if (index !== -1) {
          newDataList[index] = this.data.editData
        }

        this.setData({
          dataList: newDataList,
          showEditModal: false,
          selectedItem: null,
          editData: {}
        })
      } else {
        wx.showToast({
          title: res.result.message || '保存失败',
          icon: 'none'
        })
      }
    } catch (err) {
      console.error('[DatabaseManage] 保存失败:', err)
      wx.hideLoading()
      wx.showToast({
        title: '保存失败，请稍后重试',
        icon: 'none'
      })
    }
  },

  // 删除数据
  async onDelete() {
    if (!this.data.selectedItem) return

    wx.showModal({
      title: '确认删除',
      content: '确定要删除这条数据吗？删除后无法恢复。',
      confirmText: '删除',
      confirmColor: '#ff4d4f',
      success: async (res) => {
        if (res.confirm) {
          await this.executeDelete()
        }
      }
    })
  },

  // 执行删除
  async executeDelete() {
    wx.showLoading({ title: '删除中...' })

    try {
      const token = app.getToken()
      const _id = this.data.selectedItem._id
      
      const delRes = await app.globalData.cloud.callFunction({
        name: 'managerDatabase',
        data: {
          token: token,
          action: 'delete',
          collection: this.data.currentCollection,
          docId: _id
        }
      })

      console.log('[DatabaseManage] 删除结果:', delRes.result)

      wx.hideLoading()

      if (delRes.result.code === 0) {
        wx.showToast({
          title: '删除成功',
          icon: 'success'
        })

        // 从列表中移除
        const newDataList = this.data.dataList.filter(item => item._id !== _id)

        this.setData({
          dataList: newDataList,
          total: this.data.total - 1,
          showEditModal: false,
          selectedItem: null,
          editData: {}
        })
      } else {
        wx.showToast({
          title: delRes.result.message || '删除失败',
          icon: 'none'
        })
      }
    } catch (err) {
      console.error('[DatabaseManage] 删除失败:', err)
      wx.hideLoading()
      wx.showToast({
        title: '删除失败，请稍后重试',
        icon: 'none'
      })
    }
  },

  // 关闭弹窗
  onCloseModal() {
    this.setData({
      showEditModal: false,
      selectedItem: null,
      editData: {}
    })
  },

  // 判断是否是 tts_clone_design_logs 集合
  isTtsCloneLogs() {
    return this.data.currentCollection === 'tts_clone_design_logs'
  },

  // 展开/收起 logs 数组
  onToggleLogs(e) {
    const index = e.currentTarget.dataset.index
    const item = this.data.dataList[index]
    const expandedItems = { ...this.data.expandedItems }

    if (expandedItems[item._id]) {
      delete expandedItems[item._id]
    } else {
      expandedItems[item._id] = true
    }

    this.setData({ expandedItems })
  },

  // 展开/收起 transactions 数组
  onToggleTransactions(e) {
    const index = e.currentTarget.dataset.index
    const item = this.data.dataList[index]
    const expandedItems = { ...this.data.expandedItems }

    if (expandedItems[item._id]) {
      delete expandedItems[item._id]
    } else {
      expandedItems[item._id] = true
    }

    this.setData({ expandedItems })
  },

  // 格式化时间
  formatTime(timestamp) {
    if (!timestamp) return '-'

    const date = new Date(timestamp)
    const year = date.getFullYear()
    const month = (date.getMonth() + 1).toString().padStart(2, '0')
    const day = date.getDate().toString().padStart(2, '0')
    const hours = date.getHours().toString().padStart(2, '0')
    const minutes = date.getMinutes().toString().padStart(2, '0')

    return `${year}-${month}-${day} ${hours}:${minutes}`
  },

  // 获取时间范围（使用本地时间戳）
  getTimeRange() {
    // 使用本地时间
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    let startTime, endTime

    switch (this.data.timeFilterType) {
      case 'today':
        startTime = todayStart
        endTime = todayStart + 24 * 60 * 60 * 1000 - 1
        break
      case 'yesterday':
        startTime = todayStart - 24 * 60 * 60 * 1000
        endTime = todayStart - 1
        break
      case 'last7days':
        startTime = todayStart - 7 * 24 * 60 * 60 * 1000
        endTime = todayStart + 24 * 60 * 60 * 1000 - 1
        break
      case 'last30days':
        startTime = todayStart - 30 * 24 * 60 * 60 * 1000
        endTime = todayStart + 24 * 60 * 60 * 1000 - 1
        break
      case 'custom':
        if (this.data.customStartDate && this.data.customEndDate) {
          // 自定义日期转为本地时间戳
          const startParts = this.data.customStartDate.split('-')
          const endParts = this.data.customEndDate.split('-')
          startTime = new Date(startParts[0], startParts[1] - 1, startParts[2]).getTime()
          endTime = new Date(endParts[0], endParts[1] - 1, endParts[2]).getTime() + 24 * 60 * 60 * 1000 - 1
        } else {
          startTime = todayStart
          endTime = todayStart + 24 * 60 * 60 * 1000 - 1
        }
        break
      default:
        startTime = todayStart
        endTime = todayStart + 24 * 60 * 60 * 1000 - 1
    }

    return {
      startTime: startTime,
      endTime: endTime,
      startDate: this.formatDateForDisplay(new Date(startTime)),
      endDate: this.formatDateForDisplay(new Date(endTime))
    }
  },

  // 获取云函数需要的时间范围参数
  getTimeRangeForCloud() {
    const collection = this.data.currentCollection
    
    // 只有大数据量集合才传递时间范围参数
    const largeCollections = ['tts_clone_design_logs', 'users', 'coin_transactions', 'upload_file_logs']
    if (!largeCollections.includes(collection)) {
      return null
    }

    const range = this.getTimeRange()
    return {
      startTime: range.startTime,
      endTime: range.endTime
    }
  },

  // 格式化日期显示
  formatDateForDisplay(date) {
    const year = date.getFullYear()
    const month = (date.getMonth() + 1).toString().padStart(2, '0')
    const day = date.getDate().toString().padStart(2, '0')
    return `${year}-${month}-${day}`
  },

  // 获取统计周期文本
  getStatsPeriodText() {
    const range = this.getTimeRange()
    return `${range.startDate} 至 ${range.endDate}`
  },

  // 时间筛选类型切换
  onTimeFilterChange(e) {
    const type = e.currentTarget.dataset.type
    console.log('[DatabaseManage] 时间筛选类型切换:', type)

    const dataToSet = {
      timeFilterType: type,
      statsPeriodText: this.getStatsPeriodText()
    }

    // 如果是自定义日期，初始化默认日期
    if (type === 'custom') {
      const today = this.formatDateForDisplay(new Date())
      dataToSet.customStartDate = today
      dataToSet.customEndDate = today
    } else {
      dataToSet.customStartDate = ''
      dataToSet.customEndDate = ''
    }

    // 重新加载数据
    dataToSet.pageIndex = 0
    dataToSet.dataList = []

    this.setData(dataToSet, () => {
      this.loadData()
    })
  },

  // logs 类型筛选切换
  onLogFilterChange(e) {
    const type = e.currentTarget.dataset.type
    console.log('[DatabaseManage] logs 类型筛选切换:', type)

    // 从原始完整数据中筛选
    const filteredLogs = this.filterLogsByType(this.data.allFlatLogsList, type)
    
    this.setData({
      logFilterType: type,
      flatLogsList: filteredLogs
    })
  },

  // 根据类型筛选 logs
  filterLogsByType(logs, filterType) {
    const type = filterType || this.data.logFilterType
    if (type === 'all' || !type) {
      return logs
    }
    return logs.filter(log => log.type === type)
  },

  // coins 类型筛选切换
  onCoinFilterChange(e) {
    const type = e.currentTarget.dataset.type
    console.log('[DatabaseManage] coins 类型筛选切换:', type)

    // 从原始完整数据中筛选
    const filteredCoins = this.filterCoinsByType(this.data.allFlatCoinsList, type)
    
    this.setData({
      coinFilterType: type,
      flatCoinsList: filteredCoins
    })
  },

  // 根据类型筛选 coins（按 source 字段筛选）
  filterCoinsByType(coins, filterType) {
    const type = filterType || this.data.coinFilterType
    if (type === 'all' || !type) {
      return coins
    }
    return coins.filter(coin => coin.source === type)
  },

  // 自定义开始日期变更
  onStartDateChange(e) {
    const date = e.detail.value
    console.log('[DatabaseManage] 开始日期变更:', date)
    this.setData({
      customStartDate: date,
      statsPeriodText: this.getStatsPeriodText(),
      pageIndex: 0,
      dataList: []
    }, () => {
      this.loadData()
    })
  },

  // 自定义结束日期变更
  onEndDateChange(e) {
    const date = e.detail.value
    console.log('[DatabaseManage] 结束日期变更:', date)
    this.setData({
      customEndDate: date,
      statsPeriodText: this.getStatsPeriodText(),
      pageIndex: 0,
      dataList: []
    }, () => {
      this.loadData()
    })
  },

  // 计算统计数据
  calculateStats(dataList) {
    const timeRange = this.getTimeRange()
    const { startTime, endTime } = timeRange

    const collection = this.data.currentCollection

    if (collection === 'tts_clone_design_logs') {
      let cloneCount = 0
      let designCount = 0
      let mimoChars = 0
      let qwenChars = 0

      // 使用扁平化的日志列表计算统计
      const flatLogs = this.data.flatLogsList || []
      flatLogs.forEach(log => {
        const logTime = log.created_at
        const logType = log.type || ''

        let inTimeRange = false
        if (logTime) {
          const logTimestamp = typeof logTime === 'number' ? logTime : new Date(logTime).getTime()
          inTimeRange = logTimestamp >= startTime && logTimestamp <= endTime
        }

        if (inTimeRange) {
          if (logType === 'clone') {
            cloneCount++
          } else if (logType === 'design') {
            designCount++
          } else if (logType === 'synthesize_mimo') {
            const text = log.text || ''
            if (text) {
              mimoChars += text.length
            }
          } else if (logType === 'synthesize') {
            const text = log.text || ''
            if (text) {
              qwenChars += text.length
            }
          }
        }
      })

      this.setData({
        stats: {
          cloneCount,
          designCount,
          mimoChars,
          qwenChars,
          newUsersCount: 0,
          signCount: 0,
          adCount: 0,
          orderCount: 0
        },
        statsPeriodText: this.getStatsPeriodText()
      })
    } else if (collection === 'users') {
      let newUsersCount = 0

      dataList.forEach(item => {
        const createdAt = item.created_at
        if (createdAt) {
          const createdTimestamp = typeof createdAt === 'number' ? createdAt : new Date(createdAt).getTime()
          if (createdTimestamp >= startTime && createdTimestamp <= endTime) {
            newUsersCount++
          }
        }
      })

      this.setData({
        stats: {
          cloneCount: 0,
          designCount: 0,
          mimoChars: 0,
          qwenChars: 0,
          newUsersCount,
          signCount: 0,
          adCount: 0,
          orderCount: 0
        },
        statsPeriodText: this.getStatsPeriodText()
      })
    } else if (collection === 'coin_transactions') {
      let signCount = 0
      let adCount = 0
      let orderCount = 0

      // 使用扁平化列表统计，避免因分页导致嵌套结构中部分文档未被加载而漏算
      const flatCoins = this.data.allFlatCoinsList || []
      flatCoins.forEach(trans => {
        const transTime = trans.created_at
        const transType = trans.type || ''
        const source = trans.source || ''

        let inTimeRange = false
        if (transTime) {
          const transTimestamp = typeof transTime === 'number' ? transTime : new Date(transTime).getTime()
          inTimeRange = transTimestamp >= startTime && transTimestamp <= endTime
        }

        if (inTimeRange) {
          // earn 类型：签到、看视频广告
          if (transType === 'earn') {
            if (source === 'checkin') {
              signCount++
            } else if (source === 'video_ad') {
              adCount++
            }
          }
          // recharge 类型：充值购买
          else if (transType === 'recharge' && source === 'recharge') {
            orderCount++
          }
        }
      })

      this.setData({
        stats: {
          cloneCount: 0,
          designCount: 0,
          mimoChars: 0,
          qwenChars: 0,
          newUsersCount: 0,
          signCount,
          adCount,
          orderCount
        },
        statsPeriodText: this.getStatsPeriodText()
      })
    }
  },

  // 播放音频并复制链接
  onPlayAudio(e) {
    const audioFileId = e.currentTarget.dataset.audioId

    if (!audioFileId) {
      wx.showToast({
        title: '音频ID为空',
        icon: 'none'
      })
      return
    }

    // 如果点击的是正在播放的音频，则停止播放
    if (this.data.currentPlayingAudioId === audioFileId && this.innerAudioContext) {
      this.stopAudio()
      return
    }

    wx.showLoading({ title: '加载音频...' })

    // 停止之前的播放
    if (this.innerAudioContext) {
      this.innerAudioContext.stop()
      this.innerAudioContext.destroy()
    }

    // 使用 app.globalData.cloud 获取临时URL
    app.globalData.cloud.getTempFileURL({
      fileList: [audioFileId]
    }).then(res => {
      wx.hideLoading()

      if (res.fileList && res.fileList.length > 0) {
        const fileInfo = res.fileList[0]

        if (fileInfo.status === 0) {
          const tempFileURL = fileInfo.tempFileURL
          
          // 复制临时链接
          wx.setClipboardData({
            data: tempFileURL,
            success: () => {
              wx.showToast({
                title: '链接已复制',
                icon: 'success',
                duration: 1500
              })
            }
          })

          // 创建音频播放器
          this.innerAudioContext = wx.createInnerAudioContext()
          this.innerAudioContext.src = tempFileURL

          this.innerAudioContext.onPlay(() => {
            console.log('[DatabaseManage] 音频开始播放')
            this.setData({ currentPlayingAudioId: audioFileId })
          })

          this.innerAudioContext.onError((err) => {
            console.error('[DatabaseManage] 音频播放失败:', err)
            wx.showToast({
              title: '播放失败',
              icon: 'none'
            })
            this.stopAudio()
          })

          this.innerAudioContext.onEnded(() => {
            console.log('[DatabaseManage] 音频播放结束')
            this.stopAudio()
          })

          this.innerAudioContext.play()
        } else {
          wx.showToast({
            title: '获取音频URL失败',
            icon: 'none'
          })
        }
      }
    }).catch(err => {
      wx.hideLoading()
      console.error('[DatabaseManage] 获取音频URL失败:', err)
      wx.showToast({
        title: '获取音频URL失败',
        icon: 'none'
      })
    })
  },

  // 停止音频播放
  stopAudio() {
    if (this.innerAudioContext) {
      this.innerAudioContext.stop()
      this.innerAudioContext.destroy()
      this.innerAudioContext = null
    }
    this.setData({ currentPlayingAudioId: null })
  },

  // 复制到剪贴板
  onCopyText(e) {
    const text = e.currentTarget.dataset.text
    if (!text) {
      wx.showToast({ title: '复制内容为空', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: text,
      success: () => {
        wx.showToast({ title: '已复制', icon: 'success' })
      },
      fail: () => {
        wx.showToast({ title: '复制失败', icon: 'none' })
      }
    })
  },

  // 跳转到客服聊天页面
  goToCustomerService(e) {
    const openid = e.currentTarget.dataset.openid
    if (!openid) {
      wx.showToast({ title: 'openid 为空', icon: 'none' })
      return
    }
    wx.navigateTo({
      url: `/pages/customer-service-chat/customer-service-chat?openid=${openid}`
    })
  },

  // 格式化显示
  formatValue(value) {
    if (typeof value === 'object' && value !== null) {
      return JSON.stringify(value)
    }
    if (value === null || value === undefined) {
      return '-'
    }
    if (typeof value === 'boolean') {
      return value ? 'true' : 'false'
    }
    return String(value)
  },

  // 编辑 api_key_usage 字段
  onEditApiKeyField(e) {
    const { index, usage, field } = e.currentTarget.dataset
    const item = this.data.dataList[index]
    if (!item) return

    const usageData = item[usage] || {}
    const value = usageData[field] || 0

    // 构建显示标签
    const usageLabel = usage === 'clone_usage' ? '克隆' : '设计'
    const fieldLabels = {
      key_num: 'key_num',
      key_v_num: 'key_v_num',
      key_w_num: 'key_w_num'
    }
    const label = `${usageLabel}使用 - ${fieldLabels[field]}`

    this.setData({
      showApiKeyEditModal: true,
      apiKeyEditIndex: index,
      apiKeyEditUsage: usage,
      apiKeyEditField: field,
      apiKeyEditLabel: label,
      apiKeyEditValue: value
    })
  },

  // api_key_usage 字段输入
  onApiKeyFieldInput(e) {
    this.setData({
      apiKeyEditValue: e.detail.value
    })
  },

  // 关闭 api_key_usage 编辑弹窗
  onCloseApiKeyEditModal() {
    this.setData({
      showApiKeyEditModal: false,
      apiKeyEditIndex: -1,
      apiKeyEditUsage: '',
      apiKeyEditField: '',
      apiKeyEditLabel: '',
      apiKeyEditValue: 0
    })
  },

  // 保存 api_key_usage 字段
  async onSaveApiKeyField() {
    const { apiKeyEditIndex, apiKeyEditUsage, apiKeyEditField, apiKeyEditValue } = this.data

    if (apiKeyEditIndex === -1 || !apiKeyEditUsage || !apiKeyEditField) {
      wx.showToast({ title: '数据错误', icon: 'none' })
      return
    }

    const item = this.data.dataList[apiKeyEditIndex]
    if (!item) return

    const newValue = Number(apiKeyEditValue) || 0
    const _id = item._id

    wx.showLoading({ title: '保存中...' })

    try {
      const token = app.getToken()

      // 构建更新数据：直接更新嵌套字段
      const updatePath = `${apiKeyEditUsage}.${apiKeyEditField}`
      const updateData = {
        [updatePath]: newValue
      }

      const res = await app.globalData.cloud.callFunction({
        name: 'managerDatabase',
        data: {
          token: token,
          action: 'update',
          collection: 'api_key_usage',
          docId: _id,
          data: updateData
        }
      })

      console.log('[DatabaseManage] 更新 api_key_usage 结果:', res.result)

      wx.hideLoading()

      if (res.result.code === 0) {
        wx.showToast({
          title: '保存成功',
          icon: 'success'
        })

        // 更新本地数据
        const newDataList = [...this.data.dataList]
        if (!newDataList[apiKeyEditIndex][apiKeyEditUsage]) {
          newDataList[apiKeyEditIndex][apiKeyEditUsage] = {}
        }
        newDataList[apiKeyEditIndex][apiKeyEditUsage][apiKeyEditField] = newValue

        this.setData({
          dataList: newDataList,
          showApiKeyEditModal: false,
          apiKeyEditIndex: -1,
          apiKeyEditUsage: '',
          apiKeyEditField: '',
          apiKeyEditLabel: '',
          apiKeyEditValue: 0
        })
      } else {
        wx.showToast({
          title: res.result.message || '保存失败',
          icon: 'none'
        })
      }
    } catch (err) {
      console.error('[DatabaseManage] 保存 api_key_usage 失败:', err)
      wx.hideLoading()
      wx.showToast({
        title: '保存失败，请稍后重试',
        icon: 'none'
      })
    }
  }
})
