const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

// ---- 列表查询（分页/筛选/搜索）相关常量与工具 ----
const PAGE_SIZE_MAX = 100
const STATUS_FILTER_OPTIONS = ['全部', '正常', '作废']

// 转义正则特殊字符，防止用户输入的关键词破坏正则匹配（如 ".", "*", "(" 等）
function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---- 本次需求新增字段的合法取值枚举（用于云函数参数校验）----
const STATUS_OPTIONS = ['正常', '作废']
const WATER_LEVEL_OPTIONS = ['平水', '涨水', '落水']
const WIND_WAVE_OPTIONS = ['无风浪', '微风浪', '中风浪', '大风浪']

// 天气快照白名单：新增钓点时随记录保存，只存关键字段，避免把 getWeather 整包数据写入
const WEATHER_KEYS = ['place', 'icon', 'text', 'temp', 'feelsLike', 'windDir', 'windScale', 'windSpeed', 'humidity', 'pressure', 'vis', 'updateTime']

// 清洗前端传入的天气快照：仅保留白名单字段，非法输入返回 null（新增时自动记录天气，失败不阻塞保存）
function cleanWeather(raw) {
  if (!raw || typeof raw !== 'object') return null
  const out = {}
  WEATHER_KEYS.forEach(k => {
    const v = raw[k]
    if (v !== undefined && v !== null && v !== '') out[k] = String(v).slice(0, 50)
  })
  const fishing = raw.fishing
  if (fishing && typeof fishing === 'object') {
    out.fishing = {}
    if (fishing.category) out.fishing.category = String(fishing.category).slice(0, 20)
    if (fishing.text) out.fishing.text = String(fishing.text).slice(0, 100)
  }
  return Object.keys(out).length ? out : null
}

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
      case 'updateStatus': return await updateStatus(OPENID, event)
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

// 查询用户昵称（user_profile 集合），未设置昵称返回空串
async function getNickName(openid) {
  if (!openid) return ''
  try {
    const res = await db.collection('user_profile').where({ _openid: openid }).limit(1).get()
    if (res.data && res.data.length && res.data[0].nickName) {
      return String(res.data[0].nickName).slice(0, 50)
    }
  } catch (err) {
    console.error('getNickName error', err)
  }
  return ''
}

// 给缺少 creatorName 的钓点记录批量补全录入人昵称（按 createOpenid 一次查询）
async function attachCreatorNames(points) {
  const missing = points.filter(p => !p.creatorName && p.createOpenid)
  if (!missing.length) return
  const openids = [...new Set(missing.map(p => p.createOpenid))]
  const nickMap = {}
  try {
    const res = await db.collection('user_profile').where({ _openid: _.in(openids) }).limit(1000).get()
    res.data.forEach(u => {
      if (u.nickName) nickMap[u._openid] = String(u.nickName).slice(0, 50)
    })
  } catch (err) {
    console.error('attachCreatorNames error', err)
  }
  points.forEach(p => {
    if (!p.creatorName && nickMap[p.createOpenid]) p.creatorName = nickMap[p.createOpenid]
  })
}

