// pages/invoice-list/invoice-list.js
const app = getApp()

Page({
  data: {
    list: [],
    currentStatus: 'all',
    keyword: '',
    page: 1,
    pageSize: 10,
    total: 0,
    hasMore: false,
    loading: false,
    currentItem: null,
    showUploadModal: false,
    uploadForm: {
      user_type: 0,
      title: '',
      tax_no: '',
      address: '',
      phone_no: '',
      bank_name: '',
      bank_account: '',
      email: ''
    },
    showInvoiceDetailModal: false,
    invoiceUrl: '',
    hasFetchedInvoiceDetail: false,
    invoiceDetail: null,
    invoiceDifferences: {}
  },

  onLoad() {
    console.log('[InvoiceList] 页面加载完成')
    if (!this.checkIsLoggedIn()) return
    this.loadInvoiceList()
  },

  onShow() {
    console.log('[InvoiceList] 页面显示')
    if (this.data.list.length > 0) {
      this.refreshList()
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
      setTimeout(() => {
        wx.reLaunch({
          url: '/pages/index/index'
        })
      }, 1500)
      return false
    }
    return true
  },

  // 加载发票列表
  async loadInvoiceList() {
    this.setData({ loading: true })

    try {
      const res = await app.globalData.cloud.callFunction({
        name: 'managerInvoiceList',
        data: {
          token: app.getToken(),
          page: this.data.page,
          pageSize: this.data.pageSize,
          status: this.data.currentStatus,
          keyword: this.data.keyword
        }
      })

      console.log('[InvoiceList] 查询结果:', res.result)
      //console.log('[InvoiceList] 详细数据:', JSON.stringify(res.result.data.list, null, 2))

      if (res.result.code === 0) {
        // 云函数已经处理了金额转换和订单详情关联
        const newData = res.result.data.list.map(item => ({
          ...item,
          amount: (item.amount / 100).toFixed(2),
          // 格式化时间
          created_at_text: this.formatTime(item.created_at),
          // 格式化关联订单的时间
          related_orders: item.related_orders ? item.related_orders.map(order => ({
            ...order,
            pay_time_text: this.formatTime(order.pay_time)
          })) : []
        }))
        this.setData({
          list: this.data.page === 1 ? newData : [...this.data.list, ...newData],
          total: res.result.data.total,
          hasMore: res.result.data.hasMore
        })
      } else {
        wx.showToast({
          title: res.result.message || '加载失败',
          icon: 'none'
        })
      }
    } catch (err) {
      console.error('[InvoiceList] 加载失败:', err)
      wx.showToast({
        title: '加载失败，请稍后重试',
        icon: 'none'
      })
    } finally {
      this.setData({ loading: false })
    }
  },

  // 刷新列表
  refreshList() {
    this.setData({
      page: 1,
      list: [],
      total: 0,
      hasMore: false
    })
    this.loadInvoiceList()
  },

  // 搜索输入
  onSearchInput(e) {
    this.setData({ keyword: e.detail.value })
  },

  // 搜索
  onSearch() {
    this.setData({
      page: 1,
      list: [],
      total: 0,
      hasMore: false
    })
    this.loadInvoiceList()
  },

  // 切换状态
  onStatusChange(e) {
    const status = e.currentTarget.dataset.status
    if (status === this.data.currentStatus) return

    this.setData({
      currentStatus: status,
      page: 1,
      list: [],
      total: 0,
      hasMore: false
    })
    this.loadInvoiceList()
  },

  // 点击审核中状态
  onReviewingClick(e) {
    const item = e.currentTarget.dataset.item

    wx.showModal({
      title: '确认修改状态',
      content: `确认将发票 "${item.title}" 的状态修改为"开票中"？`,
      success: (res) => {
        if (res.confirm) {
          this.updateInvoiceStatus(item._id, 'invoicing')
        }
      }
    })
  },

  // 下拉刷新
  onPullDownRefresh() {
    this.refreshList()
    setTimeout(() => {
      wx.stopPullDownRefresh()
    }, 1000)
  },

  // 加载更多
  loadMore() {
    if (this.data.loading || !this.data.hasMore) return
    this.setData({
      page: this.data.page + 1
    })
    this.loadInvoiceList()
  },

  // 更新发票状态
  async updateInvoiceStatus(invoiceId, status) {
    try {
      wx.showLoading({ title: '更新中...' })

      const res = await app.globalData.cloud.callFunction({
        name: 'managerInvoiceUpdate',
        data: {
          token: app.getToken(),
          invoice_id: invoiceId,
          status: status
        }
      })

      wx.hideLoading()

      if (res.result.code === 0) {
        wx.showToast({
          title: '更新成功',
          icon: 'success'
        })
        // 刷新列表
        this.refreshList()
      } else {
        wx.showToast({
          title: res.result.message || '更新失败',
          icon: 'none'
        })
      }
    } catch (err) {
      wx.hideLoading()
      console.error('[InvoiceList] 更新状态失败:', err)
      wx.showToast({
        title: '更新失败，请稍后重试',
        icon: 'none'
      })
    }
  },

  // 时间格式化
  formatTime(timeStr) {
    if (!timeStr) return ''

    const date = new Date(timeStr)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    const seconds = String(date.getSeconds()).padStart(2, '0')

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
  },

  // 上传开票信息
  onUploadInvoice(e) {
    const item = e.currentTarget.dataset.item

    // 填充表单数据
    this.setData({
      showUploadModal: true,
      'uploadForm.user_type': item.invoice_owner_type === 'company' ? 'company' : 'personal',
      'uploadForm.title': item.title || '',
      'uploadForm.tax_no': item.tax_number || '',
      'uploadForm.address': item.company_address || '',
      'uploadForm.phone_no': item.telephone || '',
      'uploadForm.bank_name': item.bank_name || '',
      'uploadForm.bank_account': item.bank_account || '',
      'uploadForm.email': item.email || ''
    })
  },

  // 表单输入
  onFormInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({
      [`uploadForm.${field}`]: e.detail.value
    })
  },

  // 取消上传
  onCancelUpload() {
    this.setData({ showUploadModal: false })
  },

  // 确认上传
  onConfirmUpload() {
    console.log(this.data.uploadForm)
    const that = this
    wx.showLoading({
      title: '上传中...'
    })
    let user_type = 0
    if(that.data.uploadForm.user_type !== 'company') user_type = 1
    console.log(user_type)
    wx.request({
      url: 'https://mm.zswf.tech/sdp/',
      method: "POST",
      header: {
        'content-type': 'application/json'
      },
      data: {
        user_type: user_type,
        title: that.data.uploadForm.title,
        tax_no: that.data.uploadForm.tax_no,
        address: that.data.uploadForm.address,
        phone_no: that.data.uploadForm.phone_no,
        bank_name: that.data.uploadForm.bank_name,
        bank_account: that.data.uploadForm.bank_account,
        email: that.data.uploadForm.email
      },
      success(res) {
        console.log(res)
        wx.hideLoading()
        wx.showToast({
          title: '上传成功',
          icon: 'success'
        })
        that.setData({ showUploadModal: false })
      },
      fail(err) {
        console.log(err)
        wx.hideLoading()
        wx.showToast({
          title: '上传失败',
          icon: 'none'
        })
      }
    })
  },

  // 复制文本
  copyText(e) {
    const text = e.currentTarget.dataset.text

    if (!text) {
      wx.showToast({
        title: '复制内容为空',
        icon: 'none'
      })
      return
    }

    wx.setClipboardData({
      data: text,
      success: () => {
        wx.showToast({
          title: '已复制',
          icon: 'success',
          duration: 1500
        })
      },
      fail: (err) => {
        console.error('[InvoiceList] 复制失败:', err)
        wx.showToast({
          title: '复制失败',
          icon: 'none'
        })
      }
    })
  },

  // 点击发票卡片
  onCardClick(e) {
    const item = e.currentTarget.dataset.item

    // 只有开票中状态的发票才显示获取发票详情弹窗
    if (item.status === 'invoicing') {
      this.setData({
        currentItem: item,
        showInvoiceDetailModal: true,
        invoiceUrl: '',
        hasFetchedInvoiceDetail: false,
        invoiceDetail: null,
        invoiceDifferences: {}
      })
    }
  },

  // 取消获取发票详情
  onCancelInvoiceDetail() {
    this.setData({
      showInvoiceDetailModal: false,
      invoiceUrl: '',
      currentItem: null,
      hasFetchedInvoiceDetail: false,
      invoiceDetail: null,
      invoiceDifferences: {}
    })
  },

  // 输入发票链接
  onInvoiceUrlInput(e) {
    this.setData({
      invoiceUrl: e.detail.value
    })
  },

  // 扫码获取链接
  onScanCode() {
    wx.scanCode({
      success: (res) => {
        console.log('[InvoiceList] 扫码结果:', res)
        this.setData({
          invoiceUrl: res.result
        })
      },
      fail: (err) => {
        console.error('[InvoiceList] 扫码失败:', err)
        wx.showToast({
          title: '扫码失败',
          icon: 'none'
        })
      }
    })
  },

  // 获取发票详情
  onGetInvoiceDetail() {
    const url = this.data.invoiceUrl.trim()

    if (!url) {
      wx.showToast({
        title: '请输入发票链接',
        icon: 'none'
      })
      return
    }

    this.getInvoiceResult({
      url: url,
      success: (data) => {
        console.log('[InvoiceList] 发票详情:', data)
        console.log('[InvoiceList] 申请时的发票信息:', this.data.currentItem)

        // 比对字段差异
        const differences = this.compareInvoiceData(data)

        // 存储获取到的发票详情和差异信息，暂不更新列表
        this.setData({
          hasFetchedInvoiceDetail: true,
          invoiceDetail: data,
          invoiceDifferences: differences
        })
      },
      fail: (err) => {
        console.error('[InvoiceList] 获取发票详情失败:', err)
      }
    })
  },

  // 比对发票数据差异
  compareInvoiceData(fetchedData) {
    if (!this.data.currentItem) return {}

    const { currentItem } = this.data

    const differences = {}

    // 比对抬头
    if (fetchedData.company_name && currentItem.title && fetchedData.company_name !== currentItem.title) {
      differences.title = true
    }

    // 比对税号
    if (fetchedData.tax_no && currentItem.tax_number && fetchedData.tax_no !== currentItem.tax_number) {
      differences.tax_no = true
    }

    return differences
  },

  // 确认更新发票信息
  async onConfirmUpdateInvoice() {
    if (!this.data.invoiceDetail) {
      wx.showToast({
        title: '暂无发票详情',
        icon: 'none'
      })
      return
    }

    if (!this.data.currentItem) {
      wx.showToast({
        title: '缺少发票信息',
        icon: 'none'
      })
      return
    }

    try {
      wx.showLoading({ title: '更新中...' })

      // 调用云函数更新数据库
      const res = await app.globalData.cloud.callFunction({
        name: 'managerInvoiceUpdate',
        data: {
          token: app.getToken(),
          invoice_id: this.data.currentItem._id,
          status: 'completed', // 获取到发票详情后，状态更新为已完成
          invoice_no: this.data.invoiceDetail.invoice_no || null,
          invoice_url: this.data.invoiceUrl || null
        }
      })

      wx.hideLoading()

      if (res.result.code === 0) {
        wx.showToast({
          title: '更新成功',
          icon: 'success'
        })

        // 更新本地列表数据
        this.updateInvoiceData(this.data.invoiceDetail)

        this.setData({
          showInvoiceDetailModal: false,
          invoiceUrl: '',
          hasFetchedInvoiceDetail: false,
          invoiceDetail: null,
          invoiceDifferences: {}
        })
      } else {
        wx.showToast({
          title: res.result.message || '更新失败',
          icon: 'none'
        })
      }
    } catch (err) {
      wx.hideLoading()
      console.error('[InvoiceList] 更新发票失败:', err)
      wx.showToast({
        title: '更新失败，请稍后重试',
        icon: 'none'
      })
    }
  },

  // 获取发票结果
  getInvoiceResult(params) {
    wx.showLoading({
      title: '获取发票信息中'
    })
    wx.request({
      url: 'https://mm.zswf.tech/sdp/?url=' + params.url,
      method: 'GET',
      header: {
        'content-type': 'application/json'
      },
      success: (e) => {
        console.log('[InvoiceList] 获取结果:', e)
        wx.hideLoading()
        wx.showToast({
          title: '获取成功',
          icon: 'success'
        })
        params.success(e.data)
      },
      fail: (e) => {
        console.error('[InvoiceList] 获取失败:', e)
        wx.hideLoading()
        wx.showToast({
          title: '获取失败',
          icon: 'none'
        })
        params.fail(e)
      }
    })
  },

  // 更新发票信息
  updateInvoiceData(data) {
    if (!this.data.currentItem || !data) return

    const invoiceId = this.data.currentItem._id

    // 更新列表中的发票信息（映射字段名：接口返回的字段 -> 列表使用的字段）
    const list = this.data.list.map(item => {
      if (item._id === invoiceId) {
        return {
          ...item,
          title: data.company_name, // 抬头
          tax_number: data.tax_no, // 税号
          amount: data.total_amount?.replace(/[￥¥]/g, ''), // 金额（去掉货币符号）
          invoice_no: data.invoice_no, // 发票号
          invoice_url: this.data.invoiceUrl, // 发票链接
          status: 'completed', // 状态更新为已完成
          status_text: '开票完成',
          updated_at: data.invoice_time, // 更新时间
          updated_at_text: data.invoice_time, // 更新时间文本
          company_address: data.company_address, // 公司地址
          telephone: data.telephone, // 联系电话
          bank_name: data.bank_name, // 开户银行
          bank_account: data.bank_account // 银行账号
        }
      }
      return item
    })

    this.setData({ list })
  }
})
