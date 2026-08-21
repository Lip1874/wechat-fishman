/**
 * getWeather 云函数：和风天气 Web API（v1 新格式）
 *
 * 并行获取 5 路数据：
 *   1) 实况天气    GET /weather/v1/current/{lat}/{lon}
 *   2) 逐时预报    GET /weather/v1/hourly/{lat}/{lon}?hours=24&localTime=true （未来24小时逐时）
 *   3) 灾害预警    GET /weatheralert/v1/current/{lat}/{lon}
 *   4) 生活指数    GET /v7/indices/1d?type=4,5 （4=钓鱼 5=紫外线）
 *   5) 区县反查    GET /geo/v2/city/lookup?location=lon,lat （返回区县名称）
 *
 * 【环境变量配置】
 *   云开发控制台 → 云函数 → getWeather → 配置 → 环境变量：
 *     QWEATHER_KEY  = 你的和风天气 API Key（必填）
 *     QWEATHER_HOST = 你的 API Host，如 abcxyz.qweatherapi.com（2024年后注册的新项目必填，
 *                     在 和风控制台 → 设置 中查看；早期个人开发版可留空，自动走旧域名）
 *   Key / Host 只存在云函数环境变量中，严禁写入前端/代码仓库，防止泄露盗刷。
 *
 * 【认证方式】自动兼容两种：
 *   配置了 QWEATHER_HOST  → 新方式：请求头 X-QW-Api-Key: KEY
 *   未配置 QWEATHER_HOST  → 旧方式：URL 传 ?key=KEY（旧版个人开发版域名 devapi.qweather.com）
 *
 * 【实现说明】
 *   使用 Node 内置 https + zlib 发起请求并自动解压 gzip，
 *   不依赖 got 等第三方包，避免云端安装依赖失败/版本不兼容。
 *
 * 【入参】
 *   lat: 纬度
 *   lon: 经度
 *   type: "now"（实况 + 24h逐时 + 预警 + 指数 + 区县）
 *
 * 【返回】
 *   { code:0, weather: {
 *     place, icon, text, temp, feelsLike,
 *     windDir, windScale, windSpeed, humidity, pressure, vis,
 *     hourly:[{time, icon, text, temp, prob, probText}],   // 未来24小时逐时
 *     fishing:{level,category,text}, uv:{level,category,text},
 *     warning:[{headline,eventName,severity,color,description}]
 *   } }
 *   任何异常均返回 code!==0 的错误标记（msg 携带真实原因），绝不抛异常导致调用方崩溃
 */
const https = require('https')
const zlib = require('zlib')
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const KEY = (process.env.QWEATHER_KEY || '').trim()
const HOST = (process.env.QWEATHER_HOST || '').trim()
const BASE = HOST ? `https://${HOST}` : 'https://devapi.qweather.com'

// 风向 compass 代码 -> 中文（v1 返回英文方位代码）
const COMPASS_CN = {
  n: '北风', nne: '东北偏北风', ne: '东北风', ene: '东北偏东风',
  e: '东风', ese: '东南偏东风', se: '东南风', sse: '东南偏南风',
  s: '南风', ssw: '西南偏南风', sw: '西南风', wsw: '西南偏西风',
  w: '西风', wnw: '西北偏西风', nw: '西北风', nnw: '西北偏北风',
  none: '无持续风向', vrb: '风向多变'
}

// 预警严重程度 -> 中文
const SEVERITY_CN = {
  minor: '一般', moderate: '较重', severe: '严重', extreme: '特别严重', unknown: '未知'
}

