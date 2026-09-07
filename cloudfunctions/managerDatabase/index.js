// 云函数入口文件
const cloud = require('wx-server-sdk')
const { requireAuth } = require('./auth')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

// 充值元宝 -> 实付人民币（元）换算（与前端 database-manage.js 保持一致）
// 基础汇率：10000 元宝 = 1 元；含赠送的套餐按实付金额映射（赠送元宝不计入实付）
const RECHARGE_COINS_TO_RMB = {
  10000: 1,
  100000: 10,
  110000: 10,
  1000000: 100,
  1200000: 100
}
function rechargeCoinsToRmb(coins) {
  const n = Number(coins) || 0
  if (RECHARGE_COINS_TO_RMB[n] != null) return RECHARGE_COINS_TO_RMB[n]
  return n / 10000
}

// 可管理的数据库集合列表
const ALLOWED_COLLECTIONS = [
  "api_key_usage",
  'tts_clone_design_logs',
  "upload_file_logs",
  'black_list',
  'coin_transactions',
  'coins',
  'customer_service_messages',
  'rate_limits',
  'recharge_orders',
  'refund_list',
  'story_audio_projects',
  'user_saved_voices',
  'users'
]

// 大数据量集合列表（默认限制100条）
const LARGE_COLLECTIONS = [
  'tts_clone_design_logs',
  'users',
  'coin_transactions',
  'upload_file_logs',
  'story_audio_projects'
]

/**
 * 查询数据
 * @param {string} collection - 集合名称
 * @param {object} where - 查询条件
 * @param {number} pageIndex - 页码
 * @param {number} pageSize - 每页条数
 * @param {object} orderBy - 排序字段
 * @param {object} timeRange - 时间范围筛选 { startTime, endTime }
 */
async function queryData(collection, where, pageIndex = 0, pageSize = 20, orderBy = { field: '_id', order: 'desc' }, timeRange = null) {
  console.log('[ManagerDatabase] 查询数据:', collection, '条件:', JSON.stringify(where), '时间范围:', JSON.stringify(timeRange))

  if (!ALLOWED_COLLECTIONS.includes(collection)) {
    throw new Error(`不允许操作的集合: ${collection}`)
  }

  // 对于大数据量集合，如果没有时间筛选，默认限制100条；有时间筛选时限制200条避免超时
  const isLargeCollection = LARGE_COLLECTIONS.includes(collection)
  const effectivePageSize = Math.min(pageSize, isLargeCollection ? (timeRange ? 200 : 100) : 100)

  try {
    // 构建查询条件（统一在查询后做服务端过滤，避免 where 条件格式不兼容）
    let queryWhere = { ...where }

    // 构建查询
    let query = db.collection(collection)
    if (queryWhere && Object.keys(queryWhere).length > 0) {
      query = query.where(queryWhere)
    }

    // 获取总数（对于大数据量集合且有时间筛选时）
    let total = 0
    if (isLargeCollection && timeRange) {
      // 先获取总数（限制最大1000条避免性能问题）
      const countResult = await query.count()
      total = Math.min(countResult.total, 1000)
    } else {
      // 对于非大数据量集合或无时间筛选，直接使用限制后的条数
      total = effectivePageSize
    }

    // 分页查询
    const listResult = await query
      .orderBy(orderBy.field, orderBy.order)
      .skip(pageIndex * effectivePageSize)
      .limit(effectivePageSize)
      .get()

    // 对大数据量集合做服务端时间过滤，减少返回数据量
    let resultList = listResult.data
    if (timeRange && timeRange.startTime !== undefined && timeRange.endTime !== undefined) {
      const startTimeNum = Number(timeRange.startTime)
      const endTimeNum = Number(timeRange.endTime)

      // 兼容 created_at 为数字、Date 对象、ISO 字符串等格式
      const toTimestamp = (val) => {
        if (!val) return 0
        return typeof val === 'number' ? val : new Date(val).getTime()
      }

      if (collection === 'tts_clone_design_logs') {
        resultList = resultList.map(item => ({
          ...item,
          logs: (item.logs || []).filter(log => {
            const t = toTimestamp(log.created_at)
            return t >= startTimeNum && t <= endTimeNum
          })
        })).filter(item => item.logs.length > 0)
        console.log(`[ManagerDatabase] logs 服务端过滤后: ${listResult.data.length} -> ${resultList.length} 条文档`)
      } else if (collection === 'users') {
        resultList = resultList.filter(item => {
          const t = toTimestamp(item.created_at)
          return t >= startTimeNum && t <= endTimeNum
        })
        console.log(`[ManagerDatabase] users 服务端过滤后: ${listResult.data.length} -> ${resultList.length} 条`)
      } else if (collection === 'coin_transactions') {
        resultList = resultList.map(item => ({
          ...item,
          transactions: (item.transactions || []).filter(trans => {
            const t = toTimestamp(trans.created_at)
            return t >= startTimeNum && t <= endTimeNum
          })
        })).filter(item => item.transactions.length > 0)
        console.log(`[ManagerDatabase] coins 服务端过滤后: ${listResult.data.length} -> ${resultList.length} 条文档`)
      } else if (collection === 'story_audio_projects') {
        // 每个文档为一个项目，按 created_at 过滤
        resultList = resultList.filter(item => {
          const t = toTimestamp(item.created_at)
          return t >= startTimeNum && t <= endTimeNum
        })
        console.log(`[ManagerDatabase] story_audio_projects 服务端过滤后: ${listResult.data.length} -> ${resultList.length} 条`)
      }
    }

    return {
      code: 0,
      message: 'success',
      data: {
        list: resultList,
        total: total,
        pageIndex: pageIndex,
        pageSize: effectivePageSize,
        hasMore: listResult.data.length === effectivePageSize,
        limited: isLargeCollection && !timeRange
      }
    }
  } catch (err) {
    console.error('[ManagerDatabase] 查询失败:', err)
    throw err
  }
}

