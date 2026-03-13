---
name: data-processing
description: Write and execute Python scripts to batch-fetch data from Firestore via the MCP server, process it, and produce reports or CSV files. Use when the user asks for reports, exports, aggregations, or any analysis that requires reading many records at once.
allowed-tools: Bash, Read, Write, Edit
---

# Data Processing with Python

Use this skill when the user needs a report, CSV export, or data analysis that requires reading many records — too many to fetch one by one via MCP tool calls.

## How it works

1. Write a Python script to `/workspace/group/scripts/<name>.py`
2. Run it with `bash -c "python3 /workspace/group/scripts/<name>.py"`
3. Output goes to `/workspace/group/output/`
4. Send the output path (or a summary) back to the user

## Setup: reading the token and tenant

Always start your script with:

```python
import json, csv, os, urllib.request, urllib.parse, base64

# Read auth token
with open('/workspace/group/mcp-token.txt') as f:
    TOKEN = f.read().strip()

# Decode JWT to get tenant
payload_b64 = TOKEN.split('.')[1]
# Pad base64 string to a multiple of 4
payload_b64 += '=' * (-len(payload_b64) % 4)
tenant = json.loads(base64.b64decode(payload_b64))['tenant']

MCP_URL = 'https://order-management-mcp-server-1089020865493.us-central1.run.app/mcp'

os.makedirs('/workspace/group/output', exist_ok=True)
```

## Calling the MCP server from Python

```python
def call_mcp(tool_name, arguments):
    """Call an MCP tool via HTTP and return the result content."""
    body = json.dumps({
        "jsonrpc": "2.0",
        "method": "tools/call",
        "id": 1,
        "params": {
            "name": tool_name,
            "arguments": {"token": TOKEN, **arguments}
        }
    }).encode()
    req = urllib.request.Request(
        MCP_URL,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": f"Bearer {TOKEN}",
        }
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    # MCP returns content as a list of {type, text} blocks
    content = data.get('result', {}).get('content', [])
    text = next((c['text'] for c in content if c.get('type') == 'text'), '{}')
    return json.loads(text)
```

## Paginating through a large collection

Firestore queries return a limited number of records. Use `startAfter` with the last document ID to paginate:

```python
def fetch_all(collection, where=None, order_by=None, limit=100):
    """Fetch all documents from a collection, handling pagination."""
    records = []
    start_after = None
    while True:
        args = {"collection": collection, "limit": limit}
        if where:
            args["where"] = where
        if order_by:
            args["orderBy"] = order_by
        if start_after:
            args["startAfter"] = start_after

        result = call_mcp("search-firestore", args)
        docs = result.get("documents", result) if isinstance(result, dict) else result
        if not docs:
            break
        records.extend(docs)
        if len(docs) < limit:
            break  # Last page
        # Get the last document ID for next page cursor
        last = docs[-1]
        start_after = last.get("id") or last.get("__name__")
    return records
```

## Example: export all jobs for a date range to CSV

```python
# Fetch all jobs for a specific date
jobs = fetch_all(
    collection=f"/com/{tenant}/jobs",
    where=[["scheduling.itinerary.date", "==", "2024-03-01"]],
)

# Write CSV
output_path = '/workspace/group/output/jobs_2024-03-01.csv'
if jobs:
    # Flatten nested fields as needed
    fieldnames = ["id", "customerPOnum", "status", "scheduling.itinerary.date",
                  "scheduling.itinerary.arrivalTimeWindowStart", "carrierId"]
    with open(output_path, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction='ignore')
        writer.writeheader()
        for job in jobs:
            # Flatten nested dicts for CSV
            row = {
                "id": job.get("id", ""),
                "customerPOnum": job.get("customerPOnum", ""),
                "status": job.get("status", ""),
                "scheduling.itinerary.date": job.get("scheduling", {}).get("itinerary", {}).get("date", ""),
                "scheduling.itinerary.arrivalTimeWindowStart": job.get("scheduling", {}).get("itinerary", {}).get("arrivalTimeWindowStart", ""),
                "carrierId": job.get("carrierId", ""),
            }
            writer.writerow(row)
    print(f"Exported {len(jobs)} jobs to {output_path}")
else:
    print("No jobs found")
```

## Index constraints

Only query field combinations that have a Firestore index. For multi-field queries on jobs:
- `carrierId` + `scheduling.itinerary.date`
- `hub` + `scheduling.itinerary.date`
- `scheduling.itinerary.date` (single field, always safe)

For routes:
- `carrierId` + `date`
- `date` + `carrierName`
- `date` + `hub` + `carrierName`

If you need a combination without an index, fetch by one field then filter in Python:

```python
jobs = fetch_all(collection=f"/com/{tenant}/jobs",
                 where=[["scheduling.itinerary.date", "==", "2024-03-01"]])
# Filter in Python
jobs = [j for j in jobs if j.get("status") == "completed"]
```

## Sending results to the user

After the script runs, tell the user the file is available at `/workspace/group/output/<filename>`. If the output is small (< 50 rows), you can also print a summary table in the chat.