exports.main = async (event) => {
  const lat = Number(event.lat)
  const lon = Number(event.lon)
  const type = event.type || 'now'
  if (!KEY) return { code: 1, msg: '未配置 QWEATHER_KEY 环境变量，请到云函数配置中添加' }
  if (!HOST) {
    console.warn('[getWeather] 未配置 QWEATHER_HOST，正在使用旧域名 devapi.qweather.com（若 Key 是2024年后注册的，旧域名已失效，请配置独立 API Host）')
  }
  if (isNaN(lat) || isNaN(lon) || !lat || !lon) return { code: 1, msg: '缺少有效坐标' }

  const latS = lat.toFixed(2)
  const lonS = lon.toFixed(2)
  const location = `${lonS},${latS}` // 和风经纬度格式：经度,纬度

  try {
    if (type === 'now') {
      const [current, hourly, alert, indices, geo] = await Promise.all([
        fetchApi(`/weather/v1/current/${latS}/${lonS}`),
        fetchApi(`/weather/v1/hourly/${latS}/${lonS}?hours=24&localTime=true`),
        fetchApi(`/weatheralert/v1/current/${latS}/${lonS}`),
        fetchApi(`/v7/indices/1d?type=4,5&location=${encodeURIComponent(location)}`),
        fetchApi(`/geo/v2/city/lookup?location=${encodeURIComponent(location)}&number=1&range=cn`)
      ])

      const n = current || {}
      const fishing = pickIndex(indices, '4')
      const uv = pickIndex(indices, '5')
      const warning = buildWarnings(alert)

      const place = buildPlace(geo)
      const windCompass = (n.wind && n.wind.direction && n.wind.direction.compass) || ''
      const windScale = (n.wind && n.wind.scale != null) ? `${n.wind.scale}级` : ''
      const windSpeed = (n.wind && n.wind.speed && n.wind.speed.value != null) ? `${Math.round(n.wind.speed.value * 10) / 10}m/s` : ''
      const humidity = n.humidity != null ? `${Math.round(n.humidity * 100)}%` : '--'
      const pressure = (n.pressure && n.pressure.value != null) ? `${Math.round(n.pressure.value)}hPa` : '--'
      const vis = (n.visibility && n.visibility.value != null)
        ? (n.visibility.value >= 1000 ? `${(n.visibility.value / 1000).toFixed(0)}km` : `${Math.round(n.visibility.value)}m`)
        : '--'

      // 未来24小时逐时预报（本地时间；prob 为 0-100 数值供前端做颜色分级）
      const hours = (hourly && hourly.hours) || []
      const hourlyArr = hours.slice(0, 24).map(h => {
        let hour = '--'
        const ft = h.forecastTime || ''
        if (ft) {
          const m = ft.match(/T(\d{2}):/)
          hour = m ? `${m[1]}时` : ft.slice(0, 13)
        }
        const prob = (h.precipitation && h.precipitation.probability != null)
          ? Math.round(h.precipitation.probability * 100)
          : null
        return {
          time: hour,
          icon: (h.condition && h.condition.code) || '',
          text: (h.condition && h.condition.text) || '',
          temp: (h.temperature && h.temperature.value != null) ? `${Math.round(h.temperature.value)}` : '--',
          prob,
          probText: prob == null ? '--' : `${prob}%`
        }
      })

      // 紫外线数值（取逐时首条，缺失则留空，前端仅作补充显示）
      const uvIndex = (hours[0] && hours[0].uvIndex != null) ? hours[0].uvIndex : '--'

      return {
        code: 0,
        weather: {
          place,
          icon: (n.condition && n.condition.code) || '',
          text: (n.condition && n.condition.text) || '--',
          temp: (n.temperature && n.temperature.value != null) ? `${Math.round(n.temperature.value)}` : '--',
          feelsLike: (n.feelsLike && n.feelsLike.value != null) ? `${Math.round(n.feelsLike.value)}` : '--',
          windDir: COMPASS_CN[windCompass] || windCompass || '',
          windScale,
          windSpeed,
          humidity,
          pressure,
          vis,
          uvIndex,
          hourly: hourlyArr,
          fishing: fishing ? { level: fishing.level, category: fishing.category, text: fishing.text } : null,
          uv: uv ? { level: uv.level, category: uv.category, text: uv.text } : null,
          warning
        }
      }
    }
    return { code: 1, msg: '未知天气类型' }
  } catch (err) {
    console.error('getWeather error', err)
    return { code: -1, msg: `天气服务异常：${err.message || '未知错误'}` }
  }
}

