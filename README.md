# mend: one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/baron347/makefun-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/baron347/makefun-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats —
a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor
tool calls as JSON — and `mend` reads all four to one written specification (`SPEC.md`), finds the lines each
edit names even when the model's whitespace or indentation drifted, and changes every file or none.

## Run it

```sh
node main.ts [options] [PATCH]
```

- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a`, `json`, or `auto`
  (the default, which detects it).
- `--check` does everything but write: the same output and exit code, no file created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- `PATCH` is the path of the patch file; when absent or `-`, the patch is read from standard input.
- Options and `PATCH` may come in any order; `--` ends the options.

Exit 0 prints one line per changed path (`A`/`D`/`M`, or `R <old> -> <new>` for a move) and `ok: <n> files`.
Exit 1 lists every edit that failed and `failed: <k> of <n> edits`; nothing is written. Exit 2 is a usage,
missing-patch, format or parse error, with exactly one line.

Matching works at three tiers: exact lines, then lines equal once trailing spaces and tabs are removed, then
lines equal once leading and trailing spaces and tabs are removed — the first tier where the old lines occur.
Context lines are written as the file's own matched lines, and at tier 2 added lines are re-indented to the
file's indentation.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone. Its last lines hand a trial over to `runner.ts`
  when `MAKEFUN_ENV_URL` is set: keep them.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the env, runs `main.ts` on each one in a
  fresh directory, and posts what `main.ts` did (its exit code, its stdout and the files left in the directory).
- `check.ts`: the practice set on your own machine. The kit carries it at `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

  It prints every check `main.ts` gets wrong, with what differed, and the practice score.
- `SPEC.md`: the specification — the whole contract.
- `LICENSE`: MIT.

## Practice score

100 of 100 practice checks pass (practice score 1000), run locally with `node check.ts`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=na41kg1z&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
