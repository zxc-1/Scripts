# Emby Notifier v1.1.0

一个基于 FastAPI 的 Emby Webhook 通知服务，支持电影、剧集和成人番号入库通知，通过 Telegram 推送。

## 功能特性

- 电影 / 剧集普通模版，自动补全：
  - 文件大小、码率、分辨率
  - 评分、类型、简介
  - TMDB / 豆瓣 外链
- 成人番号模版：
  - 自动识别番号（如 `SONE-983`）
  - 从路径推断演员（上级目录名）
  - 标签、简介、发行日期
- 剧集打包推送：
  - 同一部剧同一季的多集，支持 `S01E01-S01E15` 一条合并通知
- 封面图：
  - 优先使用本地 `fanart.jpg`
  - 其次使用 TMDB 大图或 Emby Backdrop（1200px, quality=90）

## 部署方式（docker-compose）

```bash
docker compose build
docker compose up -d
