# Private Grok backend patch

This directory carries only the source pin, a minimal downstream patch, and the
upstream MIT license. The official source is downloaded into ignored artifacts;
there is no vendored source tree, nested repository, npm publication, or upstream
fork dependency. The product installer is maintained separately.

## Source and binary identity

The authority is [manifest.json](manifest.json). It pins upstream commit
`be5fe87db22939de9405a7e9c70b1e43f7151214` from
[Episkey-G/GrokSearch-rs](https://github.com/Episkey-G/GrokSearch-rs), the SHA-256
of its official codeload archive, the patch SHA-256, Rust 1.90.0, and native targets.
GitHub API verification on 2026-11-20 confirmed that `refs/tags/v0.1.26` points
directly to this commit (tree `235762f1511a6f122b623875807af841a4ca7fff`). The
[commit-to-tag comparison](https://github.com/Episkey-G/GrokSearch-rs/compare/be5fe87db22939de9405a7e9c70b1e43f7151214...v0.1.26)
is identical: zero commits or runtime/file differences. Cargo.toml, Cargo.lock
and npm manifests in the tag still say 0.1.25. The upstream
[release workflow](https://github.com/Episkey-G/GrokSearch-rs/blob/be5fe87db22939de9405a7e9c70b1e43f7151214/.github/workflows/release.yml#L94)
injects the tag version before building and publishing; its successful
[v0.1.26 Release run](https://github.com/Episkey-G/GrokSearch-rs/actions/runs/34334375095)
uses this same commit. The source pin is unchanged. The patch changes only the
package's own Cargo version to `0.1.26-dsh.1`; dependency pins stay unchanged.

| Platform key | Node os / arch | Rust target | Package name |
| --- | --- | --- | --- |
| windows-x64 | win32 / x64 | x86_64-pc-windows-msvc | @dsh-grok-search/backend-windows-x64 |
| macos-arm64 | darwin / arm64 | aarch64-apple-darwin | @dsh-grok-search/backend-macos-arm64 |
| linux-x64 | linux / x64 | x86_64-unknown-linux-gnu | @dsh-grok-search/backend-linux-x64 |

This is a build-input manifest, not an enabled installer catalog. It deliberately
has no release URLs or archive digests before real binaries exist. Do not enable
an installation based on a placeholder checksum. The separate installer catalog
must pin each reviewed platform archive's actual digest and origin.

## Failure contract

The optional JSON-RPC `error.data` and successful fallback envelope's optional
`primary_failure` have exactly this shape:

```ts
{
  schemaVersion: 1,
  provider: 'grok',
  protocol: 'responses' | 'chat_completions',
  stage: 'request' | 'response' | 'parse' | 'result',
  httpStatus?: number,
  upstreamCode?: string,
  reason: 'auth_error' | 'rate_limited' | 'model_not_found' |
    'tool_unsupported' | 'invalid_request' | 'upstream_error' |
    'network_error' | 'timeout' | 'parse_error' |
    'content_empty' | 'sources_empty'
}
```

Request covers send/transport failures and local credential/payload failures;
response covers HTTP errors, body reads and terminal upstream errors; parse
covers malformed JSON/SSE; result covers missing answer or sources. Known HTTP
status is retained, including successful HTTP 200 headers followed by a body
read/JSON parse failure, an SSE terminal error, or an error envelope. Consumers
accept integer status values in 200-599. Only values >=400 map to an `HTTP_NNN`
client error code; values below 400 retain the reason-specific error code and
carry the actual status as metadata (for example, `grok_parse_error` with
`httpStatus: 200`). An original HTTP 404 with `error.code=model_not_found`
stays `model_not_found`, including when the supplemental chain returns nothing.
A 422 with only `error.type=api_error` has `reason=invalid_request` and no
`upstreamCode`. The code is never inferred from remote message text.

Only these code spellings are accepted (trimmed and ASCII-lowercased):

- auth_error, invalid_api_key, authentication_error, permission_denied
- rate_limited, rate_limit_exceeded, rate_limit_error, insufficient_quota
- model_not_found
- tool_unsupported, unsupported_tool, unsupported_tools
- invalid_request, invalid_request_error, unsupported_parameter, context_length_exceeded
- upstream_error, server_error, internal_server_error, service_unavailable

This exact 20-code union is shared with the JavaScript MCP parser; each list
maps to the reason given by its first code. Unknown codes are omitted.
Status-only mapping is 401/403 to auth_error,
429 to rate_limited, 400/422 to invalid_request, otherwise upstream_error.
No remote message, header, URL, key, or body is copied into the diagnostic data.
Primary HTTP/stream error messages also use local text, without remote bodies.
Existing JSON-RPC numeric codes, message prefixes and fallback_reason values
remain recognized. The service's no-evidence error retains its existing message
and numeric code, with original primary data attached. Successful evidence
fallback retains its original output and carries primary_failure. Normal success
omits that field. No doctor request is added.

The Responses collector additionally accepts `output[].search_sources` using
its existing source collector, keeps annotations/citations/action sources/inline
citations and URL deduplication, and excludes typed reasoning/tool prose from
answers. Source fields remain optional. Existing annotation metadata wins over
duplicate search_sources in the same item. SSE completion, framing and chat
metadata accumulation remain intact. Request payloads, web tools, model choice,
provider selection, supplemental ordering, budgets and enrichment are unchanged.

## Build and validate

Use Node 22+ (CI uses 24), git, tar and rustup. Install the manifest-pinned Rust
toolchain if necessary; the script does not install tools or change user config.
Run from the product root on the matching native platform:

```sh
node --test scripts/build-grok-backend.test.mjs
node scripts/build-grok-backend.mjs --platform windows-x64
```

Replace the platform with macos-arm64 or linux-x64 on those machines. To replay a
previously downloaded official archive without downloading it again, add
`--source-archive <file>`; its checksum is still mandatory. Add
`--prepare-only` to verify/extract/apply without Cargo. Every invocation extracts
a fresh source directory under `artifacts/grok-backend-build/`, applies the patch
with `git apply --check`, and verifies reverse application and the patched version.
No nested Git repository or worktree is created. The script fails if artifacts
is not ignored. Nothing is deleted automatically.

A full build runs `cargo test --locked --all-targets --target <target>` and
`cargo build --release --locked --target <target>`. Ignored upstream tests are
live probes and are never enabled. The patch includes local stub tests covering
HTTP status/code normalization, parse/SSE/transport/body failures, service/MCP
propagation, fallback success and zero budget, chat compatibility, source
extraction/deduplication and unchanged supplementary behavior. Build tests check
pins and the strict two-file archive format. These tests do not contact paid
provider endpoints. They do not establish live relay model/tool support.

## Artifacts and installer handoff

For each platform, `artifacts/grok-backend-dist/` receives:

- `grok-backend-0.1.26-dsh.1-<platform>.tar.gz`
- The same filename plus `.sha256` (SHA-256, two spaces, archive basename).
- The same filename plus `.build.json` (build identity and SHA-512 integrity).

The gzip archive has exactly two ordinary ustar entries:
`package/package.json` and `package/bin/grok-search-rs` (`.exe` on Windows).
The manifest has name/version/os/cpu/bin, no scripts, and `private: true`.
To preserve MIT without violating the existing installer's two-file allowlist,
it includes the verbatim upstream license as `licenseText`, alongside
`license: "MIT"`. [LICENSE](LICENSE) is the unmodified upstream notice.

The build identity records archive/binary SHA-256, npm-style SHA-512 integrity,
package/version/target, original source and patch pins, patched Cargo.lock hash,
Rust/Cargo versions, binary --version, exact build/test commands, repository HEAD,
and whether the build inputs have uncommitted changes. It also hashes the input
manifest, build script and license. Local build receipts with sourceDirty=true
must not be presented as clean-commit hosted build evidence. Archive header owner,
time and modes are deterministic; identical binary/manifest bytes produce an
identical archive. Compiler outputs across different host images are not claimed
to be bit-for-bit identical. Use each artifact's actual digest.

[The workflow](../.github/workflows/grok-backend-build.yml) runs only on manual
dispatch or pushes to `ci/grok-responses-backend`. It uses native Windows x64,
macOS arm64 and Linux x64 runners, contents:read, pinned actions and no secrets,
release/publish steps, Rust cache or persistent build uploads. Only the small
archive, checksum and build identity are retained for 30 days. Source, target,
Cargo home and profiles are never uploaded. Parent task owns the reviewed public
branch, workflow execution and any subsequent installer activation.

The [current GitHub runner labels](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job)
list `macos-15` as arm64 and `macos-15-intel` as Intel (verified 2026-11-20).
The workflow uses `macos-15` and checks the actual machine with `uname -m` before
building; the build script also checks Node's native OS/architecture. Linux uses
`ubuntu-22.04` to retain the requested glibc baseline.

## Maintaining the patch

Edit a fresh extracted source under ignored artifacts, regenerate only the
necessary unified diff, update the patch digest in the manifest, and replay the
complete build. Keep the original source hash and upstream license unless a
separately reviewed upstream change is authorized. No upstream request semantics
may be weakened merely to turn an unsupported tool response into HTTP 200.
