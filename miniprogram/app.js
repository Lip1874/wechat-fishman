App({
  onLaunch() {
    // ==========【云开发环境ID】==========
    // 留空 = 使用当前小程序绑定的默认环境（仅一个环境时最省心）。
    // 多环境时请填写真实环境 ID：开发者工具顶部「云开发」按钮 → 环境列表 → 环境ID（形如 xxx-xxxx-uin）。
    // 若未开通云开发，云函数调用会报 -601034「没有权限，请先开通云开发或者云托管」。
    const ENV_ID = "";
    if (!wx.cloud) {
      wx.showModal({ title: "提示", content: "请使用2.9.2以上基础库，开启云开发" });
    } else {
      wx.cloud.init(
        ENV_ID
          ? { env: ENV_ID, traceUser: true }
          : { traceUser: true }
      );
    }
    // ==========【静默登录预热】==========
    // 启动时静默获取并缓存 openid（loginService 会自动在 user 集合按 openid 建档）。
    // 全程不弹授权窗、不阻塞启动；游客可正常浏览首页与钓点地图。
    // 点击【新增标点】【我的】等入口时才由 ensureLogin() 触发正式登录校验。
    try {
      const { getOpenId } = require("./utils/login");
      getOpenId().catch(() => {});
    } catch (e) {
      // 静默失败，不阻塞启动
    }
    // 启动时静默获取并缓存用户资料（首次进入自动创建 user_profile），供"登录（资料完善）"判断
    try {
      const { getCachedUserProfile } = require("./utils/api");
      getCachedUserProfile().catch(() => {});
    } catch (e) {
      // 静默失败，不阻塞启动
    }
  },
  globalData: {
    userLocation: null,
    openid: "",
    user: null,      // user 集合中的当前用户记录（loginService 建档）
    isNewUser: false
  }
})
