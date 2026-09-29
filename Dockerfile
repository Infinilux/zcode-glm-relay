FROM node:20-bookworm-slim

# 平台以非 root 运行:直接用镜像自带的 node 用户(就是 uid 1000,别再 useradd——
# 会撞 "UID 1000 is not unique",Render 首次构建实测踩过)
ENV HOME=/home/node

# 上游引擎:官方 release 的 linux-x64 构建(本机线上是 v4.7.0 的 .exe,容器换官方 Linux 版,
# 同一项目 TriDefender/zcode-api,配置/凭据格式一致)
ADD https://github.com/TriDefender/zcode-api/releases/download/v4.7.1/zcode-proxy-linux-x64 /app/bin/zcode-proxy
RUN chmod +x /app/bin/zcode-proxy && mkdir -p /app/logs && chown -R node:node /app

WORKDIR /app
COPY --chown=node:node accounts.json zcode-gateway.js sync-accounts.js blackbox.js entrypoint.sh /app/
RUN chmod +x /app/entrypoint.sh

# HF Docker Space:README.md 元数据 app_port: 3203
EXPOSE 3203

USER node
ENTRYPOINT ["/bin/bash", "/app/entrypoint.sh"]
