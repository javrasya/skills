// crew's pi extension, loaded into a worker's session only (`pi -e`, crew-host
// launchWords), never installed: it tells the crew daemon when pi takes a
// prompt, and when an extension's dialog waits on the person, and when it no
// longer does (waiting.mjs). It changes nothing pi does or shows.
import { piWaiting } from '../waiting.mjs'
import { tell } from './tell.mjs'

export default function crewPi(pi) {
  // In order: an end sent before its start would leave the session waiting.
  // Each handler awaits its own request, so a daemon gone or refusing is
  // pi's to report, as an extension error. The next request waits for the
  // last to settle, not to succeed: one that failed was reported by its own
  // handler, and must not stop those after it.
  let told = Promise.resolve()
  const relay = async (op, said) => {
    const turn = Promise.allSettled([told]).then(() => tell(op, said))
    told = turn
    await turn
  }
  // pi wires its editor's submit before it emits session_start, so a prompt
  // typed from here on is taken; one typed earlier sits in the editor with
  // "Startup is still in progress". Its terminal says nothing of this: an
  // extension's status line may keep it drawing for good.
  pi.on('session_start', () => relay('session.ready', {}))
  pi.on('ui_prompt_start', (event) => relay('session.waiting', piWaiting(event)))
  pi.on('ui_prompt_end', (event) => relay('session.waiting', piWaiting(event)))
}
