---
id: getting-started
title: Getting started
summary: Run the platform locally, sign in with a seeded account and open the guidebook next to it.
order: 2
---

## Prerequisites

You need Node 24, pnpm, PostgreSQL 16 and Redis running locally. Read
`repo:docs/mvp/local-development.md` if anything is missing.

## Start the platform

1. Install dependencies.
2. Start the API and the portal.
3. Open the portal and sign up.

```try
command: pnpm install
command: pnpm --filter @velexis/platform-frontend dev
url: http://localhost:3000/sign-up
login: owner@example.com
password: Password123! (development only)
expect: The sign-up form loads and the page title is **Create your account**.
```

```bug-hunt
- Sign up twice with the same e-mail in different letter case: the second attempt must fail.
- Check `platform.accounts` after sign-up: `status` must be `pending_verification`.
```

### Check the database

```sql
SELECT id, email, status FROM platform.accounts ORDER BY created_at DESC LIMIT 5;
```

## Next steps

Follow [[journey:sign-up-and-create-ota]] end to end, then read [[page:overview]] again with the
[[diagram:portal/signup-flow]] open.
