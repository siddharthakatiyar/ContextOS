# Third-party license and provenance inventory

This inventory records the dependency and asset metadata available in this
checkout. It is provided for engineering and release review; it is not legal
advice, a license certification, or a substitute for the license and notice
files shipped by each upstream project.

## Reproducible dependency record

The machine-readable dependency record is [`docs/sbom.cdx.json`](docs/sbom.cdx.json).
It is a CycloneDX 1.5 SBOM generated from the repository lockfile with:

```bash
npm sbom --sbom-format cyclonedx --package-lock-only > docs/sbom.cdx.json
```

The current root package is `@siddharthakatiyar/contextos@1.0.2`; the `docs`
workspace is `docs@1.0.2`. The lockfile contains 802 package locations (the
root project is excluded from that count), and the SBOM contains 801 component
records plus 802 dependency records. npm's SBOM writer omits license objects
for the private workspace and for the `sqlite-vec` package entries; those
metadata gaps are called out below rather than inferred.

The lockfile license metadata currently groups as follows:

| SPDX/package license metadata | Package locations |
| --- | ---: |
| MIT | 663 |
| ISC | 42 |
| Apache-2.0 | 34 |
| BSD-3-Clause | 23 |
| BSD-2-Clause | 14 |
| BlueOak-1.0.0 | 6 |
| MPL-2.0 | 4 |
| MIT OR CC0-1.0 | 3 |
| LGPL-3.0-or-later | 2 |
| MIT OR Apache | 2 |
| Python-2.0 | 1 |
| CC-BY-4.0 | 1 |
| MIT OR WTFPL | 1 |
| CC0-1.0 | 1 |
| BSD-2-Clause OR MIT OR Apache-2.0 | 1 |
| Unlicense | 1 |
| 0BSD | 1 |
| License field absent (workspace/link metadata) | 2 |

The summary is derived from `package-lock.json`; package metadata and upstream
notice files remain authoritative for the complete text of each license.

## Direct and native dependencies requiring attention

The root runtime dependencies are listed in `package.json` and represented in
the SBOM. The following entries have native code, dual licensing, or bundled
third-party material that deserves an explicit release check:

| Package | Installed version | Metadata | Upstream source or notice |
| --- | --- | --- | --- |
| `sqlite-vec` and the platform package `sqlite-vec-linux-x64` | 0.1.9 | `MIT OR Apache` in npm metadata; v0.1.9 offers the MIT License or Apache License 2.0 | [MIT text](https://github.com/asg017/sqlite-vec/blob/v0.1.9/LICENSE-MIT) and [Apache text](https://github.com/asg017/sqlite-vec/blob/v0.1.9/LICENSE-APACHE) |
| `better-sqlite3` | 12.10.0 | MIT | [WiseLibs/better-sqlite3](https://github.com/WiseLibs/better-sqlite3) |
| `onnxruntime-node` and `onnxruntime-common` | 1.30.0 | MIT | [ONNX Runtime license](https://github.com/microsoft/onnxruntime/blob/main/LICENSE) |
| `@huggingface/transformers` | 4.3.0 | Apache-2.0 | [Transformers.js license](https://github.com/huggingface/transformers.js/blob/main/LICENSE) |
| `sharp` and `@img/sharp-linux-x64` | 0.35.4 | Apache-2.0 | [sharp repository](https://github.com/lovell/sharp) |
| `@img/sharp-libvips-linux-x64` and musl variant | 1.3.3 | LGPL-3.0-or-later in package metadata | [sharp-libvips third-party notices](https://github.com/lovell/sharp-libvips/blob/main/THIRD-PARTY-NOTICES.md); [libvips project](https://www.libvips.org/) |
| `tree-sitter-wasms` | 0.1.13 | Unlicense | [tree-sitter-wasms package](https://www.npmjs.com/package/tree-sitter-wasms) |

The `sharp` and libvips packages are transitive dependencies of the
Transformers package. ContextOS's embedding path processes text and does not
pass repository images to `sharp`; this does not remove the notice obligations
for any redistribution that includes those packages. The platform packages
listed above are optional in npm's graph, so the exact native set depends on
the target operating system and architecture.

The runtime embedding model is `sentence-transformers/all-MiniLM-L6-v2`, loaded
on demand into `~/.contextos/models`. The model is not downloaded by the SBOM
or by this inventory. Review its [model card and license metadata](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2)
when a release includes a populated model cache or redistributes model files.

## Repository assets and provenance

The following tracked assets have no creator, source URL, or license metadata
in this repository. Their ownership and redistribution rights are therefore
unresolved; no ownership is asserted here.

| Asset | SHA-256 | Provenance status |
| --- | --- | --- |
| `docs/public/query-where.gif` | `119045fe65e8115b20613f4374b8d2d6b599d4c60036b15008fdb6c8894c2aa1` | Repository-local GIF; source/creator/license not recorded |
| `docs/public/without-contextos.gif` | `817bbc60ab1e3df3ab1e506e78b71c4df390792a6b0c57e24b892ac8a2c7ff33` | Repository-local GIF; source/creator/license not recorded |
| `docs/src/app/icon.svg` | `71841fd9045f3790bfd477b6896da344268c59f676e90bc2726a97eb28d930df` | Repository-local SVG; attribution/license not recorded |

The docs homepage also references an external Product Hunt badge SVG at
`api.producthunt.com`; it is not bundled in this repository. The app uses
`next/font/google` for the Geist and Geist Mono families. A docs build emits
those downloaded WOFF2 assets into generated output; the upstream
[`vercel/geist-font` license](https://github.com/vercel/geist-font/blob/main/LICENSE.txt)
identifies the font software as SIL Open Font License 1.1 (also published as
[`OFL.txt`](https://github.com/vercel/geist-font/blob/main/OFL.txt)). The font
files are generated output rather than tracked source files; retain the
upstream license and attribution when redistributing a captured static build.

Generated `docs/out/` files, the local `.contextos` databases, npm caches, and
model caches are build or runtime state rather than tracked source assets and
are not part of the checked-in provenance record.

## Updating this record

After changing manifests, regenerate the SBOM and review native package notice
files again. Keep package-provided license texts and third-party notices with
any distributable artifact that bundles those dependencies.
