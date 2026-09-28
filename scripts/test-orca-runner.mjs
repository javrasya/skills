// The runner's offline suite lives in the crew package (packages/crew/test);
// this keeps the old entry point, and runs the whole suite as the package's
// own `npm test` does, never a part of it.
//   node scripts/test-orca-runner.mjs
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const crew = fileURLToPath(new URL('../packages/crew', import.meta.url))
const r = spawnSync('npm test', { cwd: crew, stdio: 'inherit', shell: true })
if (r.error) console.error(r.error)
process.exit(r.status ?? 1)
