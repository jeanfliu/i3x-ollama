
FROM node:22-bookworm

WORKDIR /app

# Install Python
RUN apt-get update && \
    apt-get install -y python3 python3-pip python3-venv && \
    rm -rf /var/lib/apt/lists/*

# Build i3X MCP Server
COPY i3X-MCP-Server /app/i3x

WORKDIR /app/i3x

RUN npm ci && npm run build

# Install Python Agent
WORKDIR /app

COPY agent/requirements.txt /app/requirements.txt

RUN python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

COPY agent/ /app/agent/

ENV PATH="/opt/venv/bin:$PATH"
ENV PYTHONUNBUFFERED=1

EXPOSE 8000

CMD ["python", "/app/agent/app.py"]