/**
 * 仅统计：在服务端按时间范围聚合，分批拉取并即时累加后丢弃（内存有界），只返回统计数字，不返回列表
 * 适用于大数据量集合（近7天/近30天等大范围），避免返回超大列表导致失败
 * @param {string} collection - 集合名称
 * @param {object} where - 查询条件
 * @param {object} timeRange - { startTime, endTime }
 */
async function queryStats(collection, where, timeRange) {
  console.log('[ManagerDatabase] 仅统计:', collection, '时间范围:', JSON.stringify(timeRange))

  if (!ALLOWED_COLLECTIONS.includes(collection)) {
    throw new Error(`不允许操作的集合: ${collection}`)
  }
  if (!timeRange || timeRange.startTime === undefined || timeRange.endTime === undefined) {
    throw new Error('统计需要时间范围参数')
  }

  const start = Number(timeRange.startTime)
  const end = Number(timeRange.endTime)
  const toTimestamp = (val) => (!val ? 0 : (typeof val === 'number' ? val : new Date(val).getTime()))

  // 累加器
  // cloneCount / designCount 仍保留为总数；按 provider 进一步拆分到 *Mimo / *Qwen
  let cloneCount = 0, designCount = 0, mimoChars = 0, qwenChars = 0
  let cloneCountMimo = 0, cloneCountQwen = 0
  let designCountMimo = 0, designCountQwen = 0
  let signCount = 0, adCount = 0, rechargeAmount = 0
  let newUsersCount = 0
  // story_audio_projects 统计
  let storyProjectCount = 0
  let storyDraftCount = 0
  let storyProcessingCount = 0
  let storyCompletedCount = 0
  let storyFailedCount = 0
  let storyCancelledCount = 0
  let storySynthesisCount = 0
  let storyTotalChars = 0

  const BATCH = 20            // 数组型文档较大，单批取小一些避免单次返回超限
  const MAX_BATCHES = 5000    // 安全上限（最多 10万 文档），防止异常死循环
  let pageIndex = 0
  let processedDocs = 0

  const hasWhere = where && Object.keys(where).length > 0

  while (pageIndex < MAX_BATCHES) {
    let q = db.collection(collection)
    if (hasWhere) q = q.where(where)

    const batch = await q
      .orderBy('_id', 'desc')
      .skip(pageIndex * BATCH)
      .limit(BATCH)
      .get()

    const docs = batch.data || []
    if (docs.length === 0) break
    processedDocs += docs.length

    if (collection === 'tts_clone_design_logs') {
      docs.forEach(doc => {
        (doc.logs || []).forEach(log => {
          const t = toTimestamp(log.created_at)
          if (t >= start && t <= end) {
            const type = log.type || ''
            const isMimo = String(log.provider || '').toLowerCase() === 'mimo'
            if (type === 'clone') {
              cloneCount++
              if (isMimo) cloneCountMimo++; else cloneCountQwen++
            } else if (type === 'design') {
              designCount++
              if (isMimo) designCountMimo++; else designCountQwen++
            } else if (type === 'synthesize_mimo') mimoChars += (log.text || '').length
            else if (type === 'synthesize') qwenChars += (log.text || '').length
          }
        })
      })
    } else if (collection === 'coin_transactions') {
      docs.forEach(doc => {
        (doc.transactions || []).forEach(trans => {
          const t = toTimestamp(trans.created_at)
          if (t >= start && t <= end) {
            const source = trans.source || ''
            if (source === 'checkin') signCount++
            else if (source === 'video_ad') adCount++
            else if (source === 'recharge') rechargeAmount += rechargeCoinsToRmb(trans.amount)
          }
        })
      })
    } else if (collection === 'users') {
      docs.forEach(doc => {
        const t = toTimestamp(doc.created_at)
        if (t >= start && t <= end) newUsersCount++
      })
    } else if (collection === 'story_audio_projects') {
      docs.forEach(doc => {
        const t = toTimestamp(doc.created_at)
        if (t < start || t > end) return
        storyProjectCount++
        const status = String(doc.status || '').toLowerCase()
        if (status === 'draft') storyDraftCount++
        else if (status === 'processing') storyProcessingCount++
        else if (status === 'completed' || status === 'success') storyCompletedCount++
        else if (status === 'failed' || status === 'error') storyFailedCount++
        else if (status === 'cancelled' || status === 'canceled') storyCancelledCount++
        // 已完成的合成条数 + 故事正文总字数
        if (Array.isArray(doc.synthesis)) {
          // 仅统计已经生成出 audio_file_id 的合成条目
          storySynthesisCount += doc.synthesis.filter(s => s && s.audio_file_id).length
        }
        const text = (doc.story && doc.story.text) || ''
        if (typeof text === 'string') storyTotalChars += text.length
      })
    }

    if (docs.length < BATCH) break
    pageIndex++
  }

  console.log('[ManagerDatabase] 统计完成，处理文档数:', processedDocs)

  return {
    code: 0,
    message: 'success',
    data: {
      statsOnly: true,
      processedDocs,
      stats: {
        cloneCount,
        designCount,
        cloneCountMimo,
        cloneCountQwen,
        designCountMimo,
        designCountQwen,
        mimoChars,
        qwenChars,
        signCount,
        adCount,
        rechargeAmount: Number(rechargeAmount.toFixed(2)),
        newUsersCount,
        storyProjectCount,
        storyDraftCount,
        storyProcessingCount,
        storyCompletedCount,
        storyFailedCount,
        storyCancelledCount,
        storySynthesisCount,
        storyTotalChars
      }
    }
  }
}

