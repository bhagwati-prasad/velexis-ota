---
id: architecture
title: Platform API — architecture
summary: Modules, data and flows of the platform API.
---

## At a glance

Entry points: `repo:platform/backend/src/main.ts` (API) and `repo:platform/backend/src/worker.ts` (worker).

## Data

Writes `platform.accounts` and `platform.tenants`; provisioning creates the [[tenant-schema]]. See
[[diagram:portal/accounts-er]].

## Where to change things

| To change | Look at |
|---|---|
| Sign-up rules | `repo:platform/backend/src/auth/sign-up.service.ts` |
| Tenant creation | `repo:platform/backend/src/tenants/tenants.service.ts` |
