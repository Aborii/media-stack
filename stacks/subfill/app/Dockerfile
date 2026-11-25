# subfill: plain Node running the TypeScript sources directly (Node strips the
# types itself), with no npm dependencies - SQLite, HTTP and fetch all come
# from Node - and no build step. The one package added is Alpine's ffmpeg, to
# read subtitle tracks stored inside videos (src/embedded.ts); it only reads
# local files and makes no network calls.
FROM node:24-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY package.json ./
COPY src ./src

# Node itself has no telemetry or update check. npm does an update check, but
# npm never runs here: the container starts node directly.
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
