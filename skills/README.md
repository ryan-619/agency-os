# Skills

Drop a skill at `.claude/skills/<name>/SKILL.md`. The agent container mounts
this directory read-only at `/app/skills`, and `AGENT_SKILLS_DIR` points at it.

**This directory may hold nothing else under `.claude/`.** Not
`settings.json`, not `agents/`, not `commands/`, not `hooks/`, not `mcp.json`.
The worker checks at boot and refuses to load *any* skills if it finds one,
naming the file.

That is not tidiness. Skills are filesystem-only in the SDK and are discovered
only when the **project setting source** is loaded — measured against this SDK
version, not assumed:

```
settingSources: []          49 commands, the test skill present: false
settingSources: ['project'] 50 commands, the test skill present: true
```

And the SDK's own warning about that source is: *"Allow rules from settings
files can also shadow the callback but are not visible here."* — the third
documented way `canUseTool` is skipped entirely.

So the bargain is: the setting source is loaded, and this directory is proved
to contain nothing that can use it. A skill itself is markdown. Everything a
skill makes the agent *do* still arrives at the approval gate as an ordinary
tool call.

A skill is instructions the agent follows, so treat adding one as you would
treat changing the system prompt. The mount is read-only for the same reason.
