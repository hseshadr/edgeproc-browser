# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Report it privately in one of two ways:

1. GitHub's private reporting — go to the
   [Security tab](https://github.com/hseshadr/edgeproc-browser/security/advisories/new)
   and open a draft advisory. This is preferred; it keeps the discussion in the
   repo and lets us issue a CVE if one is warranted.
2. Email `harish.seshadri@gmail.com` with `SECURITY` in the subject.

Please include what you can: the version, a description of the problem, and the
smallest input that reproduces it.

We aim to acknowledge a report within 5 working days and to ship a fix or an
explanation of why it is not a vulnerability within 30 days.

## Supported versions

This project is pre-1.0. Only the latest published version gets fixes. Once 1.0
ships, the latest minor of the current major will be supported as well.

## Threat model

`@edgeproc/browser` is a pure library with zero runtime dependencies. It does no
I/O: no network, no filesystem, no process or environment access. It takes
values you hand it, matches them against a catalog you register, and returns
strings and plain objects.

Two things are worth knowing when you use it:

- **Error text is data you control.** Catalog descriptions come from your own
  catalog and your own i18next translations. This library interpolates params
  into them; it does not escape them. If you render a description into HTML,
  escape it at the render site like any other string.
- **Codes are meant to be public.** A code such as `ai.provider.out_of_credits`
  is a stable, greppable identifier and is safe to log or send over the wire.
  Params are not — if you put a secret in a param, it will appear in the
  description and in the RFC 9457 payload. Keep secrets out of params.

If you find a way to make this library read, write, or leak anything outside the
values passed into it, that is a vulnerability and we want to hear about it.
