const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

// 默认字典种子（每个用户首次进入对应分类时自动写入，仅本人可见，不与他人共享）
// value 与 label 保持一致：存量钓点已用中文直接存储 waterType/fish，保证详情、筛选、编辑回显完全兼容
const SEED = {
  fish_type: ['鲫鱼', '鲤鱼', '草鱼', '青鱼', '鲢鳙', '黑鱼', '翘嘴', '马口', '罗非', '鲶鱼', '黄颡鱼', '白条', '鳜鱼', '其他'],
  river_type: ['江河', '水库', '河道', '塘', '湖泊', '溪流']
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action
  try {
    switch (action) {
      case 'list': return await list(OPENID, event)
      case 'add': return await add(OPENID, event)
      case 'update': return await update(OPENID, event)
      case 'delete': return await remove(OPENID, event)
      case 'sortBatch': return await sortBatch(OPENID, event)
      default: return { code: -1, msg: '未知操作' }
    }
  } catch (err) {
    console.error(`dictOperate.${action} error`, err)
    return { code: -1, msg: err.errMsg || err.message || '服务异常，请稍后重试' }
  }
}

// 按 dictType 返回「当前用户自己」的字典列表（sort 升序）
// 用户首次访问该分类且名下无数据时，自动写入个人默认选项
async function list(openid, event) {
  const dictType = (event.dictType || '').trim()
  if (!dictType) return { code: 1, msg: '缺少字典分类' }
  let res = await db.collection('point_option')
    .where({ dictType, _openid: openid })
    .orderBy('sort', 'asc')
    .limit(100)
    .get()
  if (!res.data.length && SEED[dictType]) {
    await seed(dictType, SEED[dictType], openid)
    res = await db.collection('point_option')
      .where({ dictType, _openid: openid })
      .orderBy('sort', 'asc')
      .limit(100)
      .get()
  }
  // 兼容旧数据：历史写入的默认种子没有 isDefault 标记，按 value 匹配种子名单自动补标，防止被误改/误删
  const seeds = SEED[dictType] || []
  const legacy = res.data.filter(i => i.isDefault !== true && seeds.includes(i.value))
  if (legacy.length) {
    await Promise.all(legacy.map(i => db.collection('point_option').doc(i._id).update({
      data: { isDefault: true, updateTime: db.serverDate() }
    }).catch(() => {})))
    const legacyIds = new Set(legacy.map(i => i._id))
    res.data.forEach(i => { if (legacyIds.has(i._id)) i.isDefault = true })
  }
  return { code: 0, list: res.data }
}

// 批量写入个人默认种子（_openid 归属当前用户）
async function seed(dictType, labels, openid) {
  const tasks = labels.map((v, i) => db.collection('point_option').add({
    data: {
      dictType,
      label: v,
      value: v,
      sort: i,
      isDefault: true, // 默认项：不可修改、不可删除
      _openid: openid,
      createTime: db.serverDate(),
      updateTime: db.serverDate()
    }
  }))
  await Promise.all(tasks)
}

// 新增选项（归属当前用户，同分类下 value 不可重复）
async function add(openid, event) {
  const dictType = (event.dictType || '').trim()
  const label = (event.label || '').trim()
  const value = (event.value || '').trim()
  const sort = parseInt(event.sort)
  if (!dictType) return { code: 1, msg: '缺少字典分类' }
  if (!label) return { code: 1, msg: '请填写展示名称' }
  if (!value) return { code: 1, msg: '请填写存储值' }
  if (isNaN(sort) || sort < 0) return { code: 1, msg: '排序号需为不小于0的数字' }
  const dup = await db.collection('point_option').where({ dictType, value, _openid: openid }).count()
  if (dup.total > 0) return { code: 2, msg: '该分类下已存在相同的存储值' }
  const res = await db.collection('point_option').add({
    data: {
      dictType, label, value, sort,
      isDefault: false, // 用户自增项：可编辑、可删除
      _openid: openid,
      createTime: db.serverDate(),
      updateTime: db.serverDate()
    }
  })
  return { code: 0, id: res._id }
}

// 更新选项（只能修改自己的记录；value 唯一性校验排除自身）
async function update(openid, event) {
  const id = event.id
  const label = (event.label || '').trim()
  const value = (event.value || '').trim()
  const sort = parseInt(event.sort)
  if (!id) return { code: 1, msg: '缺少记录ID' }
  if (!label) return { code: 1, msg: '请填写展示名称' }
  if (!value) return { code: 1, msg: '请填写存储值' }
  if (isNaN(sort) || sort < 0) return { code: 1, msg: '排序号需为不小于0的数字' }
  const old = await db.collection('point_option').doc(id).get().catch(() => null)
  if (!old || !old.data) return { code: 2, msg: '记录不存在或已删除' }
  if (old.data._openid !== openid) return { code: 3, msg: '只能修改自己的字典项' }
  if (old.data.isDefault) return { code: 4, msg: '默认字典项不可修改' }
  const dup = await db.collection('point_option')
    .where({ dictType: old.data.dictType, value, _openid: openid, _id: _.neq(id) })
    .count()
  if (dup.total > 0) return { code: 2, msg: '该分类下已存在相同的存储值' }
  await db.collection('point_option').doc(id).update({
    data: { label, value, sort, updateTime: db.serverDate() }
  })
  return { code: 0 }
}

// 删除选项（只能删除自己的记录）
async function remove(openid, event) {
  const id = event.id
  if (!id) return { code: 1, msg: '缺少记录ID' }
  const old = await db.collection('point_option').doc(id).get().catch(() => null)
  if (!old || !old.data) return { code: 2, msg: '记录不存在或已删除' }
  if (old.data._openid !== openid) return { code: 3, msg: '只能删除自己的字典项' }
  if (old.data.isDefault) return { code: 4, msg: '默认字典项不可删除' }
  await db.collection('point_option').doc(id).remove()
  return { code: 0 }
}

// 批量重排（movable-list 拖拽排序结束后，一次性提交整组新顺序）
// 只调整 sort 值（0..n-1），不涉及内容修改，默认项同样允许排序
async function sortBatch(openid, event) {
  const dictType = (event.dictType || '').trim()
  const ids = event.ids || []
  if (!dictType) return { code: 1, msg: '缺少字典分类' }
  if (!Array.isArray(ids) || !ids.length) return { code: 1, msg: '缺少排序数据' }
  const res = await db.collection('point_option')
    .where({ dictType, _openid: openid })
    .field({ _id: true })
    .limit(200)
    .get()
  const ownIds = new Set(res.data.map(i => i._id))
  if (ids.some(id => !ownIds.has(id))) return { code: 3, msg: '只能调整自己的字典项' }
  await Promise.all(ids.map((id, sort) => db.collection('point_option').doc(id).update({
    data: { sort, updateTime: db.serverDate() }
  })))
  return { code: 0 }
}
