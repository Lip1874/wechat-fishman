// ============================================================
// fishLogService —— 电子鱼护（鱼护记录）云函数
// ------------------------------------------------------------
// 职责：
//   1. 鱼护记录的 CRUD（list / save / remove）
//   2. 月度统计：条数 / 出勤次数 / 放流率 / 周柱图 / 按位置聚合
//   3. 快速录入常见鱼（quickAdd）
// 数据集合：fish_records（与 userService.getStats 已使用的集合保持一致）
// 权限模型：仅可访问 _openid === OPENID 的私有记录
// ============================================================
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const COLL = 'fish_records'

// 鱼护记录的合法取值
const RELEASE_OPTIONS = [true, false]

// 鱼名最大长度、备注最大长度
const FISH_NAME_MAX = 20
const REMARK_MAX = 200
const BAIT_MAX = 50

// 数字安全转换与边界裁剪
function clampInt(raw, min, max, fallback) {
  const n = parseInt(raw, 10)
  if (isNaN(n)) return fallback
  return Math.min(Math.max(n, min), max)
}
function clampFloat(raw, min, max, fallback) {
  const n = parseFloat(raw)
  if (isNaN(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

// 统一成功响应
function ok(data = {}) {
  return { code: 0, ...data }
}
// 统一失败响应
function fail(msg, code = -1) {
  return { code, msg: msg || '服务异常，请稍后重试' }
}

// 是否已完善资料（未完善视为未登录，禁止写操作）
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

// 给定日期返回「该日期所在月份的 6 个周区间」的起点（用于 6 周柱图）
// 返回数组：6 项，每项 { start, end } 闭区间；monthStart = 月初、monthEnd = 月末
function buildWeekRanges(monthStart, monthEnd) {
  // 周口径：以「周一」作为周首
  const ranges = []
  const cursor = new Date(monthStart.getTime())
  // 找到该日期所在周的周一
  const day = cursor.getDay() // 0=Sun..6=Sat
  const diff = (day + 6) % 7 // 距周一的天数
  cursor.setDate(cursor.getDate() - diff)
  for (let i = 0; i < 6; i++) {
    const start = new Date(cursor.getTime())
    const end = new Date(cursor.getTime())
    end.setDate(end.getDate() + 6)
    end.setHours(23, 59, 59, 999)
    // 与月份区间相交裁剪
    const s = start < monthStart ? monthStart : start
    const e = end > monthEnd ? monthEnd : end
    ranges.push({ start: s, end: e })
    cursor.setDate(cursor.getDate() + 7)
  }
  return ranges
}

// 取指定月份的第一天与最后一天
function monthBoundaries(year, month) {
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0)
  const end = new Date(year, month, 0, 23, 59, 59, 999)
  return { start, end }
}

// 计算当月中的「第几周」(1..6)：按「周日」作为第一周起点（与图像 1周-6周一致按月内周次）
function weekNoOfMonth(d) {
  const day = d.getDate()
  return Math.min(6, Math.ceil(day / 7))
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action
  try {
    switch (action) {
      case 'list': return await list(OPENID, event)
      case 'summary': return await summary(OPENID, event)
      case 'pointStats': return await pointStats(OPENID, event)
      case 'save': return await save(OPENID, event)
      case 'remove': return await remove(OPENID, event)
      case 'quickAdd': return await quickAdd(OPENID, event)
      default: return fail('未知操作')
    }
  } catch (err) {
    console.error(`fishLogService.${action} error`, err)
    return fail(err.errMsg || err.message || '服务异常，请稍后重试')
  }
}

// 列表查询：支持 (all / week / month) 范围 + 分页
// range='all' 不限日期；range='week' 仅当前周；range='month' 仅指定月份
// month=YYYY-MM；filter='all' | 'released' | 'kept' 放流筛选项
async function list(openid, event) {
  const range = event.range || 'all'
  const month = (event.month || '').trim() // YYYY-MM
  const filter = event.filter || 'all' // all / released / kept
  const page = clampInt(event.page, 1, 9999, 1)
  const pageSize = clampInt(event.pageSize, 1, 100, 20)

  const conds = [{ _openid: openid }]
  if (range === 'week') {
    const now = new Date()
    const day = now.getDay()
    const diff = (day + 6) % 7
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff, 0, 0, 0, 0)
    const end = new Date(start.getTime())
    end.setDate(end.getDate() + 7)
    end.setMilliseconds(-1)
    conds.push({ caughtAt: _.and([_.gte(start), _.lte(end)]) })
  } else if (range === 'month' && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number)
    const { start, end } = monthBoundaries(y, m)
    conds.push({ caughtAt: _.and([_.gte(start), _.lte(end)]) })
  }
  if (filter === 'released') conds.push({ isReleased: true })
  else if (filter === 'kept') conds.push({ isReleased: false })

  const where = conds.length === 1 ? conds[0] : _.and(conds)
  const countRes = await db.collection(COLL).where(where).count()
  const total = countRes.total || 0

  const res = await db.collection(COLL).where(where)
    .orderBy('caughtAt', 'desc')
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get()

  // 标准化返回：日期序列化为毫秒时间戳，便于前端直接 new Date
  const list = (res.data || []).map(r => ({
    _id: r._id,
    fishName: r.fishName || '',
    count: r.count || 0,
    weight: typeof r.weight === 'number' ? r.weight : null,
    lengthCm: typeof r.lengthCm === 'number' ? r.lengthCm : null,
    bait: r.bait || '',
    isReleased: !!r.isReleased,
    caughtAtMs: r.caughtAt ? new Date(r.caughtAt).getTime() : null,
    weekNo: r.weekNo || 0,
    pointId: r.pointId || '',
    pointName: r.pointName || '',
    location: r.location || null,
    remark: r.remark || '',
    createTimeMs: r.createTime ? new Date(r.createTime).getTime() : null
  }))

  return ok({ list, total, page, pageSize, hasMore: page * pageSize < total })
}

