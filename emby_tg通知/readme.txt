1:解压
cd /opt
tar -xzvf emby_av_notifier_backup.tar.gz
2:启动服务-构建镜像
cd /opt/emby_av_notifier
docker compose down
docker compose build
docker compose up -d
