/**
 * This file defines helper methods
 */

const _ = require('lodash')
const busApi = require('tc-bus-api-wrapper')
const config = require('config')
const neo4j = require('neo4j-driver')
const querystring = require('querystring')
const m2mAuth = require('tc-core-library-js').auth
const m2m = m2mAuth.m2m(_.pick(config, ['AUTH0_URL', 'AUTH0_AUDIENCE', 'TOKEN_CACHE_TIME', 'AUTH0_PROXY_SERVER_URL']))
const redis = require('redis')
const uuid = require('uuid')
const validate = require('uuid-validate')

const errors = require('./errors')
const logger = require('./logger')
const constants = require('../../app-constants')


let busApiClient        // Bus API Client
let redisClient = null  // redis client

const driver = neo4j.driver(config.GRAPH_DB_URI, neo4j.auth.basic(config.GRAPH_DB_USER, config.GRAPH_DB_PASSWORD), {
  maxConnectionLifetime: 3 * 60 * 60 * 1000,
  maxConnectionPoolSize: 100,
  connectionAcquisitionTimeout: 240000
})

/**
 * Wrap async function to standard express function
 * @param {Function} fn the async function
 * @returns {Function} the wrapped function
 */
function wrapExpress(fn) {
  return function (req, res, next) {
    fn(req, res, next).catch(next)
  }
}

/**
 * Wrap all functions from object
 * @param obj the object (controller exports)
 * @returns {Object|Array} the wrapped object
 */
function autoWrapExpress(obj) {
  if (_.isArray(obj)) {
    return obj.map(autoWrapExpress)
  }
  if (_.isFunction(obj)) {
    if (obj.constructor.name === 'AsyncFunction') {
      return wrapExpress(obj)
    }
    return obj
  }
  _.each(obj, (value, key) => {
    obj[key] = autoWrapExpress(value)
  })
  return obj
}

/**
 * Create DB session.
 * @returns {Object} new db session
 */
function createDBSession() {
  return driver.session()
}

/**
 * Close driver connection once the app exit
 */
async function closeDB() {
  await driver.close()
}

/**
 * Ensure entity exists. Throw error if not exist.
 * @param {Object} session the db session
 * @param {String} model the model name
 * @param {String} id the entity id
 * @returns {Object} the found entity
 */
async function ensureExists(tx, model, id, isAdmin = false) {
  let res
  if (model === 'Group') {
    if (validate(id, 4)) {
      if (!isAdmin) {
        res = await tx.run(`MATCH (e:${model} {id: {id}, status: '${constants.GroupStatus.Active}'}) RETURN e`, { id })
      } else {
        res = await tx.run(`MATCH (e:${model} {id: {id}}) RETURN e`, { id })
      }
    } else {
      if (!isAdmin) {
        res = await tx.run(`MATCH (e:${model} {oldId: {id}, status: '${constants.GroupStatus.Active}'}) RETURN e`, {
          id
        })
      } else {
        res = await tx.run(`MATCH (e:${model} {oldId: {id}}) RETURN e`, { id })
      }
    }

    if (res && res.records.length === 0) {
      throw new errors.NotFoundError(`Not found ${model} of id ${id}`)
    }
  } else if (model === 'User') {
    if (validate(id, 4)) {
      res = await tx.run(`MATCH (e:${model} {universalUID: {id}}) RETURN e`, { id })

      if (res && res.records.length === 0) {
        res = await tx.run('CREATE (user:User {id: \'00000000\', universalUID: {id}}) RETURN user', { id })
      }
    } else {
      res = await tx.run(`MATCH (e:${model} {id: {id}}) RETURN e`, { id })

      if (res && res.records.length === 0) {
        res = await tx.run('CREATE (user:User {id: {id}, universalUID: \'00000000\'}) RETURN user', { id })
      }
    }
  }

  return res.records[0]._fields[0].properties
}

/**
 * Ensure user is member of group.
 * @param {Object} session the db session
 * @param {String} groupId the group id
 * @param {String} userId the user id
 */
async function ensureGroupMember(session, groupId, userId) {
  const memberCheckRes = await session.run(
    'MATCH (g:Group {id: {groupId}})-[r:GroupContains {type: {membershipType}}]->(u:User {id: {userId}}) RETURN r',
    { groupId, membershipType: config.MEMBERSHIP_TYPES.User, userId }
  )
  if (memberCheckRes.records.length === 0) {
    throw new errors.ForbiddenError('User is not member of the group')
  }
}

/**
 * Return whether the user has one of the group roles or not.
 * @param {Object} session the db session
 * @param {String} groupId the group id
 * @param {String} userId the user id
 * @param {Array} roles an array of group roles
 * @returns {Boolean} true if user has one of the group roles
 */
