const express = require('express')
const bodyParser = require('body-parser')
const mqtt = require('mqtt')
const fs = require('fs')
const path = require('path')
const Influx = require('influx')
const ejs = require('ejs')
const moment = require('moment-timezone')
const WebSocket = require('ws')
const retry = require('async-retry')
const axios = require('axios')
const { backOff } = require('exponential-backoff')
const app = express()
const port = process.env.PORT || 6789
const socketPort = 8000
const { http } = require('follow-redirects')
const cors = require('cors')
const session = require('express-session')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const { startOfDay } = require('date-fns')
const { AuthenticateUser } = require('./utils/mongoService')
const mongoose = require('mongoose')

// Mongoose Schema for Settings Changes
const SettingsChangeSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  topic: String,
  old_value: mongoose.Schema.Types.Mixed,
  new_value: mongoose.Schema.Types.Mixed,
  system_state: {
    battery_soc: Number,
    pv_power: Number,
    load: Number,
    grid_voltage: Number,
    grid_power: Number,
    inverter_state: mongoose.Schema.Types.Mixed,
    timestamp: String
  },
  change_type: String
})

// Create MongoDB model
let SettingsChange
let dbConnected = false

// Middleware setup
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: '*' }))
app.use(bodyParser.urlencoded({ extended: true }))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(express.static(path.join(__dirname, 'public')))
app.set('view engine', 'ejs')
app.set('views', path.join(__dirname, 'views'))


let options;
try {
  options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
} catch (error) {
  options = JSON.parse(fs.readFileSync('./options.json', 'utf8'));
}

// Extract configuration values with defaults
const inverterNumber = options.inverter_number || 1
const batteryNumber = options.battery_number || 1
const mqttTopicPrefix = options.mqtt_topic_prefix || 'energy'
const mongoDbUri = options.mongodb_uri || process.env.MONGODB_URI || 'mongodb://localhost:27017/energy_monitor'

// Constants
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json')
const CACHE_DURATION = 24 * 3600000 // 24 hours in milliseconds

// Middleware
app.use(helmet({
  contentSecurityPolicy: false // Disabled for development, enable in production
}))
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }))
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: process.env.NODE_ENV === 'production' }
}))

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
})
app.use('/api/', limiter)

// Ensure data directory and settings file exist
try {
  if (!fs.existsSync(path.dirname(SETTINGS_FILE))) {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true })
  }
  if (!fs.existsSync(SETTINGS_FILE)) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
      apiKey: '',
      selectedZone: '',
      username: ''
    }))
  }
} catch (error) {
  console.error('Error creating settings file:', error.message)
}

// InfluxDB configuration
const influxConfig = {
  host: options.influxdb_host || '172.20.10.4',
  port: options.influxdb_port || 8086,
  database: options.influxdb_database || 'home_assistant',
  username: options.influxdb_username || 'admin',
  password: options.influxdb_password || 'adminpassword',
  protocol: 'http',
  timeout: 10000,
}

// Initialize InfluxDB client with error handling
let influx
try {
  influx = new Influx.InfluxDB(influxConfig)
  console.log('InfluxDB client initialized')
} catch (error) {
  console.error('Error initializing InfluxDB client:', error.message)
  // Create a fallback that logs errors instead of crashing
  influx = {
    writePoints: async () => {
      console.error('InfluxDB not available, data not saved')
      return Promise.resolve() // Just resolve to avoid crashing
    }
  }
}

// MQTT configuration
const mqttConfig = {
  host: options.mqtt_host,
  port: options.mqtt_port,
  username: options.mqtt_username,
  password: options.mqtt_password,
  clientId: `energy_monitor_${Math.random().toString(16).substring(2, 8)}`,
  reconnectPeriod: 5000,
  connectTimeout: 30000
}

// Connect to MQTT broker
let mqttClient
let incomingMessages = []
const MAX_MESSAGES = 400

// Learner mode configuration
let learnerModeActive = false
const settingsToMonitor = [
  'energy_pattern',
  'grid_charge',
  'power',
  'device_mode',
  'voltage',
  'work_mode_timer'
]

// System state tracking
let currentSystemState = {
  battery_soc: null,
  pv_power: null,
  load: null,
  grid_voltage: null,
  grid_power: null,
  inverter_state: null,
  timestamp: null
}

// Track previous state of settings to detect changes
let previousSettings = {}

