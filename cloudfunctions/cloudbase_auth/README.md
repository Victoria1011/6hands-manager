# cloudbase_auth 云函数

此云函数用于小程序间跨账号环境共享的鉴权，控制哪些小程序可以访问当前小程序的云开发资源。

## 功能说明

当其他小程序尝试使用共享环境时，资源方小程序的 `cloudbase_auth` 云函数会被调用，用于：
1. 鉴权调用方的身份（来源方 AppID、OpenID、UnionID）
2. 决定是否允许访问
3. 返回自定义安全规则供安全规则引擎使用

## 使用步骤

### 1. 配置白名单

编辑 `index.js` 文件，在 `allowedAppids` 数组中添加允许访问的小程序 AppID：

```javascript
const allowedAppids = [
  'wx1234567890abcdef',  // 添加小程序 AppID
  'wx9876543210fedcba'   // 可以添加多个
]
```

### 2. 开通环境共享

1. 进入微信开发者工具
2. 进入云开发控制台
3. 点击「设置」→「拓展能力」→「环境共享」
4. 点击「开通」环境共享能力

### 3. 授权共享

1. 在云开发控制台，点击「环境共享」
2. 点击「添加共享」
3. 选择要共享的云环境和授权权限
4. 选择要授权的小程序或公众号

### 4. 被授权方使用

在被授权的小程序中，使用以下代码访问共享资源：

```javascript
// 声明新的 cloud 实例
const c1 = new wx.cloud.Cloud({
  resourceAppid: '资源方AppID',    // 当前小程序的 AppID
  resourceEnv: '资源方环境ID'       // 共享的环境 ID
})

// 跨账号调用，必须等待 init 完成
await c1.init()

// 完成后正常使用资源方的已授权的云资源
await c1.callFunction({
  name: 'synthesize',
  data: { /* 参数 */ },
})

// 访问数据库
const db = c1.database()
const result = await db.collection('users').get()

// 访问云存储
const uploadResult = await c1.uploadFile({
  cloudPath: 'test.jpg',
  filePath: tempFilePath
})
```

### 5. 云函数中使用

```javascript
const cloud = require('wx-server-sdk')

exports.main = async (event) => {
  const c1 = new cloud.Cloud({
    resourceAppid: '资源方AppID',
    resourceEnv: '资源方环境ID'
  })

  await c1.init()

  return c1.callFunction({
    name: '函数名',
    data: {}
  })
}
```

## 自定义安全规则

`cloudbase_auth` 返回的 `auth` 对象可以在安全规则中通过 `auth.custom` 字段访问：

```javascript
// 示例安全规则
{
  "read": "auth.custom.appid === 'wx1234567890abcdef'",
  "write": "auth.custom.appid === 'wx1234567890abcdef'"
}
```

或更细粒度的控制：

```javascript
{
  "read": "auth.custom.permissions && auth.custom.permissions.collections.indexOf('users') > -1",
  "write": "auth.custom.permissions && auth.custom.permissions.collections.indexOf('users') > -1"
}
```

## 日志说明

云函数会记录以下日志：
- 来源方 AppID (`wxContext.FROM_APPID`)
- 来源方 OpenID (`wxContext.FROM_OPENID`)
- 来源方 UnionID (`wxContext.FROM_UNIONID`)
- 授权结果

可以在云函数日志中查看这些信息，用于调试和审计。

## 注意事项

1. 必须先配置白名单，否则所有跨账号访问都会被拒绝
2. 白名单为空数组时，所有访问都会被拒绝
3. 建议定期审查白名单，移除不再需要访问的小程序
4. 可以通过 `allowedAppids` 和 `auth.custom.permissions` 实现更精细的权限控制

## 安全建议

1. **最小权限原则**：只授权必要的权限，不要开放全部权限
2. **定期审计**：定期检查授权情况和访问日志
3. **环境隔离**：不同的小程序使用不同的环境
4. **数据隔离**：通过自定义安全规则确保数据安全

## 文档参考

- [小程序环境共享 - 微信开放文档](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/guide/resource-sharing/)
