import { expect, test } from 'claude-code/testing'

// Stands in for the engine: files in memory, subagents that start at once and
// whose ends the test raises as turn.complete.
function engine(on: any) {
  const files = new Map<string, string>()
  const spawned: { agentId: string; type: string; prompt: string }[] = []
  on('agent.register', (_: unknown, e: { name: string }) => ({ value: { agent: `storm:${e.name}` } }))
  on('command.register', () => ({ value: { command: 'storm' } }))
  on('tool.register', () => ({ value: {} }))
  on('clock.now', () => ({ value: 1763000000000 }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: false, reason: 'no-surface' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('fs.write', (_: unknown, e: { path: string; text: string }) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_: unknown, e: { path: string }) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  // The kit hands a plugin's spawn to the bottom as the Agent tool's call.
  on('agent.spawn', (_: unknown, e: { subagentType?: string; subagent_type?: string; prompt: string }) => {
    const agentId = `a${spawned.length + 1}`
    spawned.push({ agentId, type: e.subagentType ?? e.subagent_type ?? '', prompt: e.prompt })
    return { model: 'test', agentId, result: { status: 'async_launched', agentId } }
  })
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  return { files, spawned }
}

function end($: any, agentId: string, answer: string) {
  return $.turn.complete({ agentId, answer, reason: 'answer', durationMs: 1, isAborted: false, turnId: `t-${agentId}` })
}

const PERSPECTIVES = '```json\n{"related":[],"perspectives":[{"name":"Historian","focus":"history"},{"name":"Engineer","focus":"how it works"}]}\n```'
const OUTLINE = '# Fusion\n## History\n### Early work\n## Physics\n## References'

for (const mode of ['sequential', 'parallel'] as const) {
  test(`a ${mode} run goes through every STORM stage to an article`, async ($, on) => {
    const { files, spawned } = engine(on)
    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any)

    const started = await $.command.run({ command: 'storm', args: `Fusion --${mode} --perspectives 3` } as any)
    expect(started.text).toContain('STORM started on "Fusion"')
    expect(spawned.map(s => s.type)).toEqual(['storm:perspective-finder'])

    await end($, 'a1', PERSPECTIVES)
    // Basic fact writer + 2 found perspectives.
    const research = spawned.filter(s => s.type === 'storm:perspective-researcher')
    expect(research.length).toBe(mode === 'sequential' ? 1 : 3)
    expect(research[0]!.prompt).toContain('Basic fact writer')

    // Finish research tasks as they start.
    for (let i = 0; i < 3; i++) {
      const r = spawned.filter(s => s.type === 'storm:perspective-researcher')[i]!
      if (mode === 'sequential' && i > 0) expect(r.prompt).toContain('Earlier conversations')
      await end($, r.agentId, `## Perspective ${i}\n### Q1: q\nA [src: https://e.com/${i}]`)
    }
    const outline = spawned.find(s => s.type === 'storm:outline-writer')!
    expect(outline.prompt).toContain('conversations/01-basic-fact-writer.md')

    await end($, outline.agentId, OUTLINE)
    const sectionsFirst = spawned.filter(s => s.type === 'storm:section-writer')
    expect(sectionsFirst.length).toBe(mode === 'sequential' ? 1 : 2)

    for (let i = 0; i < 2; i++) {
      const s = spawned.filter(x => x.type === 'storm:section-writer')[i]!
      await end($, s.agentId, `## Section ${i}\nText [src: https://e.com/${i}]`)
    }
    const polish = spawned.find(s => s.type === 'storm:article-polisher')!
    const draft = [...files.entries()].find(([p]) => p.endsWith('/draft.md'))![1]
    expect(draft).toContain('# Fusion')
    expect(draft).toContain('## Section 1')

    await end($, polish.agentId, '```markdown\n# Fusion\nLead [1]\n## References\n1. https://e.com/0\n```')
    const article = [...files.entries()].find(([p]) => p.endsWith('/article.md'))![1]
    expect(article.startsWith('# Fusion\nLead [1]')).toBe(true)

    const status = await $.command.run({ command: 'storm', args: 'status' } as any)
    expect(status.text).toContain('Done')
  })
}

test('a second run is refused while one is in progress, and cancel frees it', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any)
  await $.command.run({ command: 'storm', args: 'Fusion' } as any)
  const again = await $.command.run({ command: 'storm', args: 'Fission' } as any)
  expect(again.text).toContain('still in progress')
  const cancelled = await $.command.run({ command: 'storm', args: 'cancel' } as any)
  expect(cancelled.text).toContain('Cancelled')
  const third = await $.command.run({ command: 'storm', args: 'Fission' } as any)
  expect(third.text).toContain('STORM started on "Fission"')
})

test('the pane draws the run on terminal and desktop', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any)
  await $.command.run({ command: 'storm', args: 'Fusion' } as any)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'storm',
      surface,
      component: 'Pane',
      requestId: 'storm',
      props: { title: 'STORM research', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    } as any)
    expect((await ui.find({ type: 'Text', text: /Discovering perspectives/ }))?.text).toBeTruthy()
    await ui.unmount()
  }
})

test('the research tool answers with text and starts a run', async ($, on) => {
  const { spawned } = engine(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any)
  const out = await $.tool.call({ tool: 'mcp__storm__research', topic: 'Fusion', perspectives: 2, turns: 1 } as any)
  expect(typeof out.result).toBe('string')
  expect(out.result).toContain('STORM started on "Fusion"')
  expect(spawned.map(s => s.type)).toEqual(['storm:perspective-finder'])
})

test('a section answer loses its notes for the caller, and one page cited under two URLs gets one', async ($, on) => {
  const { files, spawned } = engine(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as any)
  await $.command.run({ command: 'storm', args: 'Fusion --sequential --perspectives 2' } as any)
  await end($, 'a1', PERSPECTIVES)
  for (let i = 0; i < 2; i++) {
    const r = spawned.filter(s => s.type === 'storm:perspective-researcher')[i]!
    await end($, r.agentId, `## Perspective ${i}\n### Q1: q\nA [src: https://e.com/${i}]`)
  }
  await end($, spawned.find(s => s.type === 'storm:outline-writer')!.agentId, OUTLINE)
  const a = 'https://www.mag.com/arts/the-legend-of-the-keyboard-4986/'
  const b = 'https://www.mag.com/innovation/the-legend-of-the-keyboard-4986/'
  await end(
    $,
    spawned.filter(s => s.type === 'storm:section-writer')[0]!.agentId,
    `## History\nOne [src: ${a}]\n\n---\n\nNotes for the caller:\n- Files used: /w/outline.md`,
  )
  const section = [...files.entries()].find(([p]) => p.endsWith('/sections/01-history.md'))![1]
  expect(section).not.toContain('Notes for the caller')
  expect(section.trim().endsWith(`One [src: ${a}]`)).toBe(true)
  await end($, spawned.filter(s => s.type === 'storm:section-writer')[1]!.agentId, `## Physics\nTwo [src: ${b}] [src: https://e.com/9]`)
  const draft = [...files.entries()].find(([p]) => p.endsWith('/draft.md'))![1]
  expect(draft).not.toContain('/innovation/')
  expect(draft).toContain(`Two [src: ${a}]`)
  expect(draft).toContain('[src: https://e.com/9]')
})
