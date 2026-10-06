# subagent-inspector

A Claude Code mod that opens a **Subagents** pane to show what each subagent is doing.

- **Prompt** (`p`): the full task prompt, plus type, model, foreground/background and parent
- **Context** (`c`): the agent's conversation, updated live (last 40 messages, tool calls and results, tokens in context)
- **Tools** (`t`): every tool call and its status
- **Output** (`o`): the final answer, or the latest text while it runs

The top of the pane lists all subagents: status (`●` running, `✓` done, `✗` error, `■` stopped), type, run time, context size and tool count. Press `1`–`9` to select one and `x` to clear finished ones.

It opens by itself when the first subagent starts, or with `/subagents`.

The pane shows in the terminal. Where an app can't show plugin panes (claude.ai/code in the browser, some VS Code builds), `/subagents` prints a text view in the chat instead:

- `/subagents`: list of subagents with status, type, run time, context size and tool count
- `/subagents <number>`: that agent's prompt, recent conversation, tool calls and output

The text view is a snapshot; run the command again to refresh it.

## Install

```
/plugin marketplace add rundercaster/subagentClaude
/plugin install subagent-inspector@subagent-inspector
```

Or load a local clone:

- Terminal: `claude --plugin-dir /path/to/subagent-inspector`
- Desktop app: add `"CLAUDE_CODE_PLUGIN_DIRS": "/path/to/subagent-inspector"` to the `env` block of `~/.claude/settings.json`

## Develop

```
claude plugin validate .
claude plugin test .
```

The mod API is early access and may change between Claude Code releases (built against 2.1.288).
