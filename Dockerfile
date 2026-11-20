# Isolated dev container: Node + Chromium (official Playwright image, matches playwright@1.65.0 in package-lock.json)
FROM mcr.microsoft.com/playwright:v1.65.0-noble

WORKDIR /app

# Install deps from the lockfile first (cached layer). --ignore-scripts: no lifecycle scripts run;
# esbuild (used by tsx) ships its binary via optional platform packages, so it still works.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .

# Run as the image's non-root user
RUN chown -R pwuser:pwuser /app
USER pwuser

ENV PORT=3000
EXPOSE 3000
CMD ["npm", "run", "dev"]
