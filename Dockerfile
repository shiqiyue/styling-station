# ============================================================
#  搭配台（styling-station）服务端镜像
#  - 阶段 1：下载官方 Flutter SDK（国内镜像）编译 Web 前端
#  - 阶段 2：零依赖 Node 服务，静态托管前端 + JSON API + SSE
#  用法见 README「Docker 部署（可选）」；compose 绑定 ./server/data
#  持久化数据与配置（arkApiKey 在 settings.json 里，绝不进镜像）。
# ============================================================

# ---------- 阶段 1：编译 Flutter Web ----------
# 不用第三方 Flutter 镜像：公开镜像的版本线都落后于 3.47.x，
# 直接取与本机 (build-web.bat) 相同的官方 SDK 版本，行为可复现。
FROM debian:bookworm-slim AS webbuild

ARG FLUTTER_VERSION=3.47.5
ENV PUB_HOSTED_URL=https://pub.flutter-io.cn \
    FLUTTER_STORAGE_BASE_URL=https://storage.flutter-io.cn \
    PATH=/opt/flutter/bin:$PATH

# 换阿里云 apt 源（国内构建提速；文件不存在时跳过，不中断构建）
RUN sed -i 's|//deb.debian.org|//mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources || true
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl xz-utils git unzip zip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# 下载并解压 Flutter SDK（约 1.5GB；该层缓存后重复构建不再下载）
RUN curl -fSL --retry 3 -o /tmp/flutter.tar.xz \
      "$FLUTTER_STORAGE_BASE_URL/flutter_infra_release/releases/stable/linux/flutter_linux_${FLUTTER_VERSION}-stable.tar.xz" \
 && tar -xJf /tmp/flutter.tar.xz -C /opt \
 && rm /tmp/flutter.tar.xz \
 && flutter --version

WORKDIR /src
# 先只拷依赖清单：pubspec 没变时依赖层直接复用缓存
COPY app/pubspec.yaml app/pubspec.lock ./
RUN flutter pub get

# 源码（app/ 下 build、.dart_tool、android 等已由 .dockerignore 排除）
COPY app/ ./

# 与 build-web.bat 同参数：CanvasKit 本地化，不依赖外网 CDN
RUN flutter build web --release --no-web-resources-cdn

# ---------- 阶段 2：运行镜像 ----------
FROM node:22-alpine

# 时区：记录时间戳按本地时区格式化（与本机 start.bat 模式一致，否则差 8 小时）
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories \
 && apk add --no-cache tzdata
ENV TZ=Asia/Shanghai

WORKDIR /app
# 容器内目录结构与仓库一致：数据在 server/data（compose 绑定），Flutter 产物在 app/build/web
COPY server/ server/
COPY web/ web/
COPY --from=webbuild /src/build/web/ app/build/web/

EXPOSE 4584

# 健康检查：读 settings.json 的 port（缺省 4584）再探 /api/health
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node","-e","let p=4584;try{p=JSON.parse(require('fs').readFileSync('/app/server/data/settings.json','utf8')).port||p}catch{};fetch('http://127.0.0.1:'+p+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node","server/server.mjs"]
