const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 云函数入口：返回当前调用者 openid，用于"仅作者可见"权限判断
exports.main = async () => {
  const { OPENID } = cloud.getWXContext()
  return { openid: OPENID }
}