/**
 * 按某一天查询 upload_file_logs（每条文档为单条上传记录）
 * 按 date 倒序扫描并提前终止，兼容 date 为 Date / 时间戳 / ISO 字符串等格式
 * @param {number} startTime - 当天起始时间戳(ms)
 * @param {number} endTime - 当天结束时间戳(ms)
 */
async function queryUploadFilesByDate(startTime, endTime) {
  const start = Number(startTime)
  const end = Number(endTime)
  const toTimestamp = (val) => (!val ? 0 : (typeof val === 'number' ? val : new Date(val).getTime()))

  const BATCH = 100
  const MAX_BATCHES = 1000 // 安全上限
  let pageIndex = 0
  const matched = []

  while (pageIndex < MAX_BATCHES) {
    const res = await db.collection('upload_file_logs')
      .orderBy('date', 'asc')
      .skip(pageIndex * BATCH)
      .limit(BATCH)
      .get()

    const docs = res.data || []
    if (docs.length === 0) break

    for (const doc of docs) {
      const ts = toTimestamp(doc.date)
      if (ts >= start && ts <= end) matched.push(doc)
    }

    // date 升序：本批最后一条已晚于当天终点，则后续都更晚，提前结束
    const lastTs = toTimestamp(docs[docs.length - 1].date)
    if (lastTs > 0 && lastTs > end) break
    if (docs.length < BATCH) break
    pageIndex++
  }

  console.log('[ManagerDatabase] upload_file_logs 按日查询，命中:', matched.length)

  return {
    code: 0,
    message: 'success',
    data: {
      list: matched,
      total: matched.length,
      hasMore: false
    }
  }
}

/**
 * 更新数据
 */
async function updateData(collection, docId, data) {
  console.log('[ManagerDatabase] 更新数据:', collection, 'docId:', docId)

  if (!ALLOWED_COLLECTIONS.includes(collection)) {
    throw new Error(`不允许操作的集合: ${collection}`)
  }

  if (!docId) {
    throw new Error('文档ID不能为空')
  }

  try {
    // 移除不能更新的字段
    const updateData = { ...data }
    delete updateData._id
    delete updateData._openid

    await db.collection(collection).doc(docId).update({
      data: updateData
    })

    return {
      code: 0,
      message: '更新成功',
      data: { docId }
    }
  } catch (err) {
    console.error('[ManagerDatabase] 更新失败:', err)
    throw err
  }
}

