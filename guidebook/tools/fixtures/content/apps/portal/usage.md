---
id: usage
title: Portal — usage guide
summary: How to run the portal, what every screen does and what to test.
---

## What it is

The portal is where an OTA owner signs up and runs their [[ota|OTAs]]. It is a [[bff]]: the browser never calls the
[[app:platform-api]] directly.

```diagram
neighbours
```

## Before you start

Start the platform API first, then the portal.

```try
command: pnpm --filter @velexis/platform-frontend dev
url: http://localhost:3000
login: owner@example.com
password: Password123! (development only)
expect: The marketing home page loads with a **Sign up** button.
```

## Tour

| Route | What it shows | What to try | What should happen |
|---|---|---|---|
| `/sign-up` | Sign-up form | Submit an existing e-mail | A neutral "check your e-mail" page (no account enumeration) |
| `/dashboard` | Your OTAs | Open an OTA | Its overview page opens |
| `/otas/new` | New OTA form | Use the key `platform` | The form rejects the reserved key |

## How to sign up

1. Open `/sign-up` and fill in the form.
2. Open Mailpit and click the verification link.
3. Sign in.

```diagram
signup-flow
```

## Roles and permissions

A **viewer** who opens `/otas/<id>/billing` must see a "not allowed" message, never the invoices.

## Bug-hunting checklist

```bug-hunt
- E-mail case: `Owner@Example.com` and `owner@example.com` are the same [[account]].
- After sign-up, `platform.accounts.status` is `pending_verification` until the link is clicked.
- A [[membership]] row exists for the founder with role `owner`.
```

```bug-hunt
Tenancy: an owner of OTA A must never see OTA B's pages by editing the `tenantId` in the URL.
```

## Troubleshooting

```warning
If sign-up hangs, the platform API is not running on port 3100.
```
