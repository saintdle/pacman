# Release records

Release records pin the bytes and source identities for Pac-Man artifacts. The
release workflow publishes `app-release-record.json` with each new app release
after it verifies the manifest list and signs the image. The existing
`release-metadata.json` asset and dispatch fields remain available during the
compatibility period; the metadata asset also pins the app record URL and its
SHA-256 checksum.

The currently documented published pair is app `0.7.16` and chart `0.7.17`.
App `0.7.16` was built from
[`saintdle/pacman` commit `13f04d6e6aea62f1d32d57d90e4eff786083c02e`](https://github.com/saintdle/pacman/commit/13f04d6e6aea62f1d32d57d90e4eff786083c02e)
as `docker.io/saintdle/pacman@sha256:592740129bce7530a347146b86647f8b516df3c19105aa4c2fe40b878840fccf`.
The public `pacman-0.7.17` chart source tag resolves to
[`saintdle/helm-charts` commit `1d11684428b2069aef8d4e69c37237b5b3c910a5`](https://github.com/saintdle/helm-charts/commit/1d11684428b2069aef8d4e69c37237b5b3c910a5).
The later `c24c5267340a58259cf3d7c8f337ace4c19d1d7a` commit is a migration
donor for a chart copy, not provenance for the published release.
These published releases predate schema-v1 release records: their legacy
metadata does not provide the v1 record proof for platform descriptors,
provenance, signatures, or a consumer compatibility lock. This record-format
limit does not mean platform manifests are absent. The public
[native runtime run](https://github.com/saintdle/pacman-for-k8s/actions/runs/40221882676)
resolved the published image index to its amd64 child/config and exercised it
in the owned container runtime. Keep the missing v1 record proofs explicit;
do not construct or relabel a v1 record for either release.

The versioned codecs and validators are in
[`tools/release-records.js`](../tools/release-records.js). Their public
functions include `serializeAppReleaseRecord` / `parseAppReleaseRecord`,
`serializeChartReleaseRecord` / `parseChartReleaseRecord`, and
`serializeCompatibilityLock` / `parseCompatibilityLock`. Reference helpers
include `appReleaseRecordReference`, `chartReleaseRecordReference`, and
`createCompatibilityLock`; `assertImmutableRecordBytes` rejects changed bytes
for an existing version. The workflow CLI supports `write-app`, `verify-app`,
and `verify-legacy` for record creation and read-only replay validation.

Schema-v1 app records use `kind: "app-release"` and contain an
independent app version and tag, the source repository and full commit SHA, the
image repository and manifest-list digest, observed platform manifest
descriptors, and provenance and signature references. Platform digests are
read from the verified image manifest list. The provenance reference points to
the producing GitHub Actions run; the signature reference identifies the
signed image digest.

Chart records use `kind: "chart-release"` and a chart version that is
independent of the app version. They pin the chart source commit, package
filename, SHA-256 checksum and versioned immutable package URL, plus the app
record URL and checksum. The chart-record URL is derived as the sibling
`chart-release-record.json` asset at that package's versioned release URL.
The chart source repository can differ from the repository that distributes
the generated package. Both chart-record and package assets must come from the
same immutable distribution release. Supported release tags are exactly
`helm-chart-v<version>` and `pacman-<version>`; the version must be canonical
stable SemVer without leading zeroes.
This repository provides chart-record codecs and fixtures; chart publication
is owned by the chart repository.

Consumer compatibility locks use
`kind: "consumer-compatibility-lock"`. They pin both the app record and
chart record URLs and checksums, the chart package URL and checksum, both source
commits and versions, the image digest, and the supported evidence lanes.
Keeping the chart-record pin separate from the package pin lets consumers
verify the record that asserts the package identity as well as the package
bytes.

Serializers sort object keys and the platform/evidence arrays, use two-space
JSON, and end with a newline. Checksums are lowercase SHA-256 over those exact
UTF-8 bytes. Release references use versioned GitHub release assets; mutable
`latest` and root-page URLs are rejected.

The fixture files are synthetic examples for downstream contract tests:

- [`app-release-record.json`](../test/fixtures/release-records/app-release-record.json)
- [`chart-release-record.json`](../test/fixtures/release-records/chart-release-record.json)
- [`consumer-compatibility-lock.json`](../test/fixtures/release-records/consumer-compatibility-lock.json)

On replay, a schema-v1 app record must match the release metadata's version,
tag, source SHA, image digest, record URL and exact record checksum. Older
releases use a separate verified legacy reader for the original three-field
metadata plus the image digest in the release body; the workflow verifies that
digest against the published image before dispatch. Legacy records do not
claim platform, provenance or signature evidence that was not recorded.

## Recovering a release stopped after an image push

The app workflow checks the Docker Hub version tag before publishing a new
release. If a run stopped after an image push but before creating its GitHub
release, a retry will stop when that version tag already exists. It will not
replace the version tag, move `latest`, create a release, or dispatch chart
promotion. A registry authentication, network, rate-limit, or other ambiguous
response also stops publication; only a verified manifest-not-found response
allows the workflow to continue.

For a stopped release, inspect the failed run and retain its source commit and
any image digest shown by completed steps. Do not delete, retag, or overwrite
the image, and do not retry publication after changing registry tag settings.
Ask the release maintainer to decide the next recovery action after checking
the immutable image identity and its available release evidence. This guard
does not infer that an occupied tag belongs to the retrying source commit.
