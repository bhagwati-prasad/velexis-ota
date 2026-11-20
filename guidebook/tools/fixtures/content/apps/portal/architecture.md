---
id: architecture
title: Portal — architecture
summary: Next.js app router structure, server-side API client, data it touches and key flows.
---

## At a glance

Next.js App Router in `repo:platform/frontend/src/app`; the API client is `repo:platform/frontend/src/lib/api.ts`;
port 3000.

```tree-not-a-diagram
plain code block with an unknown language
```

## Components

```diagram
neighbours
```

```diagram
screen-map
```

## Data

The portal has no database of its own; the [[app:platform-api]] writes these tables:

```diagram
accounts-er
```

## Key flows

```diagram
sign-in
```

## Lifecycles

```diagram
ota-status
```

## Security

Sessions are `HttpOnly` cookies ([[session-cookie]]); no token is readable by browser JavaScript. CSRF protection
follows [[csrf]].

## Where to change things

| To change | Look at |
|---|---|
| Sign-up page | `repo:platform/frontend/src/app/(auth)/sign-up/page.tsx` |
| Session handling | `repo:platform/frontend/src/lib/session.ts` |
| Roles | `repo:platform/frontend/src/lib/roles.ts#L1` |

## Further reading

- `repo:platform/docs/architecture.md`
- `repo:docs/mvp/adr/0014-frontend-stack-nextjs-tailwind.md`
