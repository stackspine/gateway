# syntax=docker/dockerfile:1
FROM denoland/deno:2.0.0

WORKDIR /app

# Copy gateway source
COPY gateway/ ./gateway/

# Cache dependencies
RUN deno cache gateway/index.ts

# Expose the default Deno serve port
EXPOSE 8000

# Run the gateway
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "gateway/index.ts"]
