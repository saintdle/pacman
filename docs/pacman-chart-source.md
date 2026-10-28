# Pac-Man Helm chart source

[`charts/pacman`](../charts/pacman/) is the sole maintained, editable Pac-Man
chart source in [`saintdle/pacman`](https://github.com/saintdle/pacman). This
repository also owns the Pac-Man chart source publisher. The
[`pacman-for-k8s` repository](https://github.com/saintdle/pacman-for-k8s)
maintains platform setup, scenario guides, and the published consumer
identities. The [`helm-charts` repository](https://github.com/saintdle/helm-charts)
continues to serve the public Helm repository at
<https://saintdle.github.io/helm-charts> and its immutable package history;
it no longer maintains or publishes the Pac-Man chart source.

For the latest chart, select a version from the public
[Helm index](https://saintdle.github.io/helm-charts/index.yaml), then verify
its versioned chart-release record and package. Do not use the mutable image
`latest` tag or the index alone as an immutable release identity.

## Verified migration/reference pair

The pinned app `0.7.17` / chart `0.7.20` pair is a fixed, verified migration
and reproduction reference; the public index identifies later packages. The app
record identifies source commit
[`776bc7d98003ea2361ef8ee84e624da2a63f8f08`](https://github.com/saintdle/pacman/commit/776bc7d98003ea2361ef8ee84e624da2a63f8f08)
and image digest
`sha256:2a55f4d74bc05dea3ae05912fbdcbe9348f9aafb752902054a7f066cfa112f68`.
The chart source is Pac-Man commit
[`a405d8d66d63c8d121ed993f55583a6ff634c86d`](https://github.com/saintdle/pacman/commit/a405d8d66d63c8d121ed993f55583a6ff634c86d);
the generated distribution is
[`helm-charts` commit `1381632438f8f54088996d0cb86bf6f1d16e8602`](https://github.com/saintdle/helm-charts/commit/1381632438f8f54088996d0cb86bf6f1d16e8602).
The immutable [chart release](https://github.com/saintdle/helm-charts/releases/tag/pacman-0.7.20)
records package SHA-256
`07544a4b0d1279d2310a61f065140a2a5c6b12d13ca45017f920188990dd6e58`.
[`docs/release-records.md`](release-records.md) lists the app and chart record
checksums and the matching consumer lock.

The public [native consumer run](https://github.com/saintdle/pacman-for-k8s/actions/runs/40666073800)
verified the amd64 image identity, Cilium L7 allow/deny with baseline and
recovery behavior, and loaded Tetragon sensors with synthetic file/exec events
in observe-only mode. It does not demonstrate Tetragon enforcement or validate
the full scenario catalog, OpenShift deployment, or external-provider paths.

## Historical provenance

The published chart `0.7.17` source tag resolves to
[`helm-charts` commit `1d11684428b2069aef8d4e69c37237b5b3c910a5`](https://github.com/saintdle/helm-charts/commit/1d11684428b2069aef8d4e69c37237b5b3c910a5).
The later `c24c5267340a58259cf3d7c8f337ace4c19d1d7a` commit is a chart-copy
migration donor, not provenance for that published release. The app `0.7.16`
and chart `0.7.17` pair remains a historical reference; its release-record
limitations and exact provenance are documented in
[`docs/release-records.md`](release-records.md).

## Source promotion and recovery

The source-promotion workflow verifies the app's immutable release record and
opens or updates a reviewable chart-source pull request. That proposal does
not publish a chart. After source changes merge, the chart CI validates the
exact Pac-Man commit; the generated publisher packages that commit and sends
the immutable artifacts to the public distribution. The GitHub release can
become visible before its chart-release record, compatibility lock, and Pages
package and index are complete; treat the version as consumer-ready only after
the package, records, checksum, index, and public reads agree for one immutable
identity.

For a completed-release replay, verify current publisher authority, the source
commit and package identity, and every existing immutable tag and asset before
reusing the version. For partial recovery, including when the originating run
failed after making the release visible, use a reviewed recovery bound to the
original validated Pac-Man source commit and package. Revalidate current source
authority and every existing immutable tag and asset, then add only missing
chart-release record, compatibility lock, or Pages package and index entries
for that same identity. Preserve all existing bytes, tags, historical
provenance, and record/lock reference pairs; verify public readiness before
notifying consumers. If recovery requires a publisher implementation change,
stop for a reviewed repair plan tied to the original immutable identity. Do
not blindly rerun against the latest source or rebuild or overwrite existing
immutable assets. An older legacy app release cannot be relabeled to supply a
schema-v1 record. Publisher rollback requires a separately reviewed
restoration plan and verification of the resulting public distribution and
consumer state.
