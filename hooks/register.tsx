// STORM: Synthesis of Topic Outlines through Retrieval and Multi-perspective
// Question Asking (Shao et al., Stanford OVAL, NAACL 2024).
//
// The pipeline, each stage done by subagents this mod registers:
//   1. perspectives  discover related topics and pick N editor perspectives
//   2. research      one simulated writer/expert conversation per perspective,
//                    the expert grounded in web search, every claim cited
//   3. outline       draft an outline from the model's own knowledge, then
//                    refine it with what the conversations found
//   4. writing       one subagent per top-level section, citing the sources
//   5. polish        lead section, de-duplication, numbered references
//
// Research and writing run their subagents in parallel (up to maxParallel at
// once) or sequentially (one at a time, each handed the earlier ones' work).
// The run is a state machine kept in $.state and advanced by the subagents'
// turn.complete events, so no hook ever waits on a subagent.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { StormMode, StormRun, StormStage, StormTask, StormTaskKind } from '../types'

type $ = EngineInterface

const PANE = 'storm'
const TOOL = 'mcp__storm__research'
const runAtom = atom({ plugin: 'storm', key: 'run' } as const, null, { shape: 'run-1' })

const AGENT: Record<StormTaskKind, string> = {
  perspectives: 'storm:perspective-finder',
  research: 'storm:perspective-researcher',
  outline: 'storm:outline-writer',
  section: 'storm:section-writer',
  polish: 'storm:article-polisher',
}

const STAGE_LABEL: Record<StormStage, string> = {
  perspectives: 'Discovering perspectives',
  research: 'Researching (multi-perspective conversations)',
  outline: 'Building the outline',
  writing: 'Writing sections',
  polish: 'Polishing the article',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

const FINISHED: readonly StormStage[] = ['done', 'failed', 'cancelled']

// ---------------------------------------------------------------- prompts

const PERSPECTIVE_PROMPT = `You run the perspective-discovery stage of STORM, a method for researching a topic and writing a grounded, Wikipedia-style article.

Given a topic:
1. Use WebSearch to find 3-6 closely related topics and existing encyclopedia-style articles about the topic or its neighbours. Note how those articles are organised (their sections), since they hint at which angles matter.
2. From that survey, choose the number of distinct editor perspectives you are asked for. Each perspective is a kind of person who would contribute something different to an article on the topic (for example a historian, an engineer who builds it, a policy analyst, an affected end user). Perspectives must not overlap; together they should cover the topic broadly. Do not include a generic "basic facts" perspective: that one is added separately.

Reply with only a JSON code block, nothing before or after it:
\`\`\`json
{"related": ["related topic", "..."], "perspectives": [{"name": "Short role name", "focus": "One or two sentences on what this editor cares about and will ask."}]}
\`\`\``

const RESEARCH_PROMPT = `You run one simulated conversation of STORM's research stage. You play two roles in turn:

- THE WRITER: a Wikipedia writer with the specific perspective you are given. The writer asks one focused question at a time, each building on what has been learned, to gather what an article on the topic needs from that perspective.
- THE EXPERT: a topic expert who answers only from sources found on the web. For each question the expert breaks it into 1-3 search queries, runs WebSearch, opens the most trustworthy results with WebFetch, and answers using only what those sources say.

Rules:
- Run at most the number of rounds you are given. Stop early when the writer has nothing more worth asking.
- Every factual sentence in an answer ends with a citation of the form [src: URL], using the exact URL of the page it came from. Never invent a URL or cite a page you did not open or see in search results. If the sources do not answer a question, the expert says so.
- If you are handed earlier conversations, Read them first and ask questions they did not already answer.

Reply with only this markdown:
## Perspective: <name>
### Q1: <question>
<answer with [src: URL] citations>
### Q2: ...
(and so on)
## Sources
- <URL> | <page title> | <one line on what it supports>`

const OUTLINE_PROMPT = `You run the outline stage of STORM.

1. First, from your own knowledge alone, draft an outline for an encyclopedia article on the topic.
2. Then Read every research conversation file you are given and refine the draft: add sections the research supports, drop or merge ones it does not, and order them logically. The outline must be answerable from the research.

Format rules:
- First line: "# <topic>".
- Top-level sections are "## " headings; subsections "### " (and "#### " if needed). Use 4-9 top-level sections.
- Do not include an introduction, summary, conclusion, "See also" or "References" section; the lead and references are written later.

Reply with only the outline in markdown.`

const SECTION_PROMPT = `You write one section of a STORM article.

- Read the full outline and every research conversation file you are given.
- Write the section named in your task, following its subsection outline. Use only information found in the research files.
- Keep every citation exactly in the form it appears in the research: [src: URL]. Each factual sentence carries at least one. Do not invent sources.
- Write in a neutral, encyclopedic register, in full paragraphs. No lists unless the content is inherently a list.
- If you are handed sections written earlier, Read them first, do not repeat what they cover, and keep terminology consistent with them.

Reply with only the section's markdown, starting with its "## " heading.`

const POLISH_PROMPT = `You polish a STORM article draft into its final form.

Read the draft file you are given, then:
1. Write a lead section of 2-4 paragraphs summarising the whole article, placed right after the "# " title with no heading of its own. Cite it like the body.
2. Remove content that repeats across sections; keep every piece of non-repeated content and every section.
3. Replace each [src: URL] citation with a numbered one like [1], numbering URLs in order of first appearance; the same URL always gets the same number.
4. End with a "## References" section listing each number with its URL (and the page title where the draft or research shows it).

Reply with only the final article in markdown.`

// ---------------------------------------------------------------- helpers

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'topic'
  )
}

function stamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function unfence(text: string): string {
  const m = text.trim().match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/)
  return (m?.[1] ?? text).trim()
}

function asMode(value: unknown, fallback: StormMode): StormMode {
  return value === 'parallel' || value === 'sequential' ? value : fallback
}

function asCount(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback
}

type Perspective = { name: string; focus: string }

function parsePerspectives(answer: string): Perspective[] {
  const block = answer.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = block?.[1] ?? answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1)
  try {
    const parsed = JSON.parse(raw) as { perspectives?: unknown }
    if (!Array.isArray(parsed.perspectives)) return []
    return parsed.perspectives
      .map(p => p as Partial<Perspective>)
      .filter(p => typeof p.name === 'string' && p.name.trim() !== '')
      .map(p => ({ name: String(p.name).trim(), focus: String(p.focus ?? '').trim() }))
  } catch {
    return []
  }
}

const FALLBACK_PERSPECTIVES: Perspective[] = [
  { name: 'Historian', focus: 'Origins, key events and how the topic developed over time.' },
  { name: 'Technical specialist', focus: 'How it works: mechanisms, components, methods and terminology.' },
  { name: 'Policy and society analyst', focus: 'Impact on people, economics, regulation, controversies and debates.' },
  { name: 'Practitioner', focus: 'Real-world applications, notable examples and current state of practice.' },
]

const BASIC_FACTS: Perspective = {
  name: 'Basic fact writer',
  focus: 'Broad, basic facts about the topic: what it is, when and where, who is involved, and why it matters.',
}

type Section = { heading: string; outline: string }

