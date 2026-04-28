import os
import httpx
from flask import Flask, request, jsonify

app = Flask(__name__)

ANTHROPIC_KEY = os.getenv("ANTHROPIC_TOKEN")
PLUGIN_SECRET = os.getenv("PLUGIN_SECRET", "")

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
        resp = httpx.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": ANTHROPIC_KEY,
                "anthropic-version": "2022-06-01",
                "content-type": "application/json",
            },
            json=body,
            timeout=30,
        )
        return cors(jsonify(resp.json()), resp.status_code)
    except Exception as e:
        return cors(jsonify({"error": str(e)}), 500)

def cors(response, status=200):
    if isinstance(response, str):
        from flask import make_response
        r = make_response(response, status)
    else:
        from flask import make_response
        r = make_response(response, status)
    r.headers["Access-Control-Allow-Origin"] = "*"
    r.headers["Access-Control-Allow-Headers"] = "Content-Type, x-plugin-secret"
    r.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    return r

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
