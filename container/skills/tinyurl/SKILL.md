---
name: tinyurl
description: >
  Shorten any URL using the TinyURL API with the custom Streamlion domain (lnk.streamlion.app).
  Use this skill whenever the user wants to shorten a URL, create a short link, generate a
  tiny/short version of a long URL, or produce a compact shareable link. Also trigger this
  skill when a long URL needs to be embedded in an SMS, email, or any context where a short
  link is preferable. If the user says "shorten this", "make a short link", "create a tiny url",
  or pastes a long URL and asks for a shorter version, use this skill immediately.
---

# TinyURL — URL Shortener

Shorten long URLs via the TinyURL API using the custom `lnk.streamlion.app` domain.

## Prerequisites

You need the TinyURL API token. It is stored in the environment variable `TINY_URL_KEY`
(or the user may provide it directly). If neither is available, ask the user for their
`api_token` before proceeding.

## How to shorten a URL

Make a single `curl` POST request. Return **only** the `tiny_url` field from the response.

```bash
curl -s -X POST "https://api.tinyurl.com/create?api_token=$TINY_URL_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "<LONG_URL>",
    "domain": "lnk.streamlion.app",
    "description": "<OPTIONAL_DESCRIPTION>"
  }'
```

Parse the short URL from the response:

```bash
# One-liner with jq
curl -s -X POST "https://api.tinyurl.com/create?api_token=$TINY_URL_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"url\": \"<LONG_URL>\", \"domain\": \"lnk.streamlion.app\"}" \
  | jq -r '.data.tiny_url'
```

## Expected output

Return the short URL as plain text to the user, e.g.:

```
https://lnk.streamlion.app/y4anbva4
```

Nothing else — no JSON, no explanation preamble unless the user asks.

## Error handling

- `code != 0` or non-2xx HTTP → report the `errors` array to the user.
- Missing token → ask for `TINY_URL_KEY` before running the request.
- If `jq` is unavailable, use `python -c "import sys,json; print(json.load(sys.stdin)['data']['tiny_url'])"` to parse the response instead.

## Optional description

If the user provides context about what the link is for, pass it as `"description"` in the
request body. This helps identify links in the TinyURL dashboard later. If no description
is given, omit the field.

## Shortening multiple URLs

If the user provides multiple URLs, loop and call the API once per URL, returning each
short link on its own line.

```bash
for url in "<URL1>" "<URL2>" "<URL3>"; do
  curl -s -X POST "https://api.tinyurl.com/create?api_token=$TINY_URL_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"url\": \"$url\", \"domain\": \"lnk.streamlion.app\"}" \
    | jq -r '.data.tiny_url'
done
```