function parseOutline(outline: string): Section[] {
  const lines = outline.split('\n')
  const level = lines.some(l => /^##\s/.test(l)) ? '## ' : '# '
  const sections: Section[] = []
  let current: { heading: string; lines: string[] } | null = null
  let titleSeen = false
  for (const line of lines) {
    if (line.startsWith(level)) {
      if (level === '# ' && !titleSeen) {
        titleSeen = true
        continue
      }
      if (current) sections.push({ heading: current.heading, outline: current.lines.join('\n') })
      current = { heading: line.slice(level.length).trim(), lines: [line] }
    } else if (current && line.trim() !== '' && !(level === '## ' && /^#\s/.test(line))) {
      current.lines.push(line)
    }
  }
  if (current) sections.push({ heading: current.heading, outline: current.lines.join('\n') })
  return sections.filter(s => !/^(references|see also|external links)$/i.test(s.heading))
}

function limitFor(run: StormRun, kind: StormTaskKind): number {
  const mode = kind === 'research' ? run.researchMode : kind === 'section' ? run.writingMode : 'sequential'
  return mode === 'sequential' ? 1 : run.maxParallel
}

function done(run: StormRun, kind: StormTaskKind): StormTask[] {
  return run.tasks.filter(t => t.kind === kind && t.status === 'done').sort((a, b) => a.index - b.index)
}

function pending(run: StormRun, kind: StormTaskKind): boolean {
  return run.tasks.some(t => t.kind === kind && (t.status === 'queued' || t.status === 'starting' || t.status === 'running'))
}

function bullets(paths: readonly string[]): string {
  return paths.map(p => `- ${p}`).join('\n')
}

function promptFor(run: StormRun, task: StormTask): string {
  const research = done(run, 'research').map(t => t.outputPath)
  switch (task.kind) {
    case 'perspectives':
      return `Topic: ${run.topic}\n\nChoose ${Math.max(1, run.perspectives - 1)} perspectives.`
    case 'research': {
      const earlier =
        run.researchMode === 'sequential' && research.length > 0
          ? `\n\nEarlier conversations (Read them first; ask what they did not cover):\n${bullets(research)}`
          : ''
      return `Topic: ${run.topic}\nYour perspective: ${task.brief}\nRounds: at most ${run.turns}.${earlier}`
    }
    case 'outline':
      return `Topic: ${run.topic}\n\nResearch conversation files to Read:\n${bullets(research)}`
    case 'section': {
      const written = done(run, 'section').map(t => t.outputPath)
      const earlier =
        run.writingMode === 'sequential' && written.length > 0
          ? `\n\nSections written earlier (Read them first; do not repeat them):\n${bullets(written)}`
          : ''
      return `Topic: ${run.topic}\nFull outline: ${run.dir}/outline.md\n\nWrite this section:\n${task.brief}\n\nResearch conversation files to Read:\n${bullets(research)}${earlier}`
    }
    case 'polish':
      return `Topic: ${run.topic}\nDraft to Read: ${run.dir}/draft.md\n\nResearch files, for page titles if useful:\n${bullets(research)}`
  }
}

function task(run: StormRun, kind: StormTaskKind, index: number, label: string, brief: string, file: string): StormTask {
  return {
    id: `${kind}-${index}`,
    kind,
    label,
    status: 'queued',
    outputPath: `${run.dir}/${file}`,
    index,
    brief,
  }
}

// ---------------------------------------------------------------- the machine

let cwd = '.'
// A subagent can end before its spawn's agentId is recorded; hold such ends.
const early = new Map<string, { answer: string; ok: boolean }>()
let defaults = {
  mode: 'parallel' as StormMode,
  perspectives: 4,
  turns: 4,
  maxParallel: 4,
  outputDir: 'storm-output',
  model: 'inherit',
}

async function showStatus($: $, run: StormRun | null) {
  if (!run || FINISHED.includes(run.stage)) {
    $.ui.status(undefined)
    return
  }
  const kind: StormTaskKind | undefined =
    run.stage === 'research' ? 'research' : run.stage === 'writing' ? 'section' : undefined
  const count = kind
    ? ` ${done(run, kind).length}/${run.tasks.filter(t => t.kind === kind).length}`
    : ''
  $.ui.status(`STORM: ${run.stage}${count}`)
}

async function startRun(
  $: $,
  args: { topic: string; researchMode: StormMode; writingMode: StormMode; perspectives: number; turns: number; maxParallel: number },
): Promise<{ run?: StormRun; error?: string }> {
  const current = await read($, runAtom)
  if (current && !FINISHED.includes(current.stage)) {
    return { error: `A STORM run on "${current.topic}" is still in progress. Use /storm cancel first.` }
  }
  const now = await $.clock.now()
  const base = defaults.outputDir.startsWith('/') ? defaults.outputDir : `${cwd}/${defaults.outputDir}`
  const run: StormRun = {
    id: `${now}`,
    topic: args.topic,
    dir: `${base}/${slugify(args.topic)}-${stamp(now)}`,
    researchMode: args.researchMode,
    writingMode: args.writingMode,
    maxParallel: args.maxParallel,
    perspectives: args.perspectives,
    turns: args.turns,
    model: defaults.model,
    stage: 'perspectives',
    tasks: [],
    startedAt: now,
  }
  run.tasks = [task(run, 'perspectives', 0, 'Survey related topics, pick perspectives', '', 'perspectives.md')]
  await $.fs.write(
    `${run.dir}/run.json`,
    JSON.stringify({ topic: run.topic, researchMode: run.researchMode, writingMode: run.writingMode, perspectives: run.perspectives, turns: run.turns, maxParallel: run.maxParallel, startedAt: new Date(now).toISOString() }, null, 2),
  )
  await update($, runAtom, () => run)
  void $.ui.open({ id: PANE, title: 'STORM research' })
  await pump($)
  return { run }
}

// Start queued tasks up to the stage's concurrency limit.
async function pump($: $) {
  let picked: StormTask[] = []
  const run = await update($, runAtom, r => {
    picked = []
    if (!r || FINISHED.includes(r.stage)) return r
    const active = r.tasks.filter(t => t.status === 'starting' || t.status === 'running').length
    const queued = r.tasks.filter(t => t.status === 'queued')
    if (queued.length === 0) return r
    picked = queued.slice(0, Math.max(0, limitFor(r, queued[0]!.kind) - active))
    const ids = new Set(picked.map(t => t.id))
    return { ...r, tasks: r.tasks.map(t => (ids.has(t.id) ? { ...t, status: 'starting' as const } : t)) }
  })
  await showStatus($, run)
  if (!run) return
  await Promise.all(picked.map(t => launch($, run, t)))
}

async function launch($: $, run: StormRun, t: StormTask) {
  let agentId: string | undefined
  let error: string | undefined
  try {
    const spawned = await $.agent.spawn({
      subagentType: AGENT[t.kind],
      prompt: promptFor(run, t),
      description: `STORM ${t.kind}: ${t.label}`.slice(0, 60),
      ...(run.model !== 'inherit' ? { model: run.model } : {}),
    })
    agentId = spawned.agentId
    if (!agentId) error = spawned.deny ?? 'the subagent did not start'
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  await update($, runAtom, r =>
    r && r.id === run.id
      ? {
          ...r,
          tasks: r.tasks.map(x =>
            x.id === t.id ? { ...x, status: error ? ('failed' as const) : ('running' as const), agentId, error } : x,
          ),
        }
      : r,
  )
  if (error) {
    await advance($)
    return
  }
  const ended = agentId ? early.get(agentId) : undefined
  if (agentId && ended) {
    early.delete(agentId)
    await finish($, agentId, ended.answer, ended.ok)
  }
}

// A subagent ended: store its answer and move the machine on.
async function finish($: $, agentId: string, answer: string, ok: boolean) {
  const run = await read($, runAtom)
  const t = run?.tasks.find(x => x.agentId === agentId)
  if (!run || !t) {
    if (run?.tasks.some(x => x.status === 'starting')) early.set(agentId, { answer, ok })
    return
  }
  if (t.status !== 'running') return
  const text = unfence(answer)
  const good = ok && text !== ''
  if (good) await $.fs.write(t.outputPath, text + '\n')
  await update($, runAtom, r =>
    r && r.id === run.id
      ? {
          ...r,
          tasks: r.tasks.map(x =>
            x.id === t.id
              ? { ...x, status: good ? ('done' as const) : ('failed' as const), error: good ? undefined : 'the subagent ended without an answer' }
              : x,
          ),
        }
      : r,
  )
  await advance($)
}

// When the current stage has no work left, open the next one.
async function advance($: $) {
  const run = await read($, runAtom)
  if (!run || FINISHED.includes(run.stage)) return
  const stageKind: StormTaskKind = run.stage === 'writing' ? 'section' : (run.stage as StormTaskKind)
  if (pending(run, stageKind)) {
    await pump($)
    return
  }

  let next: StormStage = run.stage
  let added: StormTask[] = []
  let error: string | undefined
  let articlePath: string | undefined

  if (run.stage === 'perspectives') {
    const out = done(run, 'perspectives')[0]
    let found = out ? parsePerspectives(await $.fs.read(out.outputPath)) : []
    if (found.length === 0) found = FALLBACK_PERSPECTIVES
    const chosen = [BASIC_FACTS, ...found.slice(0, Math.max(1, run.perspectives - 1))]
    await $.fs.write(`${run.dir}/perspectives.json`, JSON.stringify(chosen, null, 2) + '\n')
    added = chosen.map((p, i) =>
      task(run, 'research', i, p.name, `${p.name}: ${p.focus}`, `conversations/${String(i + 1).padStart(2, '0')}-${slugify(p.name)}.md`),
    )
    next = 'research'
  } else if (run.stage === 'research') {
    if (done(run, 'research').length === 0) {
      next = 'failed'
      error = 'every research conversation failed'
    } else {
      added = [task(run, 'outline', 0, 'Draft and refine the outline', '', 'outline.md')]
      next = 'outline'
    }
  } else if (run.stage === 'outline') {
    const out = done(run, 'outline')[0]
    const outline = out ? await $.fs.read(out.outputPath) : ''
    let sections = parseOutline(outline)
    if (!out) {
      next = 'failed'
      error = 'the outline subagent failed'
    } else {
      if (sections.length === 0) sections = [{ heading: 'Overview', outline: outline }]
      added = sections.map((s, i) =>
        task(run, 'section', i, s.heading, s.outline, `sections/${String(i + 1).padStart(2, '0')}-${slugify(s.heading)}.md`),
      )
      next = 'writing'
    }
  } else if (run.stage === 'writing') {
    const written = done(run, 'section')
    if (written.length === 0) {
      next = 'failed'
      error = 'every section subagent failed'
    } else {
      const parts = await Promise.all(written.map(t => $.fs.read(t.outputPath)))
      await $.fs.write(`${run.dir}/draft.md`, `# ${run.topic}\n\n${parts.map(p => p.trim()).join('\n\n')}\n`)
      added = [task(run, 'polish', 0, 'Lead section, de-duplication, references', '', 'article.md')]
      next = 'polish'
    }
  } else if (run.stage === 'polish') {
    articlePath = `${run.dir}/article.md`
    if (done(run, 'polish').length === 0) {
      // Polishing failed: the draft, with its [src: URL] citations, stands as the article.
      await $.fs.write(articlePath, await $.fs.read(`${run.dir}/draft.md`))
    }
    next = 'done'
  }

  const finishedAt = FINISHED.includes(next) ? await $.clock.now() : undefined
  let moved = false
  const after = await update($, runAtom, r => {
    moved = false
    if (!r || r.id !== run.id || r.stage !== run.stage) return r
    moved = true
    return { ...r, stage: next, tasks: [...r.tasks, ...added], error, articlePath, finishedAt }
  })
  if (!moved || !after) return
  await showStatus($, after)
  if (FINISHED.includes(next)) await announce($, after)
  else await pump($)
}

async function announce($: $, run: StormRun) {
  const minutes = Math.max(1, Math.round(((run.finishedAt ?? run.startedAt) - run.startedAt) / 60000))
  const text =
    run.stage === 'done'
      ? `STORM research on "${run.topic}" finished in ${minutes} min. Article: ${run.articlePath} (outline, conversations and sections are beside it in ${run.dir}).`
      : `STORM research on "${run.topic}" ${run.stage}${run.error ? `: ${run.error}` : ''}. Partial output: ${run.dir}`
  $.ui.toast(text, { timeoutMs: 10000 })
  void $.ui.notify(text, { title: 'STORM' })
  try {
    await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } })
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `[storm plugin] ${text}` }] } })
  } catch {
    // A session that refuses plugin rows still got the toast.
  }
}

