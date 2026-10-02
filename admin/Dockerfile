FROM node:22-alpine
WORKDIR /app
COPY admin/package.json admin/package-lock.json ./
RUN npm ci --omit=dev
COPY admin/src ./src
COPY admin/public ./public
ENV HOST=0.0.0.0 PORT=3026
EXPOSE 3026
CMD ["node", "src/server.js"]