// 月度统计：条数 / 出勤次数（独立钓获日期数）/ 放流率 / 周柱图
async function summary(openid, event) {
  const month = (event.month || '').trim()
  const now = new Date()
  let year = now.getFullYear()
  let mon = now.getMonth() + 1
  if (/^\d{4}-\d{2}$/.test(month)) {
    const arr = month.split('-').map(Number)
    year = arr[0]
    mon = arr[1]
  }
  const { start, end } = monthBoundaries(year, mon)
  const where = {
    _openid: openid,
    caughtAt: _.and([_.gte(start), _.lte(end)])
  }
  const res = await db.collection(COLL).where(where).limit(1000).get()
  const data = res.data || []

  let totalCount = 0 // 总条数
  let releaseCount = 0 // 放流条数
  const daySet = new Set() // 出勤天数
  const weekly = [0, 0, 0, 0, 0, 0] // 6 个周的条数累计
  let maxWeek = 0

  data.forEach(r => {
    const c = (r.count && r.count > 0) ? r.count : 0
    totalCount += c
    if (r.isReleased) releaseCount += c
    if (r.caughtAt) {
      const d = new Date(r.caughtAt)
      const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
      daySet.add(key)
      const w = weekNoOfMonth(d)
      if (w >= 1 && w <= 6) {
        weekly[w - 1] += c
        if (weekly[w - 1] > maxWeek) maxWeek = weekly[w - 1]
      }
    }
  })

  // 计算当月 6 个周的具体周区间，供前端 hover/详情使用
  const weekRanges = buildWeekRanges(start, end)

  return ok({
    month: `${year}-${String(mon).padStart(2, '0')}`,
    totalCount,
    attendanceCount: daySet.size,
    releaseCount,
    releaseRate: totalCount > 0 ? Math.round((releaseCount / totalCount) * 100) : 0,
    weekly,
    weeklyMax: maxWeek,
    weekRanges: weekRanges.map(r => ({ startMs: r.start.getTime(), endMs: r.end.getTime() }))
  })
}

// 按位置聚合：返回有定位的钓点分组
async function pointStats(openid, event) {
  const month = (event.month || '').trim()
  const now = new Date()
  let year = now.getFullYear()
  let mon = now.getMonth() + 1
  if (/^\d{4}-\d{2}$/.test(month)) {
    const arr = month.split('-').map(Number)
    year = arr[0]
    mon = arr[1]
  }
  const { start, end } = monthBoundaries(year, mon)
  const where = {
    _openid: openid,
    caughtAt: _.and([_.gte(start), _.lte(end)])
  }
  const res = await db.collection(COLL).where(where).limit(1000).get()
  const data = res.data || []
  // 按 pointId 分组（无 pointId 的归入 "__no_point__"）
  const groupMap = {}
  data.forEach(r => {
    const key = r.pointId || '__no_point__'
    if (!groupMap[key]) {
      groupMap[key] = {
        pointId: r.pointId || '',
        pointName: r.pointName || '未关联钓点',
        totalCount: 0,
        releaseCount: 0,
        recordCount: 0,
        latitude: r.location && r.location.latitude ? r.location.latitude : null,
        longitude: r.location && r.location.longitude ? r.location.longitude : null
      }
    }
    const g = groupMap[key]
    const c = (r.count && r.count > 0) ? r.count : 0
    g.totalCount += c
    if (r.isReleased) g.releaseCount += c
    g.recordCount++
  })
  const groups = Object.values(groupMap)
    .filter(g => g.pointId) // 仅返回有关联钓点的分组
    .sort((a, b) => b.totalCount - a.totalCount)
  return ok({ groups })
}

