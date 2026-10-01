import { expect, test, type Page } from '@playwright/test'

/**
 * The core user journeys, against the fake OpenRouter: the model's replies are scripted
 * (see backend/tests/fake_llm.py), but every request goes through the real UI, proxy,
 * AgentOS, Studio, scheduler, and database.
 */

const suffix = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
const idOf = (name: string) => name.toLowerCase().replace(/\s+/g, '-')

async function sendMessage(page: Page, text: string) {
  await page.getByLabel('Message').fill(text)
  await page.getByLabel('Message').press('Enter')
}

const lastReply = (page: Page) => page.locator('.message.assistant').last()

/** Build something through the Create dialog and wait for the Builder to publish it. */
async function create(page: Page, kind: 'Agent' | 'Team' | 'Workflow', name: string, picks: string[]) {
  await page.getByRole('button', { name: '+ Create' }).click()
  const dialog = page.getByRole('dialog', { name: 'Create' })
  await dialog.getByRole('tab', { name: kind }).click()
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByLabel('What should it do?').fill(`E2E ${kind.toLowerCase()}.`)
  for (const pick of picks) await dialog.getByLabel(pick, { exact: true }).check()
  await dialog.getByRole('button', { name: `Build ${kind.toLowerCase()}` }).click()
  await expect(page.getByRole('heading', { name: 'Platform Builder' })).toBeVisible()
  await expect(lastReply(page)).toContainText('published')
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
}

test('build an agent from the UI, chat with it, then archive it with approval', async ({ page, request }) => {
  const name = `E2E Scout ${suffix()}`
  const id = idOf(name)

  await page.goto('/')
  await expect(page.getByTestId('backend-status')).toContainText('online')
  const admin = page.getByRole('navigation', { name: 'Admin agents' })
  for (const agent of ['Platform Builder', 'Platform Manager', 'Platform Engineer']) {
    await expect(admin.getByText(agent, { exact: true })).toBeVisible()
  }

  await create(page, 'Agent', name, ['calculator'])
  await expect(lastReply(page).locator('.tool-done', { hasText: 'create_agent' })).toBeVisible()

  // Studio records the signed-in UI user as the owner (the proxy sets user_id server-side).
  type Listed = { id: string; metadata?: { studio?: { created_by?: string } } }
  const listed = (await (await request.get('/api/os/agents')).json()) as Listed[]
  expect(listed.find((agent) => agent.id === id)?.metadata?.studio?.created_by).toBe(
    process.env.UI_USERNAME || 'admin',
  )

  const agents = page.getByRole('navigation', { name: 'Agents', exact: true })
  await agents.getByText(name, { exact: true }).click()
  await expect(page.getByRole('heading', { name })).toBeVisible()
  await sendMessage(page, 'hello there')
  await expect(lastReply(page)).toContainText('Echo: hello there')
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()

  // Archiving is confirmation-gated: the run pauses until the user approves.
  await admin.getByText('Platform Builder', { exact: true }).click()
  await sendMessage(page, `ARCHIVE: ${id}`)
  await expect(page.getByText('This action needs your approval')).toBeVisible()
  await page.getByRole('button', { name: 'Approve' }).click()
  await expect(lastReply(page).locator('.tool-done', { hasText: 'archive_component' })).toBeVisible()
  await expect(agents.getByText(name, { exact: true })).toHaveCount(0)
})

test('teams delegate to members and workflows run their steps', async ({ page }) => {
  const tag = suffix()
  const writer = `Writer ${tag}`
  const critic = `Critic ${tag}`
  const team = `Desk ${tag}`
  const flow = `Pipeline ${tag}`

  await page.goto('/')
  await create(page, 'Agent', writer, [])
  await create(page, 'Agent', critic, [])
  await create(page, 'Team', team, [writer, critic])
  await create(page, 'Workflow', flow, [writer, critic])

  // The team leader delegates; the member's work shows as activity, the reply is the team's.
  await page.getByRole('navigation', { name: 'Teams' }).getByText(team, { exact: true }).click()
  await sendMessage(page, `ASK ${idOf(writer)}: draft a haiku`)
  await expect(lastReply(page).locator('.activity-member.tool-done', { hasText: writer })).toBeVisible()
  await expect(lastReply(page)).toContainText('Echo: draft a haiku')
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()

  // The workflow runs one step per agent, in order.
  await page.getByRole('navigation', { name: 'Workflows' }).getByText(flow, { exact: true }).click()
  await sendMessage(page, 'topic: tides')
  await expect(lastReply(page).locator('.activity-step.tool-done')).toHaveCount(2)
  await expect(lastReply(page)).toContainText('tides')
})

test('channels live on the server and survive a reload', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Admin agents' }).getByText('Platform Manager', { exact: true }).click()
  await page.getByRole('button', { name: 'New chat' }).click()
  const first = `first channel ${suffix()}`
  await sendMessage(page, first)
  await expect(lastReply(page)).toContainText(`Echo: ${first}`)
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
  // Session timestamps have one-second resolution: keep "most recent" unambiguous.
  await page.waitForTimeout(1100)
  await page.getByRole('button', { name: 'New chat' }).click()
  const second = `second channel ${suffix()}`
  await sendMessage(page, second)
  await expect(lastReply(page)).toContainText(`Echo: ${second}`)
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()

  await page.reload()
  await page.getByRole('navigation', { name: 'Admin agents' }).getByText('Platform Manager', { exact: true }).click()
  // The newest channel opens by default, with its history from the server.
  await expect(lastReply(page)).toContainText(`Echo: ${second}`)
  await page.getByLabel('Channel').selectOption({ label: first })
  await expect(lastReply(page)).toContainText(`Echo: ${first}`)
  await expect(page.locator('.message.user')).toHaveCount(1)
})

