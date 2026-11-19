import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectDirectory = fileURLToPath(new URL('../', import.meta.url))
const projectRepository = 'q761505855/crypto_contract_workstation'
const workflow = 'deploy-pages.yml'
const pagesUrl = 'https://q761505855.github.io/crypto_contract_workstation/'

function run(program, args, failure) {
  const result = spawnSync(program, args, {
    cwd: projectDirectory,
    encoding: 'utf8',
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
  })
  if (result.error?.code === 'ENOENT' && program === 'gh') {
    throw new Error('请先安装 GitHub CLI 并运行 gh auth login。')
  }
  if (result.status !== 0) throw new Error(failure)
  return result.stdout.trim()
}

export async function publishPages({
  command = run,
  request = fetch,
  pause = delay,
  log = console.log,
} = {}) {
  const git = (args, failure = '无法读取当前 Git 工作区。') => command('git', args, failure)
  const gh = (args, failure) => command('gh', [...args, '--repo', `github.com/${projectRepository}`], failure)
  if (git(['branch', '--show-current']) !== 'main') throw new Error('请在 main 分支发布。')
  if (git(['status', '--porcelain'])) throw new Error('请先提交要发布的修改。')
  const origin = git(['remote', 'get-url', '--push', '--all', 'origin'])
  const repoPath = origin.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^\s]+)$/i)?.[1].replace(/\.git$/i, '')
  if (repoPath?.toLowerCase() !== projectRepository) throw new Error('origin 的推送地址必须指向本项目的 GitHub 仓库。')

  const commit = git(['rev-parse', 'HEAD'])
  const remoteMain = git(['ls-remote', 'origin', 'refs/heads/main'], '无法读取 GitHub 远端 main 分支。').split('\t')[0]
  if (remoteMain) git(['merge-base', '--is-ancestor', remoteMain, commit], '请先拉取并合并 GitHub 远端 main 分支。')
  const runList = () => JSON.parse(gh(
    ['run', 'list', '--workflow', workflow, '--branch', 'main', '--commit', commit, '--json', 'databaseId,event,status,conclusion,url'],
    '无法读取 Pages 部署记录。请检查 GitHub CLI 登录和 Actions 权限。',
  ))
  const previousRunIds = new Set(runList().map(run => run.databaseId))

  const push = git(['push', '--porcelain', 'origin', `${commit}:refs/heads/main`], 'Git 推送失败。请检查登录状态，以及远端 main 是否有待合并的提交。')
  const upToDate = push.split(/\r?\n/).some(line => line.startsWith('=\t'))
  const event = upToDate ? 'workflow_dispatch' : 'push'
  if (upToDate) {
    gh(['workflow', 'run', workflow, '--ref', 'main'], '无法触发 Pages 重新部署。请检查 GitHub CLI 的 Actions 写入权限。')
  }
  log(`正在等待 ${commit.slice(0, 7)} 部署到 GitHub Pages…`)
  let deployed = false
  for (let attempt = 0; attempt < 120; attempt++) {
    const current = runList().find(run => run.event === event && !previousRunIds.has(run.databaseId))
    if (current?.status === 'completed') {
      if (current.conclusion !== 'success') {
        throw new Error(`Pages 部署结果为 ${current.conclusion}。部署记录 ${current.url}`)
      }
      deployed = true
      break
    }
    if (attempt < 119) await pause(5_000)
  }
  if (!deployed) throw new Error('10 分钟内未确认 Pages 部署结果，请查看仓库的 Actions。')

  for (let attempt = 0; attempt < 12; attempt++) {
    const url = new URL('cloud-connection.json', pagesUrl)
    url.searchParams.set('release', `${commit}-${attempt}-${Date.now()}`)
    try {
      const response = await request(url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5_000) })
      if (response.ok) {
        const connection = await response.json()
        const token = typeof connection?.token === 'string' ? connection.token.trim() : ''
        if (connection?.schemaVersion === 1 && connection.project === 'crypto-contract-workstation' && token.length <= 4096 && /^\S+$/.test(token)) {
          const auth = await request('https://api.github.com/user', {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
            redirect: 'error',
            signal: AbortSignal.timeout(5_000),
          })
          if (auth.ok) {
            log(`发布成功，线上云同步 Token 已通过 GitHub 认证。 ${pagesUrl}`)
            return
          }
        }
      }
    } catch {
      // The Pages CDN can briefly serve the previous build or fail during rollout.
    }
    if (attempt < 11) await pause(5_000)
  }
  throw new Error('Pages 已部署，但线上云同步连接未通过验证。请检查部署产物和 Actions 的 CLOUD_STORAGE_TOKEN。')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  publishPages().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
