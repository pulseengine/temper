# Dockerfile for Probot Repository Configurator

# Use official Node.js LTS image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application files
COPY . .

# Expose port
EXPOSE 3000

# Set environment variables (these should be overridden in deployment)
ENV NODE_ENV=production
ENV PORT=3000

# Start the application
CMD ["npm", "start"]
