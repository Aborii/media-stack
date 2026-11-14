# subfill: plain Node running the TypeScript sources directly (Node strips the
# types itself), with no runtime dependencies at all - SQLite, HTTP and fetch
# all come from Node. So there is nothing installed that could phone home or
# go stale, and no build step.
FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src

# Node itself has no telemetry or update check. npm does an update check, but
# npm never runs here: the container starts node directly.
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
