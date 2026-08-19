const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action
  try {
    switch (action) {
      case 'list': return await list(OPENID, event)
      case 'get': return await get(OPENID, event)
      case 'save': return await save(OPENID, event)
      case 'remove': return await remove(OPENID, event)
      case 'removeMany': return await removeMany(OPENID, event)
      case 'moveToTeam': return await moveToTeam(OPENID, event)
      case 'migratePrivate': return await migratePrivate(OPENID)
      case 'repairOpenid': return await repairOpenid(OPENID)
      default: return { code: -1, msg: '未知操作' }
    }
  } catch (err) {
    console.error(`dianpointService.${action} error`, err)
    return { code: -1, msg: err.errMsg || err.message || '服务异常，请稍后重试' }
  }
}

async function findTeam(teamId) {
  try {
    const res = await db.collection('team').doc(teamId).get()
    return res.data
  } catch (err) {
    return null
  }
}

function isMember(team, openid) {
  return team && (team.memberOpenids || []).indexOf(openid) > -1
}

// 列表：私有 -> 本人创建且无团队归属；团队 -> 成员身份校验通过后返回团队全部钓点
async function list(openid, event) {
  const mode = event.mode || 'private'
  let where
  if (mode === 'team') {
    const teamId = event.teamId
    if (!teamId) return { code: 1, msg: '缺少团队ID' }
    const team = await findTeam(teamId)
    if (!team) return { code: 2, msg: '团队不存在或已解散' }
    if (!isMember(team, openid)) return { code: 3, msg: '无权限访问该团队' }
    where = { teamId }
  } else {
    where = { _openid: openid, teamId: '' }
  }
  const res = await db.collection('dianpoints')
    .where(where)
    .orderBy('createTime', 'desc')
    .limit(100)
    .get()
  return { code: 0, list: res.data }
}

// 详情：私有仅本人；团队仅成员；share=1 允许通过分享卡片临时查看（不可编辑）
async function get(openid, event) {
  const { id, share } = event
  if (!id) return { code: 1, msg: '缺少钓点ID' }
  const res = await db.collection('dianpoints').doc(id).get().catch(() => null)
  if (!res || !res.data) return { code: 2, msg: '钓点不存在或已删除' }
  const p = res.data
  let canEdit = false
  let teamName = ''
  if (p.teamId) {
    const team = await findTeam(p.teamId)
    if (isMember(team, openid)) {
      canEdit = true
      teamName = team.teamName
    }
  } else {
    if (p._openid === openid) canEdit = true
  }
  if (!canEdit && !share) {
    return { code: 3, msg: '无权限访问该钓点' }
  }
  return {
    code: 0,
    point: {
      ...p,
      canEdit,
      teamId: p.teamId || '',
      teamName
    }
  }
}

// 新增/编辑：私有校验本人；团队校验成员身份（归属不可通过编辑改变）
async function save(openid, event) {
  const { id, mode, teamId, data } = event
  if (!data || !data.name) return { code: 1, msg: '请填写钓点名称' }
  if (!data.feeType) return { code: 1, msg: '请选择收费类型' }
  if (!data.longitude) return { code: 1, msg: '请选择地图位置' }
  if (data.depth) {
    const d = parseFloat(data.depth)
    if (isNaN(d) || d <= 0 || d > 30) return { code: 1, msg: '水深需在 0.1-30 米之间' }
  }

  let targetTeamId = ''
  if (mode === 'team') {
    if (!teamId) return { code: 1, msg: '缺少团队ID' }
    const team = await findTeam(teamId)
    if (!team) return { code: 2, msg: '团队不存在或已解散' }
    if (!isMember(team, openid)) return { code: 3, msg: '无权限访问该团队' }
    targetTeamId = teamId
  }

  const payload = {
    name: data.name,
    feeType: data.feeType,
    waterType: data.waterType || '',
    fish: Array.isArray(data.fish) ? data.fish : [],
    depth: data.depth || '',
    park: data.park || '',
    remark: data.remark || '',
    longitude: data.longitude,
    latitude: data.latitude,
    images: Array.isArray(data.images) ? data.images : [],
    teamId: targetTeamId,
    updateTime: db.serverDate()
  }

  if (id) {
    const old = await db.collection('dianpoints').doc(id).get().catch(() => null)
    if (!old || !old.data) return { code: 2, msg: '钓点不存在或已删除' }
    const oldPoint = old.data
    if (oldPoint.teamId) {
      const team = await findTeam(oldPoint.teamId)
      if (!isMember(team, openid)) return { code: 3, msg: '无权限编辑该钓点' }
    } else {
      if (oldPoint._openid !== openid) return { code: 3, msg: '无权限编辑该钓点' }
    }
    payload.teamId = oldPoint.teamId || '' // 归属不可通过编辑改变
    await db.collection('dianpoints').doc(id).update({ data: payload })
    return { code: 0 }
  }

  payload.createTime = db.serverDate()
  payload.createOpenid = openid
  // 云函数端 add 不会自动注入 _openid，必须手动写入（私有列表查询依赖该字段）
  payload._openid = openid
  const res = await db.collection('dianpoints').add({ data: payload })
  return { code: 0, id: res._id }
}

