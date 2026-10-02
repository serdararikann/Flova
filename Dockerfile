# Flova Audio Studio - AI Backend Server Dockerfile
# Optimized for Hugging Face Spaces (Docker Space) & Cloud Containers

FROM python:3.10-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1

# Install audio processing and system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    git \
    curl \
    nodejs \
    && rm -rf /var/lib/apt/lists/*

# Hugging Face Spaces requires a non-root user with UID 1000
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH

WORKDIR $HOME/app

# Install Python requirements
COPY --chown=user:user requirements-server.txt .
RUN pip install --no-cache-dir --user -r requirements-server.txt

# Copy server code and cookies if present
COPY --chown=user:user server.py .
COPY --chown=user:user *cookie*.txt* ./

# Standard port for Hugging Face Spaces
EXPOSE 7860
ENV PORT=7860

CMD ["python", "server.py"]

