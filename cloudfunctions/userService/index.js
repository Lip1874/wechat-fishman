const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

// 管理员 openid 白名单（空数组表示人人都是管理员，兼容现有逻辑）
const ADMIN_OPENIDS = []

// 同步模式合法取值
const SYNC_MODE_OPTIONS = ['cloud', 'local']

// 统一成功响应
function ok(data = {}) {
  return { code: 0, ...data }
}

// 统一失败响应（禁止裸抛原始报错给前端）
function fail(msg, code = -1) {
  return { code, msg: msg || '服务异常，请稍后重试' }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action
  try {
    switch (action) {
      case 'getUserInfo': return await getUserInfo(OPENID, event)
      case 'getStats': return await getStats(OPENID, event)
      case 'getProfile': return await getProfile(OPENID)
      case 'updateProfile': return await updateProfile(OPENID, event)
      case 'updateSyncConfig': return await updateSyncConfig(OPENID, event)
      case 'getModelProgress': return await getModelProgress(OPENID)
      case 'getDiagnosisInfo': return await getDiagnosisInfo(OPENID, event)
      default: return fail('未知操作')
    }
  } catch (err) {
    console.error(`userService.${action} error`, err)
    return fail(err.errMsg || err.message || '服务异常，请稍后重试')
  }
}

// 判断管理员：白名单为空时默认 true，与 getOpenId 云函数保持一致
function checkAdmin(openid) {
  return ADMIN_OPENIDS.length ? ADMIN_OPENIDS.indexOf(openid) > -1 : true
}

// 安全截断字符串
function safeString(raw, maxLen = 100) {
  if (raw === undefined || raw === null) return ''
  return String(raw).trim().slice(0, maxLen)
}

// 获取/创建用户资料
async function getOrCreateProfile(openid) {
  const res = await db.collection('user_profile').where({ _openid: openid }).limit(1).get()
  if (res.data && res.data.length) return res.data[0]

  const defaultProfile = {
    _openid: openid,
    nickName: '',
    avatarUrl: '',
    remark: '',
    modelProgress: 0,
    syncMode: 'cloud',
    createTime: db.serverDate(),
    updateTime: db.serverDate()
  }
  const addRes = await db.collection('user_profile').add({ data: defaultProfile })
  return { _id: addRes._id, ...defaultProfile }
}

// 1. 聚合：一次性返回个人资料、统计、模型进度、管理员状态、同步配置
async function getUserInfo(openid) {
  const [profile, stats, model] = await Promise.all([
    getOrCreateProfile(openid),
    getStats(openid),
    getModelProgress(openid)
  ])
  return ok({
    profile: {
      _id: profile._id,
      nickName: profile.nickName || '',
      avatarUrl: profile.avatarUrl || '',
      remark: profile.remark || '',
      syncMode: profile.syncMode || 'cloud'
    },
    stats,
    modelProgress: model.progress,
    isAdmin: checkAdmin(openid)
  })
}

// 2. 统计数字：我的钓点、鱼护记录、活跃记录
async function getStats(openid) {
  const results = { myPoints: 0, fishRecords: 0, activeRecords: 0 }

  try {
    const myPointsRes = await db.collection('dianpoints')
      .where({ _openid: openid, teamId: '' })
      .count()
    results.myPoints = myPointsRes.total || 0
  } catch (err) {
    console.error('count dianpoints error', err)
  }

  // 鱼护记录：复用/预留 fish_records 集合，集合不存在时安全返回 0
  try {
    const fishRes = await db.collection('fish_records').where({ _openid: openid }).count()
    results.fishRecords = fishRes.total || 0
  } catch (err) {
    console.error('count fish_records error', err)
  }

  // 活跃记录：复用/预留 active_records 集合
  try {
    const activeRes = await db.collection('active_records').where({ _openid: openid }).count()
    results.activeRecords = activeRes.total || 0
  } catch (err) {
    console.error('count active_records error', err)
  }

  return results
}

// 3. 获取个人资料
async function getProfile(openid) {
  const profile = await getOrCreateProfile(openid)
  return ok({
    profile: {
      _id: profile._id,
      nickName: profile.nickName || '',
      avatarUrl: profile.avatarUrl || '',
      remark: profile.remark || '',
      syncMode: profile.syncMode || 'cloud'
    }
  })
}

// 4. 更新头像/昵称/备注
async function updateProfile(openid, event) {
  const { nickName, avatarUrl, remark } = event
  const updateData = {}

  if (nickName !== undefined) updateData.nickName = safeString(nickName, 50)
  if (avatarUrl !== undefined) updateData.avatarUrl = safeString(avatarUrl, 500)
  if (remark !== undefined) updateData.remark = safeString(remark, 50)

  if (!Object.keys(updateData).length) return fail('缺少可更新字段')

  updateData.updateTime = db.serverDate()

  const profile = await getOrCreateProfile(openid)
  await db.collection('user_profile').doc(profile._id).update({ data: updateData })

  return ok({
    profile: {
      nickName: updateData.nickName !== undefined ? updateData.nickName : profile.nickName,
      avatarUrl: updateData.avatarUrl !== undefined ? updateData.avatarUrl : profile.avatarUrl,
      remark: updateData.remark !== undefined ? updateData.remark : profile.remark
    }
  })
}

// 5. 更新同步配置
async function updateSyncConfig(openid, event) {
  const mode = String(event.mode || '').trim()
  if (!SYNC_MODE_OPTIONS.includes(mode)) return fail('同步模式参数不合法')

  const profile = await getOrCreateProfile(openid)
  await db.collection('user_profile').doc(profile._id).update({
    data: { syncMode: mode, updateTime: db.serverDate() }
  })

  return ok({ syncMode: mode })
}

// 6. 鱼情模型进度（从用户资料读取，后续可扩展为计算值）
async function getModelProgress(openid) {
  const profile = await getOrCreateProfile(openid)
  const progress = Math.max(0, Math.min(100, parseInt(profile.modelProgress, 10) || 0))
  return { progress }
}

// 7. 诊断信息：复制小程序环境、账号、云状态等基础信息
async function getDiagnosisInfo(openid, event) {
  const clientInfo = event.clientInfo || {}
  const info = {
    env: cloud.DYNAMIC_CURRENT_ENV,
    openidShort: openid ? openid.slice(-6) : '',
    timestamp: Date.now(),
    // 客户端传入的系统信息
    system: clientInfo.system || '',
    platform: clientInfo.platform || '',
    version: clientInfo.version || '',
    SDKVersion: clientInfo.SDKVersion || '',
    brand: clientInfo.brand || '',
    model: clientInfo.model || '',
    // 云状态
    cloudStatus: 'online',
    isAdmin: checkAdmin(openid)
  }
  return ok({ diagnosis: info })
}
