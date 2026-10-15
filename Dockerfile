FROM oven/bun:1.4.3-debian@sha256:923bedb355f7746666659f71e724998159a5c8c54bd1cb1030e1975a0698415b
WORKDIR /app
RUN mkdir -p /opt/codex \
    && cd /opt/codex \
    && bun add --exact --ignore-scripts @openai/codex@0.162.1 \
    && ln -s /opt/codex/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex \
    && bun pm cache rm
COPY dist/ ./dist/
COPY index.mdx ./
USER bun
ENV NODE_ENV=production
ENV BUN_INSTALL_CACHE_DIR=/tmp/bun-cache
EXPOSE 8792
CMD ["bun", "dist/server/aria-runtime.js"]
