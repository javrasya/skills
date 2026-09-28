// The runner's offline suite lives in the crew package (packages/crew/test);
// this keeps the old entry point.
//   node scripts/test-orca-runner.mjs
import '../packages/crew/test/test-orca-runner.mjs'
import '../packages/crew/test/test-crew-bin.mjs'
import '../packages/crew/test/test-crew-run.mjs'
