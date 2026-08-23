# dsh-codex v0.3.0 — AI Deployment Contract

Use this file as the complete low-token runbook. Human docs: [English](README.md), [中文](README.zh.md).

## Immutable facts

- Product: DSH plugin for DeepSeek Harness.
- Package: `dsh-codex`.
- Release: `v0.3.0`.
- Provider: `openai-codex`.
- Host plugin id: `llm-openai-codex`.
- Node: `>=22.5.0`.
- Release URL: `https://github.com/chenmzh/dsh-codex/releases/download/v0.3.0/dsh-codex-0.3.0.tgz`.
- Upstream dependency: this is an enhanced fork of `Yan-Zero/dsh-codex`, not a co-installable addon.
- Mutual exclusion: install this build instead of upstream/npm `dsh-codex`. Never install both in one profile.
- Auth: ChatGPT Codex OAuth; no OpenAI Platform API key.
- Storage: `$DSH_HOME/.openai-codex-usage.sqlite3`; request metadata only, no prompts, responses, or tokens.
- Session usage: provider-neutral normalized token counts; DeepSeek, OpenCode Go, Kimi, and standard usage-emitting DSH adapters.
- Account quota: separate OpenAI Codex account feature, never mixed into LLM Usage analytics.

## Install

Choose one launcher and one profile. Default profile: `web`.

Installed DSH:

```sh
dsh plugin --profile web add https://github.com/chenmzh/dsh-codex/releases/download/v0.3.0/dsh-codex-0.3.0.tgz
dsh web
```

Harness source checkout:

```sh
pnpm dsh plugin --profile web add https://github.com/chenmzh/dsh-codex/releases/download/v0.3.0/dsh-codex-0.3.0.tgz
pnpm dsh web
```

Local development checkout:

```sh
pnpm install
pnpm run build
pnpm dsh plugin --profile web add link:/absolute/path/to/dsh-codex
pnpm dsh web
```

Do not patch Harness. Do not add a second `openai-codex` provider.

## Authenticate

Prefer Web: **Settings → OpenAI Codex → Sign in with ChatGPT**.

CLI fallback:

```sh
dsh plugin --profile web exec dsh-openai-codex status
dsh plugin --profile web exec dsh-openai-codex login
```

Use `login --device-code` only when localhost browser callback is unavailable. OAuth approval is user-only.

## Verify

Require all:

1. DSH root page returns HTTP 200.
2. Boot manifest contains `dsh-codex`.
3. `GET /plugins/dsh-openai-codex/auth/status` returns HTTP 200 and no credentials.
4. `GET /plugins/dsh-openai-codex/usage/summary?range=7d` returns HTTP 200.
5. Settings contains **OpenAI Codex** and **LLM Usage**.
6. Session HUD appears for any configured provider/model and displays no account quota.
7. Analytics filters: provider, time, exact model, reasoning.
8. **Download JSON** exports the current filtered panel without quota or credit fields.

## Safety

Never read, print, copy, commit, or modify:

- `~/.codex/auth.json`
- `$DSH_HOME/.openai-codex-auth.json`
- OAuth URLs/codes, access tokens, refresh tokens, authorization headers, account identifiers

Do not delete the SQLite ledger during update. Do not infer weekly credit denominator from a rounded percentage.

## Update

Install the new release archive over the existing package spec, restart DSH, then repeat Verify. Preserve profile settings and the SQLite ledger.

## Remove

Only on explicit request:

```sh
dsh plugin --profile web remove dsh-codex
```

Credential deletion is separate:

```sh
dsh plugin --profile web exec dsh-openai-codex logout
```

## Success report

Return only: profile, installed release/spec, signed-in or signed-out, Web client detected, usage API detected. Never return secret or account fields.
