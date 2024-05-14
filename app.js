/**
 * The application entry point
 */

require('./app-bootstrap')

const bodyParser = require('body-parser')
const config = require('config')
const cors = require('cors')
const express = require('express')
const _ = require('lodash')
const HttpStatus = require('http-status-codes')
const morgan = require('morgan')
const swaggerUi = require('swagger-ui-express')
const YAML = require('yamljs')

const helper = require('./src/common/helper')
const logger = require('./src/common/logger')

const swaggerDocument = YAML.load('./docs/swagger.yml')
// setup express app
const app = express()

app.use(cors())
app.use(bodyParser.json({ limit: '50mb' }))
app.use(bodyParser.urlencoded({ extended: true }))
app.set('port', config.PORT)

// Request logger
app.use(morgan('common', { skip: (req, res) => res.statusCode < 400 }))

// Serve Swagger Docs after setting host and base path
swaggerDocument.host = config.HOST
swaggerDocument.basePath = config.API_PREFIX
app.use('/groups/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument))

// Register routes
require('./app-routes')(app)

// The error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.logFullError(err, req.signature || `${req.method} ${req.url}`)
  const errorResponse = {}
  const status = err.isJoi ? HttpStatus.BAD_REQUEST : err.httpStatus || HttpStatus.INTERNAL_SERVER_ERROR

  if (_.isArray(err.details)) {
    if (err.isJoi) {
      _.map(err.details, (e) => {
        if (e.message) {
          if (_.isUndefined(errorResponse.message)) {
            errorResponse.message = e.message
          } else {
            errorResponse.message += `, ${e.message}`
          }
        }
      })
    }
  }
  if (_.isUndefined(errorResponse.message)) {
    if (err.message && status !== HttpStatus.INTERNAL_SERVER_ERROR) {
      errorResponse.message = err.message
    } else {
      errorResponse.message = 'Internal server error'
    }
  }

  res.status(status).json(errorResponse)
})

const server = app.listen(app.get('port'), () => {
  logger.info(`Express server listening on port ${app.get('port')}`)
})

server.on('close', async (error) => {
  await helper.closeDB()
  logger.info('server closed')
  process.exit(error ? 1 : 0)
})
