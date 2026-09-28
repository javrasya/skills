// What a validation list may hold (#102). The rendered workflow.js keeps the
// list in a String.raw template literal (workflow.template.js, VALIDATION_RAW):
// a backtick ends that literal, `${` starts an interpolation in it, and a
// backslash ending the list escapes its closing backtick, so a list with any of
// them renders a workflow.js that dies on load. A backslash ending any line is
// refused, not just the last's: lines get reordered, and a command ending in
// one is a shell line continuation, not a command. Refused, never escaped:
// escaping would change the command the run's agents are told to run.
export function validationLineProblem(line) {
  if (line.includes('`')) return 'holds a backtick'
  if (line.includes('${')) return 'holds ${, which starts an interpolation (resolve a ${{ }} expression to a concrete command)'
  if (/\\\s*$/.test(line)) return 'ends in a backslash'
  return null
}

// The first line of `text` the rendered workflow.js cannot hold, as a reason
// naming it; null when every line can be held.
export function validationListProblem(text) {
  const lines = String(text).replace(/\r/g, '').split('\n')
  for (const [i, line] of lines.entries()) {
    const why = validationLineProblem(line)
    if (why) return `line ${i + 1} ${why}: ${JSON.stringify(line.trim())}`
  }
  return null
}
