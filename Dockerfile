FROM node:20-slim

# Install system dependencies (curl, git, ca-certificates)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Working directory
WORKDIR /app

# Copy application files
COPY package*.json ./
COPY server.js ./

# Set environment
ENV NODE_ENV=production
ENV PORT=8000
ENV HOST=0.0.0.0

# Expose port (Railway will map process.env.PORT automatically)
EXPOSE 8000

# Start server
CMD ["node", "server.js"]
