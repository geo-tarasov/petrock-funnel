FROM node:22-alpine
WORKDIR /app
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev
COPY api/src ./src
COPY db/schema.sql ./schema.sql
ENV PORT=3014
EXPOSE 3014
# Миграция идемпотентна: обновляет схему, на пустой базе заводит воронку и владельца админки.
CMD ["sh", "-c", "node src/migrate.js && exec node src/server.js"]
