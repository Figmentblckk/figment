import os
import json
import urllib.request
from flask import Flask, request, jsonify, make_response, Response, stream_with_context

app = Flask(__name__)

ANTHROPIC_KEY = os.getenv("ANTHROPIC_TOKEN")
PLUGIN_SECRET = os.getenv("PLUGIN_SECRET", "")

def cors(response, status=200):
    r = make_response(response, status)
    r.headers["Access-Control-Allow-Origin"] = "*"
    r.headers["Access-Control-Allow-Headers"] = "Content-Type, x-plugin-secret"
    r.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    return r

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True})

@app.route("/claude", methods=["POST", "OPTIONS"])
def proxy():
    if request.method == "OPTIONS":
        return cors("", 204)
    body = request.get_json()
    if not body:
        return cors(jsonify({"error": "No body"}), 400)
    try:
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=data,
            headers={
                "x-api-key": ANTHROPIC_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            return cors(jsonify(result), 200)
    except urllib.error.HTTPError as e:
        result = json.loads(e.read().decode("utf-8"))
        return cors(jsonify(result), e.code)
    except Exception as e:
        return cors(jsonify({"error": str(e)}), 500)

@app.route("/claude-stream", methods=["POST", "OPTIONS"])
def proxy_stream():
    if request.method == "OPTIONS":
        return cors("", 204)
    body = request.get_json()
    if not body:
        return cors(jsonify({"error": "No body"}), 400)
    body["stream"] = True

    def generate():
        try:
            data = json.dumps(body).encode("utf-8")
            req = urllib.request.Request(
                "https://api.anthropic.com/v1/messages",
                data=data,
                headers={
                    "x-api-key": ANTHROPIC_KEY,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=60) as resp:
                for line in resp:
                    yield line.decode("utf-8")
        except Exception as e:
            yield "data: " + json.dumps({"error": str(e)}) + "\n\n"

    r = Response(stream_with_context(generate()), content_type="text/event-stream")
    r.headers["Access-Control-Allow-Origin"] = "*"
    r.headers["Access-Control-Allow-Headers"] = "Content-Type"
    r.headers["Cache-Control"] = "no-cache"
    r.headers["X-Accel-Buffering"] = "no"
    return r

REPO_RAW = 'https://raw.githubusercontent.com/Figmentblckk/figment/refs/heads/main/prompts/'

@app.route("/prompt/<name>", methods=["GET", "OPTIONS"])
def get_prompt(name):
    if request.method == "OPTIONS":
        return cors("", 204)
    allowed = ['analyze_frame.md','rename_layers.md','ai_normalize.md','smart_autolayout.md','audit_colors.md','annotate.md','config.json']
    if name not in allowed:
        return cors(jsonify({"error": "Not found"}), 404)
    try:
        req = urllib.request.Request(REPO_RAW + name)
        with urllib.request.urlopen(req, timeout=10) as resp:
            content = resp.read().decode('utf-8')
            r = make_response(content, 200)
            r.headers["Access-Control-Allow-Origin"] = "*"
            r.headers["Content-Type"] = "text/plain; charset=utf-8"
            return r
    except Exception as e:
        return cors(jsonify({"error": str(e)}), 500)

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
