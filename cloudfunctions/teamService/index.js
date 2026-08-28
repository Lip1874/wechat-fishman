const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action
  try {
    switch (action) {
      case 'createTeam': return await createTeam(OPENID, event)
      case 'getMyTeams': return await getMyTeams(OPENID)
      case 'getTeamDetail': return await getTeamDetail(OPENID, event)
      case 'joinTeam': return await joinTeam(OPENID, event)
      case 'removeMember': return await removeMember(OPENID, event)
      case 'leaveTeam': return await leaveTeam(OPENID, event)
      case 'dismissTeam': return await dismissTeam(OPENID, event)
      case 'updateAnnouncement': return await updateAnnouncement(OPENID, event)
      case 'getTeamCatchSummary': return await getTeamCatchSummary(OPENID, event)
      default: return { code: -1, msg: '未知操作' }
    }
  } catch (err) {
    console.error(`teamService.${action} error`, err)
    return { code: -1, msg: err.errMsg || err.message || '服务异常，请稍后重试' }
  }
}

// 读取团队记录，不存在返回 null
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

// 是否已完善资料（未完善视为未登录，禁止创建团队）
async function checkLoggedIn(openid) {
  try {
    const res = await db.collection('user_profile').where({ _openid: openid }).limit(1).get()
    if (res.data && res.data.length && res.data[0].nickName && String(res.data[0].nickName).trim()) {
      return true
    }
  } catch (err) {
    console.error('checkLoggedIn error', err)
  }
  return false
}

// 创建团队
async function createTeam(openid, event) {
  if (!(await checkLoggedIn(openid))) return { code: 3, msg: '请先登录' }
  const teamName = (event.teamName || '').trim()
  if (!teamName) return { code: 1, msg: '请填写团队名称' }
  if (teamName.length > 20) return { code: 1, msg: '团队名称不能超过20个字' }
  const res = await db.collection('team').add({
    data: {
      teamName,
      creatorOpenid: openid,
      memberOpenids: [openid],
      createTime: db.serverDate()
    }
  })
  return { code: 0, teamId: res._id, teamName }
}

// 我的团队（我创建的 + 我加入的，按 id 去重）
async function getMyTeams(openid) {
  const [created, joined] = await Promise.all([
    db.collection('team').where({ creatorOpenid: openid }).limit(100).get(),
    db.collection('team').where({ memberOpenids: openid }).limit(100).get()
  ])
  const map = {}
  created.data.concat(joined.data).forEach(t => { map[t._id] = t })
  const teams = Object.keys(map).map(id => {
    const t = map[id]
    return {
      _id: id,
      teamName: t.teamName,
      memberCount: (t.memberOpenids || []).length,
      isCreator: t.creatorOpenid === openid
    }
  })
  return { code: 0, teams }
}

// 团队详情（含成员 openid 列表与昵称、公告、钓点数，仅成员可看）
async function getTeamDetail(openid, event) {
  const teamId = event.teamId
  if (!teamId) return { code: 1, msg: '缺少团队ID' }
  const team = await findTeam(teamId)
  if (!team) return { code: 2, msg: '团队不存在或已解散' }
  if (!isMember(team, openid)) return { code: 3, msg: '无权限访问该团队' }
  const memberOpenids = team.memberOpenids || []
  // 批量补全成员昵称与头像（未完善资料的回退空串，前端展示尾号/占位头像）
  const memberProfiles = []
  try {
    const ures = await db.collection('user_profile')
      .where({ _openid: _.in(memberOpenids) })
      .limit(100)
      .get()
    const profileMap = {}
    ures.data.forEach(u => {
      if (!u._openid) return
      profileMap[u._openid] = {
        nickName: u.nickName ? String(u.nickName).slice(0, 50) : '',
        avatarUrl: u.avatarUrl ? String(u.avatarUrl).slice(0, 500) : ''
      }
    })
    memberOpenids.forEach(oid => memberProfiles.push({
      openid: oid,
      nickName: (profileMap[oid] || {}).nickName || '',
      avatarUrl: (profileMap[oid] || {}).avatarUrl || ''
    }))
  } catch (err) {
    console.error('load member profiles error', err)
    memberOpenids.forEach(oid => memberProfiles.push({ openid: oid, nickName: '', avatarUrl: '' }))
  }
  // 团队钓点数（含作废，统计失败不影响详情展示）
  let pointCount = 0
  try {
    const cnt = await db.collection('dianpoints').where({ teamId }).count()
    pointCount = cnt.total || 0
  } catch (err) {
    console.error('count team points error', err)
  }
  return {
    code: 0,
    team: {
      _id: team._id,
      teamName: team.teamName,
      creatorOpenid: team.creatorOpenid,
      memberCount: memberOpenids.length,
      isCreator: team.creatorOpenid === openid,
      members: memberOpenids,
      memberProfiles,
      announcement: team.announcement || '',
      announcementUpdateTime: team.announcementUpdateTime || null,
      pointCount
    }
  }
}

