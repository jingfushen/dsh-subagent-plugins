# Codex imagegen tool (`@local/dsh-codex-imagegen`)

Standalone DSH plugin that adds one model-facing tool, `codex_imagegen`: GPT Image
through **Codex CLI's built-in imagegen skill** (the `image_gen` tool), with optional
output path and reference images. It is the standalone-plugin redo of the historical
`./imagegen.mjs` row that lived inside the local `dsh-codex-agy-preset` bundle.

## What it does

- Registers `codex_imagegen` on the Host plane, so every Agent sees it (like the
  official native-subagent bundles; override or disable the row by id to narrow that).
- Each call spawns the real Codex CLI once:
  `codex exec --skip-git-repo-check --ephemeral -C <cwd> -s <sandbox> --json -o <lastMessage> [flags] <task>`
  and asks it to use the **built-in** imagegen skill (not the Python/API fallback).
- Returns the absolute path of the produced image. Reasoning, tool traffic, and
  stderr stay out of the parent Session; failures surface as a bounded diagnostic.

## Tool contract

```
codex_imagegen({
  prompt: string,             // required: what to generate or edit
  out?: string,               // optional absolute path for the final image
  refs?: string[],            // optional absolute paths of reference images
}) -> { path: string, prompt: string }
```

When `out` is omitted, Codex keeps its generated file (usually under
`$CODEX_HOME/generated_images/`) and the tool returns that path. Reference images are
passed to Codex with `-i`.

## Mount

This bundle already carries the row; installing it is enough:

```yaml
- insert:
    - id: tool-codex-imagegen
      name: '@local/dsh-codex-imagegen'
      config:
        command: codex
        sandbox: danger-full-access
        proxy: http://127.0.0.1:12450
        timeoutMs: 600000
```

## Config

| Field | Default | Meaning |
|---|---|---|
| `command` | `codex` | Codex CLI executable name or absolute path |
| `model` | native Codex config | `-m <model>` for the child run |
| `reasoningEffort` | native Codex config | `-c model_reasoning_effort="<effort>"` |
| `sandbox` | `danger-full-access` | Codex sandbox for the child; image output lands outside the workspace, so writes are required |
| `proxy` | `http://127.0.0.1:12450` | Global proxy applied to the child (`null` disables) |
| `verifyProxy` | `true` | Probe the proxy with a TCP connect before spawning |
| `timeoutMs` | `600000` | Wall-clock ceiling for one generation (also declared to the tool timeout policy) |
| `disposeGraceMs` | `3000` | Grace between subprocess termination tiers |
| `env` | `{}` | Extra environment entries layered over the child env |

The historical preset used `model: gpt-6-astra` and `reasoningEffort: xhigh`; both are
optional here and default to the native `~/.codex/config.toml`.

## Requirements

- Codex CLI installed and signed in on this machine (the built-in `image_gen` tool uses
  the ChatGPT login; no `OPENAI_API_KEY` needed).
- Reachable proxy at `127.0.0.1:12450` on this machine (or set `proxy: null`).

## Limits

- One generation per call; long runs up to `timeoutMs`. The caller's cancellation
  terminates the Codex child and its managed process range.
- The tool returns a path, not the image bytes in the parent context.
