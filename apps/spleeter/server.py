"""Dedicated stem-separation service — see ../gateway/src/routes/stems.ts for the one
caller. Deliberately just a thin Flask wrapper around Spleeter's own separator; no auth,
no persistence, no queueing — the gateway is the only thing that ever talks to this, over
a Docker-internal network with no published host port (see ../../docker-compose.yml), and
every request is synchronous and one-shot (load bytes in, four stems out, forget).

UNVERIFIED, same flag as this whole service carries in docker-compose.yml: I haven't run
this against a real spleeter install from here, so treat the exact API calls below
(`Separator`, `separate`) as "this is the documented 2.4.0 API", not "this has been
exercised end to end."
"""
import base64
import tempfile

from flask import Flask, Response, jsonify, request
from prometheus_client import Counter, CONTENT_TYPE_LATEST, generate_latest
from spleeter.separator import Separator

app = Flask(__name__)

# One counter per /separate outcome (not just a single "requests" total) — "how many
# separations actually failed" is the number that matters for alerting, and a single
# undifferentiated counter can't answer that on its own.
SEPARATE_REQUESTS_TOTAL = Counter(
    "spleeter_separate_requests_total",
    "Total /separate requests, by outcome",
    ["outcome"],  # "success" | "bad_request" | "error"
)

# Loaded once at process start, not per-request — this is what the Dockerfile's build-time
# warm-up (see Dockerfile) is priming into the image's model cache, so the *first* real
# request doesn't also eat a cold-start model download on top of inference time.
_separator = Separator("spleeter:4stems")

STEM_NAMES = ("vocals", "drums", "bass", "other")


@app.get("/health")
def health():
    return jsonify({"ok": True})


@app.get("/metrics")
def metrics():
    return Response(generate_latest(), mimetype=CONTENT_TYPE_LATEST)


@app.post("/separate")
def separate():
    file = request.files.get("file")
    if file is None:
        SEPARATE_REQUESTS_TOTAL.labels(outcome="bad_request").inc()
        return jsonify({"error": "file is required"}), 400

    try:
        # Spleeter's API reads/writes real files, not in-memory buffers — a temp dir
        # per request keeps concurrent calls (however unlikely, given this is a
        # synchronous single-worker service) from colliding on the same output
        # filenames.
        with tempfile.TemporaryDirectory() as tmp:
            in_path = f"{tmp}/input{_extension_for(file.mimetype)}"
            file.save(in_path)

            _separator.separate_to_file(in_path, tmp, filename_format="{instrument}.wav")

            stems = {}
            for name in STEM_NAMES:
                with open(f"{tmp}/{name}.wav", "rb") as f:
                    stems[name] = base64.b64encode(f.read()).decode("ascii")
    except Exception:
        SEPARATE_REQUESTS_TOTAL.labels(outcome="error").inc()
        raise

    SEPARATE_REQUESTS_TOTAL.labels(outcome="success").inc()
    return jsonify({"stems": stems})


def _extension_for(mimetype):
    return {"audio/wav": ".wav", "audio/x-wav": ".wav", "audio/mpeg": ".mp3"}.get(mimetype, ".wav")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8100)