// 通过分享卡片加入团队（memberOpenids 自动去重）
async function joinTeam(openid, event) {
  const teamId = event.teamId
  if (!teamId) return { code: 1, msg: '缺少团队ID' }
  const team = await findTeam(teamId)
  if (!team) return { code: 2, msg: '团队不存在或已解散' }
  const members = team.memberOpenids || []
  if (members.indexOf(openid) > -1) {
    return { code: 0, alreadyJoined: true, teamName: team.teamName }
  }
  await db.collection('team').doc(teamId).update({
    data: { memberOpenids: _.push([openid]) }
  })
  return { code: 0, teamName: team.teamName }
}

// 移除团队成员（仅创建人）
// 采用"读取-过滤-写回"而非更新指令 pull：团队写操作低频，且不依赖 SDK 指令版本差异，确保按 openid 精确移除
async function removeMember(openid, event) {
  const { teamId, memberOpenid } = event
  if (!teamId || !memberOpenid) return { code: 1, msg: '参数不完整' }
  const team = await findTeam(teamId)
  if (!team) return { code: 2, msg: '团队不存在或已解散' }
  if (team.creatorOpenid !== openid) return { code: 3, msg: '仅创建人可移除成员' }
  if (memberOpenid === openid) return { code: 1, msg: '不能移除自己，解散请使用解散团队' }
  const members = team.memberOpenids || []
  const next = members.filter(oid => oid !== memberOpenid)
  if (next.length === members.length) return { code: 1, msg: '该成员不在团队中' }
  await db.collection('team').doc(teamId).update({
    data: { memberOpenids: next }
  })
  return { code: 0 }
}

// 成员主动退出团队（创建人不可退出），同样读改写精确移除
async function leaveTeam(openid, event) {
  const teamId = event.teamId
  if (!teamId) return { code: 1, msg: '缺少团队ID' }
  const team = await findTeam(teamId)
  if (!team) return { code: 2, msg: '团队不存在或已解散' }
  if (team.creatorOpenid === openid) return { code: 1, msg: '创建人请使用解散团队' }
  if (!isMember(team, openid)) return { code: 3, msg: '你不在该团队中' }
  const members = team.memberOpenids || []
  const next = members.filter(oid => oid !== openid)
  if (next.length === members.length) return { code: 3, msg: '你不在该团队中' }
  await db.collection('team').doc(teamId).update({
    data: { memberOpenids: next }
  })
  return { code: 0 }
}

// 解散团队（仅创建人），团队下全部钓点一并删除
async function dismissTeam(openid, event) {
  const teamId = event.teamId
  if (!teamId) return { code: 1, msg: '缺少团队ID' }
  const team = await findTeam(teamId)
  if (!team) return { code: 2, msg: '团队不存在或已解散' }
  if (team.creatorOpenid !== openid) return { code: 3, msg: '仅创建人可解散团队' }
  // 循环删除该团队下钓点，避免批量删除限制
  const points = await db.collection('dianpoints').where({ teamId }).limit(1000).get()
  for (const p of points.data) {
    await db.collection('dianpoints').doc(p._id).remove()
  }
  await db.collection('team').doc(teamId).remove()
  return { code: 0 }
}

