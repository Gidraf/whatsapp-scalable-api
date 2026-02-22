FROM node:20-alpine

# Prisma's query engine requires openssl on Alpine Linux
RUN apk add --no-cache openssl ffmpeg git

WORKDIR /app

# 1. Copy package files AND the prisma folder first
COPY package*.json ./
COPY prisma ./prisma/

# 2. Install dependencies (Prisma will automatically run `generate` here because the schema is present)
RUN npm install
RUN npm install -g pm2

# 3. Copy the rest of your application code
COPY . .

# 4. Run an explicit generate just to guarantee the client is built for the container's architecture
RUN npx prisma generate

CMD ["pm2-runtime", "ecosystem.config.js"]