async function hasGroupRole(session, groupId, userId, roles) {
  const memberCheckRes = await session.run(
    'MATCH (g:Group {id: {groupId}})-[r:GroupContains {type: {membershipType}}]->(u:User {id: {userId}}) RETURN r',
    { groupId, membershipType: config.MEMBERSHIP_TYPES.User, userId }
  )
  if (memberCheckRes.records.length === 0) {
    return false
  }
  const existRoles = memberCheckRes.records[0]._fields[0].properties.roles || []
  return _.some(existRoles, r => _.some(roles, role => JSON.parse(r).role === role))
}

/**
 * Get child groups.
 * @param {Object} session the db session
 * @param {String} groupId the group id
 * @returns {Array} the child groups
 */
async function getChildGroups(session, groupId) {
  const res = await session.run(
    'MATCH (g:Group {id: {groupId}})-[r:GroupContains]->(c:Group) RETURN c ORDER BY c.oldId',
    { groupId }
  )
  return _.map(res.records, (record) => record.get(0).properties)
}

/**
 * Get parent groups.
 * @param {String} groupId the group id
 * @returns {Array} the parent groups
 */
async function getParentGroups(groupId) {
  const session = createDBSession()

  const res = await session.run(
    'MATCH (g:Group)-[r:GroupContains]->(c:Group {id: {groupId}}) RETURN g ORDER BY g.oldId',
    { groupId }
  )

  await session.close()
  return _.map(res.records, (record) => record.get(0).properties)
}

/**
 * Get link for a given page.
 * @param {Object} req the HTTP request
 * @param {Number} page the page number
 * @returns {String} link for the page
 */
function getPageLink(req, page) {
  const q = _.assignIn({}, req.query, { page })
  return `${req.protocol}://${req.get('Host')}${req.baseUrl}${req.path}?${querystring.stringify(q)}`
}

/**
 * Set HTTP response headers from result.
 * @param {Object} req the HTTP request
 * @param {Object} res the HTTP response
 * @param {Object} result the operation result
 */
function setResHeaders(req, res, result) {
  const totalPages = Math.ceil(result.total / result.perPage)
  if (result.page > 1) {
    res.set('X-Prev-Page', result.page - 1)
  }

  if (result.page < totalPages) {
    res.set('X-Next-Page', result.page + 1)
  }
  res.set('X-Page', result.page)
  res.set('X-Per-Page', result.perPage)
  res.set('X-Total', result.total)
  res.set('X-Total-Pages', totalPages)
  // set Link header
  if (totalPages > 0) {
    let link = `<${getPageLink(req, 1)}>; rel="first", <${getPageLink(req, totalPages)}>; rel="last"`
    if (result.page > 1) {
      link += `, <${getPageLink(req, result.page - 1)}>; rel="prev"`
    }
    if (result.page < totalPages) {
      link += `, <${getPageLink(req, result.page + 1)}>; rel="next"`
    }
    res.set('Link', link)
  }

  // Allow browsers access pagination data in headers
  let accessControlExposeHeaders = res.get('Access-Control-Expose-Headers') || ''
  accessControlExposeHeaders += accessControlExposeHeaders ? ', ' : ''
  // append new values, to not override values set by someone else
  accessControlExposeHeaders += 'X-Page, X-Per-Page, X-Total, X-Total-Pages, X-Prev-Page, X-Next-Page'

  res.set('Access-Control-Expose-Headers', accessControlExposeHeaders)
}

/**
 * Check if exists.
 *
 * @param {Array} source the array in which to search for the term
 * @param {Array | String} term the term to search
 */
function checkIfExists(source, term) {
  let terms

  if (!_.isArray(source)) {
    throw new Error('Source argument should be an array')
  }

  source = source.map((s) => s.toLowerCase())

  if (_.isString(term)) {
    terms = term.split(' ')
  } else if (_.isArray(term)) {
    terms = term.map((t) => t.toLowerCase())
  } else {
    throw new Error('Term argument should be either a string or an array')
  }

  for (let i = 0; i < terms.length; i++) {
    if (source.includes(terms[i])) {
      return true
    }
  }

  return false
}

/**
 * Check if the user has admin role
 * @param {Object} authUser the user
 */
function hasAdminRole(authUser) {
  for (let i = 0; i < authUser.roles.length; i++) {
    if (authUser.roles[i].toLowerCase() === config.USER_ROLES.Admin.toLowerCase()) {
      return true
    }
  }
  return false
}

/**
 * Get Bus API Client
 * @return {Object} Bus API Client Instance
 */
function getBusApiClient() {
  // if there is no bus API client instance, then create a new instance
  if (!busApiClient) {
    busApiClient = busApi(
      _.pick(config, [
        'AUTH0_URL',
        'AUTH0_AUDIENCE',
        'TOKEN_CACHE_TIME',
        'AUTH0_CLIENT_ID',
        'AUTH0_CLIENT_SECRET',
        'BUSAPI_URL',
        'KAFKA_ERROR_TOPIC',
        'AUTH0_PROXY_SERVER_URL'
      ])
    )
  }

  return busApiClient
}

