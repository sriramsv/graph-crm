const { startRegistration, startAuthentication } = SimpleWebAuthnBrowser

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `request failed: ${res.status}`)
  return body
}

function showError(message) {
  document.getElementById('login-error').textContent = message
}

async function init() {
  let status
  try {
    status = await api('/api/auth/status')
  } catch (err) {
    showError('Could not reach the server. Is it running?')
    return
  }

  if (status.authenticated) {
    window.location.href = '/'
    return
  }

  if (status.hasCredential) {
    document.getElementById('login-mode').classList.remove('hidden')
  } else {
    document.getElementById('register-mode').classList.remove('hidden')
  }
}

document.getElementById('login-btn').addEventListener('click', async () => {
  showError('')
  try {
    const options = await api('/api/auth/login/options', { method: 'POST' })
    const response = await startAuthentication({ optionsJSON: options })
    await api('/api/auth/login/verify', { method: 'POST', body: JSON.stringify({ response }) })
    window.location.href = '/'
  } catch (err) {
    showError(err.message)
  }
})

document.getElementById('register-btn').addEventListener('click', async () => {
  showError('')
  const name = document.getElementById('register-name').value.trim()
  if (!name) {
    showError('Enter your name first.')
    return
  }
  try {
    const options = await api('/api/auth/register/options', { method: 'POST' })
    const response = await startRegistration({ optionsJSON: options })
    await api('/api/auth/register/verify', { method: 'POST', body: JSON.stringify({ response, name }) })
    window.location.href = '/'
  } catch (err) {
    showError(err.message)
  }
})

init()
