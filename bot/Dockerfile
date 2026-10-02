FROM node:22-alpine
WORKDIR /app
COPY bot/package.json bot/package-lock.json ./
RUN npm ci --omit=dev
COPY bot/src ./src
ENV HTTP_HOST=0.0.0.0 HTTP_PORT=3025
EXPOSE 3025
CMD ["node", "src/index.js"]