// 列表查询：私有 -> 本人创建且无团队归属；团队 -> 成员身份校验通过后查询团队钓点
// 支持组合筛选（收费/河道类型/鱼种/状态）、关键词搜索（名称/备注）、分页（page/pageSize）
// 筛选与分页全部在云函数端执行，前端不再一次性拉取全量数据
// 参数：mode/teamId（数据范围）、page/pageSize（分页）、keyword（搜索词）、
//      fee/waterType/fish（筛选值）、status（全部/正常/作废）、hideInvalid（旧版兼容）、all（地图页一次取前100条）
async function list(openid, event) {
  const mode = event.mode || 'private'
  let baseWhere
  let teamNameMap = null
  if (mode === 'team') {
    const teamId = event.teamId
    if (!teamId) return { code: 1, msg: '缺少团队ID' }
    const team = await findTeam(teamId)
    if (!team) return { code: 2, msg: '团队不存在或已解散' }
    if (!isMember(team, openid)) return { code: 3, msg: '无权限访问该团队' }
    baseWhere = { teamId }
    teamNameMap = { [teamId]: team.teamName }
  } else if (mode === 'teamAll') {
    // 永不空军分组：聚合我加入的全部团队的钓点（团队钓点自动同步到首页该分组）
    const teamIds = (Array.isArray(event.teamIds) ? event.teamIds : []).filter(Boolean)
    if (!teamIds.length) return { code: 1, msg: '缺少团队参数' }
    teamNameMap = {}
    for (const tid of teamIds) {
      const team = await findTeam(tid)
      if (!team) return { code: 2, msg: '团队不存在或已解散' }
      if (!isMember(team, openid)) return { code: 3, msg: '无权限访问该团队' }
      teamNameMap[tid] = team.teamName
    }
    baseWhere = { teamId: _.in(teamIds) }
  } else {
    baseWhere = { _openid: openid, teamId: '' }
  }

  // 1. 组装筛选条件（各条件之间为 AND 关系）
  const conds = [baseWhere]

  // 收费类型
  const fee = (event.fee || '').trim()
  if (fee && fee !== '全部') conds.push({ feeType: fee })

  // 河道类型
  const waterType = (event.waterType || '').trim()
  if (waterType) conds.push({ waterType })

  // 鱼种：fish 为数组字段，等值查询即"数组包含该值"
  const fish = (event.fish || '').trim()
  if (fish) conds.push({ fish })

  // 钓点状态：全部 / 正常 / 作废（兼容旧版 hideInvalid 开关参数）
  let status = event.status
  if (STATUS_FILTER_OPTIONS.indexOf(status) < 0) {
    status = event.hideInvalid === false ? '全部' : '正常'
  }
  let statusConds = null
  if (status === '正常') {
    // 历史数据可能没有 status 字段，一律视为"正常"，故用"不存在或非作废"表达
    statusConds = _.or([{ status: _.exists(false) }, { status: _.neq('作废') }])
  } else if (status === '作废') {
    statusConds = { status: '作废' }
  }
  if (statusConds) conds.push(statusConds)

  // 关键词：钓点名称 / 备注 模糊匹配（大小写不敏感，特殊字符已转义）
  const keyword = (event.keyword || '').trim().slice(0, 30)
  if (keyword) {
    const reg = db.RegExp({ regexp: escapeRegExp(keyword), options: 'i' })
    conds.push(_.or([{ name: reg }, { remark: reg }]))
  }

  const where = conds.length === 1 ? conds[0] : _.and(conds)
  const query = db.collection('dianpoints').where(where)

  // 2. 匹配总数（供前端"共 X 个"与空状态判断）
  const totalRes = await query.count()
  const total = totalRes.total || 0

  // 3. 被"正常"状态隐藏的作废钓点数（默认过滤下用于首页"已隐藏 X 个"提示）
  let hiddenInvalidCount = 0
  if (status === '正常') {
    const noStatusConds = conds.filter(c => c !== statusConds)
    const noStatusWhere = noStatusConds.length === 1 ? noStatusConds[0] : _.and(noStatusConds)
    const allRes = await db.collection('dianpoints').where(noStatusWhere).count()
    hiddenInvalidCount = Math.max(0, (allRes.total || 0) - total)
  }

  // 4. 分页查询（地图页 all=true：一次取前100条，不分页）
  const pageSize = Math.min(Math.max(parseInt(event.pageSize) || 10, 1), PAGE_SIZE_MAX)
  const page = Math.max(parseInt(event.page) || 1, 1)
  const res = event.all
    ? await query.orderBy('createTime', 'desc').limit(PAGE_SIZE_MAX).get()
    : await query
        .orderBy('createTime', 'desc')
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .get()

  // 团队模式/团队聚合模式补充团队名（永不空军分组用于展示钓点来源）
  if (teamNameMap) {
    res.data.forEach(p => { p.teamName = teamNameMap[p.teamId] || '' })
  }
  // 补全录入人昵称（历史数据可能未记录 creatorName）
  attachCreatorNames(res.data)

  // 近期有人上鱼：最近 7 天内该钓点存在鱼获记录（fish_records.pointId 关联），
  // 标记 recentCatch 供列表展示"近期上鱼"标识。云函数端查询无权限限制，失败静默降级。
  try {
    const pointIds = res.data.map(p => p._id).filter(Boolean)
    if (pointIds.length) {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      const recentCatchSet = new Set()
      const fres = await db.collection('fish_records')
        .where({ pointId: _.in(pointIds), caughtAt: _.gte(since) })
        .field({ pointId: true })
        .limit(1000)
        .get()
      fres.data.forEach(r => { if (r.pointId) recentCatchSet.add(r.pointId) })
      res.data.forEach(p => { p.recentCatch = recentCatchSet.has(p._id) })
    }
  } catch (err) {
    console.error('query recentCatch error', err)
  }
  return {
    code: 0,
    list: res.data,
    total,
    page,
    pageSize,
    hasMore: event.all ? false : page * pageSize < total,
    hiddenInvalidCount
  }
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
  // 历史数据可能未记录录入人昵称，这里按 createOpenid 补全
  if (!p.creatorName) {
    p.creatorName = await getNickName(p.createOpenid || '')
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
// 编辑链路复用说明：详情页内联编辑（pages/detail 编辑模式）与新增页（addPoint）均调用本 action；
// 带 id 视为编辑，服务端二次校验当前用户对该钓点的编辑权限（私有=本人 / 团队=成员），
// 校验通过后仅更新可编辑字段，归属（teamId）以库中原值为准、不可被篡改。
async function save(openid, event) {
  const { id, mode, teamId, data } = event
  // 新增钓点需先登录（已完善昵称资料）；编辑沿用原有权限校验
  if (!id && !(await getNickName(openid))) return { code: 3, msg: '请先登录' }
  if (!data || !data.name) return { code: 1, msg: '请填写钓点名称' }
  if (!data.feeType) return { code: 1, msg: '请选择收费类型' }
  if (!data.longitude || !data.latitude) return { code: 1, msg: '请选择地图位置' }
  // ---- 本次新增字段参数校验（防止越界/非法值写入）----
  if (data.depth) {
    const d = parseFloat(data.depth)
    if (isNaN(d) || d <= 0 || d > 30) return { code: 1, msg: '水深需在 0.1-30 米之间' }
  }
  if (data.status !== undefined && STATUS_OPTIONS.indexOf(data.status) < 0) return { code: 1, msg: '状态参数不合法' }
  if (data.fishTime !== undefined && (typeof data.fishTime !== 'string' || data.fishTime.length > 20)) return { code: 1, msg: '作钓时间参数不合法' }
  if (data.bait !== undefined && (typeof data.bait !== 'string' || data.bait.length > 50)) return { code: 1, msg: '饵料参数不合法' }
  if (data.waterLevel && WATER_LEVEL_OPTIONS.indexOf(data.waterLevel) < 0) return { code: 1, msg: '水位参数不合法' }
  if (data.windWave && WIND_WAVE_OPTIONS.indexOf(data.windWave) < 0) return { code: 1, msg: '风浪参数不合法' }
  if (data.fishCaught !== undefined && !Array.isArray(data.fishCaught)) return { code: 1, msg: '钓获鱼种参数不合法' }

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
    fishCaught: Array.isArray(data.fishCaught)
      ? data.fishCaught.map(s => String(s).trim()).filter(Boolean).slice(0, 20)
      : [],
    depth: data.depth || '',
    fishTime: data.fishTime || '',
    bait: data.bait || '',
    waterLevel: data.waterLevel || '',
    windWave: data.windWave || '',
    park: data.park || '',
    remark: data.remark || '',
    longitude: data.longitude,
    latitude: data.latitude,
    images: Array.isArray(data.images) ? data.images : [],
    teamId: targetTeamId,
    status: data.status === '作废' ? '作废' : '正常', // 状态枚举：正常/作废，默认正常
    updateTime: db.serverDate()
  }
  // 新增时自动把当前点位天气信息存入钓点记录（前端已通过 getWeather 拉取，此处仅做白名单清洗）
  // 编辑时未携带天气快照则保留原记录，不会清空
  const weather = cleanWeather(data.weather)
  if (weather) payload.weather = weather

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
  // 新增时记录录入人昵称（未设置昵称时为 ''，展示端回退 openid 尾号）
  payload.creatorName = await getNickName(openid)
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

// 归档/恢复：仅修改钓点状态（正常/作废），权限校验与删除一致
async function updateStatus(openid, event) {
  const { id, status } = event
  if (!id) return { code: 1, msg: '缺少钓点ID' }
  if (STATUS_OPTIONS.indexOf(status) < 0) return { code: 1, msg: '状态参数不合法' }
  const res = await db.collection('dianpoints').doc(id).get().catch(() => null)
  if (!res || !res.data) return { code: 2, msg: '钓点不存在或已删除' }
  const p = res.data
  if (p.teamId) {
    const team = await findTeam(p.teamId)
    if (!isMember(team, openid)) return { code: 3, msg: '无权限操作该钓点' }
  } else {
    if (p._openid !== openid) return { code: 3, msg: '无权限操作该钓点' }
  }
  await db.collection('dianpoints').doc(id).update({
    data: { status, updateTime: db.serverDate() }
  })
  return { code: 0 }
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
          creatorName: await getNickName(_openid),
          createTime: doc.createTime || db.serverDate()
        }
      })
      moved++
    }
    await db.collection('fishing_point').doc(_id).remove()
  }
  return { code: 0, moved }
}
