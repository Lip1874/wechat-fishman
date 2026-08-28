// ============================================================
// loginService —— 微信一键登录（静默鉴权）
// ------------------------------------------------------------
// 原理：小程序调用云函数时，微信侧会自动把当前用户的 OPENID 注入
// 到 cloud.getWXContext()，无需 wx.login / wx.getUserProfile 弹窗，
// 天然满足"静默鉴权、不强制弹窗"的微信审核要求。
//
// 职责：
//   1. 获取当前用户 OPENID（唯一身份）
//   2. 校验 user 集合中是否存在该用户（以 openid 作为 _id 主键）
//   3. 不存在则自动建档（nickName/avatarUrl 留空，后续在「我的」页完善）
//   4. 已存在则刷新 lastLoginTime
// ============================================================
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

// 统一成功响应
function ok(data = {}) {
  return { code: 0, ...data }
}

// 统一失败响应（禁止裸抛原始报错给前端）
function fail(msg, code = -1) {
  return { code, msg: msg || '服务异常，请稍后重试' }
}

// 登录（静默）：openid 主键校验 + 自动建档
async function login(OPENID) {
  const userColl = db.collection('user')
  let user = null
  let isNewUser = false

  try {
    // 以 openid 作为 _id 直接读取，速度快且天然唯一
    const res = await userColl.doc(OPENID).get()
    user = res.data
  } catch (err) {
    // 文档不存在（首次登录）：标记为新建
    isNewUser = true
  }

  const now = db.serverDate()

  if (isNewUser) {
    // 自动建档：openid 作为唯一主键，防止重复注册
    const newUser = {
      _id: OPENID,
      nickName: '',
      avatarUrl: '',
      createTime: now,
      updateTime: now,
      lastLoginTime: now
    }
    await userColl.doc(OPENID).set({ data: newUser })
    user = newUser
  } else {
    // 老用户：仅刷新最近登录时间，不动其他字段
    await userColl.doc(OPENID).update({
      data: { lastLoginTime: now, updateTime: now }
    })
  }

  return ok({
    openid: OPENID,
    isNewUser,
    user: {
      nickName: user.nickName || '',
      avatarUrl: user.avatarUrl || ''
    }
  })
}

// 读取用户资料（未建档返回 null，供前端展示兜底）
async function getUser(OPENID) {
  try {
    const res = await db.collection('user').doc(OPENID).get()
    return ok({ user: res.data })
  } catch (err) {
    return ok({ user: null })
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'login'
  try {
    switch (action) {
      case 'login': return await login(OPENID)
      case 'getUser': return await getUser(OPENID)
      default: return fail('未知操作')
    }
  } catch (err) {
    console.error(`loginService.${action} error`, err)
    return fail(err.errMsg || err.message || '服务异常，请稍后重试')
  }
}
