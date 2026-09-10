---
status: accepted
---

# ADR-0022 — API-transport Runtime Endpoint 的身份绑定凭据信封（identity-bound credential envelope）

## 0. 本 ADR 开篇自陈冲突（先 ADR 后任何凭据落盘代码）

本决策与项目现有记录里的**三处**正面冲突，逐处自陈并给出调和方式。此节是本 ADR 存在的前提：
凭据落盘这半边此前零设计，而上述三处已把"Workbench 不碰凭据"写成了承诺。

### 冲突一：ADR 0001（runtime 自持认证）

`docs/adr/0001-runtime-owned-auth-and-agent-loops.md`（status: accepted，唯一正文段）原文：

> "…while official Agent Runtimes retain authentication, model execution, tools, permissions, and
> native session lifecycle. … the Workbench will neither broker subscription credentials nor
> reimplement their agent loops."

**冲突实质**：本 ADR 让 Workbench 存储 API key——凭据材料进入 Workbench 进程并落盘，字面上撞
"Agent Runtimes retain authentication"。

**调和**：ADR 0001 写于只有订阅型 runtime（Claude OAuth / Codex ChatGPT 登录）存在的时代，其
立法意图是**不代理订阅凭据、不重造 runtime 的认证流程**。Owner 裁定 D4（2026-08-29）使
kimi/glm/deepseek 的 API 能力成为硬性要求，并明确 *"its auth is a key rather than a login
command"*——对 API-transport endpoint 而言，不存在一个"提供方自己的应用"可以拥有这次登录：
key 形态的认证没有 vendor 登录流可走，Workbench 是它唯一可以活的地方。因此本 ADR 对 ADR 0001
做**窄幅修订**而非废除：Workbench 可以、且仅可以，为 API-transport endpoint 存储key 形态的凭据；
订阅凭据的代理禁令与订阅路径的一切既有行为**原样保留**（ADR 0001 对订阅路径继续全文有效）。

### 冲突二：settings-copy.ts:21（已发布用户可见文案）

`src/workbench-shell/renderer/copy/settings-copy.ts:19-21`（英文；中文对应 :174-176）原文：

> :19 `credentialHeading: "The Workbench never handles credentials"`
> :21 `"This page never asks for a password, API key or token, never reads a credential file, and
> never stores credentials. None of those controls may be added."`

**冲突实质**："never stores credentials. None of those controls may be added." 是随产品发布过的
用户承诺；本 ADR 为 API-transport endpoint 增加 key 存储，按字面为假。

**调和（开门动作，非本 lane 执行）**：P2 开门时修订该文案（双语），把承诺范围如实收窄为
订阅路径（此页的订阅状态面板行为不变），并为 API-transport endpoint 如实披露信封存储及其
Windows 边界（见 §4）。收窄不是隐瞒：文案必须说清"存了什么、以何种保护、防什么不防什么"。

### 冲突三：stage-copy.ts:34（已发布用户可见文案，本 lane 复核新发现）

`src/workbench-shell/renderer/copy/stage-copy.ts:34`（runtimeBoundary；中文对应 :65）原文：

> `"Sign-in happens in each provider's own app. The Workbench never asks for a password, API key,
> or token, never reads a credential file, and never stores credentials."`

**冲突实质与调和**：同冲突二。评估原文只列了 settings-copy 一处；stage-copy 这处是本 lane
复核新增发现——两句文案几乎同文，开门时必须**同批修订**，否则留下一个说谎的边界提示。

> 附注（次要，供开门文案清扫参考）：`src/workbench-shell/renderer/copy/chrome-copy.ts:39` 还有
> 同族第三处 `credentialsNote: "Workbench 永不处理凭据"`。它不在本 Work Order 点名的三处之内，
> 但开门修订文案时应当一并清点，避免漏网。

## 1. 背景与范围（钉死）

- Owner 裁定 D4：kimi/glm/deepseek 的 API 能力为硬性要求，认证形态是 key 而非登录命令。
  本 lane（glm-endpoint-integration）的 GLM endpoint 是第一个实例；claude-api / codex-api /
  kimi / deepseek 是后续实例（spec P3）。
- **范围仅限 API-transport Runtime Endpoints**（glm / kimi / deepseek / claude-api / codex-api）。
- **订阅路径字节不动**：claude OAuth store、codex ChatGPT 登录、两家的 logout/状态机、
  `settings-copy` 中订阅状态面板的行为，开门后保持现状；本 ADR 不授权任何订阅凭据接触。
- 与用量计数（主线 F213 队列）的兼容：endpoint-selection key 的不透明性不被本设计破坏——
  信封的 keyName 是 endpoint 域内的不透明短标识（如 `glm-primary`），不携带用量语义。

## 2. 决策：身份绑定密钥信封 + 命名降级态 + 名字过界桥面

