// 云函数入口文件
const cloud = require('wx-server-sdk')
const { requireAuth } = require('./auth')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

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
  'user_saved_voices',
  'users'
]

/**
 * 查询数据
 */
async function queryData(collection, where, pageIndex = 0, pageSize = 20, orderBy = { field: '_id', order: 'desc' }) {
  console.log('[ManagerDatabase] 查询数据:', collection, '条件:', JSON.stringify(where))

  if (!ALLOWED_COLLECTIONS.includes(collection)) {
    throw new Error(`不允许操作的集合: ${collection}`)
  }

  try {
    let query = db.collection(collection)

    // 添加查询条件
    if (where && Object.keys(where).length > 0) {
      query = query.where(where)
    }

    // 获取总数
    const countResult = await query.count()
    const total = countResult.total

    // 分页查询
    const listResult = await query
      .orderBy(orderBy.field, orderBy.order)
      .skip(pageIndex * pageSize)
      .limit(pageSize)
      .get()

    return {
      code: 0,
      message: 'success',
      data: {
        list: listResult.data,
        total: total,
        pageIndex: pageIndex,
        pageSize: pageSize
      }
    }
  } catch (err) {
    console.error('[ManagerDatabase] 查询失败:', err)
    throw err
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

    switch (action) {
      case 'query':
        result = await queryData(collection, where || {}, pageIndex || 0, pageSize || 20, orderBy)
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
