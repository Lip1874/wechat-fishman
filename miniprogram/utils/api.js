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

// 获取当前用户 openid（全局缓存，避免重复调用云函数）
function getOpenId() {
  if (app.globalData && app.globalData.openid) {
    return Promise.resolve(app.globalData.openid)
  }
  return wx.cloud.callFunction({ name: 'getOpenId' }).then(res => {
    const openid = res.result.openid
    if (app.globalData) app.globalData.openid = openid
    return openid
  })
}

module.exports = { call, getOpenId }