test('routines created by the Builder can be listed, run, and turned off', async ({ page }) => {
  const name = `Digest ${suffix()}`
  await page.goto('/')
  await create(page, 'Agent', name, [])
  await sendMessage(page, `SCHEDULE: agent ${idOf(name)} | 0 9 * * *`)
  await expect(lastReply(page).locator('.tool-done', { hasText: 'create_schedule' })).toBeVisible()

  await page.getByRole('button', { name: 'Routines' }).click()
  const dialog = page.getByRole('dialog', { name: 'Routines' })
  const row = dialog.getByRole('row', { name: new RegExp(idOf(name)) })
  await expect(row).toContainText('0 9 * * *')
  await row.getByRole('button', { name: 'Turn off' }).click()
  await expect(row.getByRole('button', { name: 'Turn on' })).toBeVisible()
})

test('a bot gets its own computer: shell, browser, live screen, and an audit trail', async ({ page }) => {
  const name = `Operator ${suffix()}`
  await page.goto('/')
  await create(page, 'Agent', name, ['computer'])
  await page.getByRole('navigation', { name: 'Agents', exact: true }).getByText(name, { exact: true }).click()
  const panel = page.getByRole('complementary', { name: 'Computer' })
  await expect(panel).toBeVisible()

  // The shell runs in this bot's own workspace, as an unprivileged user.
  await sendMessage(page, 'SHELL: echo hello-from-computer > note.txt && cat note.txt && pwd')
  const shell = lastReply(page).locator('.tool-done', { hasText: 'run_shell' })
  await expect(shell).toBeVisible()
  await expect(shell.locator('summary')).toContainText('exit 0')
  await shell.locator('summary').click()
  await expect(shell).toContainText('hello-from-computer')
  await expect(shell).toContainText(`/${idOf(name)}\n`)
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()

  // The browser renders where the live screen can see it.
  await sendMessage(page, 'BROWSE: data:text/html,<title>Screen test</title><h1>On screen</h1>')
  // Rendered as a page card: its title is the headline.
  await expect(lastReply(page).locator('.tool-done', { hasText: 'browse' }).locator('summary')).toContainText('Screen test')
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
  const screen = panel.getByRole('img')
  await expect(screen).toBeVisible()
  await expect.poll(() => screen.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)

  // The gateway refuses the deployment's own network before anything runs, and says why.
  await sendMessage(page, 'BROWSE: http://localhost:8000/health')
  const refused = lastReply(page).locator('.tool-refused', { hasText: 'browse' })
  await expect(refused).toContainText('The computer policy refused this action (private network address)')
  const activity = page.getByTestId('computer-activity')
  await expect(activity.locator('.audit-denied').first()).toContainText('private network address')
  await expect(activity.locator('.audit-allowed', { hasText: 'run_shell' })).toBeVisible()
})

test('a dropped stream reconnects and finishes without losing or repeating output', async ({ page }) => {
  const message = 'SLOW reconnect one two three four five'
  let cut = false
  const resumes: string[] = []
  page.on('request', (request) => {
    if (request.url().endsWith('/resume')) resumes.push(request.url())
  })
  // Simulate a network drop: deliver the first run stream only up to its first token.
  await page.route(/\/api\/os\/agents\/platform-manager\/runs$/, async (route) => {
    if (cut) return route.continue()
    cut = true
    const response = await route.fetch()
    const body = await response.text()
    const frames = body.split('\n\n')
    const firstToken = frames.findIndex((frame) => frame.includes('"event":"RunContent"'))
    await route.fulfill({ response, body: frames.slice(0, firstToken + 1).join('\n\n') + '\n\n' })
  })

  await page.goto('/')
  await page.getByRole('navigation', { name: 'Admin agents' }).getByText('Platform Manager', { exact: true }).click()
  await page.getByRole('button', { name: 'New chat' }).click()
  await sendMessage(page, message)

  await expect(lastReply(page)).toHaveText(`Echo: ${message}`)
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
  expect(resumes).toHaveLength(1)
})

test('Stop cancels the run on the server', async ({ page }) => {
  const words = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ')
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Admin agents' }).getByText('Platform Engineer', { exact: true }).click()
  await page.getByRole('button', { name: 'New chat' }).click()
  await sendMessage(page, `SLOW ${words}`)

  const reply = lastReply(page)
  await expect(reply).toContainText('w2')
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(reply).toContainText('Stopped.')
  await expect(reply).not.toContainText('w29')
})

test('the proxy refuses endpoints the UI does not use', async ({ request }) => {
  expect((await request.get('/api/os/agents')).status()).toBe(200)
  expect((await request.get('/api/os/components')).status()).toBe(404)
  expect((await request.post('/api/os/schedules', { multipart: {} })).status()).toBe(404)
  expect((await request.delete('/api/os/agents')).status()).toBe(405)
})
