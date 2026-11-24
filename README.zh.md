# dsh-session-notify

DeepSeek Harness 插件：会话一停下来就提醒你，不用再逐个点开确认状态。

## 加了什么

- 会话需要你、完成任务、空闲或出错时，弹出 **Windows 通知** 和一声**提示音**。
- 屏幕右上角最多叠 4 张可点击的**小卡片**；点「查看」跳到对应会话。
- 侧栏底部多一个**铃铛**，带未读角标和设置面板。

## 触发时机

| 提醒 | 什么时候 |
|---|---|
| 等你选择 | 提问工具正在等你点选项 |
| 等你授权 | 权限/审批提示正在等你决定 |
| 已完成 | 助手停止运行，这一轮结束 |
| 等你输入 | 会话空闲超过设定时长 |
| 出错 / 中断 | 这一轮出错、被中止或撞到输出上限 |

默认监控所有工作区、所有会话，包括子任务与定时任务会话。

## 设置

铃铛 → 设置面板：每种提醒单独开关、空闲判定时长（默认 5 分钟）、
「只在窗口不在前台时提醒」、「只提醒当前没在看的会话」、小卡片开关，以及四个测试按钮。

## 限制

- 通知与声音由 Host 侧通过 PowerShell 发出，需要 **Windows 桌面版**；
  纯网页版仍会显示页面内卡片。
- 卡片画在页面里：Harness 完全关闭后没有代码在监听会话，关闭后完成的任务不会补发提醒。
- Windows 首次使用时会创建「Harness Notify」开始菜单快捷方式，用于登记通知身份。

## 安装

```sh
dsh plugin --profile <profile> add @iridensity_gray/dsh-session-notify
```

安装后重启 Harness，Host 侧才会挂载。提醒偏好按浏览器存在 `localStorage` 里。

## 卸载

```sh
dsh plugin --profile <profile> remove @iridensity_gray/dsh-session-notify
```

之后重启 DSH。

## 许可证

MIT
