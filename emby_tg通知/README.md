Emby Notifier v1.1.0 部署说明

当前说明对应你现在在用的这套版本：
功能：解耦多模块 + 成人识别 + fanart 优先 + 剧集打包推送

⸻

1. 部署前准备

1.1 环境要求
	•	一台可以运行 Docker 的服务器（Linux 推荐）
	•	已经在跑的 Emby 服务（例如：http://154.12.28.250:8096）
	•	Telegram 机器人 & 频道：
	•	一个 Bot Token（TG_BOT_TOKEN）
	•	一个频道/群 ID（TG_CHAT_ID，通常是负数，如 -1003218964901）

1.2 代码目录结构（示例）

假设项目放在：/home/emby_notifier_v1.1.0
目录结构如下：
/home/emby_notifier_v1.1.0/
  ├── app.py
  ├── docker-compose.yml
  ├── Dockerfile
  ├── requirements.txt
  └── notifier/
      ├── __init__.py
      ├── config.py
      ├── utils.py
      ├── mediainfo.py
      ├── emby_meta.py
      ├── tmdb_client.py
      ├── telegram_client.py
      ├── templates.py
      └── services.py

2. 配置 docker-compose

核心部署通过 docker-compose 完成。

2.1 示例 docker-compose.yml

在 /home/emby_notifier_T3.0/docker-compose.yml 填入类似内容（如果已存在，按下面对照调整即可）：
version: "3.9"

services:
  emby_notifier:
    build: .
    container_name: emby_notifier_T3.0
    restart: unless-stopped

    environment:
      TG_BOT_TOKEN: "你的_TG_BOT_TOKEN"
      TG_CHAT_ID: "-1003218964901"               # 你的频道/群 ID
      EMBY_BASE_URL: "http://154.12.28.250:8096" # 你的 Emby 面板地址
      EMBY_API_KEY: "你的_emby_api_key"
      TMDB_API_KEY: "你的_tmdb_api_key"

      # mediainfo 等待策略（全局设置）
      # 在 60 秒内，每 5 秒检查一次 mediainfo json 是否生成
      MI_TIMEOUT: "60"
      MI_INTERVAL: "5"

    volumes:
      # 这里要和 Emby/MediaHelper 使用的路径一致
      - /media:/media:ro
      - /home/MediaHelp/strm:/home/MediaHelp/strm:ro

    ports:
      # 宿主机 8000 暴露给 Emby 调用 Webhook
      - "8000:8000"
3. 配置项说明（环境变量）

所有配置通过环境变量注入（在 docker-compose.yml 的 environment 中）。

3.1 Telegram 相关
	•	TG_BOT_TOKEN
	•	Telegram 机器人 Token
	•	形如：1234567890:AAxxxxxxxxxxxxxxxxxxxxxx
	•	TG_CHAT_ID
	•	接收通知的频道或群 ID
	•	频道一般是负数：-100xxxxxxxxxx
	•	你现在用的是类似 -1003218964901 这样的数字

机器人必须已经有权限在该频道/群里发消息（你已经在用，就照旧填）。

⸻

3.2 Emby 相关
	•	EMBY_BASE_URL
	•	你的 Emby 服务地址（对这个容器可达）
	•	示例：http://154.12.28.250:8096
	•	不要带 /emby 之类的尾巴，末尾不要加 /
	•	EMBY_API_KEY
	•	Emby 后台生成的 API Key，用来访问封面等资源
	•	Emby 后台生成方式：
	1.	登录 Emby 管理后台
	2.	进入：控制台 → 高级 → API 密钥（或类似选项）
	3.	新建一个密钥，备注随便写（例如 emby_notifier）
	4.	把生成的字符串填到 EMBY_API_KEY

这个 Key 会被用来拼接封面地址：
http://154.12.28.250:8096/Items/{ItemId}/Images/Backdrop?api_key=...&maxWidth=1200&quality=90

⸻

3.3 TMDB 相关（选填但强烈推荐）
	•	TMDB_API_KEY
	•	The Movie Database API Key
	•	用来查询电影/剧集：中文片名、原始片名、评分、类型、封面等
	•	没有的话也能跑，但电影/剧集的评分与类型会弱一些，封面可能只能用 Emby 的

⸻

3.4 mediainfo 等待策略
	•	MI_TIMEOUT
	•	类型：秒
	•	默认/推荐：60
	•	含义：在这段时间内，循环检查 mediainfo json 文件是否生成
	•	MI_INTERVAL
	•	类型：秒
	•	默认/推荐：5
	•	含义：检查间隔，避免疯狂读盘

逻辑是：
	•	每次有 .strm 入库，程序会去找同目录下的
xxx-mediainfo.json 或 xxx.mediainfo.json
	•	在 MI_TIMEOUT 秒内，每 MI_INTERVAL 秒检查一次
	•	找不到就放弃，用 Emby 自带的信息兜底，不会阻塞推送

⸻

4. 启动容器

4.1 构建镜像并启动

在服务器上执行：
cd /home/emby_notifier_T3.0

# 停掉旧容器（如果有）
docker compose down

# 强制重建镜像（保证最新代码）
docker compose build --no-cache

# 后台启动
docker compose up -d
4.2 验证服务状态

查看容器状态：
docker ps | grep emby_notifier_v1.1.0
查看日志：
docker logs --tail=50 emby_notifier_v1.1.0
如果一切正常，会看到类似：
INFO:     Started server process [1]
Emby Notifier v1.1.0 startup, episode batch window=60.0s
INFO:     Application startup complete.
INFO:     Uvicorn running on http://0.0.0.0:8000

5. Emby Webhook 设置

目标：让 Emby 在「有新片入库」时通知我们的服务：
http://服务器IP:8000/emby-webhook

具体界面可能因为插件版本略有不同，下面是通用步骤（你之前已经配置过，只是现在换了地址）：
	1.	打开 Emby 管理后台（例如 http://154.12.28.250:8096）。
	2.	以管理员账号登录。
	3.	找到 「插件」 / 「Webhooks」 / 「通知」 相关设置：
	•	常见插件名：Webhooks、Webhook Notifications 等。
	4.	在 Webhook 配置页中新建一个 webhook：
	•	URL 填：http://154.12.28.250:8000/emby-webhook

注意端口是 8000，路径是 /emby-webhook。

	•	触发事件 根据需要勾选，至少包括：
	•	ItemAdded / 新增媒体 / New Media Added
	•	（你若只关心入库，不勾播放相关事件即可）

	5.	保存配置，重启 Emby 或应用设置。

之后只要 Emby 检测到新影片入库，就会往这个 URL 发 POST，
我们的服务收到后会根据类型（电影 / 剧集 / 成人）生成推送。
