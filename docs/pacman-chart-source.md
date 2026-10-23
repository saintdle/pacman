# Pac-Man Helm chart source

`charts/pacman` is a byte-for-byte source snapshot from the public
[`saintdle/helm-charts` chart](https://github.com/saintdle/helm-charts/tree/c24c5267340a58259cf3d7c8f337ace4c19d1d7a/charts/pacman)
at commit `c24c5267340a58259cf3d7c8f337ace4c19d1d7a`. Its chart version remains
`0.7.17`; the Pac-Man application version remains `0.7.16`.

The static chart contracts and isolated install/upgrade checks were carried
from the accepted
[`e4f69aa` lifecycle CI change](https://github.com/saintdle/helm-charts/commit/e4f69aa7e6c7ea97fe1ed1427308512b7a5f0c46).
In this repository, lifecycle checks build the exact pull request checkout and
use the chart from that same checkout.

During expansion, `helm-charts` remains the sole chart publisher. This
repository's chart workflow validates pull requests only and has read-only
permissions; it does not publish packages, releases, or Pages content.
