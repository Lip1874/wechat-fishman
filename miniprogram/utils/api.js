// 云函数调用统一封装：code!==0 统一抛出带 code/message 的错误
// App 实例需在使用处实时获取：app.js 的 onLaunch 会 require 本模块，
// 此时 getApp() 可能尚未就绪返回 undefined，模块顶层缓存会导致 app.globalData 抛错
function getAppInstance() {
  try {
    return getApp()
  } catch (e) {
    return null
  }
}

function call(name, data = {}) {
  return wx.cloud.callFunction({ name, data }).then(res => {
    const r = res.result || {}
    if (r.code !== 0) {
      const err = new Error(r.msg || '操作失败')
      err.code = r.code
      throw err
    }
    return r
  })
}

// 获取当前用户 openid（全局缓存，避免重复调用云函数），同时缓存 isAdmin
function getOpenId() {
  const app = getAppInstance()
  if (app && app.globalData && app.globalData.openid) {
    return Promise.resolve(app.globalData.openid)
  }
  return wx.cloud.callFunction({ name: 'getOpenId' }).then(res => {
    const r = res.result || {}
    const openid = r.openid || ''
    // 兼容旧版 getOpenId 云函数：未返回 isAdmin 字段时按 true 处理（保持"人人可维护"现状，不锁定功能）
    const isAdmin = typeof r.isAdmin === 'boolean' ? r.isAdmin : true
    const cur = getAppInstance()
    if (cur && cur.globalData) {
      cur.globalData.openid = openid
      cur.globalData.isAdmin = isAdmin
    }
    return openid
  })
}

// 获取当前用户 openid + 管理员状态（带全局缓存）
function getAdminInfo() {
  const app = getAppInstance()
  if (app && app.globalData && typeof app.globalData.isAdmin === 'boolean') {
    return Promise.resolve({
      openid: app.globalData.openid || '',
      isAdmin: app.globalData.isAdmin
    })
  }
  return getOpenId().then(openid => {
    const cur = getAppInstance()
    const isAdmin = cur && cur.globalData && typeof cur.globalData.isAdmin === 'boolean'
      ? cur.globalData.isAdmin
      : true
    return { openid, isAdmin }
  })
}

// 获取系统信息（缓存）
// 新基础库用 wx.getWindowInfo / wx.getAppBaseInfo / wx.getDeviceInfo 组合，
// 旧基础库回退 wx.getSystemInfoSync（已废弃，仅兼容）
function getCachedSystemInfo() {
  const app = getAppInstance()
  if (app && app.globalData && app.globalData.systemInfo) {
    return app.globalData.systemInfo
  }
  let info = {}
  try {
    if (wx.getWindowInfo && wx.getAppBaseInfo && wx.getDeviceInfo) {
      info = Object.assign(
        {},
        wx.getDeviceInfo(),
        wx.getAppBaseInfo(),
        wx.getWindowInfo()
      )
    } else if (wx.getSystemInfoSync) {
      info = wx.getSystemInfoSync()
    }
  } catch (e) {
    try {
      if (wx.getSystemInfoSync) info = wx.getSystemInfoSync()
    } catch (e2) { /* 忽略 */ }
  }
  if (app && app.globalData) app.globalData.systemInfo = info
  return info
}

// ========== 用户中心相关接口 ==========
function getUserInfo() {
  return call('userService', { action: 'getUserInfo' })
}

function getUserStats() {
  return call('userService', { action: 'getStats' })
}

function updateProfile(data) {
  return call('userService', { action: 'updateProfile', ...data })
}

function updateSyncConfig(mode) {
  return call('userService', { action: 'updateSyncConfig', mode })
}

function getModelProgress() {
  return call('userService', { action: 'getModelProgress' })
}

function getDiagnosisInfo() {
  return call('userService', {
    action: 'getDiagnosisInfo',
    clientInfo: getCachedSystemInfo()
  })
}