净室声明：机制四要点出自 `docs/github issue 2 backup.txt` #7（中文机制段 + 英文报告 §3.7）的
**机制描述**；未访问 grok-bot 仓库（本机亦不存在）；未复制其任何标识符、字符串常量、注释或
文件结构。信封前缀等常量为本项目自创（§3）；桥面五操作名（`listKeys` / `isPersistent` /
`upsert` / `remove` / `reveal`）与两态字符串（`"encrypted"` / `"in-memory"`）是 Work Order
钦定的契约词汇（亦为通用 CRUD 语义），除此之外的一切命名（类名、错误名、文件布局、存储文件
schema）均为本项目原创。

原型（屋外，自包含，`node --test` 全绿 21/21）：`prototypes/glm-endpoint-secret-envelope/`。

### 2.1 密文自描述格式：属主校验无需解密

每条密文信封是四段点分字符串：

```
uaw-env1.sha256.<64 位小写十六进制属主摘要>.<base64url(平台加密密文)>
```

属主摘要 = SHA-256(subject)（subject 是该信封绑定的身份串，如 endpoint 作用域）。验属主只需
重算 subject 摘要与第三段比对——**平台解密后端全程不被触碰**。这正是密钥链不可用、解密不可行
时唯一还成立的校验：坏 backend 下 `listKeys()` 仍能列出本 subject 的 key 名，属主错配仍能被
指名拒绝（`SecretEnvelopeOwnerMismatchError`），而不是把别人的条目当成自己的去解。

格式解析 fail-closed：段数、前缀、摘要算法、hex 字符集、base64url 规范编码（严格往返校验，
杜绝 Node base64url 解码器静默跳过杂字符）任一不符即抛 `SecretEnvelopeFormatError`，绝不猜测。

### 2.2 命名两态降级：`encrypted | in-memory`，绝不静默写明文

`resolveEnvelopeStorageMode({ isEncryptionAvailable }) → "encrypted" | "in-memory"`，唯一输入是
平台可用性声明，无第三态、无回退态。`in-memory` 臂的行为契约：

- 该 key 的值只存进程内存；**盘上同名条目被删除**（盘上状态不得谎称仍是该 key 的事实来源）；
- 每个 store 实例**警告恰好一次**（可注入 warn 汇，UI 可断言计数），不刷屏也不沉默；
- `isPersistent()` 返回 `false`，UI 如实呈现"本次会话有效，重启即失"；
- **绝不写明文**。这是本设计的硬底线：上游 grok-bot 的教训正是把加密桌面存储降级成
  `~/.grokbot/box-secrets.json` 明文 0600 落盘——密级貌似收紧、实际防线消失。我们把它作为
  反例钉在这里：降级态宁可诚实地丢持久化，不可撒谎地保持久化。

另两条 fail-closed 边界：backend 声称可用但 `encryptString` 抛错 → `upsert` 响亮失败、
分毫不写、不降级（`SecretEnvelopeEncryptError`）；store 文件损坏（非法 JSON / 错 marker /
错版本 / 条目非字符串）→ 构造即抛 `SecretEnvelopeStoreFileError`，**文件字节原样保留**，
绝不静默重建（重建即销毁可能可恢复的条目）。

### 2.3 桥面：名字过界，值仅按需

五个操作构成 UI/主进程与存储之间的全部桥面：

| 操作 | 语义 |
| --- | --- |
| `listKeys()` | 只返回名字（排序、去重），**永不返回值**；他 subject 的条目不列出 |
| `isPersistent()` | 模式是否 `encrypted`（值是否跨重启存活） |
| `upsert(keyName, secret)` | 加密态：信封原子落盘；内存态：走 §2.2 降级臂 |
| `remove(keyName)` | 清内存副本 + 盘上同名槽位，返回是否删了东西 |
| `reveal(keyName)` | **唯一**取值通道：内存优先，其次盘上信封；属主校验先于解密 |

供 P2 per-endpoint env 工厂消费的形状：`resolve(keyName) → string | undefined`——缺 key（= 
endpoint 未配置）返回 `undefined`；**已配置但坏了**（损坏/错主/解密失败）照样抛错，降级态的
store 永远不能靠异常静默伪装成"未配置"。key 在 env 工厂里只进子进程环境变量，不进日志、
快照与报告（对齐 spec 安全节与 ADR-0001 精神：认证细节对目录视图不透明）。

keyName 语法钉死 `/^[a-z0-9][a-z0-9._-]{0,64}$/`（`InvalidSecretKeyNameError` 把关），保证名字
可安全作 JSON 键、可入 UI、不可与格式内部结构撞车。

### 2.4 可注入、无 Electron 可单测

构造注入 `{ subject, safeStorage, storePath }`，另有可选 `warn` 汇与文件系统桥
（`FilesystemBridge`）。`safeStorage` 只依赖 Electron 该 API 的三方法切片
（`isEncryptionAvailable / encryptString / decryptString`），测试用确定性假 backend
（XOR 密钥流 + 完整性标签）注入，21 个用例全部无 Electron 通过。真机 DPAPI 行为
（含不可用时的真实降级路径）是开门后验证项，见 spec 开放问题。

