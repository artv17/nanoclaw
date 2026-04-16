---
name: gcs-upload
description: Upload a file to Google Cloud Storage and return a signed URL that callers can download. Use whenever the user requests a report, CSV, or any file to be shared via a link.
allowed-tools: Bash, Write
---

# Upload Files to Google Cloud Storage

Use this skill to upload any file (CSV, JSON, PDF, etc.) to GCS and share it via a signed URL that expires after 1 hour (configurable).

## Credentials setup

Credentials are read from (in order of preference):
1. `/workspace/group/gcs-credentials.json` — group-specific service account key
2. `/workspace/global/gcs-credentials.json` — shared service account key

Bucket name from:
1. `/workspace/group/gcs-bucket.txt`
2. `/workspace/global/gcs-bucket.txt`

If credentials are missing, tell the user: "GCS credentials are not configured. Please place the service account key at `groups/global/gcs-credentials.json` and the bucket name at `groups/global/gcs-bucket.txt`."

## How to upload a file and get a signed URL

Copy this script EXACTLY as written — do not rewrite or paraphrase it. Only change `LOCAL_FILE`, `OBJECT_NAME`, and optionally `EXPIRY_SECONDS`. The signing logic is precise and must not be altered.

```bash
python3 - <<'PYEOF'
import sys, json, os, base64, hashlib, subprocess, time, urllib.request, urllib.parse
from datetime import datetime, timezone

# --- Config ---
LOCAL_FILE = '/workspace/group/output/report.csv'   # file to upload
OBJECT_NAME = 'reports/report.csv'                  # path inside the bucket
EXPIRY_SECONDS = 3600                               # signed URL validity (1 hour)
CONTENT_TYPE = 'text/csv'

# --- Load credentials ---
def load_creds():
    for path in ['/workspace/group/gcs-credentials.json', '/workspace/global/gcs-credentials.json']:
        if os.path.exists(path):
            with open(path) as f:
                return json.load(f)
    raise FileNotFoundError('GCS credentials not found. Expected at /workspace/global/gcs-credentials.json')

def load_bucket():
    for path in ['/workspace/group/gcs-bucket.txt', '/workspace/global/gcs-bucket.txt']:
        if os.path.exists(path):
            with open(path) as f:
                return f.read().strip()
    raise FileNotFoundError('GCS bucket name not found. Expected at /workspace/global/gcs-bucket.txt')

creds = load_creds()
BUCKET = load_bucket()
SERVICE_ACCOUNT_EMAIL = creds['client_email']
PRIVATE_KEY_PEM = creds['private_key']

# --- RSA-SHA256 signing via openssl (no extra packages needed) ---
def rsa_sign(data: bytes) -> bytes:
    key_file = '/tmp/_gcs_sa_key.pem'
    try:
        with open(key_file, 'w') as f:
            f.write(PRIVATE_KEY_PEM)
        os.chmod(key_file, 0o600)
        return subprocess.check_output(
            ['openssl', 'dgst', '-sha256', '-sign', key_file],
            input=data, stderr=subprocess.DEVNULL
        )
    finally:
        try: os.unlink(key_file)
        except: pass

# --- Step 1: Get OAuth2 access token via service account JWT ---
def get_access_token():
    now = int(time.time())
    def b64(d): return base64.urlsafe_b64encode(d).rstrip(b'=').decode()
    header = b64(json.dumps({'alg': 'RS256', 'typ': 'JWT'}).encode())
    payload = b64(json.dumps({
        'iss': SERVICE_ACCOUNT_EMAIL,
        'scope': 'https://www.googleapis.com/auth/devstorage.read_write',
        'aud': 'https://oauth2.googleapis.com/token',
        'iat': now, 'exp': now + 3600
    }).encode())
    unsigned = f'{header}.{payload}'
    sig = b64(rsa_sign(unsigned.encode()))
    jwt_token = f'{unsigned}.{sig}'

    data = urllib.parse.urlencode({
        'grant_type': 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        'assertion': jwt_token
    }).encode()
    req = urllib.request.Request('https://oauth2.googleapis.com/token', data=data)
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())['access_token']

# --- Step 2: Upload file ---
access_token = get_access_token()
with open(LOCAL_FILE, 'rb') as f:
    file_data = f.read()

bucket_enc = urllib.parse.quote(BUCKET, safe='')
object_enc = urllib.parse.quote(OBJECT_NAME)
upload_url = f'https://storage.googleapis.com/upload/storage/v1/b/{bucket_enc}/o?uploadType=media&name={object_enc}'
req = urllib.request.Request(upload_url, data=file_data, headers={
    'Authorization': f'Bearer {access_token}',
    'Content-Type': CONTENT_TYPE,
})
req.get_method = lambda: 'POST'
with urllib.request.urlopen(req) as resp:
    json.loads(resp.read())  # confirm success

# --- Step 3: Generate V4 signed URL ---
now_dt = datetime.now(timezone.utc)
datestamp = now_dt.strftime('%Y%m%d')
timestamp = now_dt.strftime('%Y%m%dT%H%M%SZ')
credential = f'{SERVICE_ACCOUNT_EMAIL}/{datestamp}/auto/storage/goog4_request'
signed_headers = 'host'

object_path = urllib.parse.quote(OBJECT_NAME, safe='/')
# GCS V4: credential must have @ → %40 and / → %2F (string replace, not urllib.parse.quote)
credential_enc = credential.replace('%', '%25').replace('@', '%40').replace('/', '%2F')
query_string = '&'.join([
    'X-Goog-Algorithm=GOOG4-RSA-SHA256',
    f'X-Goog-Credential={credential_enc}',
    f'X-Goog-Date={timestamp}',
    f'X-Goog-Expires={EXPIRY_SECONDS}',
    f'X-Goog-SignedHeaders={signed_headers}',
])
canonical_request = '\n'.join([
    'GET',
    f'/{BUCKET}/{object_path}',
    query_string,
    f'host:storage.googleapis.com\n',
    signed_headers,
    'UNSIGNED-PAYLOAD',
])
string_to_sign = '\n'.join([
    'GOOG4-RSA-SHA256',
    timestamp,
    f'{datestamp}/auto/storage/goog4_request',
    hashlib.sha256(canonical_request.encode()).hexdigest(),
])

signature = rsa_sign(string_to_sign.encode()).hex()
signed_url = (
    f'https://storage.googleapis.com/{BUCKET}/{object_path}'
    f'?{query_string}&X-Goog-Signature={signature}'
)

print(signed_url)
PYEOF
```

The script prints the signed URL to stdout. Capture it and send it to the user.

## Full example: produce a CSV report and share it

1. Generate the CSV (e.g., using the data-processing skill)
2. Run the upload script with the correct `LOCAL_FILE` and `OBJECT_NAME`
3. Return the signed URL to the user:

> Here is your report: https://storage.googleapis.com/...

## Object naming convention

Use a consistent, collision-free naming scheme:
- `reports/{date}-{description}.csv` — e.g. `reports/2026-03-24-top-jobs.csv`
- `exports/{user_id}/{date}-{description}.csv` — for per-user files

## Customizing expiry

Change `EXPIRY_SECONDS`:
- `3600` = 1 hour (default)
- `86400` = 24 hours
- `604800` = 7 days (max for service account signed URLs)
