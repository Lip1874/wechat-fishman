// ============================================================
// 通用登录工具 —— 微信一键授权（静默鉴权）
// ------------------------------------------------------------
// 设计原则：
//   1. 游客可直接浏览首页 / 钓点地图，无需登录（微信审核要求）
//   2. 仅在点击【新增标点】【我的】等需要身份的入口时才调用 ensureLogin()
//   3. 登录 = 静默获取 openid：调用云函数时微信自动注入身份，
//      不弹 wx.getUserProfile 授权窗，符合"静默鉴权、不强行弹窗"
//   4. loginService 云函数会以 openid 为主键在 user 集合自动建档
//   5. openid 本地缓存（storage），避免重复调用云函数
// ------------------------------------------------------------
// 用法示例（页面中）：
//   const { ensureLogin } = require('../../utils/login')
//   ensureLogin().then(openid => { /* 已登录，继续操作 */ })
//           .catch(err => { /* 登录失败，提示重试 */ })
// ============================================================

// App 实例需在使用处实时获取：app.js 的 onLaunch 会 require 本模块，
// 此时 getApp() 可能尚未就绪返回 undefined，若在模块顶层缓存该值，
// 后续 app.globalData 会抛出 "undefined is not an object (evaluating 'a.globalData')"
function getAppInstance() {
  try {
    return getApp()
  } catch (e) {
    return null
  }
}

// 本地缓存 key
const OPENID_STORAGE_KEY = 'fishman_openid'

// 在途请求锁：同一时刻只允许一个获取 openid 的云函数请求
let fetching = null

// 从本地缓存读取 openid
function getCachedOpenId() {
  try {
    const openid = wx.getStorageSync(OPENID_STORAGE_KEY)
    return typeof openid === 'string' && openid ? openid : ''
  } catch (e) {
    return ''
  }
}

// 写入本地缓存 + 内存缓存（globalData）
function cacheOpenId(openid) {
  if (!openid) return
  try {
    wx.setStorageSync(OPENID_STORAGE_KEY, openid)
  } catch (e) {
    // 存储失败不影响内存缓存
  }
  const app = getAppInstance()
  if (app && app.globalData) app.globalData.openid = openid
}

// 静默获取 openid（Promise<string>）
// 读取顺序：globalData -> 本地缓存 -> 云函数 loginService（登录+自动建档）
// 云函数每次调用都会校验 user 集合，不存在则自动创建，天然幂等
function getOpenId() {
  const app = getAppInstance()
  // 1. 内存缓存命中
  if (app && app.globalData && app.globalData.openid) {
    return Promise.resolve(app.globalData.openid)
  }
  // 2. 本地缓存命中
  const cached = getCachedOpenId()
  if (cached) {
    if (app && app.globalData) app.globalData.openid = cached
    return Promise.resolve(cached)
  }
  // 3. 并发去重：已有在途请求直接复用
  if (fetching) return fetching

  fetching = wx.cloud
    .callFunction({ name: 'loginService', data: { action: 'login' } })
    .then(res => {
      const r = res.result || {}
      if (r.code !== 0) throw new Error(r.msg || '登录失败，请稍后重试')
      const openid = r.openid || ''
      if (!openid) throw new Error('登录失败，未获取到用户身份')
      cacheOpenId(openid)
      const app = getAppInstance()
      if (app && app.globalData) {
        app.globalData.user = r.user || null
        app.globalData.isNewUser = !!r.isNewUser
      }
      return openid
    })
    .catch(err => {
      fetching = null // 失败立即释放锁，允许下次重试
      throw err
    })
    .then(openid => {
      fetching = null // 成功后释放锁
      return openid
    })
  return fetching
}

// 一键登录入口（Promise<string>）
// 语义：确保用户已静默登录并返回 openid；失败时 reject（调用方决定是否提示）
function ensureLogin() {
  return getOpenId()
}

// 获取当前用户资料（可能为 null：尚未建档）
// 优先读内存缓存，否则调用云函数拉取 user 集合
function getCachedUser() {
  const app = getAppInstance()
  if (app && app.globalData && app.globalData.user) {
    return Promise.resolve(app.globalData.user)
  }
  return getOpenId()
    .then(() => wx.cloud.callFunction({ name: 'loginService', data: { action: 'getUser' } }))
    .then(res => {
      const r = res.result || {}
      const user = r.user || null
      const cur = getAppInstance()
      if (cur && cur.globalData) cur.globalData.user = user
      return user
    })
    .catch(() => null)
}

// 登出（清除本地登录缓存；不影响云端 user 记录）
function logout() {
  try {
    wx.removeStorageSync(OPENID_STORAGE_KEY)
  } catch (e) {
    // 忽略存储异常
  }
  const app = getAppInstance()
  if (app && app.globalData) {
    app.globalData.openid = ''
    app.globalData.user = null
    app.globalData.isNewUser = false
  }
}

module.exports = {
  getOpenId,
  ensureLogin,
  getCachedUser,
  logout,
  OPENID_STORAGE_KEY
}
