const axios = require('axios')
const config = require('config')
const helper = require('./src/common/helper')
const logger = require('./src/common/logger')
const uuid = require('uuid')
const { random } = require('lodash')

// Group API server to test, default: http://localhost:3000
const GROUPS_API_URL = process.env.GROUPS_API_URL || 'http://localhost:3000'
// Members API server to fetch members from, default: https://api.topcoder-dev.com/v5/members
const MEMBERS_API_URL = process.env.MEMBERS_API_URL || 'https://api.topcoder-dev.com/v5/members'
// Perf test configurations
// Initial number of members to add to the test group, default: 50000
const INITIAL_MEMBER_SIZE = parseInt(process.env.INITIAL_MEMBER_SIZE || '50000')

function sleep (ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Get members from members API
 * @param page - page number
 * @param accessToken - access token
 * @returns {Promise<void>}
 */
async function getMembers (page, pageSize, accessToken) {
  const resp = await axios.get(MEMBERS_API_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    params: {
      page,
      perPage: pageSize,
      fields: 'userId'
    }
  })
  return resp.data
}

/**
 * Get n members from members API.
 * @param n - number of members
 * @param accessToken - access token
 * @returns {Promise<void>}
 */
async function getNMembers (n, accessToken) {
  logger.info(`Reading ${n} members from Members API...`)
  const maxPageSize = 100
  const members = []
  let page = 1
  while (members.length < n) {
    logger.info(`Reading page ${page}... members ${members.length}/${n}`)
    const diff = n - members.length
    if (diff <= maxPageSize) {
      members.push(...await getMembers(page, diff, accessToken))
    } else {
      members.push(...await getMembers(page, maxPageSize, accessToken))
      page++
    }
    await sleep(100)
  }
  return members
}

/**
 * Run Health check against Groups API server
 * @param accessToken - access token
 * @returns {Promise<void>}
 */
async function groupApiHealthCheck (accessToken) {
  const resp = await axios.get(`${GROUPS_API_URL}/health`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  })
  if (resp.status !== 200) {
    throw new Error(`Health check failed ${resp}`)
  }
}

/**
 * Create test group with random group name, returns group id.
 * @param accessToken - access token
 * @returns {Promise<String>} group id
 */
async function createTestGroup (accessToken) {
  const resp = await axios.post(`${GROUPS_API_URL}/groups`, {
    name: `TestGroup-${uuid.v4()}`,
    description: 'Test group for perf test',
    privateGroup: false,
    selfRegister: false
  }, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  })
  if (resp.status !== 200) {
    throw new Error(`Failed to create test group: ${resp.data}`)
  }
  await patchTestGroup(resp.data.id, accessToken)
  return resp.data.id
}

/**
 * Update group oldId to random uuid. This step is needed to pass the validation during add member operation.
 * @param groupId - id of the group to set the oldId
 * @param accessToken - access token
 * @returns {Promise<void>}
 */
async function patchTestGroup (groupId, accessToken) {
  const resp = await axios.patch(`${GROUPS_API_URL}/groups/${groupId}`, {
    oldId: uuid.v4()
  }, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  })
  if (resp.status !== 200) {
    throw new Error(`Failed to patch test group ${groupId}: ${resp.data}`)
  }
}

/**
 * Delete test group identified by the given id.
 * @param groupId - id of the group to delete
 * @param accessToken - access token
 * @returns {Promise<any>} - deleted group data
 */
async function deleteTestGroup (groupId, accessToken) {
  const resp = await axios.delete(`${GROUPS_API_URL}/groups/${groupId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  })
  if (resp.status !== 200) {
    throw new Error(`Failed to delete test group ${groupId}: ${resp.data}`)
  }
  return resp.data
}

/**
 * Bulk add members.
 * @param groupId - id of the group
 * @param members - array of members: {"memberId": "string", "membershipType": "user|group"}
 * @param accessToken - access token
 * @returns {Promise<void>}
 */
async function addMembers (groupId, members, accessToken) {
  const chunkSize = 100
  const result = []
  for (let i = 0; i < members.length; i += chunkSize) {
    const chunk = members.slice(i, i + chunkSize)
    const st = new Date().getTime()
    const resp = await axios.post(`${GROUPS_API_URL}/groups/${groupId}/members`, {
      members: chunk
    }, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    })
    if (resp.status !== 200) {
      throw new Error(`Failed to add bulk member to group ${groupId}: ${resp.data}`)
    }
    const et = new Date().getTime()
    if (et - st > 30000) {
      throw new Error(`API call exceeds 30 seconds limit: ${et - st} ms`)
    }
    if (resp.data.members.some(member => member.status === 'failed')) {
      throw new Error(`Failed to add some members: ${resp.data.members.filter(member => member.status === 'failed')}`)
    }
    logger.info(`Added member chunk ${i} to ${i + chunkSize} in ${et - st} ms`)
    result.push(...resp.data.members)
  }

  return result
}

async function main () {
  if (!config.AUTH0_CLIENT_ID) {
    throw new Error('Missing required config: AUTH0_CLIENT_ID')
  }
  if (!config.AUTH0_CLIENT_SECRET) {
    throw new Error('Missing required config: AUTH0_CLIENT_SECRET')
  }
  logger.info(`Groups API URL: ${GROUPS_API_URL}`)
  const accessToken = await helper.getM2Mtoken()

  const members = []
  for (let i = 0; i < INITIAL_MEMBER_SIZE; ++i) {
    members.push({
      userId: `${random(9999999, 99999999, false)}`
    })
  }

  await groupApiHealthCheck(accessToken)
  const groupId = await createTestGroup(accessToken)
  try {
    logger.info(`Test group created: ${groupId}, adding members`)
    const st = new Date().getTime()
    const resp = await addMembers(groupId, members.map(member => {
      return {
        memberId: member.userId,
        membershipType: 'user'
      }
    }), accessToken)
    const et = new Date().getTime()
    logger.info(resp)
    logger.info(`Time: ${et - st}`)
  } finally {
    logger.info('Cleaning up.')
    await deleteTestGroup(groupId, accessToken)
  }
}

main()
  .then((data) => {
    logger.info('Perf test finished.')
  })
  .catch((error) => {
    logger.error(error)
  })
