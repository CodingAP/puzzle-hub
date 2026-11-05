# puzzle hub: api server + web frontend. the puzzle repositories are not part of the image; mount them.
#
#   docker build -t puzzle-hub .
#   docker run -p 8000:8000 \
#       -e API_TOKEN=... \
#       -e HUB_TITLE="My Puzzle Hub" -e HUB_CONTACT="github.com/you" \
#       -e HUB_SOURCES=/sources/advent-of-code,/sources/everybody-codes \
#       -v /path/to/advent-of-code:/sources/advent-of-code \
#       -v /path/to/everybody-codes:/sources/everybody-codes \
#       -v puzzle-hub-data:/data \
#       puzzle-hub
#
# site credentials (session cookies) are entered in the settings panel and stored in /data.
FROM denoland/deno:2.9.7

# git + ssh so profiling can commit and push a puzzle from its repository (see backend/src/git.ts)
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# containers are usually run as the host user that owns the mounted repositories (uid 1000);
# ssh refuses to run as a uid without a passwd entry
RUN id -u 1000 >/dev/null 2>&1 || useradd --uid 1000 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin app

WORKDIR /app
COPY . .

RUN deno task build \
    && deno check backend/cli.ts backend/server.ts backend/runner-child.ts \
    && mkdir -p /data && chown 1000:1000 /data \
    && chmod -R a+rwX /deno-dir

ENV PORT=8000 \
    HUB_DATA_DIR=/data
EXPOSE 8000

CMD ["deno", "run", "-A", "backend/cli.ts", "serve"]