/**
 * Post bus event.
 * @param {String} topic the event topic
 * @param {Object} payload the event payload
 */
async function postBusEvent(topic, payload) {
  const client = getBusApiClient()
  await client.postEvent({
    topic,
    originator: 'topcoder-groups-api',
    timestamp: new Date().toISOString(),
    'mime-type': 'application/json',
    payload
  })
}

async function createGroup(tx, data, currentUser) {
  // check whether group name is already used
  const nameCheckRes = await tx.run('MATCH (g:Group) WHERE tolower(g.name) = tolower($name) RETURN g LIMIT 1', {
    name: data.name
  })
  if (nameCheckRes.records.length > 0) {
    throw new errors.ConflictError(`The group name ${data.name} is already used`)
  }

  // create group
  const groupData = data

  // generate next group id
  groupData.id = uuid.v4()
  groupData.createdAt = new Date().toISOString()
  groupData.createdBy = currentUser === 'M2M' ? '00000000' : currentUser.userId
  groupData.domain = groupData.domain ? groupData.domain : ''
  groupData.ssoId = groupData.ssoId ? groupData.ssoId : ''
  groupData.organizationId = groupData.organizationId ? groupData.organizationId : ''

  const createRes = await tx.run(
    'CREATE (group:Group {id: {id}, name: {name}, description: {description}, privateGroup: {privateGroup}, selfRegister: {selfRegister}, createdAt: {createdAt}, createdBy: {createdBy}, domain: {domain}, ssoId: {ssoId}, organizationId: {organizationId}, status: {status}}) RETURN group',
    groupData
  )

  return createRes.records[0]._fields[0].properties
}

async function deleteGroup(tx, group) {
  const groupsToDelete = [group]
  let index = 0
  while (index < groupsToDelete.length) {
    const g = groupsToDelete[index]
    index += 1

    const childGroups = await getChildGroups(tx, g.id)
    for (let i = 0; i < childGroups.length; i += 1) {
      const child = childGroups[i]
      if (_.find(groupsToDelete, (gtd) => gtd.id === child.id)) {
        // the child was checked, ignore duplicate processing
        continue
      }
      // delete child if it doesn't belong to other group
      const parents = await getParentGroups(child.id)
      if (parents.length <= 1) {
        groupsToDelete.push(child)
      }
    }
  }

  logger.debug(`Groups to delete ${JSON.stringify(groupsToDelete)}`)

  for (let i = 0; i < groupsToDelete.length; i += 1) {
    const id = groupsToDelete[i].id
    // delete group's relationships
    await tx.run('MATCH (g:Group {id: {groupId}})-[r]-() DELETE r', {
      groupId: id
    })

    // delete group
    await tx.run('MATCH (g:Group {id: {groupId}}) DELETE g', {
      groupId: id
    })
  }
  return groupsToDelete
}

async function acquireRedisClient() {
  if (!redisClient) {
    logger.debug("creating new redis client")
    redisClient = redis.createClient({ url: config.REDIS_URL })

    redisClient.on('connect', () => logger.debug('redis client connected'));
    redisClient.on('error', err => logger.error(new Date(), 'client error', err.message));
    redisClient.on('reconnecting', () => logger.debug('reconnecting'));

    await redisClient.connect()
  }

  return redisClient
}

async function getCacheKey(criteria) {
  let criteriaStr = ''
  Object.keys(criteria).forEach(c => {
    if (c != 'skipCache') criteriaStr = criteriaStr + c + '=' + criteria[c] + ','
  })

  return criteriaStr.replace(/,\s*$/, "").replace(/,/g, '|').replace(/=/g, '-')
}

async function invalidateCache(group) {
  const parentGroups = await getParentGroups(group.id)
  parentGroups.forEach(async g => {
    await deleteKeys(`group:${g.id}:*`)
    await deleteKeys(`group:${g.oldId}:*`)
  })

  await deleteKeys(`group:${group.id}:*`)
  await deleteKeys(`group:${group.oldId}:*`)
}

async function deleteKeys(key) {
  const redisClient = await acquireRedisClient()
  const keys = await redisClient.keys(key)

  keys.forEach(async (key) => {
    await redisClient.del(key)
  })
}

/* Function to get M2M token
 * @returns m2m token
 */
async function getM2Mtoken() {
  return m2m.getMachineToken(config.AUTH0_CLIENT_ID, config.AUTH0_CLIENT_SECRET)
}

module.exports = {
  wrapExpress,
  autoWrapExpress,
  createDBSession,
  closeDB,
  ensureExists,
  ensureGroupMember,
  getChildGroups,
  getParentGroups,
  setResHeaders,
  checkIfExists,
  hasAdminRole,
  hasGroupRole,
  postBusEvent,
  createGroup,
  deleteGroup,
  acquireRedisClient,
  getCacheKey,
  invalidateCache,
  getM2Mtoken
}
