# Contributing to d0-registry

Thanks for adding a doc source. The bar is intentionally low, but there are a few rules that keep the registry useful.

## What gets merged

PRs that meet all of:

- [ ] `id` is unique and lowercase-hyphenated (e.g. `tanstack-query`, not `TanStackQuery`).
- [ ] `source` is a stable public URL — docs homepage or docs root, not a deep link to a specific version page.
- [ ] Entry is for **real, maintained docs**. Not blog posts, not personal notes.
- [ ] `aliases` are specific. `["react query"]` is fine. `["docs", "api"]` will be removed.
- [ ] `registry.json` still parses as valid JSON after your edit. The CI workflow will verify this.

## What gets rejected

- Marketing pages ("pricing", "about").
- Login-walled or paywalled docs.
- Duplicate entries for the same project under different `id`s.
- Entries whose only purpose is SEO / drive traffic.
- Entries where the URL breaks within a few minutes of the CLI checking it (`doc0 doctor` must succeed).

## Testing your entry locally

```bash
# Point doc0 at your fork's raw URL:
echo 'registryUrl: https://raw.githubusercontent.com/YOUR-USER/d0-registry/YOUR-BRANCH/registry.json' > ~/.d0rc

doc0 registry sync
doc0 doctor
doc0 read your-id
```

If `doc0 doctor` shows your entry as `ok`, you're good to PR.

## Naming conventions

- Prefer the canonical product name, lowercased. `stripe`, not `stripe-com`.
- For scoped packages, use the name without the scope: `shadcn`, not `shadcn-ui`. Put variants in `aliases`.
- For forks / alternate distributions, use `project-variant`: e.g. `react-native-web`.

## Renames and removals

**Renames**: open a PR that updates the `id` and adds the old name as an alias for 90 days. After 90 days, remove the alias.

**Removals**: if a project is dead (no commits in 2 years AND docs site 404s), open a PR deleting the entry. Link the evidence.

## Review

A maintainer will:

1. Check the diff is a clean JSON edit.
2. Sanity-check the URL (200, not a login page).
3. Merge.

Expected turnaround: a few days. This is a volunteer project.
