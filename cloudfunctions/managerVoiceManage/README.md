# 音色管理云函数

## 功能说明

本云函数用于管理阿里云 DashScope 的声音复刻音色，支持以下操作：

1. **查询音色列表** - 分页查询已创建的音色
2. **删除音色** - 删除指定的音色

## 环境配置

### 必需的环境变量

在云开发控制台配置以下环境变量：

- `DASHSCOPE_API_KEY`: 阿里云 DashScope API Key

获取 API Key 的方法：https://help.aliyun.com/zh/model-studio/get-api-key

### 配置 JWT_SECRET

确保已在云开发环境变量中配置 `JWT_SECRET`，用于用户身份认证。

## 接口说明

### 1. 查询音色列表

**请求参数：**
```javascript
{
  action: 'list',          // 固定值：list
  page_index: 0,            // 页码索引，可选，默认 0
  page_size: 10             // 每页数量，可选，默认 10
}
```

**返回示例：**
```javascript
{
  code: 0,
  message: 'success',
  data: {
    voice_list: [
      {
        voice: 'qwen-tts-vc-guanyu-voice-20250812105009984-838b',
        gmt_create: '2025-08-11 17:59:32',
        target_model: 'qwen3-tts-vc-realtime-2026-01-15'
      }
    ],
    request_id: 'your-request-id'
  }
}
```

**调用示例：**
```javascript
wx.cloud.callFunction({
  name: 'managerVoiceManage',
  data: {
    action: 'list',
    page_index: 0,
    page_size: 10
  }
}).then(res => {
  console.log('音色列表:', res.result.data.voice_list)
})
```

### 2. 删除音色

**请求参数：**
```javascript
{
  action: 'delete',         // 固定值：delete
  voice: 'yourVoiceName'    // 要删除的音色名称
}
```

**返回示例：**
```javascript
{
  code: 0,
  message: 'success',
  data: {
    request_id: 'your-request-id'
  }
}
```

**调用示例：**
```javascript
wx.cloud.callFunction({
  name: 'managerVoiceManage',
  data: {
    action: 'delete',
    voice: 'qwen-tts-vc-guanyu-voice-20250812105009984-838b'
  }
}).then(res => {
  console.log('删除成功')
})
```

## 错误码说明

| 错误码 | 说明 |
|--------|------|
| 0 | 成功 |
| 400 | 请求参数错误 |
| 401 | 未授权或 token 无效 |
| 500 | 服务器内部错误 |

## 注意事项

1. 删除音色后不会恢复免费额度
2. 单个账号最多创建 1000 个音色
3. 若单个音色在过去一年内未被使用，系统会自动删除
4. 使用音色进行语音合成时，指定的模型必须与创建音色时的 target_model 一致

## 技术文档

参考阿里云官方文档：
- [千问声音复刻 API 参考](https://help.aliyun.com/zh/model-studio/qwen-tts-voice-cloning)
