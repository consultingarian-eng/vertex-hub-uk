# ── Stage 1: Build Expo web ─────────────────────────────────────────────────
FROM node:20-alpine AS web-builder
WORKDIR /app/frontend

COPY frontend/package.json frontend/yarn.lock ./
RUN yarn install --frozen-lockfile

COPY frontend/ ./

# Empty string → axios baseURL becomes "/api" (same-origin, served by the backend below)
ARG EXPO_PUBLIC_BACKEND_URL=""
ENV EXPO_PUBLIC_BACKEND_URL=$EXPO_PUBLIC_BACKEND_URL
ENV CI=1

RUN npx expo export --platform web --non-interactive

# ── Stage 2: Python backend ──────────────────────────────────────────────────
FROM python:3.11-slim
WORKDIR /app/backend

COPY backend/requirements.txt ./
# The LLM wrapper (backend/emergentintegrations/) is vendored, not installed.
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./

# Copy Expo web build from Stage 1
COPY --from=web-builder /app/frontend/dist /app/web-dist

ENV WEB_DIST_PATH=/app/web-dist

CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT:-8000}"]
