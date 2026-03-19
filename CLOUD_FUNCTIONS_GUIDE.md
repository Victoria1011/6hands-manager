# 管理员云函数使用指南

## 云函数列表

### 1. manager-login
管理员登录云函数，集成了登录和 token 验证功能。

**功能：**
- 验证管理员用户名和密码
- 生成 JWT token（有效期 24 小时）
- 验证 JWT token 有效性

---

## 接口说明

### 1. 登录接口

**请求参数：**
```javascript
{
  action: "login",
  username: "admin",  // 用户名
  password: "123456"  // 密码
}
```

**返回结果：**
```javascript
{
  code: 200,
  message: "登录成功",
  data: {
    token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    userId: "user_id_here",
    username: "admin",
    role: "admin"
  }
}
```

---

### 2. Token 验证接口

**请求参数：**
```javascript
{
  action: "verify",
  token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**返回结果：**
```javascript
{
  code: 200,
  message: "Token 验证成功",
  data: {
    userId: "user_id_here",
    username: "admin",
    role: "admin",
    exp: 1672531200,
    iat: 1672444800
  }
}
```

---

## auth.js 工具模块

云函数使用独立的 `auth.js` 模块来处理 JWT 相关操作：

### generateToken(payload)
生成 JWT token

```javascript
const { generateToken } = require('./auth');
const token = generateToken({ userId, username, role });
```

### verifyToken(token)
验证 JWT token

```javascript
const { verifyToken } = require('./auth');
const result = verifyToken(token);
// result.valid: true/false
// result.data: 解码后的数据
```

### decodeToken(token)
解码 JWT token（不验证签名，仅用于调试）

```javascript
const { decodeToken } = require('./auth');
const data = decodeToken(token);
```

---

## 部署步骤

### 1. 安装依赖
在云函数目录下安装依赖：

```bash
# 进入云函数目录
cd cloudfunctions/manager-login
npm install
```

### 2. 上传并部署云函数
在微信开发者工具中：
1. 右键点击 `cloudfunctions/manager-login` 目录
2. 选择「上传并部署：云端安装依赖」
3. 等待上传完成

---

## 数据库初始化

### 创建管理员集合
在云开发控制台创建 `managers` 集合，并添加管理员账号：

```javascript
{
  _id: "自动生成",
  username: "admin",
  password: "123456",  // 实际项目建议使用 bcrypt 加密
  role: "admin",
  createTime: "2024-01-01T00:00:00.000Z",
  status: "active"
}
```

### 安全建议
1. **修改 JWT 密钥**：在 `cloudfunctions/manager-login/auth.js` 中修改 `JWT_SECRET` 为复杂的随机字符串
2. **密码加密**：实际项目中使用 bcrypt 等方式加密存储密码
3. **使用环境变量**：可以将 `JWT_SECRET` 配置在云开发环境变量中，然后在 `auth.js` 中读取

---

## 前端调用示例

### 登录
```javascript
wx.cloud.callFunction({
  name: 'manager-login',
  data: {
    action: 'login',
    username: 'admin',
    password: '123456'
  }
}).then(res => {
  if (res.result.code === 200) {
    const token = res.result.data.token;
    // 存储 token 到本地
    wx.setStorageSync('managerToken', token);
  }
});
```

### 验证 Token
```javascript
const token = wx.getStorageSync('managerToken');

wx.cloud.callFunction({
  name: 'manager-login',
  data: {
    action: 'verify',
    token: token
  }
}).then(res => {
  if (res.result.code === 200) {
    console.log('Token 有效', res.result.data);
  } else {
    console.log('Token 无效或已过期');
    // 跳转到登录页
  }
});
```

---

## 错误码说明

| 错误码 | 说明 |
|--------|------|
| 200 | 成功 |
| 400 | 请求参数错误 |
| 401 | 认证失败（用户名密码错误或 token 无效） |
| 500 | 服务器内部错误 |
