# Boncatta

Boncatta 是暴塔联机版的独立站点。

站点地址：https://boncatta.github.io/

当前功能：

- 移动端优先的四页结构：主页、暴塔、图鉴、我的
- 独立 Node 后端 API：账号、房间、战斗、战绩与 JSON 备份
- 1v1 经典、2v2 指挥官、2v2 四玩家、多人混战
- 用户名唯一，密码为六位以上数字
- 服务端权威结算，不再使用 PeerJS / MQTT 作为战斗状态源
- 每次行动公开显示随机数、命中区间、技能和目标
- 人物图鉴展示角色技能、概率和效果

本地运行前后端：

```powershell
npm install
npm run dev
```

默认 API 与静态预览地址为 `http://localhost:8787`。后端数据会写入 `server/data/db.json`，并周期性备份到 `server/data/backups/`；这些运行数据不会提交到 Git。

APK 内的前端只调用 API。默认后端地址是 `https://boncatta-api.onrender.com`；部署到其他云端时，把 `assets/baota-config.js` 里的 `window.BAOTA_API_BASE` 改为后端地址后再构建 APK。

移动端 APK：

```powershell
npm install
npm run apk:debug
```

本地构建 APK 需要安装 JDK 和 Android SDK。构建成功后，调试包位于 `android/app/build/outputs/apk/debug/app-debug.apk`。

也可以在 GitHub Actions 中运行 `Build Android APK`，构建完成后下载 `boncatta-v0.0.<构建号>.apk`。

Android debug APK 使用仓库内固定调试签名；如果手机上装过早期临时签名包，需要先卸载一次，再安装新版。之后同一包名可以直接覆盖更新。
