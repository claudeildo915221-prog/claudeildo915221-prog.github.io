# Boncatta

Boncatta 是暴塔联机版的独立站点。

站点地址：https://boncatta.github.io/

当前功能：

- 统一暴塔大厅
- 1v1 经典、2v2 指挥官、2v2 四玩家、多人混战
- 本地用户名和六位以上数字密码登录
- WebRTC 联机战斗同步
- 每次行动公开显示随机数、命中区间、技能和目标
- 人物图鉴展示角色技能、概率和效果

移动端 APK：

```powershell
npm install
npm run apk:debug
```

本地构建 APK 需要安装 JDK 和 Android SDK。构建成功后，调试包位于 `android/app/build/outputs/apk/debug/app-debug.apk`。

也可以在 GitHub Actions 中运行 `Build Android APK`，构建完成后下载 `boncatta-debug-apk`。
