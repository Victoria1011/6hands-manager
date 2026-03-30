// pages/refund-list/refund-list.js
const app = getApp()

Page({
  data: {
    activeTab: 'reviewing',
    allRefunds: [],
    reviewingList: [],
    rejectedList: [],
    completedList: [],
    cancelledList: [],
    currentList: [],
    loading: false,
    reviewingCount: 0,
    showRejectDialog: false,
    currentRefund: null,
    rejectReason: '',
    scrollTop: 0,
    // 退款弹窗相关
    showRefundDialog: false,
    refundAmount: '',
    refundOrders: [],
    totalRefundAmount: 0
  },

  onLoad() {
    console.log('[RefundList] 页面加载完成')
    this.checkIsLoggedIn()
  },

  onShow() {
    if (this.checkIsLoggedIn()) {
      this.getRefundList()
    }
  },

  // 下拉刷新
  onPullDownRefresh() {
    this.getRefundList().then(() => {
      wx.stopPullDownRefresh()
    })
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

  // 切换 Tab
  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    this.setData({
      activeTab: tab,
      scrollTop: 0
    })

    // 根据tab设置当前列表
    if (tab === 'reviewing') {
      this.setData({ currentList: this.data.reviewingList })
    } else if (tab === 'rejected') {
      this.setData({ currentList: this.data.rejectedList })
    } else if (tab === 'completed') {
      this.setData({ currentList: this.data.completedList })
    } else if (tab === 'cancelled') {
      this.setData({ currentList: this.data.cancelledList })
    }
  },

  // 获取退款列表
  async getRefundList() {
    this.setData({ loading: true })

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
        name: 'managerGetRefundList',
        data: {
          token: token
        }
      })

      console.log('[RefundList] 获取退款列表结果:', res)

      if (res.result.code === 0) {
        const allRefunds = (res.result.data.refunds || []).map(refund => ({
          ...refund,
          formattedTime: this.formatTime(refund.created_at),
          formattedStatus: this.formatStatus(refund.status),
          // 格式化订单时间
          orders: (refund.orders || []).map(order => ({
            ...order,
            formattedTime: this.formatTime(order.created_at)
          }))
        }))

    // 按时间排序（最新的在前）
    allRefunds.sort((a, b) => {
      const timeA = new Date(a.created_at).getTime()
      const timeB = new Date(b.created_at).getTime()
      return timeB - timeA
    })

    // 分类：approved 和 reviewing 都放在待处理标签页中
    const reviewingList = allRefunds.filter(r => r.status === 'reviewing' || r.status === 'approved')
    const rejectedList = allRefunds.filter(r => r.status === 'rejected')
    const completedList = allRefunds.filter(r => r.status === 'completed')
    const cancelledList = allRefunds.filter(r => r.status === 'cancelled')

    // 统计审核中的数量（包含 approved 状态）
    const reviewingCount = allRefunds.filter(r => r.status === 'reviewing' || r.status === 'approved').length

        this.setData({
          allRefunds,
          reviewingList,
          rejectedList,
          completedList,
          cancelledList,
          currentList: this.data.activeTab === 'reviewing' ? reviewingList :
                       this.data.activeTab === 'rejected' ? rejectedList :
                       this.data.activeTab === 'completed' ? completedList : cancelledList,
          reviewingCount: reviewingList.length
        })
      } else {
        wx.showToast({
          title: res.result.message || '获取失败',
          icon: 'none'
        })
      }
    } catch (err) {
      console.error('[RefundList] 获取退款列表失败:', err)
      wx.showToast({
        title: '获取失败',
        icon: 'none'
      })
    } finally {
      this.setData({ loading: false })
    }
  },

  // 查看详情
  viewDetail(e) {
    const refund = e.currentTarget.dataset.refund
    console.log('[RefundList] 查看退款详情:', refund)
    // 可以跳转到详情页面
  },

  // 驳回退款
  rejectRefund(e) {
    const refund = e.currentTarget.dataset.refund
    this.setData({
      showRejectDialog: true,
      currentRefund: refund,
      rejectReason: ''
    })
  },

  // 同意退款
  async approveRefund(e) {
    const refund = e.currentTarget.dataset.refund
    console.log('[RefundList] 同意退款:', refund)
    if (!refund._id) {
      wx.showToast({
        title: '退款ID不存在',
        icon: 'none'
      })
      return
    }

    wx.showModal({
      title: '确认同意退款',
      content: `确认同意退款 ¥${refund.refund_info.refundable_amount} 元吗？同意后将清零用户元宝并记录退款信息。`,
      success: async (res) => {
        if (res.confirm) {
          // 先将状态改为 approved，触发清零用户元宝的逻辑
          await this.processRefund(refund._id, 'approved', '', refund.refund_info.refundable_coins, refund.openid)
        }
      }
    })
  },

  // 确认驳回
  async confirmReject() {
    const { currentRefund, rejectReason } = this.data

    if (!rejectReason || rejectReason.trim() === '') {
      wx.showToast({
        title: '请输入驳回原因',
        icon: 'none'
      })
      return
    }

    if (!currentRefund.id) {
      wx.showToast({
        title: '退款ID不存在',
        icon: 'none'
      })
      return
    }

    await this.processRefund(currentRefund.id, 'rejected', rejectReason.trim(), 0,currentRefund.openid )
    this.setData({ showRejectDialog: false })
  },

  // 关闭驳回弹窗
  closeRejectDialog() {
    this.setData({
      showRejectDialog: false,
      currentRefund: null,
      rejectReason: ''
    })
  },

  // 驳回原因输入
  onRejectReasonInput(e) {
    this.setData({
      rejectReason: e.detail.value
    })
  },

  // 阻止事件冒泡
  stopPropagation() {
    // 空函数
  },

  // 处理退款
  async processRefund(refundId, status, rejectReason = '', coins, openid) {
    wx.showLoading({
      title: '处理中...'
    })

    try {
      const token = app.getToken()

      if (!app.globalData.cloud) {
        wx.hideLoading()
        wx.showToast({
          title: '云开发未初始化',
          icon: 'none'
        })
        return
      }

      const res = await app.globalData.cloud.callFunction({
        name: 'managerProcessRefund',
        data: {
          refundId: refundId,
          status: status,
          rejectReason: rejectReason,
          token: token,
          coins: coins,
          openid: openid
        }
      })

      console.log('[RefundList] 处理退款结果:', res)

      wx.hideLoading()

      if (res.result.code === 0) {
        wx.showToast({
          title: status === 'approved' ? '已同意退款，用户元宝已清零' : status === 'completed' ? '退款已完成' : '已驳回',
          icon: 'success'
        })
        // 刷新列表
        await this.getRefundList()
      } else {
        wx.showToast({
          title: res.result.message || '处理失败',
          icon: 'none'
        })
      }
    } catch (err) {
      console.error('[RefundList] 处理退款失败:', err)
      wx.hideLoading()
      wx.showToast({
        title: '处理失败',
        icon: 'none'
      })
    }
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

  // 格式化时间
  formatTime(timeStr) {
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
      const seconds = date.getSeconds().toString().padStart(2, '0')
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
    } catch (err) {
      return timeStr || ''
    }
  },

  // 格式化状态
  formatStatus(status) {
    const statusMap = {
      'reviewing': '审核中',
      'approved': '已通过审核，正在退款中',
      'rejected': '已驳回',
      'completed': '已完成',
      'cancelled': '已取消'
    }
    return statusMap[status] || status || '未知'
  },

  // 格式化金额为两位小数
  formatAmount(amount) {
    if (typeof amount !== 'number') return amount
    return amount.toFixed(2)
  },

  // 打开退款弹窗
  openRefundDialog(e) {
    const refund = e.currentTarget.dataset.refund
    console.log('[RefundList] 打开退款弹窗:', refund)

    // 默认退款金额为可退款金额（单位已经是元）
    const defaultRefundAmount = refund.refund_info?.refundable_amount || 0

    // 计算退款订单
    const refundOrders = this.calculateRefundOrders(refund, defaultRefundAmount)

    // 计算总退款金额（使用数字类型）
    const totalAmount = refundOrders.reduce((sum, order) => sum + parseFloat(order.refund_amount), 0)

    this.setData({
      showRefundDialog: true,
      currentRefund: refund,
      refundAmount: defaultRefundAmount.toString(),
      refundOrders: refundOrders,
      totalRefundAmount: totalAmount.toFixed(2)
    })
  },

  // 计算退款订单（从最近的订单开始）
  calculateRefundOrders(refund, refundAmount) {
    const orders = refund.orders || []
    if (orders.length === 0) return []

    // 按时间倒序排序（最近的在前）
    const sortedOrders = [...orders].sort((a, b) => {
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    })

    const refundOrders = []
    let remainingAmount = refundAmount

    for (const order of sortedOrders) {
      if (remainingAmount <= 0) break

      const orderAmount = order.amount / 100
      const refundAmountFromOrder = Math.min(remainingAmount, orderAmount)
      const refundPercent = (refundAmountFromOrder / orderAmount * 100).toFixed(1)

      refundOrders.push({
        order_no: order.order_no,
        product_name: order.product_name,
        amount: (order.amount / 100).toFixed(2),
        refund_amount: refundAmountFromOrder, // 保持为数字类型
        refund_percent: refundPercent
      })

      remainingAmount -= refundAmountFromOrder
    }

    return refundOrders
  },

  // 退款金额输入
  onRefundAmountInput(e) {
    const value = e.detail.value
    const currentRefund = this.data.currentRefund

    // 验证退款金额不能超过可退款金额（单位已经是元）
    const maxAmount = currentRefund.refund_info?.refundable_amount || 0
    const refundAmount = parseFloat(value) || 0

    if (refundAmount > maxAmount) {
      wx.showToast({
        title: `退款金额不能超过 ¥${maxAmount}`,
        icon: 'none'
      })
      return
    }

    // 重新计算退款订单
    const refundOrders = this.calculateRefundOrders(currentRefund, refundAmount)

    // 计算总退款金额（使用数字类型）
    const totalAmount = refundOrders.reduce((sum, order) => sum + parseFloat(order.refund_amount), 0)

    this.setData({
      refundAmount: value,
      refundOrders: refundOrders,
      totalRefundAmount: totalAmount.toFixed(2)
    })
  },

  // 关闭退款弹窗
  closeRefundDialog() {
    this.setData({
      showRefundDialog: false,
      currentRefund: null,
      refundAmount: '',
      refundOrders: [],
      totalRefundAmount: 0
    })
  },

  // 确认退款
  async confirmRefund() {
    console.log('confirm refund ', this.data.currentRefund)
    const { currentRefund, refundAmount, refundOrders } = this.data

    if (!refundAmount || parseFloat(refundAmount) <= 0) {
      wx.showToast({
        title: '请输入退款金额',
        icon: 'none'
      })
      return
    }

    if (refundOrders.length === 0) {
      wx.showToast({
        title: '没有可退款的订单',
        icon: 'none'
      })
      return
    }

    wx.showLoading({
      title: '退款中...'
    })

    try {
      const token = app.getToken()

      if (!app.globalData.cloud) {
        wx.hideLoading()
        wx.showToast({
          title: '云开发未初始化',
          icon: 'none'
        })
        return
      }

      // 调用退款云函数
      const res = await app.globalData.cloud.callFunction({
        name: 'managerRefund',
        data: {
          refundId: currentRefund._id,
          refundAmount: parseFloat(refundAmount),
          refundOrders: refundOrders,
          token: token,
          openid: currentRefund.openid
        }
      })

      console.log('[RefundList] 退款结果:', res)

      wx.hideLoading()

      if (res.result.code === 0) {
        wx.showToast({
          title: '退款成功',
          icon: 'success'
        })
        // 关闭弹窗
        this.closeRefundDialog()
        // 刷新列表
        await this.getRefundList()
      } else {
        wx.showToast({
          title: res.result.message || '退款失败',
          icon: 'none'
        })
      }
    } catch (err) {
      console.error('[RefundList] 退款失败:', err)
      wx.hideLoading()
      wx.showToast({
        title: '退款失败',
        icon: 'none'
      })
    }
  }
})
