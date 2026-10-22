# 斗鱼全民星推荐自动领取

一个 Tampermonkey（篡改猴）脚本，支持后台自动领取全民星推荐活动红包、奖池筛选、到账统计及每日上限自动停止。

**当前版本：2.0.0。已完成19项模拟测试，尚未在登录账号中验证真实领取到账。**

## 安装

1. 安装并启用 [Tampermonkey](https://www.tampermonkey.net/)。
2. [点击安装脚本](https://raw.githubusercontent.com/ybl112/douyu-star-helper/main/douyu-star-background.user.js)。如果浏览器只下载文件，用文本编辑器复制脚本全部内容，在油猴“添加新脚本”中替换模板并保存。
3. 停用其他同类领取脚本和此前的独立扩展。
4. 打开数字房间号的斗鱼直播间，例如 [6657](https://www.douyu.com/6657)，正常登录后，点击左下角“星推” →“开始后台领取”。
5. 收起面板即可切换到其他标签页。浏览器和控制页需要保持开启。

首次安装需手动启动。刷新同一个控制页会恢复已开启的任务；手动停止、平台提示每日上限或因异常停止后，不会自动重启。达到当日上限后，次日需要手动启动。

## 功能

- 自动发现活动房间，并查询实际金币奖池，由高到低筛选；同金额优先等待较短的红包。
- 后台打开工作标签页，将可识别的视频和音频元素静音，领取结束后关闭工作页。
- 同一红包去重，每包最多尝试5次；标签页恢复时不集中补发过期请求。
- 斗鱼提示每日上限后停止全部任务，取消剩余请求并关闭工作页。
- 按服务器返回的实际奖励统计金币和星光棒，支持查询金币流水及导出本地记录。
- 同一浏览器只运行一个控制页，支持其他页面查看状态和停止任务。
- 查询失败时逐步延长重试间隔；鉴权、验证或未知领取响应会停止任务并记录原因。

| 设置 | 默认值 |
| --- | --- |
| 最低金币总奖池 | 10000 |
| 同时后台房间数 | 2 |
| 扫描间隔 | 60秒 |
| 每轮最多查询房间数 | 24 |
| 最长等待 | 600秒 |
| 自定每日领取包数 | 0，表示不额外限制；仍在斗鱼提示上限时停止 |

筛选依据是总奖池，个人实际分到的金额由斗鱼决定。没有符合条件的红包时，等待下一轮查询。

## 运行条件与验证范围

浏览器关闭、控制页被丢弃或冻结时，脚本无法保证继续运行。后台工作页仍会消耗浏览器资源。

脚本使用当前斗鱼会话和动态请求字段，不要求粘贴 Cookie。登录凭证、CSRF token和红包领取 code 不保存到日志或导出文件。页面要求验证或限制参与时停止；平台规则与账号限制仍适用。

2026-10-22只读核对了现网房间发现接口、房间明细字段和动态请求字段。19项模拟测试验证规则及调度，**不代表真实账号已成功到账**，也未覆盖全部油猴和浏览器兼容性。详见 [测试说明](docs/TESTING.md)。

## 参考与致谢

本项目使用了以下直接参考及间接来源，具体范围分别标注如下。

| 项目 / 作者 | 关系 | 借鉴范围 | 标注位置 |
| --- | --- | --- | --- |
| [ienone/douyu-qmx-pro](https://github.com/ienone/douyu-qmx-pro)，MIT | 直接参考 | 接口字段和错误码、金币/星光棒奖品映射、动态CSRF字段解析、每包有限5次的请求时间安排；后台控制页调度作为架构参考 | 脚本顶部许可，以及 `prizes`、`parseBags`、`classify`、`offsets`、`csrfConfig` 函数旁的来源链接 |
| [ysl-ovo：斗鱼全民星推荐自动领取](https://greasyfork.org/zh-CN/scripts/532514)，MIT | 间接来源 | `douyu-qmx-pro` 在其 README 中声明基于此原版脚本开发；本项目未直接引入原版脚本代码 | 本表、脚本顶部及第三方声明 |

直接参考的固定版本：[`93accebf2983a49811ee218da7adf50547408575`](https://github.com/ienone/douyu-qmx-pro/tree/93accebf2983a49811ee218da7adf50547408575)。

具体参考文件：

- [RedBagState.js](https://github.com/ienone/douyu-qmx-pro/blob/93accebf2983a49811ee218da7adf50547408575/src/features/redbag/RedBagState.js)：奖品映射、错误码分类与5次领取调度。
- [CsrfConfig.js](https://github.com/ienone/douyu-qmx-pro/blob/93accebf2983a49811ee218da7adf50547408575/src/platform/douyu/CsrfConfig.js)：动态CSRF字段与Cookie名称解析。
- [DouyuAPI.js](https://github.com/ienone/douyu-qmx-pro/blob/93accebf2983a49811ee218da7adf50547408575/src/utils/DouyuAPI.js) 和 [接口研究文档](https://github.com/ienone/douyu-qmx-pro/blob/93accebf2983a49811ee218da7adf50547408575/docs/DOUYU_REDPACKET_API.md)：房间发现、房间奖池与领取请求的协议字段。
- [RedBagTaskController.js](https://github.com/ienone/douyu-qmx-pro/blob/93accebf2983a49811ee218da7adf50547408575/src/features/redbag/RedBagTaskController.js)：后台控制页任务架构参考。

本项目另行实现了任务引擎、界面、可配置奖池筛选、单控制页互斥、绝对时间调度、停止策略、日志导出及模拟测试。相应第三方版权和MIT许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 开发与测试

需要 Node.js 22或更新版本，无需安装第三方依赖：

```sh
npm test
npm run check
```

核心调度通过依赖注入测试，不会向斗鱼发送真实领取请求。

## 许可

[MIT](LICENSE)。使用时请同时保留 [第三方版权声明](THIRD_PARTY_NOTICES.md)。