// 删除：私有校验本人；团队校验成员身份
async function remove(openid, event) {
  const { id } = event
  if (!id) return { code: 1, msg: '缺少钓点ID' }
  const res = await db.collection('dianpoints').doc(id).get().catch(() => null)
  if (!res || !res.data) return { code: 2, msg: '钓点不存在或已删除' }
  const p = res.data
  if (p.teamId) {
    const team = await findTeam(p.teamId)
    if (!isMember(team, openid)) return { code: 3, msg: '无权限删除该钓点' }
  } else {
    if (p._openid !== openid) return { code: 3, msg: '无权限删除该钓点' }
  }
  await db.collection('dianpoints').doc(id).remove()
  return { code: 0 }
}

// 批量删除：逐条复用 remove 的权限校验（私有仅本人；团队仅成员）
async function removeMany(openid, event) {
  const ids = event.ids
  if (!Array.isArray(ids) || !ids.length) return { code: 1, msg: '请选择要删除的钓点' }
  let removed = 0
  let failed = 0
  for (const id of ids) {
    const res = await db.collection('dianpoints').doc(id).get().catch(() => null)
    if (!res || !res.data) continue // 已不存在视为删除成功
    const p = res.data
    if (p.teamId) {
      const team = await findTeam(p.teamId)
      if (!isMember(team, openid)) { failed++; continue }
    } else {
      if (p._openid !== openid) { failed++; continue }
    }
    await db.collection('dianpoints').doc(id).remove()
    removed++
  }
  return { code: 0, removed, failed }
}

// 私有钓点移动到团队：仅本人私有的钓点（teamId 为空）可移动；目标团队需为本人所在团队
async function moveToTeam(openid, event) {
  const { id, teamId } = event
  if (!id) return { code: 1, msg: '缺少钓点ID' }
  if (!teamId) return { code: 1, msg: '请选择目标团队' }
  const res = await db.collection('dianpoints').doc(id).get().catch(() => null)
  if (!res || !res.data) return { code: 2, msg: '钓点不存在或已删除' }
  const p = res.data
  if (p.teamId) return { code: 3, msg: '仅私有钓点可移动到团队' }
  if (p._openid !== openid) return { code: 3, msg: '无权限操作该钓点' }
  const team = await findTeam(teamId)
  if (!team) return { code: 2, msg: '团队不存在或已解散' }
  if (!isMember(team, openid)) return { code: 3, msg: '你不是该团队成员' }
  await db.collection('dianpoints').doc(id).update({
    data: { teamId, updateTime: db.serverDate() }
  })
  return { code: 0, teamName: team.teamName }
}

// 数据修复：历史写入的私有钓点缺少 _openid 导致查不到，这里按 createOpenid 补齐（幂等）
async function repairOpenid(openid) {
  const res = await db.collection('dianpoints')
    .where({ createOpenid: openid, teamId: '', _openid: _.exists(false) })
    .limit(100)
    .get()
  let fixed = 0
  for (const doc of res.data) {
    await db.collection('dianpoints').doc(doc._id).update({
      data: { _openid: openid }
    })
    fixed++
  }
  return { code: 0, fixed }
}

// 旧数据迁移：把当前用户在旧集合 fishing_point 中的钓点迁入 dianpoints（私有，teamId=''）
// 幂等：已迁移过的记录（_id 相同）跳过，并删除旧集合中的源记录
async function migratePrivate(openid) {
  const res = await db.collection('fishing_point').where({ _openid: openid }).limit(1000).get()
  let moved = 0
  for (const doc of res.data) {
    const existed = await db.collection('dianpoints').doc(doc._id).get().then(() => true).catch(() => false)
    if (!existed) {
      const { _id, _openid, ...rest } = doc
      await db.collection('dianpoints').add({
        data: {
          ...rest,
          teamId: '',
          _openid,
          createOpenid: _openid,
          createTime: doc.createTime || db.serverDate()
        }
      })
      moved++
    }
    await db.collection('fishing_point').doc(_id).remove()
  }
  return { code: 0, moved }
}
