# 分摊网站

分摊网站管理多来源余额、税务主体资料、商品开票模板和批次记录。计算使用整数分，申领人、成本中心、法律主体及用途必须完整一致；申领部门和使用中心的空值可与唯一非空值合组，各字段的不同非空值不得同组。保留来源顺序、历史台账和可追溯记录。

## 工作流程

1. 使用网站账号登录，按优先级逐份导入金额来源，核对历史商品与余额；再上传税务主体表。工作台会依据当前状态只给出一个建议下一步。
2. 进入“新建分摊”后，页面按“录入商品 → 精确试算 → 生成文件 → 独立复核 → 确认入账”展示进度。可用一句话交给 DeepSeek 识别商品名称、单价和数量，也可直接手动填写；AI 识别失败不会阻止继续处理。
3. 试算通过前不会扣减余额。若空部门记录可归入多个互不兼容组，页面会停在“确认部门归属”并逐条要求选择；确认后重新完成精确试算。随后上传开票模板并生成待核验文件。
4. 通过受控的 Codex 工作流取得冻结资料，由两个独立 agent 分别复核并提交报告。MCP 核验包和网站下载包都不返回预设财务答案或其他复核者报告，只返回当前凭据自己的提交状态；网站本身不会自动启动 agent，不能由浏览器按钮或 DeepSeek 预检代替核验。
5. 两份有效报告通过后，页面进度进入“确认入账”，由使用者输入独立入账控制口令确认。口令不保存在浏览器；每个批次提供开票单、各来源标红表和剩余表、核对记录，新批次从更新后的余额继续。

## Skill 与网站账簿同步

网站数据库是共享余额的唯一正式账簿。Skill 不得把本地 Excel 剩余表当作另一套可独立扣减的余额；本地 Excel 只保存网站导出的带版本只读快照和本批结果。网站会拦截原总额、当前可用金额、完整资金指纹、完整业务行集合，或六个业务字段中同一位置至少五个相同的部分重叠行，因此删除隐藏元数据、改名、拆分行、改写金额或少量文字后，只要仍命中这些信号就会被拒绝。自动判重不能证明一份同时大幅改写金额和多个业务字段的任意 Excel 是否属于独立真实来源；向已有账簿追加原始 Excel 时必须填写唯一财务来源编号、明确确认独立性，并由操作人结合财务凭证核对承接关系。网站保存确认账号、时间和编号，同一编号不能重复使用。

1. 在与 `site/` 同级且不会被提交的受限位置创建同步凭据，例如 `.work/secrets/allocation-ledger-sync-token`。内容使用至少 64 位随机十六进制文本；Linux 上把权限设为 `600`。
2. 在网站进程使用的 `ALLOCATION_SYNC_TOKEN_FILE` 中指向服务端读取的同一凭据文件。不要把令牌写入仓库、命令参数、日志或聊天。
3. 本地配置文件使用以下字段，路径必须为绝对路径：

   ```json
   {
     "schema_version": 1,
     "base_url": "https://实际网站地址",
     "site_directory": "/绝对路径/site",
     "sync_script": "scripts/ledger-sync.mjs",
     "pull_command": "npm run ledger:pull -- --config /绝对路径/账目分摊网站同步配置.json",
     "token_file": "/绝对路径/.work/secrets/allocation-ledger-sync-token",
     "target_directory": "/绝对路径/网站账簿快照",
     "required_before_planning": true,
     "required_after_website_commit": true
   }
   ```

4. 在 Skill 读取金额、正式试算或制表之前，在 `site_directory` 运行 `pull_command`。同步脚本会验证工作区版本、清单摘要、来源和税务文件哈希、金额守恒与 ZIP CRC。网站不可达、凭据失效、文件被改动、版本回退或同版本摘要变化时，正式分摊必须停止。账簿状态未变时，重复同步会安全返回并保持当前版本。
5. 网站完成批次正式入账后，再次运行 `pull_command`，让本地快照前进到新版本。本地生成 Excel 和本地删除已用行都不会推进网站余额。

本地 `target_directory` 是稳定的同步根目录。根目录的 `账簿清单.json` 是唯一活动版本指针，实际文件位于 `versions/v工作区版本-摘要前缀/`；`同步接收记录.json.snapshot_directory` 给出当前版本目录。同步先完整写入并校验不可变版本目录，再用原子文件替换发布新清单，因此中断时活动清单仍指向上一份完整版本。同一目标的同步使用排他锁，禁止两个本地进程交错发布。版本文件和目录会设置为只读；这能发现意外改动，但不能代替操作系统账户权限控制，尤其 Windows 仍应使用独立服务账户和 ACL 限制写入。旧格式快照首次校验通过后可继续同步，旧文件只作历史，不再被活动清单引用。