// 新增/编辑：仅本人
async function save(openid, event) {
  if (!(await checkLoggedIn(openid))) return fail('请先登录', 3)
  const id = event.id || ''
  const data = event.data || {}
  const fishName = String(data.fishName || '').trim().slice(0, FISH_NAME_MAX)
  if (!fishName) return fail('请填写鱼种名称')
  const count = clampInt(data.count, 1, 9999, 1)
  // 重量（kg）和长度（cm）可选填
  const weight = data.weight === '' || data.weight == null ? null : clampFloat(data.weight, 0, 9999, null)
  const lengthCm = data.lengthCm === '' || data.lengthCm == null ? null : clampFloat(data.lengthCm, 0, 9999, null)
  const bait = String(data.bait || '').slice(0, BAIT_MAX)
  const isReleased = !!data.isReleased
  const remark = String(data.remark || '').slice(0, REMARK_MAX)
  const pointId = String(data.pointId || '').slice(0, 64)
  const pointName = String(data.pointName || '').slice(0, 50)
  let location = null
  if (data.location && typeof data.location === 'object') {
    const lat = clampFloat(data.location.latitude, -90, 90, NaN)
    const lng = clampFloat(data.location.longitude, -180, 180, NaN)
    if (!isNaN(lat) && !isNaN(lng)) location = { latitude: lat, longitude: lng }
  }
  // 钓获时间：默认「现在」
  const caughtAt = data.caughtAt ? new Date(data.caughtAt) : new Date()
  if (isNaN(caughtAt.getTime())) return fail('钓获时间格式不合法')
  const weekNo = weekNoOfMonth(caughtAt)

  const payload = {
    fishName,
    count,
    weight,
    lengthCm,
    bait,
    isReleased,
    remark,
    pointId,
    pointName,
    location,
    caughtAt,
    weekNo,
    updateTime: db.serverDate()
  }

  if (id) {
    // 编辑：校验所有权
    const old = await db.collection(COLL).doc(id).get().catch(() => null)
    if (!old || !old.data) return fail('记录不存在或已删除', 2)
    if (old.data._openid !== openid) return fail('无权限编辑该记录', 3)
    await db.collection(COLL).doc(id).update({ data: payload })
    return ok({ _id: id })
  }

  payload.createTime = db.serverDate()
  payload.createOpenid = openid
  payload._openid = openid
  const res = await db.collection(COLL).add({ data: payload })
  return ok({ _id: res._id })
}

// 删除：仅本人
async function remove(openid, event) {
  const id = event.id
  if (!id) return fail('缺少记录ID')
  const old = await db.collection(COLL).doc(id).get().catch(() => null)
  if (!old || !old.data) return fail('记录不存在或已删除', 2)
  if (old.data._openid !== openid) return fail('无权限删除该记录', 3)
  await db.collection(COLL).doc(id).remove()
  return ok()
}

// 快速添加：仅记录鱼种与数量（默认当前时间、保留）
async function quickAdd(openid, event) {
  if (!(await checkLoggedIn(openid))) return fail('请先登录', 3)
  const fishName = String(event.fishName || '').trim().slice(0, FISH_NAME_MAX)
  if (!fishName) return fail('请填写鱼种名称')
  const count = clampInt(event.count, 1, 9999, 1)
  const now = new Date()
  const payload = {
    fishName,
    count,
    weight: null,
    lengthCm: null,
    isReleased: false,
    remark: '快速记录',
    pointId: '',
    pointName: '',
    location: null,
    caughtAt: now,
    weekNo: weekNoOfMonth(now),
    createTime: db.serverDate(),
    createOpenid: openid,
    updateTime: db.serverDate(),
    _openid: openid
  }
  const res = await db.collection(COLL).add({ data: payload })
  return ok({ _id: res._id })
}
