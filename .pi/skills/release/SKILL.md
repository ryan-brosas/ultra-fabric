---
name: release
description: Cut and publish an Ultra Fabric npm prerelease. Use when asked to release, publish, cut a version, bump the version, or push a release tag for this repo.
---

# Release Ultra Fabric

Publishing is driven entirely by pushing a `v*` tag. GitHub Actions publishes over npm Trusted Publishing (OIDC), so there is no `NPM_TOKEN`, no `npm login`, and no local `pnpm publish`. Never publish from a workstation.

## Preconditions

- On `main`, in sync with `origin/main`.
- `pnpm run check` green from a normal shell. Run it outside a Fabric-spawned worker, otherwise `tests/worker-e2e.test.ts` fails on inherited `PI_FABRIC_DEPTH`.
- Work being released is already committed and pushed. Unrelated working-tree changes may stay uncommitted; stage release files explicitly rather than using `git commit -a`.

## Steps

1. Bump `version` in `package.json`. Prereleases use the `0.31.1-ultra.N` shape.
2. Add a `CHANGELOG.md` section directly under `# Changelog`, formatted `## <version> - <YYYY-MM-DD>` followed by bullets.
3. Commit exactly those two files: `chore(release): mark <version>`.
4. Create an **annotated** tag whose message is the tag name: `git tag -a v<version> -m "v<version>"`.
5. Push the branch, then push the tag by explicit ref:

   ```sh
   git push origin main
   git push origin refs/tags/v<version>
   ```

## Do not use --follow-tags

It silently does the wrong thing in this repo. It skips lightweight tags, so the release never triggers, and it pushes every local annotated tag not yet on the remote — which sends the inherited upstream fork tags (`v0.1.0` through `v0.30.3`) to origin as clutter. Those old tags predate `.github/workflows/release.yml`, so they trigger no workflow runs, but they do not belong on the fork. Push the release tag by explicit ref instead.

## Verify

The workflow checks that `GITHUB_REF_NAME` equals `v` + the `package.json` version, then runs `npm publish --access public --tag next`. Confirm the result:

```sh
curl -s https://registry.npmjs.org/ultra-fabric | \
  python3 -c "import sys,json;d=json.load(sys.stdin);print(d['dist-tags'])"
```

A successful OIDC publish records `_npmUser.trustedPublisher.id == "github"` on the version.

## Notes

- Every tagged release lands on the `next` dist-tag. Promoting to `latest` is a separate `npm dist-tag add ultra-fabric@<version> latest`, which does require an `npm login`.
- `prepack` is `pnpm run check`, so a local `pnpm publish` would re-run the whole gate and refuse on a dirty tree. That path is unnecessary; CI already gated the tag.