/**
 * 删除一条 upload_file_logs：先删除对应的云存储文件，再删除该日志文档
 * @param {string} docId - 日志文档 _id
 * @param {string} fileId - 云存储 file_id（cloud://...）
 */
async function deleteUploadFile(docId, fileId) {
  console.log('[ManagerDatabase] 删除上传记录:', docId, 'file:', fileId)

  if (!docId) {
    throw new Error('文档ID不能为空')
  }

  // 1. 删除云存储文件（文件可能已不存在，失败不阻断日志删除）
  let fileDeleted = false
  let fileError = null
  if (fileId) {
    try {
      const delRes = await cloud.deleteFile({ fileList: [fileId] })
      const f = delRes.fileList && delRes.fileList[0]
      if (f && f.status === 0) {
        fileDeleted = true
      } else {
        fileError = (f && (f.errmsg || f.errMsg)) || '云文件删除失败'
      }
    } catch (err) {
      fileError = err.message || String(err)
    }
    console.log('[ManagerDatabase] 云文件删除结果:', fileDeleted, fileError || '')
  }

  // 2. 删除日志文档
  await db.collection('upload_file_logs').doc(docId).remove()

  return {
    code: 0,
    message: '删除成功',
    data: { docId, fileDeleted, fileError }
  }
}

/**
 * 删除数据
 */
async function deleteData(collection, docId) {
  console.log('[ManagerDatabase] 删除数据:', collection, 'docId:', docId)

  if (!ALLOWED_COLLECTIONS.includes(collection)) {
    throw new Error(`不允许操作的集合: ${collection}`)
  }

  if (!docId) {
    throw new Error('文档ID不能为空')
  }

  try {
    await db.collection(collection).doc(docId).remove()

    return {
      code: 0,
      message: '删除成功',
      data: { docId }
    }
  } catch (err) {
    console.error('[ManagerDatabase] 删除失败:', err)
    throw err
  }
}

/**
 * 获取集合结构信息（采样）
 */
async function getCollectionSchema(collection) {
  console.log('[ManagerDatabase] 获取集合结构:', collection)

  if (!ALLOWED_COLLECTIONS.includes(collection)) {
    throw new Error(`不允许操作的集合: ${collection}`)
  }

  try {
    // 采样几条数据获取字段结构
    const sample = await db.collection(collection).limit(3).get()

    // 分析字段类型
    const fields = new Set()
    sample.data.forEach(doc => {
      Object.keys(doc).forEach(key => fields.add(key))
    })

    return {
      code: 0,
      message: 'success',
      data: {
        collection: collection,
        fields: Array.from(fields),
        sampleCount: sample.data.length
      }
    }
  } catch (err) {
    console.error('[ManagerDatabase] 获取结构失败:', err)
    throw err
  }
}

// 云函数入口函数
exports.main = async (event, context) => {
  console.log('[ManagerDatabase] ===== 数据库管理 =====')
  console.log('[ManagerDatabase] 操作:', event.action)

  // 验证用户身份
  const auth = requireAuth(event)
  if (!auth.success) {
    return {
      code: 401,
      message: '未授权，请先登录',
      data: null
    }
  }

  const { action, collection, where, data, docId, pageIndex, pageSize, orderBy } = event

  try {
    let result

    // 提取时间范围参数
    const timeRange = event.timeRange || null

    switch (action) {
      case 'query':
        result = await queryData(collection, where || {}, pageIndex || 0, pageSize || 20, orderBy, timeRange)
        break

      case 'stats':
        result = await queryStats(collection, where || {}, timeRange)
        break

      case 'upload_by_date':
        result = await queryUploadFilesByDate(event.startTime, event.endTime)
        break

      case 'delete_upload':
        result = await deleteUploadFile(docId, event.fileId)
        break

      case 'update':
        result = await updateData(collection, docId, data || {})
        break

      case 'delete':
        result = await deleteData(collection, docId)
        break

      case 'schema':
        result = await getCollectionSchema(collection)
        break

      case 'collections':
        result = {
          code: 0,
          message: 'success',
          data: { collections: ALLOWED_COLLECTIONS }
        }
        break

      default:
        return {
          code: 400,
          message: `不支持的操作类型: ${action}`,
          data: null
        }
    }

    return result
  } catch (err) {
    console.error('[ManagerDatabase] 操作失败:', err)
    return {
      code: 500,
      message: err.message || '操作失败',
      data: null
    }
  }
}
