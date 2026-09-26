# One image for both services; docker-compose.yml picks the command.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY mcp-server/package.json mcp-server/
COPY agent-service/package.json agent-service/
COPY widget/package.json widget/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
USER node
EXPOSE 3000 3100
CMD ["node", "agent-service/dist/index.js"]
