// database-manage.js
const app = getApp()

Page({
  data: {
    collections: [],
    currentCollection: '',
    dataList: [],
    loading: false,
    pageIndex: 0,
    pageSize: 20,
    total: 0,
    hasMore: true,
    selectedItem: null,
    showEditModal: false,
    editData: {},
    searchField: '',
    searchValue: ''
  },

  onLoad() {
    console.log('[DatabaseManage] 页面加载完成')
    // 检查登录状态
    if (!this.checkIsLoggedIn()) return
    this.loadCollections()
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
      const res = await app.globalData.cloud.callFunction({
        name: 'managerDatabase',
        data: {
          token: token,
          action: 'collections'
        }
      })

      console.log('[DatabaseManage] 集合列表:', res.result)

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
      pageIndex: 0,
      total: 0,
      hasMore: true
    })

    this.loadData()
  },

  // 加载数据
  async loadData() {
    if (this.data.loading || !this.data.currentCollection) return

    this.setData({ loading: true })

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

      const res = await app.globalData.cloud.callFunction({
        name: 'managerDatabase',
        data: {
          token: token,
          action: 'query',
          collection: this.data.currentCollection,
          where: where,
          pageIndex: this.data.pageIndex,
          pageSize: this.data.pageSize,
          orderBy: { field: '_id', order: 'desc' }
        }
      })

      console.log('[DatabaseManage] 数据查询结果:', res.result)

      if (res.result.code === 0) {
        const newList = this.data.pageIndex === 0
          ? res.result.data.list
          : [...this.data.dataList, ...res.result.data.list]

        this.setData({
          dataList: newList,
          total: res.result.data.total,
          hasMore: (this.data.pageIndex + 1) * this.data.pageSize < res.result.data.total
        })
      } else {
        wx.showToast({
          title: res.result.message || '查询失败',
          icon: 'none'
        })
      }
    } catch (err) {
      console.error('[DatabaseManage] 查询失败:', err)
      wx.showToast({
        title: '查询失败，请稍后重试',
        icon: 'none'
      })
    } finally {
      this.setData({ loading: false })
    }
  },

  // 加载更多
  onLoadMore() {
    if (!this.data.hasMore || this.data.loading) return

    this.setData({
      pageIndex: this.data.pageIndex + 1
    })
    this.loadData()
  },

  // 搜索字段输入
  onSearchFieldInput(e) {
    this.setData({
      searchField: e.detail.value
    })
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
      dataList: []
    })
    this.loadData()
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
  }
})
