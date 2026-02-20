const DEFAULT_BASE_URL = 'https://us-central1-hyacinthattendance.cloudfunctions.net'

const HTTP_ENDPOINTS = {
  getUsersByDepartment: '/getUsersByDepartment',
  getUserSchedule: '/getUserSchedule',
  getAttendanceLogs: '/getAttendanceLogs'
}

const CALLABLE_FUNCTIONS = {
  generateApiKey: 'generateApiKey',
  listApiKeys: 'listApiKeys',
  deleteApiKey: 'deleteApiKey',
  changeUserPassword: 'changeUserPassword',
  changeUserEmail: 'changeUserEmail',
  testFunction: 'testFunction',
  testAuth: 'testAuth'
}

const assertRequired = (name, value) => {
  if (value === undefined || value === null || value === '') {
    throw new Error(`${name} is required`)
  }
}

const isApiKeyValid = (apiKey) => typeof apiKey === 'string' && apiKey.startsWith('hk_')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const isRetryableStatus = (status) => status === 429 || status === 500 || status === 502 || status === 503 || status === 504

const getRetryDelayMs = (attempt) => {
  const baseMs = 250
  return baseMs * 2 ** attempt
}

const unwrapCallableResult = (result) => {
  if (result && typeof result === 'object' && 'data' in result) {
    return result.data
  }

  return result
}

export class HyacinthAttendanceAPI {
  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch, callableInvoker = null } = {}) {
    assertRequired('apiKey', apiKey)

    if (!isApiKeyValid(apiKey)) {
      throw new Error('Invalid API key format. Expected a key that starts with hk_.')
    }

    this.apiKey = apiKey
    this.baseUrl = baseUrl
    this.fetchImpl = fetchImpl
    this.callableInvoker = callableInvoker
  }

  async post(endpoint, payload = {}, options = {}) {
    const maxRetries = options.maxRetries ?? 2
    let lastError = null

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey
        },
        body: JSON.stringify({ apiKey: this.apiKey, ...payload })
      })

      const result = await response.json().catch(() => ({ success: false, message: 'Invalid JSON response' }))

      if (response.ok && result.success !== false) {
        return result.data ?? result
      }

      const message = result?.message || `Request failed with status ${response.status}`
      const error = new Error(message)
      error.status = response.status
      error.debug = result?.debug
      lastError = error

      if (attempt < maxRetries && isRetryableStatus(response.status)) {
        await sleep(getRetryDelayMs(attempt))
        continue
      }

      throw error
    }

    throw lastError || new Error('Request failed')
  }

  async getUsersByDepartment(departmentId) {
    assertRequired('departmentId', departmentId)
    return this.post(HTTP_ENDPOINTS.getUsersByDepartment, { departmentId })
  }

  async getUserSchedule(userId) {
    assertRequired('userId', userId)
    return this.post(HTTP_ENDPOINTS.getUserSchedule, { userId })
  }

  async getAttendanceLogs(options = {}) {
    const { userId, startDate, endDate } = options
    return this.post(HTTP_ENDPOINTS.getAttendanceLogs, { userId, startDate, endDate })
  }

  async callFunction(name, payload = undefined) {
    if (!this.callableInvoker) {
      throw new Error('callableInvoker is required to use callable Firebase functions')
    }

    const fnName = CALLABLE_FUNCTIONS[name]
    if (!fnName) {
      throw new Error(`Unsupported callable function: ${name}`)
    }

    const result = await this.callableInvoker(fnName, payload)
    return unwrapCallableResult(result)
  }

  async generateApiKey({ name, permissions, description } = {}) {
    assertRequired('name', name)
    if (!Array.isArray(permissions) || permissions.length === 0) {
      throw new Error('permissions must be a non-empty array')
    }

    return this.callFunction('generateApiKey', { name, permissions, description })
  }

  async listApiKeys() {
    return this.callFunction('listApiKeys')
  }

  async deleteApiKey({ keyId } = {}) {
    assertRequired('keyId', keyId)
    return this.callFunction('deleteApiKey', { keyId })
  }

  async changeUserPassword({ userId, newPassword } = {}) {
    assertRequired('userId', userId)
    assertRequired('newPassword', newPassword)
    return this.callFunction('changeUserPassword', { userId, newPassword })
  }

  async changeUserEmail({ userId, newEmail } = {}) {
    assertRequired('userId', userId)
    assertRequired('newEmail', newEmail)
    return this.callFunction('changeUserEmail', { userId, newEmail })
  }

  async testFunction({ message } = {}) {
    return this.callFunction('testFunction', { message })
  }

  async testAuth() {
    return this.callFunction('testAuth')
  }
}

export const createHyacinthAttendanceApi = (config) => new HyacinthAttendanceAPI(config)
