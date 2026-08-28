// 腾讯位置服务 WebService Key（免费申请：https://lbs.qq.com -> 控制台 -> 创建应用 -> 添加Key
// 类型选「微信小程序」，绑定本小程序 AppID：wx94171f60adb395c8）
const QQ_MAP_KEY = '37JBZ-2VFCL-6HQPJ-M3U7A-WAYL3-LRBVQ'

// 逆地址解析：坐标 -> 具体地址（腾讯位置服务 WebService /ws/geocoder/v1）
// 返回 Promise<string>；未配置 Key / 网络失败 / 无结果时 resolve('')，绝不 reject，供展示层静默降级
function reverseGeocode(latitude, longitude) {
  if (!QQ_MAP_KEY || !latitude || !longitude) return Promise.resolve('')
  return new Promise(resolve => {
    wx.request({
      url: 'https://apis.map.qq.com/ws/geocoder/v1/',
      data: {
        location: `${latitude},${longitude}`,
        get_poi: 0,
        key: QQ_MAP_KEY
      },
      success: (res) => {
        const d = res.data || {}
        if (d.status !== 0 || !d.result) {
          console.error('逆地址解析失败', d)
          resolve('')
          return
        }
        const r = d.result
        // 优先用推荐简略地址（如「北京市朝阳区太阳宫乡太阳宫中路」），失败回退完整地址
        const addr = (r.formatted_addresses && r.formatted_addresses.recommend) || r.address || ''
        resolve(addr)
      },
      fail: (err) => {
        console.error('逆地址解析请求失败', err)
        resolve('')
      }
    })
  })
}

module.exports = { QQ_MAP_KEY, reverseGeocode }
