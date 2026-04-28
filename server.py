import os
import json
import urllib.request
from flask import Flask, request, jsonify, make_response

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

    if PLUGIN_SECRET and request.headers.get("x-plugin-secret") != PLUGIN_SECRET:
        return cors(jsonify({"error": "Unauthorized"}), 401)

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

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
