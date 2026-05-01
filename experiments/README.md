# experiments/

In-tree past explorations. Nothing in the active build references
these — they're preserved for two reasons:

- A subdirectory's README lays out a path back if a future product
  decision wants the experiment revived (e.g. `canvas-sidepane/`
  has a "If you ever want the side-pane back" section).
- The diff that landed an experiment, then archived it, is more
  searchable here than buried in `git log`.

If you're certain an experiment will never come back, prefer
`git rm -rf experiments/<name>/` over leaving it stale — git history
preserves anything we'd realistically need to revisit.