// 请求和风天气接口（统一认证头/超时兜底）
async function fetchApi(path) {
  let headers = {}
  if (HOST) {
    // 新认证方式：API Key 放请求头
    headers = { 'X-QW-Api-Key': KEY }
  } else {
    // 旧认证方式：key 放 query（旧版个人开发版域名）
    path += (path.indexOf('?') > -1 ? '&' : '?') + `key=${KEY}`
  }
  try {
    return await requestJson(`${BASE}${path}`, headers)
  } catch (err) {
    // 401/403 场景给出可操作的定位提示
    if (err.statusCode === 401) {
      err.message = `HTTP 401：API Key 认证失败（请检查环境变量 QWEATHER_KEY 是否复制完整、是否是该 Host 对应项目下的 Key）${err.extra ? '，和风返回：' + err.extra : ''}`
    } else if (err.statusCode === 403) {
      err.message = HOST
        ? `HTTP 403：Host 与 Key 不匹配或无访问权限（请确认环境变量 QWEATHER_HOST=${HOST} 与 Key 属于同一个和风项目）${err.extra ? '，和风返回：' + err.extra : ''}`
        : 'HTTP 403：旧域名 devapi.qweather.com 已被和风停用，请在云函数环境变量配置 QWEATHER_HOST（和风控制台 → 设置 中的独立 API Host）'
    }
    throw err
  }
}

// 发送 HTTPS GET 请求并解析 JSON（支持 gzip/deflate）
function requestJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      let stream = res
      const enc = (res.headers['content-encoding'] || '').toLowerCase()
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip())
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate())
      const chunks = []
      stream.on('data', c => chunks.push(c))
      stream.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode !== 200) {
          // 尽量解析和风 JSON 错误体（code/msg 都可能携带），拿不到就带状态码
          let parsed = null
          try { parsed = JSON.parse(body) } catch (e) { /* 非 JSON（如 WAF 拦截页） */ }
          const extraMsg = parsed && (parsed.msg || parsed.message)
            ? String(parsed.msg || parsed.message)
            : (parsed && parsed.code ? `code=${parsed.code}` : '')
          const err = new Error(`HTTP ${res.statusCode}${extraMsg ? `：${extraMsg}` : ''}`)
          err.statusCode = res.statusCode
          err.extra = extraMsg || ''
          reject(err)
          return
        }
        try {
          resolve(JSON.parse(body))
        } catch (e) {
          reject(new Error('响应解析失败'))
        }
      })
      stream.on('error', reject)
    })
    req.setTimeout(10000, () => req.destroy(new Error('请求超时(10s)')))
    req.on('error', reject)
  })
}

// 从生活指数返回中取出指定 type 的指数
function pickIndex(res, type) {
  const list = (res && res.daily) || []
  const item = list.find(i => i.type === String(type))
  return item ? { level: item.level, category: item.category, text: item.text } : null
}

// 清洗预警列表（最多返回 3 条）
function buildWarnings(res) {
  const list = (res && res.alerts) || []
  return list.slice(0, 3).map(a => ({
    headline: a.headline || a.description || '',
    eventName: (a.eventType && a.eventType.name) || '',
    severity: SEVERITY_CN[a.severity] || a.severity || '',
    color: (a.color && a.color.code) || 'blue',
    description: a.description || ''
  }))
}

// 通过 GeoAPI 反查区县名称（如：北京东城）
function buildPlace(geo) {
  const loc = (geo && geo.location && geo.location[0]) || {}
  const name = loc.name || ''
  const adm2 = loc.adm2 || ''
  const adm1 = loc.adm1 || ''
  if (adm2 && name) return `${adm2}${name}`
  if (adm1 && name) return `${adm1}${name}`
  return name || ''
}
