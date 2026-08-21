const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// ======== 管理员配置（可选） ========
// 数组留空 = 保持现状：所有用户都是管理员（人人可维护自己的字典数据）
// 填入 openid 后：仅白名单内用户是管理员，普通用户隐藏「基础数据」分组、字典页仅只读
// 获取自己的 openid：云开发控制台 → 数据库 → 任一集合记录的 _openid 字段，或看云函数日志
const ADMIN_OPENIDS = [
  // 'oXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
]

exports.main = async () => {
  const { OPENID } = cloud.getWXContext()
  const isAdmin = ADMIN_OPENIDS.length ? ADMIN_OPENIDS.indexOf(OPENID) > -1 : true
  return { openid: OPENID, isAdmin }
}