// Connect to MongoDB
async function connectToDatabase() {
  if (dbConnected) return

  try {
    await mongoose.connect(mongoDbUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000, // Timeout after 5s instead of 30s
      connectTimeoutMS: 10000, // Give up initial connection after 10s
    })
    
    console.log('Connected to MongoDB')
    dbConnected = true
    
    // Initialize model after connection
    SettingsChange = mongoose.model('SettingsChange', SettingsChangeSchema)
    
    // Create indexes for better query performance
    await SettingsChange.collection.createIndex({ change_type: 1 })
    await SettingsChange.collection.createIndex({ timestamp: -1 })
    console.log('Database indexes created')
    
    return true
  } catch (error) {
    console.error('MongoDB connection error:', error.message)
    console.log('Will retry connection in background')
    // We'll continue without DB and retry later
    return false
  }
}

// Function to retry DB connection in background
async function retryDatabaseConnection() {
  try {
    if (!dbConnected) {
      console.log('Retrying database connection...')
      await connectToDatabase()
    }
  } catch (error) {
    console.error('Failed to connect to database on retry:', error.message)
    // Schedule another retry
    setTimeout(retryDatabaseConnection, 30000)
  }
}

// Handle incoming MQTT messages
function handleMqttMessage(topic, message) {
  const formattedMessage = `${topic}: ${message.toString()}`
  
  // Add to the circular buffer of messages
  incomingMessages.push(formattedMessage)
  if (incomingMessages.length > MAX_MESSAGES) {
    incomingMessages.shift()
  }

  // Parse message content
  let messageContent
  try {
    messageContent = message.toString()
    
    // Try to parse as JSON if it looks like JSON
    if (messageContent.startsWith('{') && messageContent.endsWith('}')) {
      messageContent = JSON.parse(messageContent)
    }
  } catch (error) {
    // If not JSON, keep as string
    messageContent = message.toString()
  }

  // Extract the specific topic part after the prefix
  const topicPrefix = options.mqtt_topic_prefix || ''
  let specificTopic = topic
  if (topic.startsWith(topicPrefix)) {
    specificTopic = topic.substring(topicPrefix.length + 1) // +1 for the slash
  }

  // Update system state for key metrics
  if (specificTopic.includes('battery_state_of_charge')) {
    currentSystemState.battery_soc = parseFloat(messageContent)
    currentSystemState.timestamp = moment().format('YYYY-MM-DD HH:mm:ss')
  } else if (specificTopic.includes('pv_power')) {
    currentSystemState.pv_power = parseFloat(messageContent)
  } else if (specificTopic.includes('load_power')) {
    currentSystemState.load = parseFloat(messageContent)
  } else if (specificTopic.includes('grid_voltage')) {
    currentSystemState.grid_voltage = parseFloat(messageContent)
  } else if (specificTopic.includes('grid_power')) {
    currentSystemState.grid_power = parseFloat(messageContent)
  } else if (specificTopic.includes('inverter_state') || specificTopic.includes('device_mode')) {
    currentSystemState.inverter_state = messageContent
  }

  // Handle specific settings changes
  if (specificTopic.includes('grid_charge')) {
    handleSettingChange(specificTopic, messageContent, 'grid_charge')
  } else if (specificTopic.includes('energy_pattern')) {
    handleSettingChange(specificTopic, messageContent, 'energy_pattern')
  } else {
    // Check if this is any other settings topic we're monitoring
    for (const setting of settingsToMonitor) {
      if (specificTopic.includes(setting)) {
        handleSettingChange(specificTopic, messageContent, setting)
        break
      }
    }
  }
}

// Function to handle setting changes
async function handleSettingChange(specificTopic, messageContent, changeType) {
  // Only proceed if the setting has changed
  if (previousSettings[specificTopic] !== messageContent) {
    console.log(`${changeType.toUpperCase()} CHANGE DETECTED: ${specificTopic} - ${messageContent}`)
    
    // Create a detailed change record
    const changeData = {
      timestamp: new Date(),
      topic: specificTopic,
      old_value: previousSettings[specificTopic],
      new_value: messageContent,
      system_state: { ...currentSystemState },
      change_type: changeType
    }
    
    // Update previous settings
    previousSettings[specificTopic] = messageContent
    
    // Save to database if connected
    if (dbConnected && SettingsChange) {
      try {
        const settingsChange = new SettingsChange(changeData)
        await settingsChange.save()
        console.log('Change saved to database')
      } catch (error) {
        console.error('Error saving to database:', error.message)
        // If DB fails, log to console as fallback
        console.log('Change data (fallback):', JSON.stringify(changeData))
      }
    } else {
      // Not connected to DB, log to console as fallback
      console.log('Database not connected, logging change to console')
      console.log('Change data:', JSON.stringify(changeData))
      
      // Try to connect to database in background
      retryDatabaseConnection()
    }
    
    // Send notifications
    if (changeType === 'grid_charge') {
      sendGridChargeNotification(changeData)
    } else if (changeType === 'energy_pattern') {
      sendEnergyPatternNotification(changeData)
    }
  }
}