### 2.5 落盘原子性与并发

- 存储文件 schema：`{ "uawEnvelopeStoreFile": 1, "entries": { <keyName>: <信封串> } }`，
  键排序序列化（diff 友好、确定性的文件字节）。
- 写入原子：同目录临时文件（`*.uaw-tmp-<pid>-<n>`）→ fsync 临时文件 → rename 整体替换 →
  （POSIX）目录 fsync。目的文件从不被打开写，崩溃只可能留下旧文件或新文件，不可能是半个。
- 进程内并发：每次操作重读文件、单线程同步完成读-改-写，事件循环天然串行化，按构造不可能
  丢更新（30 连发 upsert/remove 测试为证）。
- **Windows 取舍**（如实记录）：rename 覆盖走 `MoveFileEx(REPLACE_EXISTING)`，可因 AV 扫描等
  外部进程持锁而 EPERM——原型响亮暴露不重试，P2 真机观察后再决定是否加退避；**目录 fsync
  在 Windows 不是可靠原语**（Node 无法打开目录 fd），故仅在 POSIX best-effort 执行，
  Windows 接受 rename 后、目录项落盘前的残余窗口。
- 多 subject 共享一个 store 文件是合法形态：他人条目在重写时**字节原样保留**、不列出、
  reveal 时属主错配指名拒绝。

## 3. 常量自创说明（净室对照）

| 常量 | 值 | 理由 |
| --- | --- | --- |
| 信封前缀 | `uaw-env1` | 项目命名空间（uaw = unified-agent-workbench）+ envelope + 格式版本 1；可 grep、可防与任意 base64 串误认，版本位留迁移通道 |
| 存储文件标记 | `uawEnvelopeStoreFile`（版本整数 `1`） | 同上，文件级自描述与版本门 |
| 临时文件词干 | `uaw-tmp` | 同目录可识别、可清扫 |
| subject 形状 | `workbench://endpoint-lab/<名>`（原型示例） | URI 式身份串，开门定稿生产值 |
| keyName 语法 | `/^[a-z0-9][a-z0-9._-]{0,64}$/` | JSON 键安全、UI 安全、防结构撞车 |

## 4. Windows 真相文案（开门时 UI 必须如实说）

Windows 上 Electron `safeStorage` = **DPAPI，按用户账户**作用域。UI 文案（双语）必须直说：

- 它**防**：离线盘检（拆盘/拷盘后离线读密文——其他账户解不开）。
- 它**不防**：**已在同一用户账户下运行的进程**（任何以你身份跑起来的代码可直接调本 store
  的 API 取值）。这不是缺陷陈述，是威胁模型陈述；说一半就是误导用户。

冲突二/三的修订文案必须同时满足本节与 §0 的收窄要求——文案修订属于 P2 开门动作，不在本 lane
可写边界内。

## 5. 后果

**正面**：D4 硬性要求（glm/kimi/deepseek key 落盘）有了可评审的设计载体；降级态命名化使
"加密不可用"从隐性事故变成 UI 可呈现、测试可断言的一等状态；属主摘要使密钥链故障下仍可
管理（列名、验主、拒绝越主）而不需要解密能力；全部行为无 Electron 可测。

**负面/代价**：三处已发布文案须修订（用户可感知的承诺变化，开门时一次性做完并同步双语）；
ADR 0001 需窄幅修订（本文件即修订案）；DPAPI 不防同账户进程的真相必须在 UI 反复陈述；
真机 DPAPI 降级路径、AV 持锁 rename 失败两处待开门实测。

**开门清单（P2，`issues/02-integration-door-open.md` 归口）**：
1. 本 ADR 落档 `docs/adr/` 并按实际次空号编号（现主流水到 0021）。
2. 修订 settings-copy.ts:19-21（含中文 :174-176）与 stage-copy.ts:34（含中文 :65），
   双语同批；顺带清点 chrome-copy.ts:39 同族文案。
3. 原型迁入 `src/**`（信封 codec + store + 测试），GLM endpoint 的 key 来源从 owner-env
   升级为此 store（`resolve` 接口已按此对齐）。
4. 真机验证：DPAPI 可用性探测、降级路径、rename 在 AV 环境下的行为。
5. 生产 subject / keyName 常量定稿（本文件 §3 原型值仅为示例）。

## 6. 测试与凭据纪律

原型测试 21/21 全绿（`node --test`，Node v24.19.0，type stripping，零构建）。测试与全部
lane 文件中**没有任何真实凭据**——一律使用 `test-secret-<n>` 形式的显式假值；key 值在任何
错误消息、日志、证据文件中均不出现（有专门断言：错误文本不得包含秘密值）。
