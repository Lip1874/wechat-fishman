// ========== 本地设置（消息通知 / 距离单位 / 鱼种偏好）==========
// 设置仅存本机（wx storage），保证离线可用；后续可平滑迁移到云端 user_profile
const SETTINGS_KEY = 'fishman_settings'

const DEFAULT_SETTINGS = {
  notify: true,          // 消息通知开关
  distanceUnit: 'km',    // 距离单位：'km'（默认） / 'm'（米）
  fishPref: []           // 鱼种偏好（中文名数组）
}

// 读取设置（含默认值兜底）
function getSettings() {
  try {
    const saved = wx.getStorageSync(SETTINGS_KEY)
    if (saved && typeof saved === 'object') {
      return Object.assign({}, DEFAULT_SETTINGS, saved)
    }
  } catch (e) { /* 忽略读取失败 */ }
  return Object.assign({}, DEFAULT_SETTINGS)
}

// 局部更新设置（返回合并后的完整设置）
function updateSettings(patch) {
  const next = Object.assign({}, getSettings(), patch || {})
  try {
    wx.setStorageSync(SETTINGS_KEY, next)
  } catch (e) { /* 忽略写入失败 */ }
  return next
}

// 按当前距离单位格式化距离（d 为 km；返回展示字符串）
// km 模式：<1km 显示米，否则显示 km；米模式：始终显示米
function formatDistance(km) {
  const { distanceUnit } = getSettings()
  const d = Number(km)
  if (isNaN(d) || d < 0) return ''
  if (distanceUnit === 'm') {
    return Math.round(d * 1000) + 'm'
  }
  return d < 1 ? (d * 1000).toFixed(0) + 'm' : d.toFixed(1) + 'km'
}

module.exports = {
  DEFAULT_SETTINGS,
  getSettings,
  updateSettings,
  formatDistance
}
