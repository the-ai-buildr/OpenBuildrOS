import { expect, test } from '@playwright/test'

/**
 * The core user journey, against the fake OpenRouter: the model's replies are scripted
 * (see backend/tests/fake_llm.py), but every request goes through the real UI, proxy,
 * AgentOS, Studio, and database.
 */
test('build an agent from the UI, chat with it, then archive it with approval', async ({ page, request }) => {
  const name = `E2E Scout ${Date.now().toString(36)}`
  const id = name.toLowerCase().replace(/\s+/g, '-')

  await page.goto('/')
  await expect(page.getByTestId('backend-status')).toContainText('online')
  const admin = page.getByRole('navigation', { name: 'Admin agents' })
  for (const agent of ['Platform Builder', 'Platform Manager', 'Platform Engineer']) {
    await expect(admin.getByText(agent, { exact: true })).toBeVisible()
  }

  // Create through the form; the Builder publishes it via Studio.
  await page.getByRole('button', { name: '+ Create agent' }).click()
  const dialog = page.getByRole('dialog', { name: 'Create an agent' })
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByLabel('What should it do?').fill('Scouts the news.')
  await dialog.getByLabel('calculator').check()
  await dialog.getByRole('button', { name: 'Build agent' }).click()

  await expect(page.getByRole('heading', { name: 'Platform Builder' })).toBeVisible()
  await expect(page.locator('.tool-done', { hasText: 'create_agent' })).toBeVisible()
  await expect(page.locator('.message.assistant').last()).toContainText('published')

  // Studio records the signed-in UI user as the owner (the proxy sets user_id server-side).
  const listed = (await (await request.get('/api/os/agents')).json()) as { id: string; metadata?: { studio?: { created_by?: string } } }[]
  const built = listed.find((agent) => agent.id === id)
  expect(built?.metadata?.studio?.created_by).toBe(process.env.UI_USERNAME || 'admin')

  // The new agent shows up under "Your agents" and answers.
  const mine = page.getByRole('navigation', { name: 'Your agents' })
  await mine.getByText(name, { exact: true }).click()
  await expect(page.getByRole('heading', { name })).toBeVisible()
  await page.getByLabel('Message').fill('hello there')
  await page.getByLabel('Message').press('Enter')
  await expect(page.locator('.message.assistant').last()).toContainText('Echo: hello there')
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()

  // Archiving is confirmation-gated: the run pauses until the user approves.
  await admin.getByText('Platform Builder', { exact: true }).click()
  await page.getByLabel('Message').fill(`ARCHIVE: ${id}`)
  await page.getByLabel('Message').press('Enter')
  await expect(page.getByText('This action needs your approval')).toBeVisible()
  await page.getByRole('button', { name: 'Approve' }).click()
  await expect(page.locator('.tool-done', { hasText: 'archive_component' })).toBeVisible()
  await expect(mine.getByText(name, { exact: true })).toHaveCount(0)
})

test('the proxy refuses endpoints the UI does not use', async ({ request }) => {
  expect((await request.get('/api/os/agents')).status()).toBe(200)
  expect((await request.get('/api/os/sessions')).status()).toBe(404)
  expect((await request.delete('/api/os/agents')).status()).toBe(405)
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
  await page.getByLabel('Message').fill(message)
  await page.getByLabel('Message').press('Enter')

  const reply = page.locator('.message.assistant').last()
  await expect(reply).toHaveText(`Echo: ${message}`)
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
  expect(resumes).toHaveLength(1)
})

test('Stop cancels the run on the server', async ({ page }) => {
  const words = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ')
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Admin agents' }).getByText('Platform Engineer', { exact: true }).click()
  await page.getByRole('button', { name: 'New chat' }).click()
  await page.getByLabel('Message').fill(`SLOW ${words}`)
  await page.getByLabel('Message').press('Enter')

  const reply = page.locator('.message.assistant').last()
  await expect(reply).toContainText('w2')
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(reply).toContainText('Stopped.')
  await expect(reply).not.toContainText('w29')
})
