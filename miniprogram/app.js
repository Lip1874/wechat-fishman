App({
  onLaunch() {
    // ==========【重要！替换为你的云开发环境ID】==========
    const ENV_ID = "cloud1-d6gg95bnhfad05ea0";
    if (!wx.cloud) {
      wx.showModal({ title: "提示", content: "请使用2.9.2以上基础库，开启云开发" });
    } else {
      wx.cloud.init({
        env: ENV_ID,
        traceUser: true
      });
    }
  },
  globalData: {
    userLocation: null,
    openid: ""
  }
})
