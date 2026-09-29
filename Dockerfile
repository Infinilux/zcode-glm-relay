FROM node:20-bookworm-slim

# HF 平台以 uid 1000 运行容器:显式建用户,并让 /app 与 HOME 归属它,
# 否则 entrypoint 写账号池/凭据/日志全部 EACCES
ENV HOME=/home/user
RUN useradd -m -u 1000 user

# 上游引擎:官方 release 的 linux-x64 构建(本机线上是 v4.7.0 的 .exe,容器换官方 Linux 版,
# 同一项目 TriDefender/zcode-api,配置/凭据格式一致)
ADD https://github.com/TriDefender/zcode-api/releases/download/v4.7.1/zcode-proxy-linux-x64 /app/bin/zcode-proxy
RUN chmod +x /app/bin/zcode-proxy && mkdir -p /app/logs && chown -R 1000:1000 /app

WORKDIR /app
COPY --chown=1000:1000 accounts.json zcode-gateway.js sync-accounts.js blackbox.js entrypoint.sh /app/
RUN chmod +x /app/entrypoint.sh

# HF Docker Space:README.md 元数据 app_port: 3203
EXPOSE 3203

USER 1000
ENTRYPOINT ["/bin/bash", "/app/entrypoint.sh"]
