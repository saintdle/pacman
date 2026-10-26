# Pac-Man Helm chart source

`charts/pacman` is the editable packaged deployment in this repository. The
published chart `0.7.17` source tag resolves to
[`saintdle/helm-charts` commit `1d11684428b2069aef8d4e69c37237b5b3c910a5`](https://github.com/saintdle/helm-charts/commit/1d11684428b2069aef8d4e69c37237b5b3c910a5).
The later `c24c5267340a58259cf3d7c8f337ace4c19d1d7a` commit is a chart-copy
migration donor, not provenance for the published `0.7.17` release, even if
its chart files are identical. The currently documented chart version is
`0.7.17`; the Pac-Man application version is independently `0.7.16`.

The application and editable chart source are maintained in
[`saintdle/pacman`](https://github.com/saintdle/pacman). Platform setup,
Kubernetes examples, and scenario guides are maintained in
[`saintdle/pacman-for-k8s`](https://github.com/saintdle/pacman-for-k8s).
[`saintdle/helm-charts`](https://github.com/saintdle/helm-charts) retains the
stable public Helm repository at <https://saintdle.github.io/helm-charts> and
its historical package index. During the prepared transition, the existing
`helm-charts` publisher remains the sole live publishing authority; merging a
generated receiver does not switch it on.

The static chart contracts and isolated install/upgrade checks were carried
from the accepted
[`e4f69aa` lifecycle CI change](https://github.com/saintdle/helm-charts/commit/e4f69aa7e6c7ea97fe1ed1427308512b7a5f0c46).
In this repository, lifecycle checks build the exact pull request checkout and
use the chart from that same checkout.

The currently documented public chart release is `0.7.17`, with app version
`0.7.16`. Reconciliation validates immutable app identity before proposing a
source update; chart version selection is independent of app version. Replaying
an existing app release reuses its recorded digest and does not move `latest`.
Source promotion opens or updates a reviewable pull request; it does not
publish the package. The live `helm-charts` publisher creates and verifies the
chart release and Pages index.

The database-retention correction keeps the public version axis monotonic:
`0.7.18` is assigned to the legacy chart source first, and `0.7.19` is assigned
to the Pac-Man source for the later publisher cutover. These are source-version
assignments, not evidence that either package has been published. The current
public package remains `0.7.17` until the repository index proves otherwise.

Publisher rollout has separately approved expansion, switch, verification,
and rollback checkpoints. Before each merge, review the exact head and checks,
and explicitly approve any publication effect: merging to `main` can trigger
the live legacy `chart-release.yml` publisher. Expand while the authority is
unset or `helm-charts`, preserve all existing source and package history, and
verify the final-main workflows, stable checks, actual token `Variables:read`
capability, and generated-path schema-v1 app-record availability before
proposing a switch.

A switch requires separate live approval bound to the exact main identities,
release candidate, rollout conditions, and
`{"name":"PACMAN_CHART_PUBLISHER_AUTHORITY","value":"pacman"}` payload.
Drain the old distribution and Pac-Man source-publisher runs and queues, and
snapshot the setting and public index/assets before changing the single
publisher authority. In `saintdle/helm-charts`, `chart-release.yml` and
`chart-artifact-publish.yml` share the `pacman-chart-publisher` concurrency
group. Pac-Man's `chart-artifact-source.yml` uses the same name in a separate
repository; GitHub concurrency groups are repository-scoped, so drain both
repositories independently. Approve source replay separately. Verify the exact source,
package and sidecar, release records and compatibility lock, public checksum
and index, consumer event, and public install before retiring the legacy
source. Keep its source and retirement change until the public chain and
rollback conditions are accepted; see the
[`helm-charts publisher guide`](https://github.com/saintdle/helm-charts/blob/main/docs/chart-publisher-cutover.md)
for the full gate sequence.

For any retry or replay, verify the current single authority and exact
immutable identity first, then obtain separate dispatch approval. The legacy
`pacman-promotion.yml` workflow supports `reconcile`, `rollback`, and `resume`;
rollback inputs are `rollback_app_record_ref`, `rollback_app_record_sha256`,
and `rollback_reason`, and a verified legacy metadata asset remains supported
during compatibility. Pac-Man's `chart-source-promotion.yml` provides the same
modes after the prepared source path is selected, but its rollback requires a
schema-v1 app-record URL and checksum. A legacy release such as app `0.7.16`
cannot be relabeled to qualify. Both workflows propose source changes through
a reviewable pull request; neither directly publishes a chart.

A publisher rollback also requires separate approval and draining both source
and distribution work. Preserve generated packages, records, tags, and history;
revalidate the exact retained legacy source and chart version axis. If generated
publication advanced that axis, prepare, review, and approve a compatibility
bridge pull request before switching back. Approve any replay separately and
verify the resulting public artifacts and monotonic consumer state. After
source retirement, rollback requires a separately reviewed restoration plan;
do not assume the retained-source procedure remains available.
