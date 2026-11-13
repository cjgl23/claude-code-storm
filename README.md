# storm

> **Disclaimer:** This is a personal project inspired by the STORM research framework. It is not affiliated with, endorsed by, or connected to Stanford University or the Stanford OVAL team. All credit for the STORM methodology goes to its original authors (Shao et al., 2024); their official implementation is at https://github.com/stanford-oval/storm.

A Claude Code plugin that runs **STORM** research (Synthesis of Topic Outlines through Retrieval and Multi-perspective Question Asking, from Stanford OVAL: https://github.com/stanford-oval/storm) with subagents, and writes a cited, Wikipedia-style article.

## Pipeline

1. **Perspectives**: a subagent looks up related topics on the web and picks N editor perspectives. A "basic fact writer" perspective is always added.
2. **Research**: one subagent per perspective acts out a writer/expert conversation. The writer asks questions, and the expert answers only from web sources, citing each claim as `[src: URL]`.
3. **Outline**: a subagent drafts an outline from what the model already knows, then refines it using the conversations.
4. **Writing**: one subagent per top-level section writes that section from the research.
5. **Polish**: a subagent adds a lead section, removes repetition and numbers the references.

Research and writing run in **parallel** (up to `maxParallel` subagents at a time) or **sequentially** (one at a time, each reading the earlier ones' work so it avoids repeating them).

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install storm --marketplace cjgl23/claude-code-storm
```

Answer `y` to add the marketplace, then pick a scope (user is first). From a shell:

```
claude plugin install storm --marketplace cjgl23/claude-code-storm
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `cjgl23/claude-code-storm`, then Add plugin.

## Use

```
/storm <topic> [--parallel | --sequential] [--research-mode M] [--writing-mode M] [--perspectives N] [--turns N] [--max-parallel N]
/storm status | /storm cancel | /storm open
```

The model can also start a run by calling the `mcp__storm__research` tool. Progress shows in the STORM pane and the status line. Output goes to `storm-output/<topic>-<timestamp>/`: `perspectives.json`, `conversations/`, `outline.md`, `sections/`, `draft.md` and `article.md`.

Defaults (mode, perspectives, turns, maxParallel, outputDir, model) can be changed in `/config`. The research subagents need WebSearch and WebFetch to be allowed.

## License

MIT. See [LICENSE](LICENSE).
