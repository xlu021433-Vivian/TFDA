# Windows 安装程序 0.3.1

将已公开并校验的 0.3.0 便携包嵌入 Windows 安装程序。使用 Windows 自带 .NET Framework 编译器，无需下载构建依赖。

```powershell
powershell -NoProfile -File installer/build.ps1
```

输入是 `dist/windows-0.3.0/shenqi-waimai-windows-x64.zip`（也可从 GitHub v0.3.0 发布下载），SHA-256 固定在源码和构建脚本中。输出为 `dist/windows-0.3.1/Shenqi-Waimai-Setup.exe`，内含 Python、依赖、本地助手和扩展。

安装窗口允许选择空目录、选择是否创建本人桌面快捷方式。安装器拒绝覆盖非空目录，先校验内嵌包，再解压和逐个验证文件清单，不需要管理员权限。成功后提供加载扩展、启动助手和阅读说明入口，不开启定时、不添加开机启动、不自动付款。关闭助手后可手动删除安装目录和快捷方式；删除目录会清除该目录里的本地配置。

验证入口（不创建快捷方式或启动点餐）：

```powershell
Start-Process dist/windows-0.3.1/Shenqi-Waimai-Setup.exe -Wait -ArgumentList '--verify-extract', 'D:\empty-test-folder'
```

`--preview <output.png>` 将原生安装窗口绘制为图片，便于检查文案和布局。安装程序面向 Windows 10/11 x64，使用系统 .NET Framework 4.5+；内嵌点餐功能仍为测试版。
