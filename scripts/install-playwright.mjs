import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const cli = fileURLToPath(new URL('../node_modules/playwright/cli.js', import.meta.url))

async function run(args) {
  const child = spawn(process.execPath, [cli, ...args], { stdio: 'inherit' })
  await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Playwright ${args[0]} exited with ${code}`)))
  })
}

async function verifyRuntime() {
  const browser = await chromium.launch()
  await browser.close()
}

// GitHub's runner already supplies browser runtime libraries. Do not run apt
// and download every optional font on each job when Chromium can start as-is.
await run(['install', '--only-shell', 'chromium'])
try {
  await verifyRuntime()
} catch (error) {
  if (process.platform !== 'linux' || !/Host system is missing dependencies|error while loading shared libraries|cannot open shared object file/i.test(String(error))) throw error
  console.log('Installing missing Chromium system dependencies.')
  await run(['install-deps', 'chromium'])
  await verifyRuntime()
}
console.log('Playwright headless Chromium runtime verified.')
