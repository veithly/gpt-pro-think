Node.js 当前 LTS 官方核验报告
最终简答
截至2026-06-06，Node.js当前LTS为v24.16.0，代号Krypton，发布日期2026-05-21。URL：https://nodejs.org/en/download、https://nodejs.org/en/download/archive/v24.16.0、https://nodejs.org/en/blog/release/v24.16.0。 [1]
执行摘要
截至 2026-06-06，Node.js 官网下载主页把 v24.16.0 标为当前的 Latest LTS；对应的官方发布说明页则把同一版本写为 2026-05-21, Version 24.16.0 &#39;Krypton&#39; (LTS)。据此，本次问题中的“当前 Node.js LTS 版本”可确认是 v24.16.0，LTS 名称为 Krypton，发布日期为 2026-05-21。[2]
需要说明的是，主下载页本身能直接确认“当前/最新 LTS”的版本号和 LTS 状态，但没有显式写出代号与发布日期；因此，我又使用同站的版本归档下载页做补充交叉验证。该页写明 v24.16.0 (Krypton)，并显示 Last updated May 21, 2026，与发布说明页日期一致。[3]
核验方法
本次核验只使用 nodejs.org 官方页面。判断链路分成三步：先看主下载页确认官网当前标注的 Latest LTS 版本；再看对应发布说明页核对版本号、LTS 代号与发布日期；最后看同站版本归档下载页，确认代号与日期是否一致。[4]
本次核验会话的访问时间记录为 2026-06-06 04:59:16 JST。本报告中的页面访问时间统一按这一会话时间记录。
本次记录的确切 URL 为：https://nodejs.org/en/download、https://nodejs.org/en/download/archive/v24.16.0、https://nodejs.org/en/blog/release/v24.16.0。[3]
结论分析
Node.js 下载首页首屏直接显示 “Get Node.js® v24.16.0 LTS”，并在页面底部再次标注 v24.16.0 Latest LTS。这说明截至 2026-06-06，官网面向下载的“当前/最新 LTS”指向 v24.16.0。[5]
对应的官方发布说明页标题为 Node.js 24.16.0 (LTS)，正文顶部明确写出 2026-05-21, Version 24.16.0 &#39;Krypton&#39; (LTS)。这同时确认了补丁版本号、LTS 代号，以及该版本在官网发布说明中的日期。[6]
还需注意一个语义细节：同一时点的官网下载页不只列出一个带 LTS 状态的版本，它还显示 v22.22.3 LTS。但页面首屏与页脚都把 v24.16.0 明确标为 Latest LTS，因此若问题是“当前 LTS 版本”，最稳妥、最贴近官网表达的答案就是 v24.16.0。[5]
版本归档下载页显示 v24.16.0 (Krypton)、First released May 06, 2025、Last updated May 21, 2026；而 Node.js Releases 页面也把 v24 / Krypton 的 First released 记为 May 06, 2025、Last updated 记为 May 21, 2026。据此我判断，归档页里的 First released 指的是 v24/Krypton 分支 的首次发布，而不是补丁版 v24.16.0 的发布日期；针对当前补丁版，发布日期应以发布说明页的 2026-05-21 为准。[7]
核验日志
下表记录了本次实际对比的两张核心页面，并明确标注了主下载页未直接给出的字段。表中访问时间统一为本次核验会话时间 2026-06-06 04:59:16 JST。[8]
页面
精确 URL
访问时间
页面可直接读到的关键信息
核验结论
官方下载页
https://nodejs.org/en/download
2026-06-06 04:59:16 JST
Get Node.js® v24.16.0 LTS；页脚为 v24.16.0 Latest LTS。[9]
可直接确认当前官网 Latest LTS = v24.16.0；代号与发布日期此页未明确写出。[5]
官方发布说明
https://nodejs.org/en/blog/release/v24.16.0
2026-06-06 04:59:16 JST
2026-05-21, Version 24.16.0 &#39;Krypton&#39; (LTS)。[10]
直接确认版本 = v24.16.0、代号 = Krypton、发布日期 = 2026-05-21。[11]
作为补充，同站下载归档页 https://nodejs.org/en/download/archive/v24.16.0 还写明 v24.16.0 (Krypton)，并把 Last updated 记为 May 21, 2026；这与发布说明页日期相符。它同时写有 First released May 06, 2025，但结合 Releases 页面可知，这更应理解为 v24/Krypton 分支 的首次发布日期。[7]
页面片段与时间线
由于本次核验对象是 HTML 页面而非 PDF，这里用页面片段代替截图，更直接展示关键证据。[4]
“Get Node.js® v24.16.0 LTS” [5]
“2026-05-21, Version 24.16.0 &#39;Krypton&#39; (LTS)” [11]
“v24.16.0 (Krypton)” 与 “Last updated May 21, 2026” [12]

这条时间线把“分支首次发布”和“当前补丁版发布日期”区分开来：2025-05-06 对应 v24/Krypton 分支 的首次发布，而 2026-05-21 对应 v24.16.0 这个当前 Latest LTS 版本在官网发布说明中的日期。[13]

[1] [2] [3] [4] [5] [8] [9] Node.js — Download Node.js®
https://nodejs.org/en/download
[6] [10] [11] Node.js — Node.js 24.16.0 (LTS)
https://nodejs.org/en/blog/release/v24.16.0
[7] [12] [13] Node.js — Run JavaScript Everywhere
https://nodejs.org/en/download/archive/v24.16.0