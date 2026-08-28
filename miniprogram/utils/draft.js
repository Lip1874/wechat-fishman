// ========== 离线草稿（新增钓点 / 记录渔获）==========
// 表单离开页面时自动保存到本机，再次进入自动回填；提交成功后清除。
// 「我的-离线草稿」入口据此展示小红点提醒与恢复/清空操作。
const DRAFT_KEY = 'fishman_drafts'

const DRAFT_TITLES = {
  addPoint: '钓点草稿',
  addCatch: '渔获草稿'
}

// 读取全部草稿（{ type: { ...data, updateTime } }）
function readAll() {
  try {
    const all = wx.getStorageSync(DRAFT_KEY)
    return all && typeof all === 'object' ? all : {}
  } catch (e) {
    return {}
  }
}

function writeAll(all) {
  try {
    wx.setStorageSync(DRAFT_KEY, all)
  } catch (e) { /* 忽略写入失败 */ }
}

// 保存指定类型草稿
function saveDraft(type, data) {
  const all = readAll()
  all[type] = Object.assign({}, data, { updateTime: Date.now() })
  writeAll(all)
}

// 读取指定类型草稿（不存在返回 null）
function getDraft(type) {
  const all = readAll()
  return all[type] || null
}

// 清除指定类型草稿
function clearDraft(type) {
  const all = readAll()
  if (all[type]) {
    delete all[type]
    writeAll(all)
  }
}

// 是否存在未保存草稿（驱动「离线草稿」小红点）
function hasDrafts() {
  return Object.keys(readAll()).length > 0
}

// 草稿列表（按更新时间倒序，供「离线草稿」入口使用）
function listDrafts() {
  const all = readAll()
  return Object.keys(all)
    .filter(k => DRAFT_TITLES[k])
    .map(k => ({
      type: k,
      title: DRAFT_TITLES[k],
      updateTime: all[k].updateTime || 0
    }))
    .sort((a, b) => b.updateTime - a.updateTime)
}

// 清空全部草稿
function clearAllDrafts() {
  writeAll({})
}

module.exports = {
  saveDraft,
  getDraft,
  clearDraft,
  hasDrafts,
  listDrafts,
  clearAllDrafts
}
