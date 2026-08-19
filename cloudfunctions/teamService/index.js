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

// 创建团队
async function createTeam(openid, event) {
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

// 团队详情（含成员 openid 列表，仅成员可看）
async function getTeamDetail(openid, event) {
  const teamId = event.teamId
  if (!teamId) return { code: 1, msg: '缺少团队ID' }
  const team = await findTeam(teamId)
  if (!team) return { code: 2, msg: '团队不存在或已解散' }
  if (!isMember(team, openid)) return { code: 3, msg: '无权限访问该团队' }
  return {
    code: 0,
    team: {
      _id: team._id,
      teamName: team.teamName,
      creatorOpenid: team.creatorOpenid,
      memberCount: (team.memberOpenids || []).length,
      isCreator: team.creatorOpenid === openid,
      members: team.memberOpenids || []
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
async function removeMember(openid, event) {
  const { teamId, memberOpenid } = event
  if (!teamId || !memberOpenid) return { code: 1, msg: '参数不完整' }
  const team = await findTeam(teamId)
  if (!team) return { code: 2, msg: '团队不存在或已解散' }
  if (team.creatorOpenid !== openid) return { code: 3, msg: '仅创建人可移除成员' }
  if (memberOpenid === openid) return { code: 1, msg: '不能移除自己，解散请使用解散团队' }
  await db.collection('team').doc(teamId).update({
    data: { memberOpenids: _.pull(memberOpenid) }
  })
  return { code: 0 }
}

// 成员主动退出团队（创建人不可退出）
async function leaveTeam(openid, event) {
  const teamId = event.teamId
  if (!teamId) return { code: 1, msg: '缺少团队ID' }
  const team = await findTeam(teamId)
  if (!team) return { code: 2, msg: '团队不存在或已解散' }
  if (team.creatorOpenid === openid) return { code: 1, msg: '创建人请使用解散团队' }
  if (!isMember(team, openid)) return { code: 3, msg: '你不在该团队中' }
  await db.collection('team').doc(teamId).update({
    data: { memberOpenids: _.pull(openid) }
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
