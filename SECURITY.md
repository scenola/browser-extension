# Security

## Reporting a vulnerability

Please do not open a public issue. Report it privately, through GitHub: on this repository's
**Security** tab, choose **Report a vulnerability**. Only you and the maintainer see the report,
and the fix is prepared in a private advisory beside it.

Say what you found, how to reproduce it, and what it lets someone do. A proof of concept against
a development build is welcome; please do not test against other people's accounts or data. You
will hear back from the maintainer, and the fix is released before the details are made public,
with your name in the release notes if you want it there.

Reports about Scenola's own servers or apps are welcome the same way.

## Supported versions

Only the latest release is supported. Chrome updates an installed extension on its own, so a fix
reaches everyone with the next release rather than as a patch to an older one.

## What is in scope

Everything in this repository that ships or builds what ships: the service worker, the content
scripts and the collector, the interpretation sandbox, the extension's pages, the build and the
release workflow. In particular:

- a web page, a content script or a service module reaching the sign-in or its key;
- a service module reaching the network, `chrome.*` or a page;
- a page making the extension send anything beyond the fields of a play, or send it elsewhere;
- a page detecting that the extension is installed, other than by watching its own objects being
  read where a service's module reads that page's state (the one place the design allows it:
  [How a page is read](docs/architecture.md#how-a-page-is-read), step 4);
- a release whose zip, attestation or fingerprint does not match its source.

What the extension promises, and how each promise is held, is the security model in
[docs/architecture.md](docs/architecture.md#the-security-model).
