FROM node:24-bookworm-slim AS build

RUN npm install --global pnpm@10.26.1
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/api-spec run codegen
RUN PORT=3000 BASE_PATH=/ pnpm --filter @workspace/qimgv-gallery run build
RUN pnpm --filter @workspace/api-server run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    STATIC_DIR=/app/public \
    MEDIA_ROOT=/media
WORKDIR /app
COPY --from=build /app/artifacts/api-server/dist /app/artifacts/api-server/dist
COPY --from=build /app/artifacts/qimgv-gallery/dist/public /app/public
USER node
EXPOSE 3000
CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]