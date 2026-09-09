// auth-config.js — public, non-secret settings for the GitHub sign-in gate.
//
// Everything here is safe to commit. A GitHub OAuth client ID is public by
// design; the client SECRET lives only in the Cloudflare Worker, set with
// `wrangler secret put GITHUB_CLIENT_SECRET`.
//
// Until clientId and workerUrl are filled in, the deployed site shows a
// "sign-in not configured yet" screen rather than opening to everyone. See
// README -> Locking the site for the three setup steps.

export const AUTH = {
  /** OAuth App client ID (Settings -> Developer settings -> OAuth Apps). */
  clientId: '',

  /** Deployed Worker origin, e.g. https://readerhelper-auth.<subdomain>.workers.dev */
  workerUrl: '',

  /**
   * Scopes requested at sign-in. `gist` lets the session token drive the board
   * mirror, so there is no separate PAT to create, paste or rotate.
   * Drop to '' if you would rather keep signing in and syncing separate.
   */
  scope: 'gist',

  /**
   * A courtesy check so a refused user sees a clear message instead of a
   * confusing failure. The check that actually matters runs in the Worker,
   * which holds the secret and simply never issues a token to anyone else.
   */
  allowedLogins: ['misteramazingyt'],

  /**
   * With no clientId configured, refuse to open on a public host. Set this to
   * false only if you deliberately want an unauthenticated instance.
   */
  lockWhenUnconfigured: true,

  /** Re-check the session against api.github.com on load. */
  revalidateOnLoad: true,
};

/** Hosts where an unconfigured build may still be opened, for development. */
export const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '']);

export function isLocalHost() {
  return LOCAL_HOSTS.has(location.hostname);
}

export function isConfigured() {
  return Boolean(AUTH.clientId && AUTH.workerUrl);
}