网站账簿导入税务修正 JSON 时，每条修正只能选择一种作用范围：指定批次使用 `scope.batch_ids`；明确授权未来批次则使用 `scope.applies_to_all_future_batches:true`，并提供带时区的 `scope.effective_from_utc`。两种范围不能同时声明。网站会把批次创建时间与该起点比较，过去批次不会套入后来才生效的修正。活动快照中的 `资料/税务主体.xlsx` 和 `资料/税务修正.json` 才是网站模式的权威税务输入。

## 运行和测试

- Node.js 需支持 `node:sqlite`，建议使用 22.21 或更新的受支持版本。安装依赖：`npm ci`。
- `npm test` 运行分摊、开票、权限和账簿同步测试；`npm run test:ai` 运行 AI 兼容测试。`npm run build:server` 构建 Node/Next.js 服务，`npm run start:server` 以本机地址启动服务。
- 设置 `ALLOCATION_DATA_DIR` 为应用目录以外的绝对路径；程序会在其中建立 SQLite 数据库和对象文件。管理员账号须在服务器本机使用 `scripts/initialize-owner.mjs` 初始化；脚本从标准输入读取账号信息，不要把账号密码写入命令历史或仓库。
- 登录限流密钥通过 `ALLOCATION_RATE_KEY_FILE` 指向的受限文件提供；两名复核者必须分别使用 `ALLOCATION_REVIEWER_A_TOKEN_FILE` 和 `ALLOCATION_REVIEWER_B_TOKEN_FILE`，正式入账控制使用独立的 `ALLOCATION_COMMIT_TOKEN_FILE`，Skill 账簿同步使用 `ALLOCATION_SYNC_TOKEN_FILE`。网页入账按钮会临时要求输入入账控制口令，MCP 入账也必须使用独立入账控制凭据；普通登录账号和复核凭据都不能越过该门禁。报告中的 `reviewerId` 必须分别写成 `codex-reviewer-a` 和 `codex-reviewer-b`，后端会把自报身份与本次凭据身份绑定，并拒绝同一凭据提交两份报告。文件应归运行账号所有，使用足够随机的十六进制值，且不能进入 Git 仓库。生产环境可参考 `scripts/server-pm2.config.cjs`。
- DeepSeek 功能可选配置 `DEEPSEEK_API_KEY` 或 `DEEPSEEK_API_KEY_FILE`；也可在数据目录的 `secrets/deepseek-key` 放置受限密钥文件。默认模型为 `deepseek-flash`，可使用 `DEEPSEEK_MODEL` 覆盖，API 地址可通过 `DEEPSEEK_API_BASE_URL` 配置（兼容 `DEEPSEEK_API_BASE`）。
- AI 助手只读取本批结构化摘要；只有用户主动勾选后，本轮才会附带文件预览中的少量单元格。不会自动发送整份工作簿。AI 结果仅供参考，不能替代双重独立核验或人工采用确认。
- 通过 HTTPS 对外服务时，设置 `ALLOCATION_PUBLIC_ORIGIN` 为正确的 HTTPS 源，并由可信反向代理验证主机名、覆盖转发头和配置证书；如有多个严格受控入口，可用英文逗号分隔完整 HTTPS 源，任何空项、非 HTTPS 或带路径/账户的无效项都会让公网入口整体拒绝。Node 服务继续仅监听本机。
- Next.js 在独立部署时会发送 CSP、HSTS、`nosniff`、禁止嵌入、Referrer Policy 和 Permissions Policy 等完整安全响应头。若可信公网入口已经统一发送其中由入口负责的响应头，可设置 `ALLOCATION_EDGE_SECURITY_HEADERS=true`；应用会避免重复，同时通过页面 CSP meta 保留脚本和样式等细粒度限制，并继续发送 `X-Frame-Options`、`Cross-Origin-Opener-Policy` 和 `Cross-Origin-Resource-Policy`。上传接口在完整解析前限制请求体，并最多同时处理两份 XLSX/JSON；超限请求返回明确的 413 或 429，避免复杂压缩文件占满 Node 主进程。
- `scripts/allocation-backup.mjs` 可按环境变量指定的数据和备份目录创建备份，并检查 SQLite/对象引用及恢复流程。`scripts/scheduled-maintenance.sh` 会先做数据库与对象备份，再拉取最新网站账簿 Excel 快照；生产环境可按当天分摊节奏安排定时执行。备份必须与源码和凭据分开保护。当前脚本负责同机备份；生产环境还应把已验证备份复制到独立机器或对象存储，并对定时任务失败配置外部告警。

本仓库仅提供代码和合成测试，不提供账号、密钥、客户数据或历史账簿。旧规则下创建的待入账批次必须重新试算并双重核验。Skill 附带的旧版单来源脚本不支持本规则，不能用于替代网站的新规则核验。
