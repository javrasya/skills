// crew's pi extension, loaded into a worker's session only (`pi -e`, crew-host
// launchWords), never installed: it tells the crew daemon when an extension's
// dialog waits on the person, and when it no longer does (waiting.mjs). It
// changes nothing pi does or shows.
import { piWaiting } from '../waiting.mjs'
import { tell } from './tell.mjs'

export default function crewPi(pi) {
  // In order: an end sent before its start would leave the session waiting.
  let told = Promise.resolve()
  const relay = (event) => {
    told = told.then(() => tell(piWaiting(event)))
  }
  pi.on('ui_prompt_start', relay)
  pi.on('ui_prompt_end', relay)
}