// 解析头像地址：fileID 转换为临时 HTTPS URL；已是网络地址则直接返回
function resolveAvatarUrl(avatarUrl) {
  if (!avatarUrl) return Promise.resolve('')
  if (String(avatarUrl).indexOf('cloud://') !== 0) return Promise.resolve(avatarUrl)
  return wx.cloud.getTempFileURL({ fileList: [avatarUrl] })
    .then(res => {
      const item = res.fileList && res.fileList[0]
      return item && item.tempFileURL ? item.tempFileURL : ''
    })
    .catch(() => '')
}

// 判断是否为微信本地临时文件路径（chooseAvatar / getUserProfile 返回的临时头像路径）
function isTempFile(path) {
  if (!path || typeof path !== 'string') return false
  return path.indexOf('wxfile://') === 0 || path.indexOf('http://tmp') === 0 || path.indexOf('tmp/') > -1
}

// 上传头像到云存储，返回持久 fileID（供 user_profile.avatarUrl 长期引用）
function uploadAvatar(filePath) {
  const app = getAppInstance()
  const openid = app && app.globalData && app.globalData.openid ? app.globalData.openid : ''
  const match = String(filePath).match(/\.[a-zA-Z0-9]+$/)
  const suffix = match ? match[0] : '.jpg'
  const cloudPath = `avatars/${openid ? openid.slice(-12) + '-' : ''}${Date.now()}${suffix}`
  return wx.cloud.uploadFile({ cloudPath, filePath }).then(res => res.fileID)
}

// ========== 登录状态（资料完善度）相关 ==========
// 拉取并缓存当前用户资料（userService.getUserInfo 会自动创建 user_profile）
function getCachedUserProfile() {
  return getUserInfo().then(res => {
    const profile = (res && res.profile) || {}
    const app = getAppInstance()
    if (app && app.globalData) app.globalData.userProfile = profile
    return profile
  })
}

// 是否已登录：以是否完善昵称为准（带全局缓存，资料更新后缓存同步刷新）
function isLoggedIn() {
  const app = getAppInstance()
  const cached = app && app.globalData && app.globalData.userProfile
  if (cached && cached.nickName && String(cached.nickName).trim()) {
    return Promise.resolve(true)
  }
  return getCachedUserProfile()
    .then(profile => !!(profile.nickName && String(profile.nickName).trim()))
    .catch(() => false)
}

// 确保已登录：未登录时提示"请先登录"并引导到个人资料页，返回 Promise<boolean>
function ensureLogin() {
  return isLoggedIn().then(ok => {
    if (ok) return true
    wx.showModal({
      title: '请先登录',
      content: '请先完善昵称等个人信息后再操作',
      confirmText: '去完善',
      cancelText: '取消',
      success: r => {
        if (r.confirm) wx.navigateTo({ url: '/pages/profile/profile' })
      }
    })
    return false
  })
}

// ========== 鱼护记录（电子鱼护）相关接口 ==========
function listFishCatches(data = {}) {
  return call('fishLogService', Object.assign({ action: 'list' }, data))
}

function getFishSummary(month) {
  const data = { action: 'summary' }
  if (month) data.month = month
  return call('fishLogService', data)
}

function getFishPointStats(month) {
  const data = { action: 'pointStats' }
  if (month) data.month = month
  return call('fishLogService', data)
}

function saveFishCatch(payload, id) {
  return call('fishLogService', { action: 'save', id: id || '', data: payload })
}

function removeFishCatch(id) {
  return call('fishLogService', { action: 'remove', id })
}

function quickAddFishCatch(fishName, count) {
  return call('fishLogService', { action: 'quickAdd', fishName, count })
}

module.exports = {
  call,
  getOpenId,
  getAdminInfo,
  getCachedSystemInfo,
  getUserInfo,
  getUserStats,
  updateProfile,
  updateSyncConfig,
  getModelProgress,
  getDiagnosisInfo,
  resolveAvatarUrl,
  isTempFile,
  uploadAvatar,
  getCachedUserProfile,
  isLoggedIn,
  ensureLogin,
  // 鱼护相关接口
  listFishCatches,
  getFishSummary,
  getFishPointStats,
  saveFishCatch,
  removeFishCatch,
  quickAddFishCatch
}
