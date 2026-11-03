"""Live-model client for the loopback synthetic GIL server.

The SERVER must be started with GIL_MODEL_BASE_URL / GIL_MODEL_API_KEY /
GIL_MODEL_ID so that /v1/proposals/live calls a real model. Tokens are still
operator-supplied. This script is a synthetic demo, not real approval.

Expected behaviour:
- The model proposes a draft; if it weakens the host's claim contract the gate
  rejects it (MODEL_CONTRACT_REJECTED) - that is the feature, not a bug.
- If the model proposes an out-of-scope recipient/destination/fields, execute
  is denied with EFFECT_NOT_GRANTED.
"""
import json
import os
from urllib.error import HTTPError
from urllib.request import Request, urlopen

base = "http://127.0.0.1:" + os.environ.get("PORT", "8787")


def call(path, token_name, payload):
    request = Request(base + path, data=json.dumps(payload).encode(), method="POST",
                      headers={"Content-Type": "application/json",
                               "Authorization": "Bearer " + os.environ[token_name]})
    try:
        with urlopen(request, timeout=60) as response:
            return json.load(response)
    except HTTPError as error:
        body = error.read().decode()
        print(json.dumps({"step": path, "denied": error.code, "body": json.loads(body)}, ensure_ascii=False))
        raise SystemExit(1)


for domain in ("clinical", "growth"):
    view = call("/v1/proposals/live", "GIL_AGENT_TOKEN", {
        "instruction": "Prepare an internal review report. Output stays internal; recipient is the internal reviewers; only a summary field is needed.",
        "domain": domain,
        "snapshotId": domain})["view"]
    print(json.dumps({"domain": domain, "modelDraft": view["draft"], "binding": view["binding"]}, ensure_ascii=False))
    path = "/v1/contracts/" + view["id"]
    if view["questions"]:
        view = call(path + "/answer", "GIL_OWNER_TOKEN", {"binding": view["binding"], "recipient": "internal-reviewers"})
    view = call(path + "/accept", "GIL_OWNER_TOKEN", {"binding": view["binding"]})
    view = call(path + "/approve", "GIL_REVIEWER_TOKEN", {"binding": view["binding"], "review": "publication-review"})
    outcome = call(path + "/execute", "GIL_AGENT_TOKEN", {"binding": view["binding"], "idempotencyKey": domain + "-live-1"})
    print(json.dumps({"domain": domain, "status": outcome["status"], "verified": outcome.get("verified")}))
