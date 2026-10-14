# pi-btw

A small [pi](https://github.com/earendil-works/pi-mono) extension that adds a `/btw` side conversation channel.

`/btw` opens a real pi sub-session with coding-tool access, and it runs immediately even while the main agent is still busy.

![BTW overlay example](docs/btw-overlay.png)

## What it does

- opens a parallel side conversation without interrupting the main run
- runs that side conversation as a real pi sub-session with `read` / `bash` / `edit` / `write` tool access
- keeps a continuous BTW thread by default
- supports `/btw:tangent` for a contextless side thread that does not inherit the current main-session conversation
- opens a focused BTW modal shell with its own composer and transcript
- keeps the BTW overlay open while you switch focus back to the main editor with `Alt+/`
- keeps BTW thread entries out of the main agent's future context
- supports BTW-only model and thinking overrides without changing the main thread settings
- lets you inject the full thread, or a summary of it, back into the main agent
- optionally saves an individual BTW exchange as a visible session note with `--save`

## Install

### From npm (after publish)

```bash
pi install npm:pi-btw
```

### From git

```bash
pi install git:github.com/dbachelder/pi-btw
```

Then reload pi:

```text
/reload
```

### From a local checkout

```bash
pi install /absolute/path/to/pi-btw
```

## Usage

```text
/btw what file defines this route?
/btw how would you refactor this parser?
/btw --save summarize the last error in one sentence
/btw:debug inspect why the command failed
/btw:new let's start a fresh thread about auth
/btw:tangent brainstorm from first principles without using the current chat context
/btw --model gpt-5-mini --thinking low what are the risks of this change?
/btw:thinking low
/btw:inject implement the plan we just discussed
/btw:summarize turn that side thread into a short handoff
/btw:clear
```

## Commands

### `/btw [--model <m>] [--thinking <t>] [--save] <question>`

- runs right away
- works while pi is busy
- creates or reuses a real BTW sub-session instead of a one-off completion call
- continues the current BTW thread
- opens or refreshes the focused BTW modal shell
- streams into the BTW modal transcript/status surface
- persists the BTW exchange as hidden thread state
- with `--model <query>` (or `-m`), sets a BTW-only model override using fuzzy
  matching and provider aliases (e.g. `copilot/gpt-5.4`, `gpt-5-mini`, `claude`)
- with `--thinking <level>` (or `-t`), sets a BTW-only thinking override
- if a model query is ambiguous across authenticated providers, the popup
  prompts you to pick one
- with `--save`, also saves that single exchange as a visible session note

## Overlay controls

- `Alt+/` toggles focus between BTW and the main editor without closing the overlay
- `Ctrl+Alt+W` is a fallback focus toggle for terminals that do not deliver `Alt+/` as a usable shortcut
- `Esc` still dismisses BTW immediately while the overlay is focused
- BTW now opens top-centered so the main session remains visible underneath it

### `/btw:new [question]`

- clears the current BTW thread
- starts a fresh thread that still inherits the current main-session context
- optionally asks the first question in the new thread immediately
- if no question is provided, opens a fresh BTW modal ready for the next prompt

### `/btw:tangent [--save] <question>`

- starts or continues a contextless tangent thread
- does not inherit the current main-session conversation
- if you switch from `/btw` to `/btw:tangent` (or back), the previous side thread is cleared so the modes do not mix
- opens or refreshes the same focused BTW modal shell
- with `--save`, also saves that single exchange as a visible session note

### `/btw:clear`

- dismisses the BTW modal/widget
- clears the current BTW thread

### `/btw:inject [instructions]`

- sends the full BTW thread back to the main agent as a user message
- if pi is busy, queues it as a follow-up
- clears the BTW thread after sending

### `/btw:summarize [instructions]`

- summarizes the BTW thread with the current effective BTW model
- uses thinking off when the physical model supports it; otherwise uses the
  active BTW effort, and retries a provider rejection of off with that safe effort
- injects the summary into the main agent
- if pi is busy, queues it as a follow-up
- clears the BTW thread after sending

### Model & thinking controls (`--model`, `--thinking`, and natural language)

- `--model <query>` / `-m <query>`: sets a BTW-only model override on `/btw`,
  `/btw:new`, `/btw:tangent`, or `/btw:debug`
- `--model clear`: clears the override and reverts to inheriting the main
  thread model
- `--thinking <level>` / `-t <level>`: sets a BTW-only thinking override
- `--thinking clear`: reverts to inheriting the main thread thinking level
- fuzzy model resolution supports:
  - exact IDs or display names (e.g. `gpt-5-mini`)
  - provider prefixes and aliases (e.g. `copilot/gpt-5.4` -> `github-copilot`)
  - automatic credential prioritization: picks the authenticated provider if
    only one has credentials
  - in-popup disambiguation: if multiple authenticated models match (e.g.
    `claude` on Anthropic vs Bedrock), the popup prompts you to choose by number
- natural language in the popup: you can also ask directly inside the BTW modal
  composer (e.g. *"switch to gpt-5-mini with low thinking"*), and the
  sub-session will reconfigure itself using its built-in `configure_btw` tool

### `/btw:thinking [<level> | clear]`

- with no args, shows the current effective BTW thinking level and whether it
  is inherited or overridden
- with a value, sets a BTW-only thinking override for normal BTW chat
- `clear` removes the override and returns BTW to inheriting the main thread
  thinking level
- changing `--model` or `/btw:thinking` disposes the current BTW sub-session
  and applies the new settings on the next BTW prompt while preserving the
  hidden thread

### `/btw:sync` (or `/sync` in the modal)

- pulls the latest parent session messages into the active BTW sub-session's
  context
- keeps the current side thread and transcript intact while refreshing
  background context from the main agent
- seamlessly connects a tangent thread to parent session context

### `/btw:copy` (or `/copy` in the modal)

- copies the latest BTW assistant response to the system clipboard
- can be invoked as `/btw:copy` from the main session or `/copy` directly inside
  the modal composer

## Behavior

### Real sub-session model

BTW is implemented as an actual pi sub-session with its own in-memory session state, transcript events, and tool surface.

- contextual `/btw` threads seed that sub-session from the current main-session branch while filtering out BTW-visible notes from the parent context
- `/btw:tangent` starts the same BTW UI in a contextless mode with no inherited main-session conversation
- BTW can inherit the main thread model/thinking settings or use BTW-only overrides via `--model` and `--thinking` flags or natural language
- `/btw:summarize` keeps the chosen physical model, using thinking off when
  supported or the active BTW effort when off is unavailable
- the overlay transcript/status line is driven from sub-session events, so tool activity, streaming deltas, failures, and recovery are all visible without scraping rendered output
- handoff commands (`/btw:inject` and `/btw:summarize`) read from the BTW sub-session thread rather than maintaining a separate manual transcript model

### Physical model inheritance

BTW works without a router extension. Compatibility checks cover Pi 0.85.1
and 1.2.0; the peer declaration adds exactly 1.2.0, not future 1.x versions.

A new BTW child uses the selected physical model and its selected thinking
level. With a virtual selection, it instead uses the latest successful physical
assistant response on the active branch, including that response's recorded
thinking level. Failed or aborted responses and opaque router state are not
physical-model evidence.

If the physical model or its matching effort cannot be established, supply both:

```text
/btw --model provider/physical-model --thinking high your question
```

Only physical models are offered for BTW overrides. Model and thinking overrides
remain independent: a model override can inherit a known physical effort, but
an unknown virtual route cannot supply one. A thinking-only override cannot
establish an unknown physical model. Restored virtual overrides must be replaced
with a physical override or cleared before use. Missing override credentials
still fall back to a known physical parent pair, never to a virtual selection.

After a conversation starts, ordinary main-session selection or routing changes
do not retarget or relabel it. The overlay and saved notes report the physical
child and its actual SDK-clamped effort. New threads, explicit synchronization,
and BTW override changes retain their existing recreation behavior.

Children and summaries load no parent extensions or virtual routers. They use
only their chosen physical catalog model and the parent's configured provider
transport and public authentication boundary; no separate credentials are copied.
Summaries keep that physical model on an off-to-safe-effort retry.

### In-modal slash behavior

Inside the BTW modal composer, slash handling is split at the BTW/session boundary:

- bare `/clear`, `/new`, `/sync`, `/inject`, `/summarize`, `/copy`, `/debug`,
  `/thinking`, `/tangent` (as well as their `/btw:*` equivalents) are
  handled directly by BTW:
  - `/clear` resets the thread and transcript in place without dismissing the
    modal
  - `/new [question]` clears the thread, re-seeds fresh parent context, and
    keeps the modal open
  - `/sync` refreshes parent context into the active thread in place
  - `/inject` and `/summarize` hand off to the main agent and dismiss the modal
  - `/copy` copies the last assistant response to clipboard
- any other slash-prefixed input is routed through the BTW sub-session's normal
  `prompt()` path
- this means ordinary pi slash commands like `/help` are handled by the sub-session instead of being rejected by a modal-only fallback
- if the sub-session cannot handle a slash command, BTW surfaces the real sub-session failure through the transcript/status state instead of inventing an "unsupported slash input" warning

This keeps BTW-owned lifecycle commands explicit while giving the side conversation the same slash-command surface as the underlying sub-session.

## Behavior

### Hidden BTW thread state

BTW exchanges are persisted in the session as hidden custom entries so they:

- survive reloads and restarts
- rehydrate the BTW modal shell for the current branch
- preserve whether the current side thread is a normal `/btw` thread or a contextless `/btw:tangent`
- preserve the current BTW-only model and thinking overrides for that session history
- stay out of the main agent's LLM context

### Visible saved notes

If you use `--save`, that one BTW exchange is also written as a visible custom message in the session transcript.

## Why

Sometimes you want to:

- ask a clarifying question while the main agent keeps working
- think through next steps without derailing the current turn
- explore an idea, then inject it back once it's ready

## Included skill

This package also ships a small `btw` skill so pi can better recognize when a side-conversation workflow is appropriate.

It helps with discoverability and guidance, but it is not required for the extension itself to work.

## Development

The extension entrypoint is:

- `extensions/btw.ts`

The included skill is:

- `skills/btw/SKILL.md`

To use it without installing:

```bash
pi -e /path/to/pi-btw
```

### Offline compatibility checks

Keep the existing development pins. No dependency upgrade or install is required
for checks against an already available host:

```bash
npm run test:compat
PI_BTW_SDK_ROOT=/path/to/pi-host npm run test:compat
```

The optional host root supplies installed public Pi packages for the test alias;
it is not a plugin or router dependency. The runner disables Vitest caching and
config bundling, runs the existing and native caller tests, typechecks the
extension, and checks the public extension loader. Native virtual cases are
skipped on hosts without that API. Provider requests use in-memory fixtures only.
These checks do not verify a fresh package installation or live credentials.

## License

MIT
