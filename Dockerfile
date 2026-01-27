# Stage 1: Build Frontend
FROM node:18-slim AS build-frontend
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Stage 2: Runtime
FROM node:18-slim
WORKDIR /app

# Copy backend dependencies and install them
COPY backend/package*.json ./backend/
RUN cd backend && npm install --production

# Copy backend source code
COPY backend ./backend

# Copy built frontend from Stage 1
COPY --from=build-frontend /app/dist ./dist

# Copy static assets (fillers)
COPY slova ./slova

# Expose the application port
EXPOSE 3001
ENV PORT=3001
ENV NODE_ENV=production

# Start the server
CMD ["node", "backend/server.js"]
