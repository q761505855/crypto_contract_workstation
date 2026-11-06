import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { verifyPagesArtifact } from './verify-pages-artifact.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const vite = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))
const env = { ...process.env, E2E_CHART_PROBE: '1', VITE_BASE_PATH: '/crypto_contract_workstation/', VITE_GITHUB_TOKEN: 'e2e-mock-storage-token' }

async function runVite(args) {
  const child = spawn(process.execPath, [vite, ...args], { cwd: root, env, stdio: 'inherit' })
  let stopping = false
  const stop = signal => { stopping = true; child.kill(signal) }
  const interrupt = () => stop('SIGINT')
  const terminate = () => stop('SIGTERM')
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => {
        if (stopping) process.exit(0)
        if (code === 0) resolve()
        else reject(new Error(`Vite ${args[0]} exited with code ${code}`))
      })
    })
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
  }
}

// Build a credential-isolated test artifact without requiring workflow changes.
// The existing deployment workflow rebuilds the production artifact after tests.
await runVite(['build'])
await verifyPagesArtifact(fileURLToPath(new URL('../dist/', import.meta.url)), { allowTestProbe: true })
await runVite(['preview', '--host', '127.0.0.1', '--port', '4174', '--base', env.VITE_BASE_PATH, '--strictPort'])