function sendGridChargeNotification(changeData) {
  console.log('IMPORTANT: Grid Charge Setting Changed!')
  console.log(`From: ${changeData.old_value} → To: ${changeData.new_value}`)
  console.log(`Battery SOC: ${changeData.system_state.battery_soc}%`)
  console.log(`PV Power: ${changeData.system_state.pv_power}W`)
  console.log(`Grid Voltage: ${changeData.system_state.grid_voltage}V`)
  console.log(`Load: ${changeData.system_state.load}W`)
  console.log(`Time: ${moment(changeData.timestamp).format('YYYY-MM-DD HH:mm:ss')}`)
}

function sendEnergyPatternNotification(changeData) {
  console.log('IMPORTANT: Energy Pattern Setting Changed!')
  console.log(`From: ${changeData.old_value} → To: ${changeData.new_value}`)
  console.log(`Battery SOC: ${changeData.system_state.battery_soc}%`)
  console.log(`PV Power: ${changeData.system_state.pv_power}W`)
  console.log(`Grid Voltage: ${changeData.system_state.grid_voltage}V`)
  console.log(`Load: ${changeData.system_state.load}W`)
  console.log(`Time: ${moment(changeData.timestamp).format('YYYY-MM-DD HH:mm:ss')}`)
}

// API Routes with database integration
app.get('/api/grid-charge-changes', async (req, res) => {
  try {
    if (!dbConnected) {
      return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
    }
    
    const gridChargeChanges = await SettingsChange.find({ 
      $or: [
        { topic: { $regex: 'grid_charge' } },
        { change_type: 'grid_charge' }
      ]
    }).sort({ timestamp: -1 })
    
    res.json(gridChargeChanges)
  } catch (error) {
    console.error('Error retrieving grid charge changes:', error)
    res.status(500).json({ error: 'Failed to retrieve data' })
  }
})

app.get('/api/energy-pattern-changes', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
      }
      
      const energyPatternChanges = await SettingsChange.find({ 
        $or: [
          { topic: { $regex: 'energy_pattern' } },
          { change_type: 'energy_pattern' }
        ]
      }).sort({ timestamp: -1 })
      
      res.json(energyPatternChanges)
    } catch (error) {
      console.error('Error retrieving energy pattern changes:', error)
      res.status(500).json({ error: 'Failed to retrieve data' })
    }
  })

app.get('/grid-charge', async (req, res) => {
  try {
    let changesCount = 0
    if (dbConnected) {
      changesCount = await SettingsChange.countDocuments({ 
        $or: [
          { topic: { $regex: 'grid_charge' } },
          { change_type: 'grid_charge' }
        ]
      })
    }
    
    res.render('grid-charge', { 
      active: learnerModeActive,
      changes_count: changesCount,
      db_connected: dbConnected
    })
  } catch (error) {
    console.error('Error rendering grid-charge page:', error)
    res.status(500).send('Error loading page data')
  }
})

app.get('/energy-pattern', async (req, res) => {
  try {
    let changesCount = 0
    if (dbConnected) {
      changesCount = await SettingsChange.countDocuments({ 
        $or: [
          { topic: { $regex: 'energy_pattern' } },
          { change_type: 'energy_pattern' }
        ]
      })
    }
    
    res.render('energy-pattern', { 
      active: learnerModeActive,
      changes_count: changesCount,
      db_connected: dbConnected
    })
  } catch (error) {
    console.error('Error rendering energy-pattern page:', error)
    res.status(500).send('Error loading page data')
  }
})

app.get('/api/settings-changes', async (req, res) => {
  try {
    if (!dbConnected) {
      return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
    }
    
    const changeType = req.query.type
    const limit = parseInt(req.query.limit) || 100
    const skip = parseInt(req.query.skip) || 0
    
    let query = {}
    if (changeType) {
      query.change_type = changeType
    }
    
    const changes = await SettingsChange.find(query)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit)
    
    const total = await SettingsChange.countDocuments(query)
    
    res.json({
      changes,
      pagination: {
        total,
        limit,
        skip,
        hasMore: skip + limit < total
      }
    })
  } catch (error) {
    console.error('Error retrieving settings changes:', error)
    res.status(500).json({ error: 'Failed to retrieve data' })
  }
})

