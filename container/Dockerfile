# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    gnupg \
    ca-certificates \
    && install -d -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install uv (Python package manager) for MCP servers that need Python
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
    && cp /root/.local/bin/uv /usr/local/bin/uv \
    && cp /root/.local/bin/uvx /usr/local/bin/uvx \
    && rm -rf /root/.local/bin/uv /root/.local/bin/uvx

# Vulkan loader + NVIDIA ICD. The actual NVIDIA driver libs are bind-mounted
# from the host by `docker run --gpus all` (with NVIDIA Container Toolkit). We
# only need the Vulkan loader (libvulkan1 / vulkan-tools) and an ICD file that
# points at libGLX_nvidia.so.0. Mesa's CPU fallback (lavapipe) is also shipped
# so containers without --gpus still work.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libvulkan1 \
      vulkan-tools \
      mesa-vulkan-drivers \
    && mkdir -p /usr/share/vulkan/icd.d \
    && cat > /usr/share/vulkan/icd.d/nvidia_icd.json <<'EOF'
{
    "file_format_version" : "1.0.0",
    "ICD": {
        "library_path": "libGLX_nvidia.so.0",
        "api_version" : "1.3.289"
    }
}
EOF
RUN rm -rf /var/lib/apt/lists/*

# Install agent-browser, claude-code, codex CLI, codeburn, context7-mcp, and qmd globally
# qmd@2.1.0 is pinned to match the host install — avoid index/MCP schema drift.
RUN npm install -g agent-browser @anthropic-ai/claude-code @openai/codex codeburn @upstash/context7-mcp @tobilu/qmd@2.1.0

# qmd persistence lives on the bind-mounted host dir at /workspace/extra/qmd-cache.
# Both XDG paths point under that mount so the index AND the collection registry
# survive container exits. (qmd writes index.sqlite + models to XDG_CACHE_HOME/qmd
# and the collection registry to XDG_CONFIG_HOME/qmd/index.yml.)
ENV XDG_CACHE_HOME=/workspace/extra/qmd-cache \
    XDG_CONFIG_HOME=/workspace/extra/qmd-cache/config

# When NVIDIA Container Toolkit injects driver libs (--gpus all), expose the
# graphics capability so libGLX_nvidia.so.0 (Vulkan ICD target) is mounted.
ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics

# Install Serena MCP server (semantic code navigation) via uv tool
# UV_TOOL_{DIR,BIN_DIR} makes the install accessible to the non-root `node` user.
ENV UV_TOOL_DIR=/opt/uv-tools \
    UV_TOOL_BIN_DIR=/usr/local/bin \
    UV_PYTHON_INSTALL_DIR=/opt/uv-python
RUN uv tool install -p 3.13 'serena-agent@latest' --prerelease=allow \
    && chmod -R a+rX /opt/uv-tools /opt/uv-python \
    && serena --help > /dev/null

# Install rtk (token-saving CLI proxy) — musl-static binary, always pulls latest release
# Using musl build to avoid glibc version mismatch with node:22-slim (bookworm, glibc 2.36)
RUN ARCH=$(dpkg --print-architecture) \
    && case "$ARCH" in \
         amd64) RTK_ASSET=rtk-x86_64-unknown-linux-musl.tar.gz ;; \
         arm64) RTK_ASSET=rtk-aarch64-unknown-linux-gnu.tar.gz ;; \
         *) echo "Unsupported arch: $ARCH" && exit 1 ;; \
       esac \
    && curl -LsSf -o /tmp/rtk.tar.gz "https://github.com/rtk-ai/rtk/releases/latest/download/${RTK_ASSET}" \
    && tar -xzf /tmp/rtk.tar.gz -C /tmp \
    && mv /tmp/rtk /usr/local/bin/rtk \
    && chmod +x /usr/local/bin/rtk \
    && rm /tmp/rtk.tar.gz \
    && rtk --version

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
