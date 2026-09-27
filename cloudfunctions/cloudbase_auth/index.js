// 云函数入口文件
const cloud = require('wx-server-sdk')
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

// ==========================================================================
// 授权策略配置（按来源方 AppID）
// --------------------------------------------------------------------------
// 工作原理：
//   cloudbase_auth 是环境共享的授权函数，仅在调用方 cloud.init() 时执行一次，
//   无法感知调用方后续具体调用了哪个云函数、访问了哪个集合/文件。
//   它负责：
//     1. 校验来源方身份（AppID / OpenID 白名单）；
//     2. 返回权限清单 auth，云开发会将其注入资源方安全规则的 auth.custom 字段；
//     3. 资源级校验需在云开发控制台为各资源配置安全规则，每次调用都会引用
//        auth.custom.permissions 做细粒度校验，示例见下方注释。
//
// 云函数安全规则（云开发控制台 - 云函数 - 安全规则，支持函数名级 invoke 控制）：
//   {
//     "*": { "invoke": "auth.custom != null" },
//     "synthesize": { "invoke": "'synthesize' in auth.custom.permissions.functions" }
//   }
//
// 数据库集合安全规则（数据库 - 集合 - 权限设置 - 自定义安全规则，以 users 为例）：
//   {
//     "read": "'users' in auth.custom.permissions.collections",
//     "write": false
//   }
//
// 云存储安全规则（存储 - 权限设置 - 自定义安全规则）：
//   {
//     "read": "auth.custom != null",
//     "write": false
//   }
// ==========================================================================

// 各来源方允许访问的资源清单（空数组 = 不允许任何该类资源，建议按需最小化授权）
const AUTH_POLICIES = {
  // sixhands-manager
  'wx6abc7cafcf01cb1b': {
    // 允许的来源方用户 OpenID 白名单，'*' 表示不限制该小程序下的所有用户
    allowedOpenids: [
      'oAfY648UXQt0aiK9GxpJEJxgdpiw',
      'oAfY641JRaWvKz3JXmXAC88fZVYY'
    ],
    // 允许前端直接读写的数据库集合
    collections: [
      // 'users',
      // 'coins',
      // 'tts_clone_design_logs'
    ],
    // 允许调用的云函数
    functions: [
      // 'synthesize',
      // 'designVoice',
      // 'cloneVoice'
    ],
    // 允许访问的云存储路径前缀，如 'public/audio/'
    storagePrefixes: [
      // 'public/'
    ]
  },
  // tts-home
  'wx9f7892ba3915a8f3': {
    allowedOpenids: ['*'],
    collections: [
      'tts-home-user-info'
    ],
    functions: [
      'ttsHomeCloudGetInfo',
      'ttsHomeCloudSetInfo'
    ],
    storagePrefixes: []
  }
}

// 云函数入口函数
exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()

  console.log('[cloudbase_auth] 收到请求')
  console.log('[cloudbase_auth] event:', JSON.stringify(event))
  console.log('[cloudbase_auth] wxContext:', JSON.stringify(wxContext))

  // 跨账号调用时，由此拿到来源方小程序/公众号 AppID
  const fromAppid = wxContext.FROM_APPID
  // 跨账号调用时，由此拿到来源方小程序/公众号的用户 OpenID
  const fromOpenid = wxContext.FROM_OPENID
  // 跨账号调用、且满足 unionid 获取条件时，由此拿到同主体下的用户 UnionID
  const fromUnionid = wxContext.FROM_UNIONID
  console.log('[cloudbase_auth] 来源方 AppID:', fromAppid, 'OpenID:', fromOpenid)

  const deny = (msg) => {
    console.log('[cloudbase_auth] 授权失败：' + msg)
    return {
      errCode: -1,
      errMsg: '未授权访问',
      auth: ''
    }
  }

  // 1. 校验来源方 AppID 是否配置了授权策略
  const policy = AUTH_POLICIES[fromAppid]
  if (!policy) {
    return deny(`来源方 AppID ${fromAppid} 不在授权策略中`)
  }

  // 2. 校验来源方用户 OpenID
  if (!fromOpenid) {
    return deny('缺少来源方 OpenID')
  }
  if (!policy.allowedOpenids.includes('*') && !policy.allowedOpenids.includes(fromOpenid)) {
    return deny(`来源方 OpenID ${fromOpenid} 不在白名单中`)
  }

  console.log('[cloudbase_auth] 授权成功，下发权限清单')

  return {
    errCode: 0,
    errMsg: '',
    // 该对象会注入资源方安全规则的 auth.custom 字段，
    // 安全规则中通过 auth.custom.appid / auth.custom.permissions.* 做校验
    auth: JSON.stringify({
      // 标记来源方 AppID，安全规则可通过 auth.custom.appid 获取
      appid: fromAppid,

      // 标记来源方 OpenID，安全规则可通过 auth.custom.openid 获取
      openid: fromOpenid,

      // 如果有 UnionID，也可标记，安全规则可通过 auth.custom.unionid 获取
      unionid: fromUnionid || '',

      // 标记授权时间
      timestamp: Date.now(),

      // 权限清单：资源方安全规则按此逐次校验具体资源访问
      permissions: {
        // 允许访问的数据库集合
        collections: policy.collections,
        // 允许调用的云函数
        functions: policy.functions,
        // 允许访问的云存储路径前缀
        storagePrefixes: policy.storagePrefixes
      }
    })
  }
}
