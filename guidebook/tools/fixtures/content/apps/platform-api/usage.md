---
id: usage
title: Platform API — usage guide
summary: How to call the platform API locally and what each auth endpoint should return.
---

## What it is

The platform API owns [[account|accounts]], [[tenant|tenants]] and billing. The [[app:portal]] calls it from the server.

## Before you start

```try
command: pnpm --filter @velexis/platform-backend dev
url: http://localhost:3100/health/ready
expect: HTTP 200 with a JSON body.
```

## Tour

| Endpoint | Expect |
|---|---|
| `POST /v1/auth/sign-up` | 201 and a verification e-mail in Mailpit |
| `GET /v1/me` | 401 without a session |
