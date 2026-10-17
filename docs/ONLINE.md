# ClassNote 线上私人知识库

线上版沿用 Next.js 和原有深色界面，使用 Supabase Auth、PostgreSQL，附件支持私有 Supabase Storage 和 Cloudflare R2。网站保留在 EdgeOne，正式地址由 `CLASSNOTE_ORIGIN` 指定。

本机启动器仍使用电脑上的 SQLite 和附件目录，两套资料相互独立。线上版不会自动上传本机数据库或录音。

## 部署配置

1. 创建独立的 Supabase 项目，在 SQL 编辑器执行 `supabase/migrations/001_private_library.sql`。
2. 在数据库中加入自己的已验证邮箱：`insert into public.cn_owners(email) values ('your-verified-email@example.com');`。
3. 在 Authentication 创建自己的邮箱密码账号并确认邮箱，关闭公开注册和匿名登录。
4. 在 EdgeOne 生产环境设置 `.env.example` 中的基础变量。数据库仅使用 publishable key，所有数据库请求保留当前用户身份。不要配置 Supabase service_role 或管理员密钥。
5. 构建并部署后，在正式网址登录；未登录的课程、笔记和附件接口必须返回 401。不要仅凭登录页出现就认定权限检查已完成。

## 接入 Cloudflare R2

1. 在自己的 Cloudflare 账号开通 R2 Standard。订阅和支付资料由账号所有者在 Cloudflare 页面完成。
2. 创建私有桶 `classnote-private`，可选亚太位置提示。保持公开访问关闭，不启用 `r2.dev` 或公开自定义域名。
3. 配置以下桶 CORS，允许正式网站直接上传。其他网址需要单独明确加入，不能使用通配来源。

```json
[
  {
    "AllowedOrigins": ["https://lu.gucanyuexuchen.top"],
    "AllowedMethods": ["GET", "HEAD", "PUT"],
    "AllowedHeaders": ["content-type", "cache-control", "if-none-match", "range"],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"],
    "MaxAgeSeconds": 3600
  }
]
```

4. 创建仅限该桶的 Object Read & Write 凭据，将 Access Key ID 和 Secret Access Key 直接填入 EdgeOne 生产环境的 `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`。不能写进聊天、Git 或前端变量。
5. 在 Supabase SQL 编辑器执行 `supabase/migrations/002_r2_attachments.sql`。该脚本为已有附件标记 `supabase`，保留原 ID、内容和文件；新增 R2 的独立容量预留。
6. 在 EdgeOne 设置 `R2_ACCOUNT_ID`、`R2_BUCKET=classnote-private`、`CLASSNOTE_ATTACHMENT_STORAGE=r2`，再部署此版本。需要先执行迁移，再部署代码，避免查询新字段失败。
7. 用登录账号实际验证新附件上传、刷新后读取、拖动播放、图片和删除；匿名附件请求应返回 401，R2 未签名链接不可读取。旧 Supabase 附件也要能继续读取。

网站默认将 R2 新附件上传上限设为 **10,000,000,000 字节**，保留中的上传也计入，避免并发上传越过该上限。此上限仅管理本应用的逻辑附件容量，不是 Cloudflare 的账单硬上限；同账号的其他桶、存储操作等另按供应商规则计费。提高上限须由数据库所有者明确调整 `cn_storage_limits`，普通登录客户端无权修改。设置面板分别显示当前存储用量和旧存储保留量。

新上传改用 R2，已有录音保持原存储读取。此步骤不下载、迁移或删除已有录音。R2 配置缺失时明确报错，不自动把新文件传回已满的原存储。

R2 上传签名只对当前所有者、附件、分段、大小和 MIME 有效，15 分钟过期，以覆盖慢网重试，签名强制 `If-None-Match: *` 防止覆盖已校验对象。R2 仍复用分段 SHA-256 校验、完整上传确认和有长度上限的 Range 播放。下载签名 60 秒过期，凭据仅在服务端使用。

## 数据与权限（通用）

`cn_owners` 是数据库所有者维护的允许名单，普通客户端无权修改。每张业务表开启行级权限，要求登录邮箱位于允许名单，且记录的 `owner_id` 等于当前用户。课程、课堂和附件同时使用带所有者的外键，防止跨账号关联。

附件桶 `classnote-private` 不公开。上传地址在登录校验后签发，文件按账号和附件 ID 分目录。每段上传后由服务端流式计算 SHA-256，与浏览器校验结果比较；所有分段齐全后才显示为上传成功。音频以 32 MiB 分段保存，图片作为独立对象保存，均使用持久化对象存储。每份附件记录自己的存储供应商，读取和删除按该记录路由。

上传优先使用 Supabase 的[存储直连域名](https://supabase.com/docs/guides/storage/uploads/resumable-uploads)，最多同时处理同一录音的两个分段，上传与云端校验交错进行。不同录音仍按选择顺序逐份添加。浏览器用独立 Worker 按存储分段读取文件，以原生 WebCrypto 计算分段 SHA-256，并增量计算整份文件的 SHA-256；每段哈希就绪即可上传，无须等待整份录音校验完毕。音频每次读取最多 32 MiB，不将整份长录音读入内存。不支持 Worker 时按小块让出界面线程。短暂传输失败会重试当前分段，直连失败时尝试原存储入口；已确认的分段不重复上传，重复校验请求复用已有结果。最终失败仍清理本次上传，手动点击重试会重新上传整份文件，尚不支持刷新或关闭网页后的断点续传。

任务面板显示已传输大小、近期传输速度、云端校验及保存阶段。进度达到 98% 仍需等待全部分段验证，服务端最终确认后才显示 100%。网络线路、上行带宽和免费存储服务状态仍会影响实际耗时，界面不承诺固定速度。

播放器接口验证登录后提供有长度上限的 Range 响应，绕过 EdgeOne 单次响应大小限制。图片采用 60 秒有效的私人签名链接；获得该临时链接的人在有效期内仍可读取，所以不要分享临时链接。固定的附件接口仍需登录。

Cookie 设置为 HttpOnly、SameSite=Lax，正式网址使用 Secure。写请求检查网站来源。登录过期时在原页面上覆盖登录层，编辑器与草稿保持挂载。登录退出前必须成功保存当前课堂。页面和接口不允许搜索引擎收录，不缓存私人 API 响应。

## 免费方案与备份

首版按免费方案配置 1 GiB 附件容量，容量已用尽时拒绝上传并给出提示。Supabase 的月度流量和项目休眠等限制仍按其当前套餐执行。长期保存大量课堂录音需要另行选择合适容量；本项目没有自动购买套餐或开通付费资源。

大型文件下载和完整备份优先直接写入浏览器选择的文件。浏览器不支持选择保存位置时，原始附件使用最多 128 MiB 的内存下载，完整备份使用最多 256 MiB；超限会明确提示换用支持的浏览器。线上 ZIP 恢复限制为解压后 256 MiB，以控制浏览器内存占用，先校验全部关联和附件哈希，再追加导入。导入失败会尝试清理本次新增课程；如果清理失败，会明确提示检查残留。恢复期间不要关闭网页。更大的备份可在本机版恢复后分批上传。

每天使用之外，定期保存完整备份到电脑或其他磁盘。免费云存储不替代独立备份。