export const register: Register = (on, options) => {
  defaults = {
    mode: asMode(options.mode, 'parallel'),
    perspectives: asCount(options.perspectives, 4, 2, 10),
    turns: asCount(options.turns, 4, 1, 10),
    maxParallel: asCount(options.maxParallel, 4, 1, 10),
    outputDir: typeof options.outputDir === 'string' && options.outputDir !== '' ? options.outputDir : 'storm-output',
    model: typeof options.model === 'string' && options.model !== '' ? options.model : 'inherit',
  }

  function parseArgs(raw: string): { topic: string; flags: Record<string, string> } {
    const flags: Record<string, string> = {}
    const words: string[] = []
    const tokens = raw.trim().split(/\s+/).filter(Boolean)
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i] ?? ''
      if (tok === '--parallel' || tok === '--sequential') flags.mode = tok.slice(2)
      else if (tok.startsWith('--')) {
        const [key = '', inline] = tok.slice(2).split('=', 2)
        flags[key] = inline ?? tokens[++i] ?? ''
      } else words.push(tok)
    }
    return { topic: words.join(' ').replace(/^["']|["']$/g, ''), flags }
  }

  const USAGE =
    'Usage: /storm <topic> [--parallel | --sequential] [--research-mode parallel|sequential] [--writing-mode parallel|sequential] [--perspectives N] [--turns N] [--max-parallel N]\n       /storm status | /storm cancel | /storm open'

  // ------------------------------------------------------------ hooks

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    const model = defaults.model
    const spec = (name: string, description: string, prompt: string, tools: string[]) =>
      $.agent.register({ name, description, prompt, tools, model, omitClaudeMd: true })
    await Promise.all([
      spec('perspective-finder', 'STORM stage 1: surveys related topics and proposes editor perspectives.', PERSPECTIVE_PROMPT, ['WebSearch', 'WebFetch']),
      spec('perspective-researcher', 'STORM stage 2: simulates a writer/expert conversation from one perspective, grounded in cited web sources.', RESEARCH_PROMPT, ['WebSearch', 'WebFetch', 'Read']),
      spec('outline-writer', 'STORM stage 3: drafts and refines an article outline from the research.', OUTLINE_PROMPT, ['Read']),
      spec('section-writer', 'STORM stage 4: writes one cited article section from the research.', SECTION_PROMPT, ['Read']),
      spec('article-polisher', 'STORM stage 5: adds the lead, removes repetition and numbers the references.', POLISH_PROMPT, ['Read']),
    ])
    await $.command.register({
      name: 'storm',
      description: 'Research a topic with STORM (multi-perspective subagents) and write a cited article',
      argumentHint: '<topic> [--parallel|--sequential] [--perspectives N] | status | cancel',
    })
    await $.tool.register({
      name: 'research',
      description:
        'Start a STORM research run (Stanford OVAL method): subagents discover expert perspectives on a topic, hold web-grounded Q&A conversations from each, build an outline, write cited sections and polish a Wikipedia-style article. Runs in the background; returns at once with the output folder, and a note arrives in the conversation when the article is ready. mode "parallel" runs research and writing subagents concurrently; "sequential" runs them one at a time so each builds on the previous ones.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'The topic to research.' },
          mode: { type: 'string', enum: ['parallel', 'sequential'], description: 'Default for both research and writing.' },
          research_mode: { type: 'string', enum: ['parallel', 'sequential'] },
          writing_mode: { type: 'string', enum: ['parallel', 'sequential'] },
          perspectives: { type: 'integer', minimum: 2, maximum: 10, description: 'Number of perspectives, including the basic-facts one.' },
          turns: { type: 'integer', minimum: 1, maximum: 10, description: 'Question rounds per conversation.' },
        },
        required: ['topic'],
      },
      isDeferred: false,
    })
    await showStatus($, await read($, runAtom))
    return next(e)
  })

  // The pipeline's agents are for this mod's own spawns, not the model's.
  on('agent.offer', ($, e, next) => (e.agent.startsWith('storm:') ? { isOffered: false } : next(e)))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      try {
        await finish($, e.agentId, e.answer, e.reason === 'answer' && !e.isAborted)
      } catch (err) {
        $.ui.toast(`STORM: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return next(e)
  })

  on('command.run', { command: 'storm' }, async ($, e) => {
    const { topic, flags } = parseArgs(e.args)
    const word = topic.toLowerCase()
    if (topic === '' || word === 'help') return { text: USAGE }
    if (word === 'open') {
      await $.ui.open({ id: PANE, title: 'STORM research' })
      return { text: 'STORM pane opened.' }
    }
    if (word === 'status') {
      const run = await read($, runAtom)
      if (!run) return { text: 'No STORM run in this session yet.' }
      const lines = run.tasks.map(t => `  ${t.status.padEnd(8)} ${t.kind.padEnd(12)} ${t.label}${t.error ? ` (${t.error})` : ''}`)
      return { text: `STORM "${run.topic}": ${STAGE_LABEL[run.stage]}\nOutput: ${run.dir}\n${lines.join('\n')}` }
    }
    if (word === 'cancel') {
      const run = await read($, runAtom)
      if (!run || FINISHED.includes(run.stage)) return { text: 'No STORM run in progress.' }
      const now = await $.clock.now()
      const after = await update($, runAtom, r => (r ? { ...r, stage: 'cancelled' as const, finishedAt: now } : r))
      await showStatus($, after)
      return { text: `Cancelled STORM on "${run.topic}". Subagents already running finish on their own; their answers are ignored. Partial output: ${run.dir}` }
    }
    const mode = asMode(flags.mode, defaults.mode)
    const started = await startRun($, {
      topic,
      researchMode: asMode(flags['research-mode'], mode),
      writingMode: asMode(flags['writing-mode'], mode),
      perspectives: asCount(flags.perspectives, defaults.perspectives, 2, 10),
      turns: asCount(flags.turns, defaults.turns, 1, 10),
      maxParallel: asCount(flags['max-parallel'], defaults.maxParallel, 1, 10),
    })
    if (started.error || !started.run) return { text: started.error ?? 'STORM did not start.' }
    const r = started.run
    return {
      text: `STORM started on "${r.topic}" (research: ${r.researchMode}, writing: ${r.writingMode}, ${r.perspectives} perspectives, ${r.turns} rounds each).\nOutput: ${r.dir}\nProgress is in the STORM pane; /storm status prints it.`,
    }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const topic = typeof input.topic === 'string' ? input.topic.trim() : ''
    if (topic === '') return { deny: 'topic is required' }
    const mode = asMode(input.mode, defaults.mode)
    const started = await startRun($, {
      topic,
      researchMode: asMode(input.research_mode, mode),
      writingMode: asMode(input.writing_mode, mode),
      perspectives: asCount(input.perspectives, defaults.perspectives, 2, 10),
      turns: asCount(input.turns, defaults.turns, 1, 10),
      maxParallel: defaults.maxParallel,
    })
    if (started.error || !started.run) return { deny: started.error ?? 'STORM did not start.' }
    const r = started.run
    return {
      result: {
        status: 'started',
        topic: r.topic,
        outputDir: r.dir,
        articlePath: `${r.dir}/article.md`,
        researchMode: r.researchMode,
        writingMode: r.writingMode,
        note: 'Runs in the background. A note arrives in this conversation when the article is ready; do not poll.',
      },
    }
  })

  // ------------------------------------------------------------ the pane

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const run = await read($, runAtom)
    if (!run) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No STORM run yet.</Text>
          <Text dimColor>/storm &lt;topic&gt; [--parallel | --sequential]</Text>
        </Box>
      )
    }
    const isActive = !FINISHED.includes(run.stage)
    const glyph = (s: StormTask['status']) =>
      s === 'done' ? '✓' : s === 'failed' ? '✗' : s === 'queued' ? '·' : '…'
    const color = (s: StormTask['status']) =>
      s === 'done' ? 'success' : s === 'failed' ? 'error' : undefined
    const room = Math.max(3, (e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24) - 9)
    const shown = run.tasks.slice(-room)
    const width = Math.max(20, (e.props.bodyColumns ?? 40) - 4)
    return (
      <Box flexDirection="column">
        <Text bold>{run.topic}</Text>
        <Text color={run.stage === 'failed' ? 'error' : run.stage === 'done' ? 'success' : undefined}>
          {STAGE_LABEL[run.stage]}
          {run.error ? `: ${run.error}` : ''}
        </Text>
        <Text dimColor>
          research {run.researchMode} · writing {run.writingMode} · {run.perspectives} perspectives
        </Text>
        <Text> </Text>
        {run.tasks.length > shown.length && <Text dimColor>… {run.tasks.length - shown.length} earlier</Text>}
        {shown.map(t => (
          <Text color={color(t.status)} dimColor={t.status === 'queued'}>
            {glyph(t.status)} {`${t.kind}: ${t.label}`.slice(0, width)}
          </Text>
        ))}
        <Text> </Text>
        <Text dimColor>{(run.articlePath ?? run.dir).slice(-width - 2)}</Text>
        {isActive && (
          <Button
            key="cancel"
            label="Cancel run"
            onPress={async () => {
              const now = await $.clock.now()
              const after = await update($, runAtom, r =>
                r && !FINISHED.includes(r.stage) ? { ...r, stage: 'cancelled' as const, finishedAt: now } : r,
              )
              await showStatus($, after)
            }}
          />
        )}
      </Box>
    )
  })
}
