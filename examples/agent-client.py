"""Python standard-library client for the loopback synthetic GIL server.
No live LLM, no clinical/publishing action. Tokens are supplied by the operator.
"""
import json
import os
from urllib.request import Request, urlopen

base = "http://127.0.0.1:" + os.environ.get("PORT", "8787")


def call(path, token_name, payload):
    request = Request(base + path, data=json.dumps(payload).encode(), method="POST",
                      headers={"Content-Type": "application/json",
                               "Authorization": "Bearer " + os.environ[token_name]})
    with urlopen(request, timeout=10) as response:
        return json.load(response)


for domain in ("clinical", "growth"):
    draft = {"domain": domain, "goal": "Prepare a synthetic internal review", "action": "prepareReport",
             "purpose": "internal-review", "fields": ["summary"], "recipient": None,
             "destination": "internal", "requiredReviews": ["publication-review"],
             "claim": {"kind": "Descriptive", "fact": "recordAbsent" if domain == "clinical" else "analysisReady",
                       "causalDesign": None, "uncertainty": "None", "uncertaintyMethod": "None",
                       "requiresIndependentSources": False}}
    view = call("/v1/proposals", "GIL_AGENT_TOKEN", {"instruction": "Prepare report, not an external action",
                "domain": domain, "draft": draft, "snapshotId": domain})["view"]
    path = "/v1/contracts/" + view["id"]
    view = call(path + "/answer", "GIL_OWNER_TOKEN", {"binding": view["binding"], "recipient": "internal-reviewers"})
    view = call(path + "/accept", "GIL_OWNER_TOKEN", {"binding": view["binding"]})
    view = call(path + "/approve", "GIL_REVIEWER_TOKEN", {"binding": view["binding"], "review": "publication-review"})
    outcome = call(path + "/execute", "GIL_AGENT_TOKEN", {"binding": view["binding"], "idempotencyKey": domain + "-python-1"})
    print(json.dumps({"domain": domain, "status": outcome["status"], "verified": outcome["verified"]}))
