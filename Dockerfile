FROM node:20-alpine

# Prisma's query engine requires openssl on Alpine Linux
RUN apk add --no-cache openssl ffmpeg git

WORKDIR /app

# Copy everything
COPY . .

# Install dependencies
RUN npm install
RUN npm install -g pm2

# Generate the Prisma client AT RUNTIME, then start PM2
CMD ["sh", "-c", "npx prisma generate && pm2-runtime ecosystem.config.js"]