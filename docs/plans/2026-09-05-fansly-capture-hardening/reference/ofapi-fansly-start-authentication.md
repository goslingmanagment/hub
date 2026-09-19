# OnlyFansAPI — Fansly "Start Authentication" (snapshot 2026-09-05)
Source: https://docs.onlyfansapi.com/api-reference/fansly/connect-fansly-account/start-authentication
Full index of their docs: https://docs.onlyfansapi.com/llms.txt

POST https://app.onlyfansapi.com/api/fansly/authenticate  (Bearer API key)

"Start the authentication process for a new Fansly account using the account's username
(or email) and password. If Fansly requires verification, the response status will
indicate a pending challenge — either an emailed code (new IP) or an authenticator-app
code — which you submit via the Submit 2FA endpoint. Credentials are stored securely and
encrypted at rest."

Request body:
- name (string, optional display name)
- username (Fansly username or email) — required
- password — required
- proxyCountry (enum us | uk | gb) — managed proxy; cannot combine with customProxy
- customProxy { host, port, username?, password? } — cannot combine with proxyCountry
- force_connect (bool) — connect even if the account already exists

Response 200:
{ account_id: "fansly_acct_123", message: "Authentication process started. Query the
  polling_url to check the progress.", polling_url: ".../api/fansly/authenticate/fansly_acct_123" }

OnlyFans connector UI (screenshots the owner supplied, 2026-09-05): three auth methods —
"Email & Password", "Cookies & Headers" (paste a cURL of https://onlyfans.com/api2/v2/users/me
from the browser network tab; "Automatic ~30 s" vs "Manual ~2 min"; warning: do not sign
out, just close the incognito window), and "Auth+" (FansAPI Auth+ mobile app, scan a QR).
Proxy: "OnlyFansAPI Managed Proxy — Recommended: we'll automatically assign a dedicated
mobile proxy for this account", with a proxy-country selector (default United States).
