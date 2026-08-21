// 云函数调用统一封装：code!==0 统一抛出带 code/message 的错误
const app = getApp()

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
  if (app.globalData && app.globalData.openid) {
    return Promise.resolve(app.globalData.openid)
  }
  return wx.cloud.callFunction({ name: 'getOpenId' }).then(res => {
    const r = res.result || {}
    const openid = r.openid || ''
    // 兼容旧版 getOpenId 云函数：未返回 isAdmin 字段时按 true 处理（保持"人人可维护"现状，不锁定功能）
    const isAdmin = typeof r.isAdmin === 'boolean' ? r.isAdmin : true
    if (app.globalData) {
      app.globalData.openid = openid
      app.globalData.isAdmin = isAdmin
    }
    return openid
  })
}

// 获取当前用户 openid + 管理员状态（带全局缓存）
function getAdminInfo() {
  if (app.globalData && typeof app.globalData.isAdmin === 'boolean') {
    return Promise.resolve({
      openid: app.globalData.openid || '',
      isAdmin: app.globalData.isAdmin
    })
  }
  return getOpenId().then(openid => {
    const isAdmin = app.globalData && typeof app.globalData.isAdmin === 'boolean'
      ? app.globalData.isAdmin
      : true
    return { openid, isAdmin }
  })
}

module.exports = { call, getOpenId, getAdminInfo }
