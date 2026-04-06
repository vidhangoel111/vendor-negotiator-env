# Vendor Negotiation RL Environment - OpenEnv compliant
# API-first container for Hugging Face Spaces deployment

FROM python:3.11-slim

WORKDIR /app

# Install system dependencies (minimal for slim image)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY my_env_v4.py .
COPY inference.py .
COPY app.py .
COPY ui ./ui

# Environment defaults — all overridable
# LLM Configuration
ENV API_BASE_URL=https://router.huggingface.co/v1
ENV MODEL_NAME=Qwen/Qwen2.5-72B-Instruct
ENV MY_ENV_V4_TEMPERATURE=0.3
ENV MY_ENV_V4_MAX_STEPS=20

# Task Configuration
ENV MY_ENV_V4_TASK=easy
ENV MY_ENV_V4_BENCHMARK=vendor_negotiation_v4
ENV MY_ENV_V4_EXPECTED_PRICE=180
ENV MY_ENV_V4_QTY=1000
ENV MY_ENV_V4_ITEM=Rice

# HF Spaces / Web Interface Port
EXPOSE 8000

# Health check - API must respond for validator ping checks
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8000/health || exit 1

# Default entrypoint - serve API for Space validators
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