app.get('/api/learner/status', (req, res) => {
  res.json({ 
    active: learnerModeActive,
    monitored_settings: settingsToMonitor,
    current_system_state: currentSystemState,
    db_connected: dbConnected
  })
})

app.post('/api/learner/toggle', (req, res) => {
  learnerModeActive = !learnerModeActive
  
  console.log(`Learner mode ${learnerModeActive ? 'activated' : 'deactivated'}`)
  
  res.json({ 
    success: true, 
    active: learnerModeActive,
    message: `Learner mode ${learnerModeActive ? 'activated' : 'deactivated'}`
  })
})

app.get('/api/learner/changes', async (req, res) => {
  try {
    if (!dbConnected) {
      return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
    }
    
    const limit = parseInt(req.query.limit) || 50
    const changes = await SettingsChange.find()
      .sort({ timestamp: -1 })
      .limit(limit)
    
    res.json(changes)
  } catch (error) {
    console.error('Error retrieving learner changes:', error)
    res.status(500).json({ error: 'Failed to retrieve data' })
  }
})

app.get('/api/database/status', (req, res) => {
  res.json({
    connected: dbConnected,
    uri: mongoDbUri.replace(/\/\/([^:]+):([^@]+)@/, '//***:***@') // Hide credentials
  })
})

app.get('/learner', async (req, res) => {
  try {
    let changesCount = 0
    if (dbConnected) {
      changesCount = await SettingsChange.countDocuments()
    }
    
    res.render('learner', { 
      active: learnerModeActive,
      monitored_settings: settingsToMonitor,
      changes_count: changesCount,
      db_connected: dbConnected
    })
  } catch (error) {
    console.error('Error rendering learner page:', error)
    res.status(500).send('Error loading page data')
  }
})


// Connect to MQTT with robust error handling
function connectToMqtt() {
  mqttClient = mqtt.connect(`mqtt://${mqttConfig.host}:${mqttConfig.port}`, {
    username: mqttConfig.username,
    password: mqttConfig.password,
  })

  mqttClient.on('connect', () => {
    console.log('Connected to MQTT broker')
    mqttClient.subscribe(`${mqttTopicPrefix}/#`)
  })

  mqttClient.on('message', (topic, message) => {
    const formattedMessage = `${topic}: ${message.toString()}`
    incomingMessages.push(formattedMessage)
    if (incomingMessages.length > MAX_MESSAGES) {
      incomingMessages.shift()
    }
    handleMqttMessage(topic,message)
    saveMessageToInfluxDB(topic, message)
  })

  mqttClient.on('error', (err) => {
    console.error('Error connecting to MQTT broker:', err.message)
    mqttClient = null
  })
}

// Save MQTT message to InfluxDB with better error handling
async function saveMessageToInfluxDB(topic, message) {
  try {
    const parsedMessage = parseFloat(message.toString())

    if (isNaN(parsedMessage)) {
      return
    }

    const timestamp = new Date().getTime()
    const dataPoint = {
      measurement: 'state',
      fields: { value: parsedMessage },
      tags: { topic: topic },
      timestamp: timestamp * 1000000,
    }

    await retry(
      async () => {
        await influx.writePoints([dataPoint])
      },
      {
        retries: 5,
        minTimeout: 1000,
      }
    )
  } catch (err) {
    console.error(
      'Error saving message to InfluxDB:',
      err.response ? err.response.body : err.message
    )
  }
}

// Graceful shutdown function
function gracefulShutdown() {
    console.log('Starting graceful shutdown...')
    
    // Close database connection
    if (mongoose.connection.readyState === 1) {
      console.log('Closing MongoDB connection')
      mongoose.connection.close()
    }
    
    // Close MQTT connection
    if (mqttClient) {
      console.log('Closing MQTT connection')
      mqttClient.end(true)
    }
    
    console.log('Shutdown complete')
    process.exit(0)
  }
  
  // Register signal handlers
  process.on('SIGTERM', gracefulShutdown)
  process.on('SIGINT', gracefulShutdown)

 // Initialize connections to external services
async function initializeConnections() {
    // Connect to MQTT broker
    connectToMqtt()
    
    // Connect to database
    try {
      await connectToDatabase()
    } catch (err) {
      console.error('Initial database connection failed:', err)
      // Continue app startup even if DB fails initially
      setTimeout(retryDatabaseConnection, 10000)
    }
  }
  
  // Initialize connections when server starts
  initializeConnections()
  
  // Start the server
  app.listen(port, () => {
    console.log(`Server running on port ${port}`)
  })