// 更新团队公告（仅创建人，200 字以内，允许清空）
async function updateAnnouncement(openid, event) {
  const { teamId, announcement } = event
  if (!teamId) return { code: 1, msg: '缺少团队ID' }
  const text = String(announcement || '').trim().slice(0, 200)
  const team = await findTeam(teamId)
  if (!team) return { code: 2, msg: '团队不存在或已解散' }
  if (team.creatorOpenid !== openid) return { code: 3, msg: '仅创建人可编辑公告' }
  await db.collection('team').doc(teamId).update({
    data: { announcement: text, announcementUpdateTime: db.serverDate() }
  })
  return { code: 0, announcement: text }
}

// 团队渔获汇总：聚合该团队全部钓点关联的鱼获记录（fish_records.pointId 关联）
// 仅成员可看；返回累计条数/记录数/放流数/热门鱼种/最近 10 条
async function getTeamCatchSummary(openid, event) {
  const teamId = event.teamId
  if (!teamId) return { code: 1, msg: '缺少团队ID' }
  const team = await findTeam(teamId)
  if (!team) return { code: 2, msg: '团队不存在或已解散' }
  if (!isMember(team, openid)) return { code: 3, msg: '无权限访问该团队' }
  // 该团队全部钓点
  const points = await db.collection('dianpoints')
    .where({ teamId })
    .field({ _id: true })
    .limit(1000)
    .get()
  const pointIds = (points.data || []).map(p => p._id)
  if (!pointIds.length) {
    return {
      code: 0,
      pointCount: 0,
      totalCount: 0,
      recordCount: 0,
      releaseCount: 0,
      topSpecies: [],
      recentList: []
    }
  }
  const recRes = await db.collection('fish_records')
    .where({ pointId: _.in(pointIds) })
    .limit(1000)
    .get()
  const data = recRes.data || []

  let totalCount = 0
  let releaseCount = 0
  const speciesMap = {}
  data.forEach(r => {
    const c = Number(r.count) || 0
    totalCount += c
    if (r.isReleased) releaseCount += c
    const name = String(r.fishName || '其他').slice(0, 20)
    speciesMap[name] = (speciesMap[name] || 0) + c
  })
  const topSpecies = Object.keys(speciesMap)
    .map(name => ({ name, count: speciesMap[name] }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)

  // 最近 10 条渔获（按钓获时间倒序）+ 批量补全记录人昵称
  const sorted = data.slice().sort((a, b) => {
    const ta = a.caughtAt ? new Date(a.caughtAt).getTime() : 0
    const tb = b.caughtAt ? new Date(b.caughtAt).getTime() : 0
    return tb - ta
  })
  const recent = sorted.slice(0, 10)
  const recorderMap = {}
  try {
    const openids = [...new Set(recent.map(r => r._openid).filter(Boolean))]
    if (openids.length) {
      const ures = await db.collection('user_profile')
        .where({ _openid: _.in(openids) })
        .limit(100)
        .get()
      ures.data.forEach(u => {
        if (u._openid && u.nickName) recorderMap[u._openid] = String(u.nickName).slice(0, 50)
      })
    }
  } catch (err) {
    console.error('getTeamCatchSummary nickname error', err)
  }
  const recentList = recent.map(r => ({
    _id: r._id,
    fishName: r.fishName || '',
    count: Number(r.count) || 0,
    isReleased: !!r.isReleased,
    caughtAtMs: r.caughtAt ? new Date(r.caughtAt).getTime() : null,
    pointName: r.pointName || '',
    recorderName: recorderMap[r._openid] || ''
  }))
  return {
    code: 0,
    pointCount: pointIds.length,
    totalCount,
    recordCount: data.length,
    releaseCount,
    topSpecies,
    recentList
  }
}
