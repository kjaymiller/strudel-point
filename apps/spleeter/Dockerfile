# Not a Dockerfile.dev like every other apps/*/Dockerfile.dev in this repo: there's no
# "dev" mode here worth having — no live-reload story makes sense once a multi-GB
# pretrained model is baked into the image, so this is the one and only build for this
# service, dev or otherwise.
#
# spleeter 2.4.2 (current PyPI release) pins tensorflow==2.12.1, which ships
# manylinux_2_17_aarch64 wheels — this builds and runs natively on Apple Silicon, no
# platform/emulation pin needed in docker-compose.yml. See pyproject.toml for the
# flask/click pin that works around a real dependency conflict in spleeter's own tree.
FROM python:3.11-slim

# ffmpeg: spleeter shells out to it for audio decode/encode. libsndfile1: soundfile's own
# runtime dependency (one of spleeter's transitive deps).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

WORKDIR /app
COPY pyproject.toml .
RUN uv pip install --system .

# Bakes the pretrained spleeter:4stems model into the image at build time, so a container
# starting fresh doesn't also need a first-run download before it can serve anything.
RUN python -c "from spleeter.separator import Separator; Separator('spleeter:4stems')"

COPY server.py .

EXPOSE 8100
CMD ["python", "server.py"]
