# Release records

Release records pin the bytes and source identities for Pac-Man artifacts. The
release workflow publishes `app-release-record.json` with each new app release
after it verifies the manifest list and signs the image. The existing
`release-metadata.json` asset and dispatch fields remain available during the
compatibility period; the metadata asset also pins the app record URL and its
SHA-256 checksum.

The versioned codecs and validators are in
[`tools/release-records.js`](../tools/release-records.js). Their public
functions include `serializeAppReleaseRecord` / `parseAppReleaseRecord`,
`serializeChartReleaseRecord` / `parseChartReleaseRecord`, and
`serializeCompatibilityLock` / `parseCompatibilityLock`. Reference helpers
include `appReleaseRecordReference`, `chartReleaseRecordReference`, and
`createCompatibilityLock`; `assertImmutableRecordBytes` rejects changed bytes
for an existing version. The workflow CLI supports `write-app`, `verify-app`,
and `verify-legacy` for record creation and read-only replay validation.

Schema-v1 app records use `record_type: "app-release"` and contain an
independent app version and tag, the source repository and full commit SHA, the
image repository and manifest-list digest, observed platform manifest
descriptors, and provenance and signature references. Platform digests are
read from the verified image manifest list. The provenance reference points to
the producing GitHub Actions run; the signature reference identifies the
signed image digest.

Chart records use `record_type: "chart-release"` and a chart version that is
independent of the app version. They pin the chart source commit, package
filename, SHA-256 checksum and versioned immutable package URL, plus the app
record URL and checksum. The chart-record URL is derived as the sibling
`chart-release-record.json` asset at that package's versioned release URL.
This repository provides chart-record codecs and fixtures; chart publication
is owned by the chart repository.

Consumer compatibility locks use
`record_type: "consumer-compatibility-lock"`. They pin both the app record and
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
