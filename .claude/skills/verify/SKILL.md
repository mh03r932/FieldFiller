---
name: verify
description: How to drive the running LinkWeave app for end-to-end verification — throwaway users, form login, session manipulation.
---

# Verifying LinkWeave in the running app

Both servers are assumed running: SPA at `https://local-linkweave.localhost:5173` (Vite, proxies `/api` to Quarkus on 8443). Self-signed TLS — curl needs `-k`, Playwright contexts need `ignoreHTTPSErrors` (the MCP browser is already configured).

## Throwaway user (setup + cleanup)

```bash
curl -sk -X POST https://local-linkweave.localhost:5173/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"<unique>@example.com","password":"test-password-123","vorname":"X","nachname":"Y"}'
```

Log in through the real UI: `/login` → Email/Password textboxes → "Sign in" button (form auth via `/api/j_security_check`; Google OIDC is not drivable). First `/api/auth/me` auto-provisions the default collection; login lands on `/collections/{defaultCollectionId}`.

Cleanup: while logged in, `DELETE /api/auth/me` (from page context include `X-Requested-With: XMLHttpRequest` and credentials) — hard-deletes the user and everything they own, returns 204.

## Useful session tricks

- **Simulate session expiry**: `page.context().clearCookies()` — kills the `linkweave-credential` cookie while the SPA still thinks it's logged in. Any subsequent API call returns 499 (Quarkus OIDC/form "unauthenticated AJAX" status; the SPA sends `X-Requested-With: XMLHttpRequest`).
- **Trigger the tab-focus session probe**: `document.dispatchEvent(new Event('visibilitychange'))` (state is already `visible`). Probe is throttled to one per 60s.
- **Post-login return target** lives in `sessionStorage['linkweave.postLoginRedirect']`.
- **Toasts** (vue-sonner): `[data-sonner-toast]` — may match multiple, use `.all()`/screenshot, not `.textContent()`.

## Gotchas

- The Vite HMR websocket occasionally drops and force-reloads the page ("server connection lost. Polling for restart..." in console) — if the app state resets mid-scenario, that's the environment, not the change. Redo the scenario.
- E2E helper reference: `frontend/e2e/models/TestUser.ts` (register/login/cleanup over HTTP).
