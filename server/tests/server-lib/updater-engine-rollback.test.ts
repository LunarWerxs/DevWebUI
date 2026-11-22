import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRollback } from '../../src/updater-engine-rollback.mjs'
import { createRunner } from '../../src/updater-engine-run.mjs'

test('rollback preserves a commit made during the build', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rollback-audit-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  try {
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
    writeFileSync(join(cwd, 'a'), 'before'); git('add', '.'); git('commit', '-qm', 'before')
    const before = git('rev-parse', 'HEAD')
    writeFileSync(join(cwd, 'a'), 'updated'); git('add', '.'); git('commit', '-qm', 'update')
    const updated = git('rev-parse', 'HEAD')
    writeFileSync(join(cwd, 'b'), 'new work'); git('add', '.'); git('commit', '-qm', 'new work')
    const later = git('rev-parse', 'HEAD')
    const { runCommand, gitText } = createRunner({ appRoot: cwd })
    const rollback = createRollback({ serviceName: 'test', runCommand, gitText })
    await expect(rollback.rollbackAfterFailedUpdate(new Error('build failed'), { branch: 'main', currentCommit: before, remoteCommit: updated }, [])).rejects.toThrow('NOT rolled back')
    expect(git('rev-parse', 'HEAD')).toBe(later)
    expect(readFileSync(join(cwd, 'b'), 'utf8')).toBe('new work')
  } finally { rmSync(cwd, { recursive: true, force: true }) }
}, 30000)


test('rollback preserves the checkout when HEAD changes at the ref update', async () => {
  for (const change of ['branch', 'commit', 'cas-failure']) {
    const cwd = mkdtempSync(join(tmpdir(), 'rollback-boundary-'))
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
    try {
      git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
      writeFileSync(join(cwd, 'a'), 'before'); git('add', '.'); git('commit', '-qm', 'before')
      const before = git('rev-parse', 'HEAD')
      writeFileSync(join(cwd, 'a'), 'updated'); git('add', '.'); git('commit', '-qm', 'update')
      const updated = git('rev-parse', 'HEAD')
      if (change === 'cas-failure') writeFileSync(join(cwd, 'edit'), 'saved edit')
      const runner = createRunner({ appRoot: cwd })
      const runCommand = async (args: string[], timeout: number, dir?: string) => {
        if (args[1] === 'update-ref' && change === 'cas-failure') {
          writeFileSync(join(cwd, 'new'), 'new commit'); git('add', 'new'); git('commit', '-qm', 'new work')
        }
        const result = await runner.runCommand(args, timeout, dir)
        if (args[1] === 'update-ref' && result.ok) {
          if (change === 'branch') git('switch', '-qc', 'other')
          else { writeFileSync(join(cwd, 'new'), 'new commit'); git('add', '.'); git('commit', '-qm', 'new work') }
        }
        return result
      }
      const rollback = createRollback({ serviceName: 'test', runCommand, gitText: runner.gitText })
      const output: string[] = []
      let message = ''
      try { await rollback.rollbackAfterFailedUpdate(new Error('build failed'), { branch: 'main', currentCommit: before, remoteCommit: updated }, output) }
      catch (err) { message = String(err) }
      expect(message).toContain('rollback incomplete')
      expect(readFileSync(join(cwd, 'a'), 'utf8')).toBe('updated')
      expect(output.some((step) => JSON.stringify(step).includes('read-tree'))).toBe(false)
      if (change === 'branch') expect(git('branch', '--show-current')).toBe('other')
      else expect(readFileSync(join(cwd, 'new'), 'utf8')).toBe('new commit')
      if (change === 'cas-failure') {
        expect(message).toContain('saved to git stash')
        expect(git('stash', 'list')).toContain('test-update-rollback-')
        expect(git('show', 'stash@{0}^3:edit')).toBe('saved edit')
      }
    } finally { rmSync(cwd, { recursive: true, force: true }) }
  }
}, 30000)

