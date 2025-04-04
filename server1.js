const express = require('express')
const bodyParser = require('body-parser')
const mqtt = require('mqtt')
const fs = require('fs')
const path = require('path')
const Influx = require('influx')
const ejs = require('ejs')
const moment = require('moment-timezone')
const retry = require('async-retry')
const app = express()
const port = process.env.PORT || 6789
const { http } = require('follow-redirects')
const cors = require('cors')
const session = require('express-session')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const cron = require('node-cron')

// Middleware setup
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: '*' }))
app.use(bodyParser.urlencoded({ extended: true }))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(express.static(path.join(__dirname, 'public')))
app.set('view engine', 'ejs')
app.set('views', path.join(__dirname, 'views'))

// Load configuration
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

// Constants
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json')
const RULES_FILE = path.join(__dirname, 'data', 'rules.json')
const CACHE_DURATION = 24 * 3600000 // 24 hours in milliseconds

// Create data directory if it doesn't exist
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'))
}

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

// InfluxDB configuration
const influxConfig = {
  host: '10.110.1.28',
  port: 8086,
  database:  'home_assistant',
  username:  'admin',
  password:  'adminpassword',
  protocol: 'http',
  timeout: 10000,
  schema: [
    {
      measurement: 'state',
      fields: {
        value: Influx.FieldType.FLOAT,
        old_value: Influx.FieldType.FLOAT,
        string_value: Influx.FieldType.STRING,
        old_string_value: Influx.FieldType.STRING,
      },
      tags: [
        'topic',
        'change_type',
        'inverter',
        'setting'
      ]
    },
    {
      measurement: 'setting_changes',
      fields: {
        new_value: Influx.FieldType.STRING,
        old_value: Influx.FieldType.STRING,
        battery_soc: Influx.FieldType.FLOAT,
        pv_power: Influx.FieldType.FLOAT,
        load: Influx.FieldType.FLOAT,
        grid_voltage: Influx.FieldType.FLOAT,
        grid_power: Influx.FieldType.FLOAT,
        inverter_state: Influx.FieldType.STRING
      },
      tags: [
        'topic',
        'change_type',
        'inverter',
        'setting'
      ]
    },
    {
      measurement: 'rules',
      fields: {
        name: Influx.FieldType.STRING,
        description: Influx.FieldType.STRING,
        active: Influx.FieldType.BOOLEAN,
        conditions: Influx.FieldType.STRING, // JSON encoded
        actions: Influx.FieldType.STRING, // JSON encoded
        timeRestrictions: Influx.FieldType.STRING, // JSON encoded
        triggerCount: Influx.FieldType.INTEGER
      },
      tags: [
        'rule_id',
        'name'
      ]
    },
    {
      measurement: 'rule_executions',
      fields: {
        rule_name: Influx.FieldType.STRING,
        rule_description: Influx.FieldType.STRING,
        actions: Influx.FieldType.STRING, // JSON encoded
        battery_soc: Influx.FieldType.FLOAT,
        pv_power: Influx.FieldType.FLOAT,
        load: Influx.FieldType.FLOAT,
        grid_voltage: Influx.FieldType.FLOAT,
        grid_power: Influx.FieldType.FLOAT
      },
      tags: [
        'rule_id'
      ]
    }
  ]
}
// Initialize InfluxDB client with error handling
let influx
let dbConnected = false
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

// Helper function to connect to InfluxDB and create database if needed
async function connectToInfluxDB() {
  if (dbConnected) return true
  
  try {
    // Check connection
    const hosts = await influx.ping(5000)
    if (hosts.some(host => host.online)) {
      console.log('Connected to InfluxDB')
      
      // Check if database exists, if not create it
      const dbs = await influx.getDatabaseNames()
      if (!dbs.includes(influxConfig.database)) {
        await influx.createDatabase(influxConfig.database)
        console.log(`Created database: ${influxConfig.database}`)
      }

      // Create retention policies for different data types
      await influx.createRetentionPolicy('settings_policy', {
        duration: '52w',
        replication: 1,
        isDefault: false
      })
      console.log('Created retention policy for settings')

      await influx.createRetentionPolicy('system_state_policy', {
        duration: '4w',
        replication: 1,
        isDefault: false
      })
      console.log('Created retention policy for system state')

      await influx.createRetentionPolicy('rules_policy', {
        duration: '52w',
        replication: 1,
        isDefault: false
      })
      console.log('Created retention policy for rules')

      dbConnected = true
      return true
    } else {
      console.warn('InfluxDB is not responding')
      return false
    }
  } catch (error) {
    console.error('InfluxDB connection error:', error.message)
    return false
  }
}

// Function to retry DB connection in background
async function retryDatabaseConnection() {
  try {
    if (!dbConnected) {
      console.log('Retrying database connection...')
      await connectToInfluxDB()
    }
  } catch (error) {
    console.error('Failed to connect to database on retry:', error.message)
    // Schedule another retry
    setTimeout(retryDatabaseConnection, 30000)
  }
}

// MQTT configuration
const mqttConfig = {
  host: options.mqtt_host,
  port: options.mqtt_port,
  username: options.mqtt_username,
  password: options.mqtt_password,
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
  'work_mode_timer',
  'voltage_point',
  // Battery charging settings
  'max_discharge_current',
  'max_charge_current',
  'max_grid_charge_current',
  'max_generator_charge_current',
  'battery_float_charge_voltage',
  'battery_absorption_charge_voltage',
  'battery_equalization_charge_voltage',
  // Work mode settings
  'remote_switch',
  'generator_charge',
  'force_generator_on',
  'output_shutdown_voltage',
  'stop_battery_discharge_voltage',
  'start_battery_discharge_voltage',
  'start_grid_charge_voltage',
  // Work mode detail settings
  'work_mode',
  'solar_export_when_battery_full',
  'max_sell_power',
  'max_solar_power',
  'grid_trickle_feed'
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

// Rules-related functions
let rules = []; // In-memory rules cache
let ruleIdCounter = 1; // Simple counter for rule IDs

// Load rules from InfluxDB or file
async function loadRules() {
  try {
    if (dbConnected) {
      // Try to get rules from InfluxDB
      const results = await influx.query(`
        SELECT last("name"), last("description"), last("active"), 
               last("conditions"), last("actions"), last("timeRestrictions"),
               last("triggerCount")
        FROM "rules"
        GROUP BY "rule_id"
      `)
      
      if (results && results.length > 0) {
        // Transform InfluxDB results into rule objects
        rules = results.map(row => {
          return {
            id: row.rule_id,
            name: row.last_name,
            description: row.last_description,
            active: row.last_active,
            conditions: JSON.parse(row.last_conditions || '[]'),
            timeRestrictions: JSON.parse(row.last_timeRestrictions || '{}'),
            actions: JSON.parse(row.last_actions || '[]'),
            triggerCount: row.last_triggerCount || 0,
            lastTriggered: null // Will be fetched separately
          }
        })
        
        // For each rule, fetch the last execution time
        for (const rule of rules) {
          try {
            const execResults = await influx.query(`
              SELECT last(rule_name)
              FROM "rule_executions"
              WHERE "rule_id" = ${Influx.escape.stringLit(rule.id)}
            `)
            
            if (execResults && execResults.length > 0) {
              rule.lastTriggered = execResults[0].time
            }
          } catch (error) {
            console.error(`Error getting last trigger time for rule ${rule.id}:`, error.message)
          }
        }
        
        console.log(`Loaded ${rules.length} rules from InfluxDB`)
        
        // Update the rule ID counter to be higher than any existing rule ID
        const maxId = Math.max(...rules.map(r => parseInt(r.id.replace('rule-', ''))), 0)
        ruleIdCounter = maxId + 1
        
        return
      }
    }
    
    // Fallback to file if no rules in DB or DB not connected
    if (fs.existsSync(RULES_FILE)) {
      const fileData = fs.readFileSync(RULES_FILE, 'utf8')
      rules = JSON.parse(fileData)
      console.log(`Loaded ${rules.length} rules from file`)
      
      // Update the rule ID counter
      const maxId = Math.max(...rules.map(r => parseInt(r.id.replace('rule-', ''))), 0)
      ruleIdCounter = maxId + 1
    } else {
      console.log('No rules file found, creating default rules')
      await createDefaultRules()
    }
  } catch (error) {
    console.error('Error loading rules:', error.message)
    // If both DB and file fail, initialize with empty array
    rules = []
  }
}

// Save rules to InfluxDB and file (as backup)
async function saveRules() {
  try {
    // Always save to file as backup
    fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2))
    
    if (dbConnected) {
      // Save to InfluxDB - we'll create a point for each rule
      const points = rules.map(rule => ({
        measurement: 'rules',
        tags: {
          rule_id: rule.id,
          name: rule.name.substring(0, 64) // Keep tag size reasonable
        },
        fields: {
          name: rule.name,
          description: rule.description || '',
          active: !!rule.active,
          conditions: JSON.stringify(rule.conditions || []),
          actions: JSON.stringify(rule.actions || []),
          timeRestrictions: JSON.stringify(rule.timeRestrictions || {}),
          triggerCount: rule.triggerCount || 0
        },
        timestamp: new Date()
      }))
      
      await influx.writePoints(points, {
        precision: 'ms',
        retentionPolicy: 'rules_policy'
      })
      
      console.log(`Saved ${rules.length} rules to InfluxDB`)
    }
  } catch (error) {
    console.error('Error saving rules:', error.message)
  }
}

// Handle incoming MQTT messages
async function handleMqttMessage(topic, message) {
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

  // Update system state for key metrics - always do this regardless of learner mode
  if (specificTopic.includes('total/battery_state_of_charge')) {
    currentSystemState.battery_soc = parseFloat(messageContent)
    currentSystemState.timestamp = moment().format('YYYY-MM-DD HH:mm:ss')
  } else if (specificTopic.includes('total/pv_power')) {
    currentSystemState.pv_power = parseFloat(messageContent)
  } else if (specificTopic.includes('total/load_power')) {
    currentSystemState.load = parseFloat(messageContent)
  } else if (specificTopic.includes('total/grid_voltage')) {
    currentSystemState.grid_voltage = parseFloat(messageContent)
  } else if (specificTopic.includes('total/grid_power')) {
    currentSystemState.grid_power = parseFloat(messageContent)
  } else if (specificTopic.includes('inverter_state') || specificTopic.includes('device_mode')) {
    currentSystemState.inverter_state = messageContent
  }

  // Only handle setting changes if learner mode is active
  if (learnerModeActive) {
    try {
      // Handle existing settings changes
      if (specificTopic.includes('grid_charge')) {
        await handleSettingChange(specificTopic, messageContent, 'grid_charge')
      } else if (specificTopic.includes('energy_pattern')) {
        await handleSettingChange(specificTopic, messageContent, 'energy_pattern')
      } else if (specificTopic.includes('voltage_point')) {
        await handleSettingChange(specificTopic, messageContent, 'voltage_point')
      } 
      // Battery charging settings
      else if (specificTopic.includes('max_discharge_current')) {
        await handleBatteryChargingSettingChange(specificTopic, messageContent, 'max_discharge_current')
      } else if (specificTopic.includes('max_charge_current')) {
        await handleBatteryChargingSettingChange(specificTopic, messageContent, 'max_charge_current')
      } else if (specificTopic.includes('max_grid_charge_current')) {
        await handleBatteryChargingSettingChange(specificTopic, messageContent, 'max_grid_charge_current')
      } else if (specificTopic.includes('max_generator_charge_current')) {
        await handleBatteryChargingSettingChange(specificTopic, messageContent, 'max_generator_charge_current')
      } else if (specificTopic.includes('battery_float_charge_voltage')) {
        await handleBatteryChargingSettingChange(specificTopic, messageContent, 'battery_float_charge_voltage')
      } else if (specificTopic.includes('battery_absorption_charge_voltage')) {
        await handleBatteryChargingSettingChange(specificTopic, messageContent, 'battery_absorption_charge_voltage')
      } else if (specificTopic.includes('battery_equalization_charge_voltage')) {
        await handleBatteryChargingSettingChange(specificTopic, messageContent, 'battery_equalization_charge_voltage')
      }
      // Work mode settings
      else if (specificTopic.includes('remote_switch')) {
        await handleWorkModeSettingChange(specificTopic, messageContent, 'remote_switch')
      } else if (specificTopic.includes('generator_charge')) {
        await handleWorkModeSettingChange(specificTopic, messageContent, 'generator_charge')
      } else if (specificTopic.includes('force_generator_on')) {
        await handleWorkModeSettingChange(specificTopic, messageContent, 'force_generator_on')
      } else if (specificTopic.includes('output_shutdown_voltage')) {
        await handleWorkModeSettingChange(specificTopic, messageContent, 'output_shutdown_voltage')
      } else if (specificTopic.includes('stop_battery_discharge_voltage')) {
        await handleWorkModeSettingChange(specificTopic, messageContent, 'stop_battery_discharge_voltage')
      } else if (specificTopic.includes('start_battery_discharge_voltage')) {
        await handleWorkModeSettingChange(specificTopic, messageContent, 'start_battery_discharge_voltage')
      } else if (specificTopic.includes('start_grid_charge_voltage')) {
        await handleWorkModeSettingChange(specificTopic, messageContent, 'start_grid_charge_voltage')
      }
      // Work mode detail settings
      else if (specificTopic.includes('work_mode') && !specificTopic.includes('work_mode_timer')) {
        await handleWorkModeSettingChange(specificTopic, messageContent, 'work_mode')
      } else if (specificTopic.includes('solar_export_when_battery_full')) {
        await handleWorkModeSettingChange(specificTopic, messageContent, 'solar_export_when_battery_full')
      } else if (specificTopic.includes('max_sell_power')) {
        await handleWorkModeSettingChange(specificTopic, messageContent, 'max_sell_power')
      } else if (specificTopic.includes('max_solar_power')) {
        await handleWorkModeSettingChange(specificTopic, messageContent, 'max_solar_power')
      } else if (specificTopic.includes('grid_trickle_feed')) {
        await handleWorkModeSettingChange(specificTopic, messageContent, 'grid_trickle_feed')
      } else {
        // Check if this is any other settings topic we're monitoring
        for (const setting of settingsToMonitor) {
          if (specificTopic.includes(setting)) {
            await handleSettingChange(specificTopic, messageContent, setting)
            break
          }
        }
      }
    } catch (error) {
      console.error('Error handling MQTT message:', error.message)
    }
  } else {
    // Learner mode is not active, but still update previousSettings
    // This ensures we have the latest values when learner mode is activated
    if (settingsToMonitor.some(setting => specificTopic.includes(setting))) {
      previousSettings[specificTopic] = messageContent
    }
  }

  // Process rules after updating system state - always do this regardless of learner mode
  try {
    await processRules()
  } catch (error) {
    console.error('Error processing rules:', error.message)
  }
}

// Function to handle setting changes
async function handleSettingChange(specificTopic, messageContent, changeType) {
  // Only proceed if the setting has changed
  if (previousSettings[specificTopic] !== messageContent) {
    console.log(`${changeType.toUpperCase()} CHANGE DETECTED: ${specificTopic} - ${messageContent}`)
    
    // Extract inverter number from topic
    const inverterMatch = specificTopic.match(/inverter_(\d+)/);
    const inverter = inverterMatch ? `inverter_${inverterMatch[1]}` : 'unknown';
    
    // Extract setting name from topic
    const settingParts = specificTopic.split('/');
    const setting = settingParts[settingParts.length - 1];
    
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
    
    // Save to InfluxDB if connected
    if (dbConnected) {
      try {
        // Create field values for numeric and string data
        const fields = {
          new_value: String(messageContent),
          old_value: String(previousSettings[specificTopic] || ''),
          battery_soc: currentSystemState.battery_soc,
          pv_power: currentSystemState.pv_power,
          load: currentSystemState.load,
          grid_voltage: currentSystemState.grid_voltage,
          grid_power: currentSystemState.grid_power,
          inverter_state: String(currentSystemState.inverter_state || '')
        }
        
        // Use writePoints instead of writePoint, and wrap the point in an array
        await influx.writePoints([{
          measurement: 'setting_changes',
          tags: {
            topic: specificTopic,
            change_type: changeType,
            inverter,
            setting
          },
          fields,
          timestamp: changeData.timestamp
        }], {
          precision: 'ms',
          retentionPolicy: 'settings_policy'
        });
        
        console.log('Change saved to InfluxDB')
      } catch (error) {
        console.error('Error saving to InfluxDB:', error.message)
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
    
    // Send notifications based on change type
    if (changeType === 'grid_charge') {
      sendGridChargeNotification(changeData)
    } else if (changeType === 'energy_pattern') {
      sendEnergyPatternNotification(changeData)
    } else if (changeType === 'voltage_point') {
      sendVoltagePointNotification(changeData)
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

function sendVoltagePointNotification(changeData) {
  console.log('IMPORTANT: Voltage Point Setting Changed!')
  console.log(`From: ${changeData.old_value} → To: ${changeData.new_value}`)
  console.log(`Battery SOC: ${changeData.system_state.battery_soc}%`)
  console.log(`PV Power: ${changeData.system_state.pv_power}W`)
  console.log(`Grid Voltage: ${changeData.system_state.grid_voltage}V`)
  console.log(`Load: ${changeData.system_state.load}W`)
  console.log(`Time: ${moment(changeData.timestamp).format('YYYY-MM-DD HH:mm:ss')}`)
}

// ================ AUTOMATION RULES ENGINE ================

// Function to check if current time is within the specified time range
function isWithinTimeRange(startTime, endTime) {
  if (!startTime || !endTime) return true
  
  const currentTime = moment()
  const start = moment(startTime, 'HH:mm')
  const end = moment(endTime, 'HH:mm')
  
  return currentTime.isBetween(start, end)
}

// Function to check if current day is in the allowed days
function isAllowedDay(allowedDays) {
  if (!allowedDays || allowedDays.length === 0) return true
  
  const currentDay = moment().format('dddd').toLowerCase()
  return allowedDays.includes(currentDay)
}

// Function to evaluate a condition
function evaluateCondition(condition) {
  const { parameter, operator, value } = condition
  let currentValue
  
  // Get the current value based on parameter
  switch (parameter) {
    case 'battery_soc':
      currentValue = currentSystemState.battery_soc
      break
    case 'pv_power':
      currentValue = currentSystemState.pv_power
      break
    case 'load':
      currentValue = currentSystemState.load
      break
    case 'grid_voltage':
      currentValue = currentSystemState.grid_voltage
      break
    case 'grid_power':
      currentValue = currentSystemState.grid_power
      break
    default:
      return false
  }
  
  // If we don't have the value yet, return false
  if (currentValue === null || currentValue === undefined) {
    return false
  }
  
  // Evaluate the condition
  switch (operator) {
    case 'gt': // greater than
      return currentValue > value
    case 'lt': // less than
      return currentValue < value
    case 'eq': // equal to
      return currentValue === value
    case 'gte': // greater than or equal to
      return currentValue >= value
    case 'lte': // less than or equal to
      return currentValue <= value
    default:
      return false
  }
}

// Function to apply an action
function applyAction(action) {
  // Only allow sending commands when learner mode is active
  if (!learnerModeActive) {
    console.warn('Cannot apply action: Learner mode is not active')
    return false
  }

  const { setting, value, inverter } = action
  let inverters = []
  
  // Determine which inverters to apply the action to
  if (inverter === 'all') {
    // Apply to all inverters
    for (let i = 1; i <= inverterNumber; i++) {
      inverters.push(`inverter_${i}`)
    }
  } else {
    // Apply to a specific inverter
    inverters.push(inverter)
  }
  
  // Apply the action to each inverter
  inverters.forEach(inv => {
    let topic, mqttValue
    
    // Construct the topic and value based on the setting
    switch (setting) {
      // Existing settings
      case 'grid_charge':
        topic = `${mqttTopicPrefix}/${inv}/grid_charge/set`
        mqttValue = value
        break
      case 'energy_pattern':
        topic = `${mqttTopicPrefix}/${inv}/energy_pattern/set`
        mqttValue = value
        break
      
      // Battery charging settings
      case 'max_discharge_current':
        topic = `${mqttTopicPrefix}/${inv}/max_discharge_current/set`
        mqttValue = value
        break
      case 'max_charge_current':
        topic = `${mqttTopicPrefix}/${inv}/max_charge_current/set`
        mqttValue = value
        break
      case 'max_grid_charge_current':
        topic = `${mqttTopicPrefix}/${inv}/max_grid_charge_current/set`
        mqttValue = value
        break
      case 'max_generator_charge_current':
        topic = `${mqttTopicPrefix}/${inv}/max_generator_charge_current/set`
        mqttValue = value
        break
      case 'battery_float_charge_voltage':
        topic = `${mqttTopicPrefix}/${inv}/battery_float_charge_voltage/set`
        mqttValue = value
        break
      case 'battery_absorption_charge_voltage':
        topic = `${mqttTopicPrefix}/${inv}/battery_absorption_charge_voltage/set`
        mqttValue = value
        break
      case 'battery_equalization_charge_voltage':
        topic = `${mqttTopicPrefix}/${inv}/battery_equalization_charge_voltage/set`
        mqttValue = value
        break
        
      // Work mode settings
      case 'remote_switch':
        topic = `${mqttTopicPrefix}/${inv}/remote_switch/set`
        mqttValue = value
        break
      case 'generator_charge':
        topic = `${mqttTopicPrefix}/${inv}/generator_charge/set`
        mqttValue = value
        break
      case 'force_generator_on':
        topic = `${mqttTopicPrefix}/${inv}/force_generator_on/set`
        mqttValue = value
        break
      case 'output_shutdown_voltage':
        topic = `${mqttTopicPrefix}/${inv}/output_shutdown_voltage/set`
        mqttValue = value
        break
      case 'stop_battery_discharge_voltage':
        topic = `${mqttTopicPrefix}/${inv}/stop_battery_discharge_voltage/set`
        mqttValue = value
        break
      case 'start_battery_discharge_voltage':
        topic = `${mqttTopicPrefix}/${inv}/start_battery_discharge_voltage/set`
        mqttValue = value
        break
      case 'start_grid_charge_voltage':
        topic = `${mqttTopicPrefix}/${inv}/start_grid_charge_voltage/set`
        mqttValue = value
        break
        
      // Work mode detail settings
      case 'work_mode':
        topic = `${mqttTopicPrefix}/${inv}/work_mode/set`
        mqttValue = value
        break
      case 'solar_export_when_battery_full':
        topic = `${mqttTopicPrefix}/${inv}/solar_export_when_battery_full/set`
        mqttValue = value
        break
      case 'max_sell_power':
        topic = `${mqttTopicPrefix}/${inv}/max_sell_power/set`
        mqttValue = value
        break
      case 'max_solar_power':
        topic = `${mqttTopicPrefix}/${inv}/max_solar_power/set`
        mqttValue = value
        break
      case 'grid_trickle_feed':
        topic = `${mqttTopicPrefix}/${inv}/grid_trickle_feed/set`
        mqttValue = value
        break
        
      // Voltage point settings (existing)
      case 'voltage_point_1':
      case 'voltage_point_2':
      case 'voltage_point_3':
      case 'voltage_point_4':
      case 'voltage_point_5':
      case 'voltage_point_6':
        topic = `${mqttTopicPrefix}/${inv}/${setting}/set`
        mqttValue = value
        break
      default:
        console.warn(`Unknown setting: ${setting}`)
        return
    }
        // Send the command via MQTT
        if (mqttClient && mqttClient.connected) {
          mqttClient.publish(topic, mqttValue.toString(), { qos: 1, retain: false }, (err) => {
            if (err) {
              console.error(`Error publishing to ${topic}: ${err.message}`)
            } else {
              console.log(`Command sent: ${topic} = ${mqttValue}`)
            }
          })
        } else {
          console.warn('MQTT client not connected, cannot send command')
        }
      })
      
      return true
    }
    
    // Function to process all rules
    async function processRules() {
      // Skip if database is not connected
      if (!dbConnected) return;
      
      try {
        // Process all rules that are active
        for (const rule of rules) {
          if (!rule.active) continue;
          
          // Check time restrictions
          if (rule.timeRestrictions && rule.timeRestrictions.enabled) {
            const { days, startTime, endTime } = rule.timeRestrictions;
            
            // Check day of week restrictions
            if (days && days.length > 0) {
              const currentDay = moment().format('dddd').toLowerCase();
              if (!days.includes(currentDay)) {
                continue; // Skip this rule if not an allowed day
              }
            }
            
            // Check time range restrictions
            if (startTime && endTime) {
              if (!isWithinTimeRange(startTime, endTime)) {
                continue; // Skip this rule if outside time range
              }
            }
          }
          
          // Check if all conditions are met
          const allConditionsMet = rule.conditions.length === 0 || 
            rule.conditions.every(condition => evaluateCondition(condition));
          
          if (allConditionsMet) {
            console.log(`Rule "${rule.name}" triggered: ${rule.description}`);
            
            // Only apply actions if learner mode is active
            if (learnerModeActive) {
              // Apply all actions
              rule.actions.forEach(action => {
                const actionApplied = applyAction(action);
                if (!actionApplied) {
                  console.warn(`Rule "${rule.name}" matched but actions weren't applied because learner mode is inactive`);
                }
              });
              
              // Update rule statistics
              rule.lastTriggered = new Date();
              rule.triggerCount = (rule.triggerCount || 0) + 1;
              
              // Save rule execution to InfluxDB
              try {
                await influx.writePoint({
                  measurement: 'rule_executions',
                  tags: {
                    rule_id: rule.id
                  },
                  fields: {
                    rule_name: rule.name,
                    rule_description: rule.description || '',
                    actions: JSON.stringify(rule.actions),
                    battery_soc: currentSystemState.battery_soc,
                    pv_power: currentSystemState.pv_power,
                    load: currentSystemState.load,
                    grid_voltage: currentSystemState.grid_voltage,
                    grid_power: currentSystemState.grid_power
                  },
                  timestamp: new Date()
                }, {
                  precision: 'ms',
                  retentionPolicy: 'rules_policy'
                });
                
                // Update the rule in memory and save to file as backup
                await saveRules();
                
              } catch (error) {
                console.error(`Error logging rule execution to InfluxDB: ${error.message}`);
              }
            } else {
              console.log(`Rule "${rule.name}" matched conditions but actions weren't applied because learner mode is inactive`);
            }
          }
        }
      } catch (error) {
        console.error('Error processing rules:', error.message);
      }
    }
    
  // Function to handle battery charging setting changes
async function handleBatteryChargingSettingChange(specificTopic, messageContent, settingType) {
  // Only proceed if the setting has changed
  if (previousSettings[specificTopic] !== messageContent) {
    console.log(`${settingType.toUpperCase()} CHANGE DETECTED: ${specificTopic} - ${messageContent}`)
    
    // Extract inverter number from topic
    const inverterMatch = specificTopic.match(/inverter_(\d+)/);
    const inverter = inverterMatch ? `inverter_${inverterMatch[1]}` : 'unknown';
    
    // Extract setting name from topic
    const settingParts = specificTopic.split('/');
    const setting = settingParts[settingParts.length - 1];
    
    // Create a detailed change record
    const changeData = {
      timestamp: new Date(),
      topic: specificTopic,
      old_value: previousSettings[specificTopic],
      new_value: messageContent,
      system_state: { ...currentSystemState },
      change_type: settingType
    }
    
    // Update previous settings
    previousSettings[specificTopic] = messageContent
    
    // Save to InfluxDB if connected
    if (dbConnected) {
      try {
        const fields = {
          new_value: String(messageContent),
          old_value: String(previousSettings[specificTopic] || ''),
          battery_soc: currentSystemState.battery_soc,
          pv_power: currentSystemState.pv_power,
          load: currentSystemState.load,
          grid_voltage: currentSystemState.grid_voltage,
          grid_power: currentSystemState.grid_power,
          inverter_state: String(currentSystemState.inverter_state || '')
        }
        
        await influx.writePoint({
          measurement: 'setting_changes',
          tags: {
            topic: specificTopic,
            change_type: settingType,
            inverter,
            setting
          },
          fields,
          timestamp: changeData.timestamp
        }, {
          precision: 'ms',
          retentionPolicy: 'settings_policy'
        });
        
        console.log('Battery charging setting change saved to InfluxDB')
      } catch (error) {
        console.error('Error saving to InfluxDB:', error.message)
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
    
    // Send notification
    sendBatteryChargingNotification(changeData)
  }
}
    
  // Function to handle work mode setting changes
async function handleWorkModeSettingChange(specificTopic, messageContent, settingType) {
  // Only proceed if the setting has changed
  if (previousSettings[specificTopic] !== messageContent) {
    console.log(`${settingType.toUpperCase()} CHANGE DETECTED: ${specificTopic} - ${messageContent}`)
    
    // Extract inverter number from topic
    const inverterMatch = specificTopic.match(/inverter_(\d+)/);
    const inverter = inverterMatch ? `inverter_${inverterMatch[1]}` : 'unknown';
    
    // Extract setting name from topic
    const settingParts = specificTopic.split('/');
    const setting = settingParts[settingParts.length - 1];
    
    // Create a detailed change record
    const changeData = {
      timestamp: new Date(),
      topic: specificTopic,
      old_value: previousSettings[specificTopic],
      new_value: messageContent,
      system_state: { ...currentSystemState },
      change_type: settingType
    }
    
    // Update previous settings
    previousSettings[specificTopic] = messageContent
    
    // Save to InfluxDB if connected
    if (dbConnected) {
      try {
        const fields = {
          new_value: String(messageContent),
          old_value: String(previousSettings[specificTopic] || ''),
          battery_soc: currentSystemState.battery_soc,
          pv_power: currentSystemState.pv_power,
          load: currentSystemState.load,
          grid_voltage: currentSystemState.grid_voltage,
          grid_power: currentSystemState.grid_power,
          inverter_state: String(currentSystemState.inverter_state || '')
        }
        
        await influx.writePoint({
          measurement: 'setting_changes',
          tags: {
            topic: specificTopic,
            change_type: settingType,
            inverter,
            setting
          },
          fields,
          timestamp: changeData.timestamp
        }, {
          precision: 'ms',
          retentionPolicy: 'settings_policy'
        });
        
        console.log('Work mode setting change saved to InfluxDB')
      } catch (error) {
        console.error('Error saving to InfluxDB:', error.message)
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
    
    // Send notification
    sendWorkModeNotification(changeData)
  }
}
    
    // Notification functions for setting types
    function sendBatteryChargingNotification(changeData) {
      console.log('IMPORTANT: Battery Charging Setting Changed!')
      console.log(`Setting: ${changeData.topic}`)
      console.log(`From: ${changeData.old_value} → To: ${changeData.new_value}`)
      console.log(`Battery SOC: ${changeData.system_state.battery_soc}%`)
      console.log(`PV Power: ${changeData.system_state.pv_power}W`)
      console.log(`Grid Voltage: ${changeData.system_state.grid_voltage}V`)
      console.log(`Load: ${changeData.system_state.load}W`)
      console.log(`Time: ${moment(changeData.timestamp).format('YYYY-MM-DD HH:mm:ss')}`)
    }
    
    function sendWorkModeNotification(changeData) {
      console.log('IMPORTANT: Work Mode Setting Changed!')
      console.log(`Setting: ${changeData.topic}`)
      console.log(`From: ${changeData.old_value} → To: ${changeData.new_value}`)
      console.log(`Battery SOC: ${changeData.system_state.battery_soc}%`)
      console.log(`PV Power: ${changeData.system_state.pv_power}W`)
      console.log(`Grid Voltage: ${changeData.system_state.grid_voltage}V`)
      console.log(`Load: ${changeData.system_state.load}W`)
      console.log(`Time: ${moment(changeData.timestamp).format('YYYY-MM-DD HH:mm:ss')}`)
    }
    
    // ================ API ROUTES ================
    
    // API Routes with InfluxDB integration
    app.get('/api/energy-pattern-changes', async (req, res) => {
      try {
        if (!dbConnected) {
          return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
        }
        
        const energyPatternChanges = await influx.query(`
         SELECT *
      FROM "settings_policy"."setting_changes"
      WHERE "change_type" = 'energy_pattern' OR topic =~ /.*energy_pattern.*/
      ORDER BY time DESC
      LIMIT 100
        `)
        
        res.json(energyPatternChanges)
      } catch (error) {
        console.error('Error retrieving energy pattern changes:', error)
        res.status(500).json({ error: 'Failed to retrieve data' })
      }
    })
    
    // API endpoints for retrieving battery charging settings changes
    app.get('/api/battery-charging-changes', async (req, res) => {
      try {
        if (!dbConnected) {
          return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
        }
        
        const batteryChargingChanges = await influx.query(`
          SELECT *
          FROM "setting_changes"
          WHERE ("change_type" = 'max_discharge_current' OR
                 "change_type" = 'max_charge_current' OR
                 "change_type" = 'max_grid_charge_current' OR
                 "change_type" = 'max_generator_charge_current' OR
                 "change_type" = 'battery_float_charge_voltage' OR
                 "change_type" = 'battery_absorption_charge_voltage' OR
                 "change_type" = 'battery_equalization_charge_voltage' OR
                 "topic" =~ /.*max_discharge_current.*/ OR
                 "topic" =~ /.*max_charge_current.*/ OR
                 "topic" =~ /.*max_grid_charge_current.*/ OR
                 "topic" =~ /.*max_generator_charge_current.*/ OR
                 "topic" =~ /.*battery_float_charge_voltage.*/ OR
                 "topic" =~ /.*battery_absorption_charge_voltage.*/ OR
                 "topic" =~ /.*battery_equalization_charge_voltage.*/)
          ORDER BY time DESC
          LIMIT 100
        `)
        
        res.json(batteryChargingChanges)
      } catch (error) {
        console.error('Error retrieving battery charging changes:', error)
        res.status(500).json({ error: 'Failed to retrieve data' })
      }
    })

    app.get('/work-mode', async (req, res) => {
      try {
        let changesCount = 0
        if (dbConnected) {
          const result = await influx.query(`
            SELECT count("new_value") 
            FROM "settings_policy"."setting_changes"
            WHERE "change_type" = 'remote_switch' OR
                  "change_type" = 'generator_charge' OR
                  "change_type" = 'force_generator_on' OR
                  "change_type" = 'output_shutdown_voltage' OR
                  "change_type" = 'stop_battery_discharge_voltage' OR
                  "change_type" = 'start_battery_discharge_voltage' OR
                  "change_type" = 'start_grid_charge_voltage' OR
                  "change_type" = 'work_mode' OR
                  "change_type" = 'solar_export_when_battery_full' OR
                  "change_type" = 'max_sell_power' OR
                  "change_type" = 'max_solar_power' OR
                  "change_type" = 'grid_trickle_feed'
          `)
          
          if (result && result.length > 0) {
            changesCount = result[0].count_new_value || 0
          }
        }
        
        res.render('work-mode', { 
          active: learnerModeActive,
          changes_count: changesCount,
          db_connected: dbConnected
        })
      } catch (error) {
        console.error('Error rendering work-mode page:', error)
        res.status(500).send('Error loading page data')
      }
    })
    
    // API endpoints for retrieving work mode settings changes
    app.get('/api/work-mode-changes', async (req, res) => {
      try {
        if (!dbConnected) {
          return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
        }
        
        const workModeChanges = await influx.query(`
          SELECT *
          FROM "settings_policy"."setting_changes"
          WHERE "change_type" = 'remote_switch' OR
                "change_type" = 'generator_charge' OR
                "change_type" = 'force_generator_on' OR
                "change_type" = 'output_shutdown_voltage' OR
                "change_type" = 'stop_battery_discharge_voltage' OR
                "change_type" = 'start_battery_discharge_voltage' OR
                "change_type" = 'start_grid_charge_voltage' OR
                "change_type" = 'work_mode' OR
                "change_type" = 'solar_export_when_battery_full' OR
                "change_type" = 'max_sell_power' OR
                "change_type" = 'max_solar_power' OR
                "change_type" = 'grid_trickle_feed'
          ORDER BY time DESC
          LIMIT 100
        `)
        
        res.json(workModeChanges)
      } catch (error) {
        console.error('Error retrieving work mode changes:', error)
        res.status(500).json({ error: 'Failed to retrieve data' })
      }
    })
    
    // Routes for viewing battery charging and work mode settings
    app.get('/api/battery-charging-changes', async (req, res) => {
      try {
        if (!dbConnected) {
          return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
        }
        
        const batteryChargingChanges = await influx.query(`
          SELECT *
          FROM "settings_policy"."setting_changes"
          WHERE "change_type" = 'max_discharge_current' OR
                "change_type" = 'max_charge_current' OR
                "change_type" = 'max_grid_charge_current' OR
                "change_type" = 'max_generator_charge_current' OR
                "change_type" = 'battery_float_charge_voltage' OR
                "change_type" = 'battery_absorption_charge_voltage' OR
                "change_type" = 'battery_equalization_charge_voltage' OR
                "topic" =~ /.*max_discharge_current.*/ OR
                "topic" =~ /.*max_charge_current.*/ OR
                "topic" =~ /.*max_grid_charge_current.*/ OR
                "topic" =~ /.*max_generator_charge_current.*/ OR
                "topic" =~ /.*battery_float_charge_voltage.*/ OR
                "topic" =~ /.*battery_absorption_charge_voltage.*/ OR
                "topic" =~ /.*battery_equalization_charge_voltage.*/
          ORDER BY time DESC
          LIMIT 100
        `)
        
        res.json(batteryChargingChanges)
      } catch (error) {
        console.error('Error retrieving battery charging changes:', error)
        res.status(500).json({ error: 'Failed to retrieve data' })
      }
    })

    // Update the battery charging settings API
    app.post('/api/battery-charging/set', (req, res) => {
      try {
        // Check if learner mode is active
        if (!learnerModeActive) {
          return res.status(403).json({ error: 'Learner mode is not active. Cannot send commands.' })
        }
        
        const { inverter, setting, value } = req.body
        
        if (!inverter || !setting || value === undefined) {
          return res.status(400).json({ error: 'Missing inverter, setting, or value' })
        }
        
        if (!mqttClient || !mqttClient.connected) {
          return res.status(503).json({ error: 'MQTT client not connected' })
        }
        
        // Validate settings that are allowed to be changed
        const allowedSettings = [
          'max_discharge_current',
          'max_charge_current',
          'max_grid_charge_current',
          'max_generator_charge_current',
          'battery_float_charge_voltage',
          'battery_absorption_charge_voltage',
          'battery_equalization_charge_voltage'
        ]
        
        if (!allowedSettings.includes(setting)) {
          return res.status(400).json({ error: `Invalid setting: ${setting}. Allowed settings are: ${allowedSettings.join(', ')}` })
        }
        
        // Validate inverter ID
        const inverterID = inverter.replace('inverter_', '')
        if (isNaN(inverterID) || parseInt(inverterID) < 1 || parseInt(inverterID) > inverterNumber) {
          return res.status(400).json({ error: `Invalid inverter ID. Valid values: 1-${inverterNumber}` })
        }
        
        // Validate value ranges based on the setting type
        let isValid = true
        let validationError = ''
        
        switch (setting) {
          case 'max_discharge_current':
          case 'max_charge_current':
          case 'max_grid_charge_current':
          case 'max_generator_charge_current':
            // Current values are typically between 0-100A
            if (parseFloat(value) < 0 || parseFloat(value) > 100) {
              isValid = false
              validationError = `${setting} must be between 0 and 100 A`
            }
            break
          case 'battery_float_charge_voltage':
          case 'battery_absorption_charge_voltage':
          case 'battery_equalization_charge_voltage':
            // Voltage values are typically between 40-60V for 48V systems
            if (parseFloat(value) < 40 || parseFloat(value) > 60) {
              isValid = false
              validationError = `${setting} must be between 40 and 60 V`
            }
            break
        }
        
        if (!isValid) {
          return res.status(400).json({ error: validationError })
        }
        
        // Construct MQTT topic
        const topic = `${mqttTopicPrefix}/${inverter}/${setting}/set`
        
        // Publish to MQTT
        mqttClient.publish(topic, value.toString(), { qos: 1, retain: false }, (err) => {
          if (err) {
            console.error(`Error publishing to ${topic}: ${err.message}`)
            return res.status(500).json({ error: err.message })
          }
          
          console.log(`Battery Charging command sent: ${topic} = ${value}`)
          res.json({ success: true, message: `Command sent: ${topic} = ${value}` })
        })
      } catch (error) {
        console.error('Error sending battery charging command:', error)
        res.status(500).json({ error: error.message })
      }
    })
    
    // API endpoint for getting current battery charging and work mode settings
    app.get('/api/current-settings', async (req, res) => {
      try {
        // Create an object to hold current settings
        const currentSettings = {
          battery_charging: {},
          work_mode: {}
        }
        
        // Filter the previousSettings object to get battery charging settings
        for (const topic in previousSettings) {
          if (topic.includes('max_discharge_current') || 
              topic.includes('max_charge_current') || 
              topic.includes('max_grid_charge_current') || 
              topic.includes('max_generator_charge_current') || 
              topic.includes('battery_float_charge_voltage') || 
              topic.includes('battery_absorption_charge_voltage') || 
              topic.includes('battery_equalization_charge_voltage')) {
            
            // Extract the setting name from the topic
            const settingName = topic.split('/').pop()
            currentSettings.battery_charging[settingName] = previousSettings[topic]
          }
          
          // Filter for work mode settings
          if (topic.includes('remote_switch') || 
              topic.includes('generator_charge') || 
              topic.includes('force_generator_on') || 
              topic.includes('output_shutdown_voltage') || 
              topic.includes('stop_battery_discharge_voltage') || 
              topic.includes('start_battery_discharge_voltage') || 
              topic.includes('start_grid_charge_voltage') || 
              topic.includes('work_mode') || 
              topic.includes('solar_export_when_battery_full') || 
              topic.includes('max_sell_power') || 
              topic.includes('max_solar_power') || 
              topic.includes('grid_trickle_feed')) {
            
            const settingName = topic.split('/').pop()
            currentSettings.work_mode[settingName] = previousSettings[topic]
          }
        }
        
        res.json({
          success: true,
          currentSettings,
          inverterCount: inverterNumber,
          batteryCount: batteryNumber
        })
      } catch (error) {
        console.error('Error retrieving current settings:', error)
        res.status(500).json({ error: 'Failed to retrieve current settings' })
      }
    })
    
    // API endpoints for manually changing work mode settings from UI
    app.post('/api/work-mode/set', (req, res) => {
      try {
        // Check if learner mode is active
        if (!learnerModeActive) {
          return res.status(403).json({ error: 'Learner mode is not active. Cannot send commands.' })
        }
        
        const { inverter, setting, value } = req.body
        
        if (!inverter || !setting || value === undefined) {
          return res.status(400).json({ error: 'Missing inverter, setting, or value' })
        }
        
        if (!mqttClient || !mqttClient.connected) {
          return res.status(503).json({ error: 'MQTT client not connected' })
        }
        
        // Validate settings that are allowed to be changed
        const allowedSettings = [
          'remote_switch',
          'generator_charge',
          'force_generator_on',
          'output_shutdown_voltage',
          'stop_battery_discharge_voltage',
          'start_battery_discharge_voltage',
          'start_grid_charge_voltage',
          'work_mode',
          'solar_export_when_battery_full',
          'max_sell_power',
          'max_solar_power',
          'grid_trickle_feed'
        ]
        
        if (!allowedSettings.includes(setting)) {
          return res.status(400).json({ error: `Invalid setting: ${setting}. Allowed settings are: ${allowedSettings.join(', ')}` })
        }
        
        // Validate inverter ID
        const inverterID = inverter.replace('inverter_', '')
        if (isNaN(inverterID) || parseInt(inverterID) < 1 || parseInt(inverterID) > inverterNumber) {
          return res.status(400).json({ error: `Invalid inverter ID. Valid values: 1-${inverterNumber}` })
        }
        
        // Validate value based on setting type
        let isValid = true
        let validationError = ''
        
        switch (setting) {
          case 'remote_switch':
          case 'generator_charge':
          case 'force_generator_on':
          case 'solar_export_when_battery_full':
            // Boolean settings
            if (value !== 'Enabled' && value !== 'Disabled' && value !== 'true' && value !== 'false' && value !== '1' && value !== '0') {
              isValid = false
              validationError = `${setting} must be one of: Enabled, Disabled, true, false, 1, 0`
            }
            break
          case 'work_mode':
            // Enumeration settings
            const validWorkModes = ['Battery first', 'Grid first', 'Solar first', 'Solar + Battery', 'Solar + Grid']
            if (!validWorkModes.includes(value)) {
              isValid = false
              validationError = `${setting} must be one of: ${validWorkModes.join(', ')}`
            }
            break
          case 'output_shutdown_voltage':
          case 'stop_battery_discharge_voltage':
          case 'start_battery_discharge_voltage':
          case 'start_grid_charge_voltage':
            // Voltage values typically between 40-60V for 48V systems
            if (parseFloat(value) < 40 || parseFloat(value) > 60) {
              isValid = false
              validationError = `${setting} must be between 40 and 60 V`
            }
            break
          case 'max_sell_power':
          case 'max_solar_power':
            // Power values in Watts, typical range 0-15000W
            if (parseFloat(value) < 0 || parseFloat(value) > 15000) {
              isValid = false
              validationError = `${setting} must be between 0 and 15000 W`
            }
            break
          case 'grid_trickle_feed':
            // Typically a percentage or small value
            if (parseFloat(value) < 0 || parseFloat(value) > 100) {
              isValid = false
              validationError = `${setting} must be between 0 and 100`
            }
            break
        }
        
        if (!isValid) {
          return res.status(400).json({ error: validationError })
        }
        
        // Construct MQTT topic
        const topic = `${mqttTopicPrefix}/${inverter}/${setting}/set`
        
        // Publish to MQTT
        mqttClient.publish(topic, value.toString(), { qos: 1, retain: false }, (err) => {
          if (err) {
            console.error(`Error publishing to ${topic}: ${err.message}`)
            return res.status(500).json({ error: err.message })
          }
          
          console.log(`Work Mode command sent: ${topic} = ${value}`)
          res.json({ success: true, message: `Command sent: ${topic} = ${value}` })
        })
      } catch (error) {
        console.error('Error sending work mode command:', error)
        res.status(500).json({ error: error.message })
      }
    })
    
    // Complete the API endpoint for retrieving setting history that was cut off
    app.get('/api/settings-history/:setting', async (req, res) => {
      try {
        if (!dbConnected) {
          return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
        }
        
        const setting = req.params.setting
        const days = parseInt(req.query.days) || 7 // Default to 7 days
        
        // Calculate time range for InfluxDB
        const timeFilter = `time > now() - ${days}d`
        
        // Query InfluxDB for setting changes
        const query = `
          SELECT "new_value", "old_value", "battery_soc", "pv_power", "load", "grid_voltage", "grid_power", "inverter_state"
          FROM "settings_policy"."setting_changes"
          WHERE ("change_type" = ${Influx.escape.stringLit(setting)} OR
                 "topic" =~ /.*${setting}.*/) AND
                ${timeFilter}
          ORDER BY time ASC
        `
        
        const changes = await influx.query(query)
        
        // Format data for charting (timestamp + value pairs)
        const formattedData = changes.map(change => ({
          timestamp: change.time,
          value: change.new_value,
          old_value: change.old_value,
          system_state: {
            battery_soc: change.battery_soc,
            pv_power: change.pv_power,
            load: change.load,
            grid_voltage: change.grid_voltage,
            grid_power: change.grid_power,
            inverter_state: change.inverter_state
          }
        }))
        
        res.json({
          success: true,
          setting,
          data: formattedData,
          count: formattedData.length
        })
      } catch (error) {
        console.error(`Error retrieving ${req.params.setting} history:`, error)
        res.status(500).json({ error: 'Failed to retrieve setting history' })
      }
    })
  
  // Add API endpoint for voltage point changes
  app.get('/api/voltage-point-changes', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
      }
      
      const voltagePointChanges = await influx.query(`
        SELECT *
        FROM "settings_policy"."setting_changes"
        WHERE ("change_type" = 'voltage_point' OR "topic" =~ /.*voltage_point.*/)
        ORDER BY time DESC
        LIMIT 100
      `)
      
      res.json(voltagePointChanges)
    } catch (error) {
      console.error('Error retrieving voltage point changes:', error)
      res.status(500).json({ error: 'Failed to retrieve data' })
    }
  })
  
  // Add route for grid charge view
  app.get('/grid-charge', async (req, res) => {
    try {
      let changesCount = 0
      if (dbConnected) {
        const result = await influx.query(`
          SELECT count("new_value")
          FROM "setting_changes" 
          WHERE ("change_type" = 'grid_charge' OR "topic" =~ /.*grid_charge.*/)
        `)
        
        if (result && result.length > 0) {
          changesCount = result[0].count
        }
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
  
  // API endpoint for grid charge changes
  app.get('/api/grid-charge-changes', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
      }
      
      const gridChargeChanges = await influx.query(`
        SELECT *
        FROM "settings_policy"."setting_changes"
        WHERE ("change_type" = 'grid_charge' OR 
               "change_type" = 'max_grid_charge_current' OR
               "topic" =~ /.*grid_charge.*/)
        ORDER BY time DESC
        LIMIT 100
      `)
      
      res.json(gridChargeChanges)
    } catch (error) {
      console.error('Error retrieving grid charge changes:', error)
      res.status(500).json({ error: 'Failed to retrieve data' })
    }
  })

app.get('/battery-charging', async (req, res) => {
  try {
    let changesCount = 0
    if (dbConnected) {
      const result = await influx.query(`
        SELECT count("new_value") 
        FROM "settings_policy"."setting_changes"
        WHERE "change_type" = 'max_discharge_current' OR
              "change_type" = 'max_charge_current' OR
              "change_type" = 'max_grid_charge_current' OR
              "change_type" = 'max_generator_charge_current' OR
              "change_type" = 'battery_float_charge_voltage' OR
              "change_type" = 'battery_absorption_charge_voltage' OR
              "change_type" = 'battery_equalization_charge_voltage'
      `)
      
      if (result && result.length > 0) {
        changesCount = result[0].count_new_value || 0
      }
    }
    
    res.render('battery-charging', { 
      active: learnerModeActive,
      changes_count: changesCount,
      db_connected: dbConnected
    })
  } catch (error) {
    console.error('Error rendering battery-charging page:', error)
    res.status(500).send('Error loading page data')
  }
})

  
  // Add route for energy pattern view
  app.get('/energy-pattern', async (req, res) => {
    try {
      let changesCount = 0
      if (dbConnected) {
        const result = await influx.query(`
          SELECT count("new_value")
          FROM "setting_changes" 
          WHERE ("change_type" = 'energy_pattern' OR "topic" =~ /.*energy_pattern.*/)
        `)
        
        if (result && result.length > 0) {
          changesCount = result[0].count
        }
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
  
  // Add route for voltage point view
  app.get('/voltage-point', async (req, res) => {
    try {
      let changesCount = 0
      if (dbConnected) {
        const result = await influx.query(`
          SELECT count("new_value")
          FROM "setting_changes" 
          WHERE ("change_type" = 'voltage_point' OR "topic" =~ /.*voltage_point.*/)
        `)
        
        if (result && result.length > 0) {
          changesCount = result[0].count
        }
      }
      
      res.render('voltage-point', { 
        active: learnerModeActive,
        changes_count: changesCount,
        db_connected: dbConnected
      })
    } catch (error) {
      console.error('Error rendering voltage-point page:', error)
      res.status(500).send('Error loading page data')
    }
  })
  
  // Rule wizard page
  app.get('/wizard', async (req, res) => {
    try {
      // Check if editing an existing rule (optional)
      const ruleId = req.query.edit
      let rule = null
      
      if (ruleId && dbConnected) {
        // Query InfluxDB for rule details
        const ruleResults = await influx.query(`
          SELECT last("name"), last("description"), last("active"), 
                 last("conditions"), last("actions"), last("timeRestrictions")
          FROM "rules"
          WHERE "rule_id" = ${Influx.escape.stringLit(ruleId)}
          GROUP BY "rule_id"
        `)
        
        if (ruleResults && ruleResults.length > 0) {
          rule = {
            id: ruleId,
            name: ruleResults[0].last_name,
            description: ruleResults[0].last_description,
            active: ruleResults[0].last_active,
            conditions: JSON.parse(ruleResults[0].last_conditions || '[]'),
            timeRestrictions: JSON.parse(ruleResults[0].last_timeRestrictions || '{}'),
            actions: JSON.parse(ruleResults[0].last_actions || '[]')
          }
        }
      }
      
      // Get current system state for reference
      const systemState = { ...currentSystemState }
      
      // Get the number of inverters from config
      const numInverters = inverterNumber || 1
      
      res.render('wizard', { 
        rule,
        systemState,
        numInverters,
        editMode: !!ruleId,
        db_connected: dbConnected
      })
    } catch (error) {
      console.error('Error rendering wizard page:', error)
      res.status(500).send('Error loading wizard page')
    }
  })
  
  // ================ RULES MANAGEMENT API ================
  
  // Create a new rule
  app.post('/api/rules', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
      }
      
      // Validate the request body
      const { name, description, active, conditions, timeRestrictions, actions } = req.body
      
      if (!name) {
        return res.status(400).json({ error: 'Rule name is required' })
      }
      
      if (!actions || actions.length === 0) {
        return res.status(400).json({ error: 'At least one action is required' })
      }
      
      // Generate a new rule ID
      const ruleId = `rule-${ruleIdCounter++}`
      
      // Create the rule in InfluxDB
      await influx.writePoint({
        measurement: 'rules',
        tags: {
          rule_id: ruleId,
          name: name.substring(0, 64) // Keep tag size reasonable
        },
        fields: {
          name: name,
          description: description || '',
          active: active !== undefined ? active : true,
          conditions: JSON.stringify(conditions || []),
          actions: JSON.stringify(actions || []),
          timeRestrictions: JSON.stringify(timeRestrictions || {}),
          triggerCount: 0
        },
        timestamp: new Date()
      }, {
        precision: 'ms',
        retentionPolicy: 'rules_policy'
      })
      
      // Add to in-memory rules array
      const newRule = {
        id: ruleId,
        name,
        description: description || '',
        active: active !== undefined ? active : true,
        conditions: conditions || [],
        timeRestrictions: timeRestrictions || {},
        actions: actions || [],
        triggerCount: 0,
        lastTriggered: null
      }
      
      rules.push(newRule)
      
      // Also save to file as backup
      await saveRules()
      
      // Log the creation
      console.log(`Rule "${name}" created successfully with ID ${ruleId}`)
      
      res.status(201).json(newRule)
    } catch (error) {
      console.error('Error creating rule:', error)
      res.status(400).json({ error: error.message })
    }
  })
  
  // Update an existing rule
  app.put('/api/rules/:id', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
      }
      
      const ruleId = req.params.id
      const { name, description, active, conditions, timeRestrictions, actions } = req.body
      
      if (!name) {
        return res.status(400).json({ error: 'Rule name is required' })
      }
      
      if (!actions || actions.length === 0) {
        return res.status(400).json({ error: 'At least one action is required' })
      }
      
      // Find rule in memory
      const ruleIndex = rules.findIndex(r => r.id === ruleId)
      if (ruleIndex === -1) {
        return res.status(404).json({ error: 'Rule not found' })
      }
      
      // Update the rule in InfluxDB
      await influx.writePoint({
        measurement: 'rules',
        tags: {
          rule_id: ruleId,
          name: name.substring(0, 64) // Keep tag size reasonable
        },
        fields: {
          name: name,
          description: description || '',
          active: active !== undefined ? active : true,
          conditions: JSON.stringify(conditions || []),
          actions: JSON.stringify(actions || []),
          timeRestrictions: JSON.stringify(timeRestrictions || {}),
          triggerCount: rules[ruleIndex].triggerCount || 0
        },
        timestamp: new Date()
      }, {
        precision: 'ms',
        retentionPolicy: 'rules_policy'
      })
      
      // Update in-memory rule
      rules[ruleIndex] = {
        ...rules[ruleIndex],
        name,
        description: description || '',
        active: active !== undefined ? active : true,
        conditions: conditions || [],
        timeRestrictions: timeRestrictions || {},
        actions: actions || []
      }
      
      // Save to file as backup
      await saveRules()
      
      console.log(`Rule "${name}" updated successfully`)
      
      res.json(rules[ruleIndex])
    } catch (error) {
      console.error('Error updating rule:', error)
      res.status(400).json({ error: error.message })
    }
  })
  
  // Duplicate a rule
  app.post('/api/rules/:id/duplicate', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
      }
      
      const ruleId = req.params.id
      
      // Find original rule
      const originalRule = rules.find(r => r.id === ruleId)
      if (!originalRule) {
        return res.status(404).json({ error: 'Rule not found' })
      }
      
      // Generate a new rule ID
      const newRuleId = `rule-${ruleIdCounter++}`
      
      // Create new rule based on original
      const newRule = {
        id: newRuleId,
        name: `Copy of ${originalRule.name}`,
        description: originalRule.description,
        active: originalRule.active,
        conditions: originalRule.conditions,
        timeRestrictions: originalRule.timeRestrictions,
        actions: originalRule.actions,
        triggerCount: 0,
        lastTriggered: null
      }
      
      // Add to InfluxDB
      await influx.writePoint({
        measurement: 'rules',
        tags: {
          rule_id: newRuleId,
          name: newRule.name.substring(0, 64) // Keep tag size reasonable
        },
        fields: {
          name: newRule.name,
          description: newRule.description || '',
          active: newRule.active,
          conditions: JSON.stringify(newRule.conditions || []),
          actions: JSON.stringify(newRule.actions || []),
          timeRestrictions: JSON.stringify(newRule.timeRestrictions || {}),
          triggerCount: 0
        },
        timestamp: new Date()
      }, {
        precision: 'ms',
        retentionPolicy: 'rules_policy'
      })
      
      // Add to in-memory rules array
      rules.push(newRule)
      
      // Save to file as backup
      await saveRules()
      
      console.log(`Rule "${originalRule.name}" duplicated as "${newRule.name}"`)
      
      res.status(201).json(newRule)
    } catch (error) {
      console.error('Error duplicating rule:', error)
      res.status(400).json({ error: error.message })
    }
  })
  
  // View rule execution history
  app.get('/rule-history', async (req, res) => {
    try {
      let ruleHistory = []
      let systemState = { ...currentSystemState }
      
      if (dbConnected) {
        // Get all rule executions from InfluxDB
        const executionResults = await influx.query(`
          SELECT rule_id, rule_name, rule_description, last(rule_name) AS rule_name_last
          FROM "rule_executions"
          GROUP BY "rule_id"
          ORDER BY time DESC
          LIMIT 100
        `)
        
        for (const execution of executionResults) {
          // Get additional rule details
          const ruleDetails = rules.find(r => r.id === execution.rule_id) || {
            name: execution.rule_name,
            description: execution.rule_description,
            actions: [],
            triggerCount: 0
          }
          
          ruleHistory.push({
            id: execution.rule_id,
            name: ruleDetails.name,
            description: ruleDetails.description,
            lastTriggered: execution.time,
            triggerCount: ruleDetails.triggerCount
          })
        }
      }
      
      res.render('rule-history', {
        ruleHistory,
        db_connected: dbConnected,
        system_state: systemState
      })
    } catch (error) {
      console.error('Error rendering rule history page:', error)
      res.status(500).send('Error loading rule history page')
    }
  })
  
  // API route to get rule execution history
  app.get('/api/rules/history', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
      }
      
      const limit = parseInt(req.query.limit) || 50
      const skip = parseInt(req.query.skip) || 0
      
      // Get rule executions from InfluxDB
      // Note: InfluxDB doesn't support skip/offset in the same way as MongoDB,
      // so this implementation is simplified
      const query = `
        SELECT rule_id, rule_name, rule_description, actions, 
               battery_soc, pv_power, load, grid_voltage, grid_power
        FROM "rule_executions"
        ORDER BY time DESC
        LIMIT ${limit}
      `
      
      const executionResults = await influx.query(query)
      
      // Format results
      const ruleHistory = executionResults.map(execution => {
        // Get additional rule details from in-memory rules
        const ruleDetails = rules.find(r => r.id === execution.rule_id) || {
          name: execution.rule_name,
          description: execution.rule_description
        }
        
        return {
          id: execution.rule_id,
          name: ruleDetails.name,
          description: ruleDetails.description,
          lastTriggered: execution.time,
          actions: JSON.parse(execution.actions || '[]'),
          systemState: {
            battery_soc: execution.battery_soc,
            pv_power: execution.pv_power,
            load: execution.load,
            grid_voltage: execution.grid_voltage,
            grid_power: execution.grid_power
          }
        }
      })
      
      // Get total count for pagination
      const countQuery = `
        SELECT COUNT(rule_id) as count
        FROM "rule_executions"
      `
      
      const countResults = await influx.query(countQuery)
      const totalCount = countResults.length > 0 ? countResults[0].count : 0
      
      res.json({
        rules: ruleHistory,
        pagination: {
          total: totalCount,
          limit,
          skip,
          hasMore: skip + limit < totalCount
        }
      })
    } catch (error) {
      console.error('Error fetching rule history:', error)
      res.status(500).json({ error: 'Failed to retrieve rule history' })
    }
  })
  
  // API for rule statistics
  app.get('/api/rules/statistics', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ 
          totalRules: 0,
          totalExecutions: 0,
          last24Hours: 0,
          mostActiveRule: 'None'
        })
      }
      
      // Get total rules count
      const totalRules = rules.length
      
      // Calculate total executions
      const totalExecutionsQuery = `
        SELECT COUNT(rule_name) as count
        FROM "rule_executions"
      `
      
      const totalExecutionsResults = await influx.query(totalExecutionsQuery)
      const totalExecutions = totalExecutionsResults.length > 0 ? totalExecutionsResults[0].count : 0
      
      // Find most active rule
      const activeRuleQuery = `
        SELECT rule_id, rule_name, COUNT(rule_name) as count
        FROM "rule_executions"
        GROUP BY rule_id
        ORDER BY count DESC
        LIMIT 1
      `
      
      const activeRuleResults = await influx.query(activeRuleQuery)
      const mostActiveRule = activeRuleResults.length > 0 ? activeRuleResults[0].rule_name : 'None'
      
      // Calculate executions in the last 24 hours
      const last24HoursQuery = `
        SELECT COUNT(rule_name) as count
        FROM "rule_executions"
        WHERE time > now() - 24h
      `
      
      const last24HoursResults = await influx.query(last24HoursQuery)
      const last24Hours = last24HoursResults.length > 0 ? last24HoursResults[0].count : 0
      
      res.json({
        totalRules,
        totalExecutions,
        last24Hours,
        mostActiveRule
      })
    } catch (error) {
      console.error('Error fetching rule statistics:', error)
      // Return default values if error occurs
      res.json({
        totalRules: 0,
        totalExecutions: 0,
        last24Hours: 0,
        mostActiveRule: 'None'
      })
    }
  })
  
  // Get execution history for a specific rule
  app.get('/api/rules/:id/execution-history', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
      }
      
      const ruleId = req.params.id
      
      // Find rule in memory
      const rule = rules.find(r => r.id === ruleId)
      if (!rule) {
        return res.status(404).json({ error: 'Rule not found' })
      }
      
      // Get rule execution history from InfluxDB
      const executionQuery = `
        SELECT rule_name, rule_description, actions, 
               battery_soc, pv_power, load, grid_voltage, grid_power
        FROM "rule_executions"
        WHERE "rule_id" = ${Influx.escape.stringLit(ruleId)}
        ORDER BY time DESC
        LIMIT 20
      `
      
      const executionResults = await influx.query(executionQuery)
      
      // Format execution history
      const executionHistory = executionResults.map(execution => ({
        timestamp: execution.time,
        actions: JSON.parse(execution.actions || '[]'),
        systemState: {
          battery_soc: execution.battery_soc,
          pv_power: execution.pv_power,
          load: execution.load,
          grid_voltage: execution.grid_voltage,
          grid_power: execution.grid_power
        }
      }))
      
      // Get full rule details
      const ruleDetails = {
        id: rule.id,
        name: rule.name,
        description: rule.description,
        active: rule.active,
        conditions: rule.conditions,
        actions: rule.actions,
        timeRestrictions: rule.timeRestrictions,
        lastTriggered: rule.lastTriggered,
        triggerCount: rule.triggerCount || 0
      }
      
      res.json({
        rule: ruleDetails,
        executionHistory
      })
    } catch (error) {
      console.error('Error fetching rule execution history:', error)
      res.status(500).json({ error: 'Failed to retrieve rule execution history' })
    }
  })
  
  // Execute a rule manually
  app.post('/api/rules/:id/execute', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
      }
      
      // Check if learner mode is active
      if (!learnerModeActive) {
        return res.status(403).json({ error: 'Learner mode is not active. Cannot execute rules.' })
      }
      
      const ruleId = req.params.id
      
      // Find rule in memory
      const ruleIndex = rules.findIndex(r => r.id === ruleId)
      if (ruleIndex === -1) {
        return res.status(404).json({ error: 'Rule not found' })
      }
      
      // Execute rule actions
      if (rules[ruleIndex].actions && rules[ruleIndex].actions.length > 0) {
        let allActionsApplied = true
        
        rules[ruleIndex].actions.forEach(action => {
          const actionApplied = applyAction(action)
          if (!actionApplied) {
            allActionsApplied = false
          }
        })
        
        if (!allActionsApplied) {
          return res.status(403).json({ error: 'Some or all actions could not be applied because learner mode is inactive' })
        }
      } else {
        return res.status(400).json({ error: 'Rule has no actions to execute' })
      }
      
      // Update rule statistics
      const timestamp = new Date()
      rules[ruleIndex].lastTriggered = timestamp
      rules[ruleIndex].triggerCount = (rules[ruleIndex].triggerCount || 0) + 1
      
      // Save to InfluxDB
      await influx.writePoint({
        measurement: 'rule_executions',
        tags: {
          rule_id: ruleId
        },
        fields: {
          rule_name: rules[ruleIndex].name,
          rule_description: rules[ruleIndex].description || '',
          actions: JSON.stringify(rules[ruleIndex].actions),
          battery_soc: currentSystemState.battery_soc,
          pv_power: currentSystemState.pv_power,
          load: currentSystemState.load,
          grid_voltage: currentSystemState.grid_voltage,
          grid_power: currentSystemState.grid_power
        },
        timestamp
      }, {
        precision: 'ms',
        retentionPolicy: 'rules_policy'
      })
      
      // Update rule in InfluxDB
      await influx.writePoint({
        measurement: 'rules',
        tags: {
          rule_id: ruleId,
          name: rules[ruleIndex].name.substring(0, 64)
        },
        fields: {
          name: rules[ruleIndex].name,
          description: rules[ruleIndex].description || '',
          active: rules[ruleIndex].active,
          conditions: JSON.stringify(rules[ruleIndex].conditions || []),
          actions: JSON.stringify(rules[ruleIndex].actions || []),
          timeRestrictions: JSON.stringify(rules[ruleIndex].timeRestrictions || {}),
          triggerCount: rules[ruleIndex].triggerCount
        },
        timestamp
      }, {
        precision: 'ms',
        retentionPolicy: 'rules_policy'
      })
      
      // Save to file as backup
      await saveRules()
      
      console.log(`Rule "${rules[ruleIndex].name}" manually executed at ${timestamp}`)
      
      res.json({ 
        message: `Rule "${rules[ruleIndex].name}" executed successfully`, 
        execution: {
          ruleId: rules[ruleIndex].id,
          ruleName: rules[ruleIndex].name,
          timestamp: rules[ruleIndex].lastTriggered,
          triggerCount: rules[ruleIndex].triggerCount,
          actions: rules[ruleIndex].actions.map(action => ({
            setting: action.setting,
            value: action.value,
            inverter: action.inverter
          }))
        }
      })
    } catch (error) {
      console.error('Error executing rule:', error)
      res.status(500).json({ error: error.message })
    }
  })
  
  // Rules page
  app.get('/rules', async (req, res) => {
    try {
      let rulesCount = 0
      let activeRulesCount = 0
      let systemState = { ...currentSystemState }
      let recentlyTriggered = []
      
      if (dbConnected) {
        rulesCount = rules.length
        activeRulesCount = rules.filter(r => r.active).length
        
        // Get recently triggered rules (sort in-memory rules by lastTriggered)
        recentlyTriggered = rules
          .filter(r => r.lastTriggered)
          .sort((a, b) => new Date(b.lastTriggered) - new Date(a.lastTriggered))
          .slice(0, 5)
          .map(rule => ({
            name: rule.name,
            lastTriggered: rule.lastTriggered
          }))
      }
      
      res.render('rules', { 
        db_connected: dbConnected,
        rules_count: rulesCount,
        active_rules_count: activeRulesCount,
        system_state: systemState,
        recently_triggered: recentlyTriggered
      })
    } catch (error) {
      console.error('Error rendering rules page:', error)
      res.status(500).send('Error loading page data')
    }
  })
  
  // Get all rules
  app.get('/api/rules', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
      }
      
      // Return the in-memory rules array (which is synced with InfluxDB)
      res.json(rules)
    } catch (error) {
      console.error('Error retrieving rules:', error)
      res.status(500).json({ error: 'Failed to retrieve rules' })
    }
  })
  
  // Delete a rule
  app.delete('/api/rules/:id', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
      }
      
      const ruleId = req.params.id
      
      // Find rule in memory
      const ruleIndex = rules.findIndex(r => r.id === ruleId)
      if (ruleIndex === -1) {
        return res.status(404).json({ error: 'Rule not found' })
      }
      
      // Remove from memory
      const deletedRule = rules.splice(ruleIndex, 1)[0]
      
      // Save to file as backup
      await saveRules()
      
      // Note: InfluxDB doesn't support true deletion in the same way as MongoDB
      // We can mark it as deleted by writing a new point with a "deleted" field
      await influx.writePoint({
        measurement: 'rules',
        tags: {
          rule_id: ruleId,
          name: deletedRule.name.substring(0, 64)
        },
        fields: {name: deletedRule.name.substring(0, 64)
        },
        fields: {
          name: deletedRule.name,
          description: deletedRule.description || '',
          active: false,
          deleted: true,
          conditions: JSON.stringify(deletedRule.conditions || []),
          actions: JSON.stringify(deletedRule.actions || []),
          timeRestrictions: JSON.stringify(deletedRule.timeRestrictions || {})
        },
        timestamp: new Date()
      }, {
        precision: 'ms',
        retentionPolicy: 'rules_policy'
      })
      
      console.log(`Rule "${deletedRule.name}" deleted successfully`)
      
      res.json({ message: 'Rule deleted successfully' })
    } catch (error) {
      console.error('Error deleting rule:', error)
      res.status(500).json({ error: error.message })
    }
  })
  
  // Get a specific rule
  app.get('/api/rules/:id', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
      }
      
      const ruleId = req.params.id
      
      // Find the rule in memory
      const rule = rules.find(r => r.id === ruleId)
      if (!rule) {
        return res.status(404).json({ error: 'Rule not found' })
      }
      
      res.json(rule)
    } catch (error) {
      console.error('Error retrieving rule:', error)
      res.status(500).json({ error: 'Failed to retrieve rule' })
    }
  })
  
  // API endpoint for current system state
  app.get('/api/system-state', (req, res) => {
    res.json({ 
      current_state: currentSystemState,
      timestamp: new Date()
    })
  })
  
  // Get settings changes with pagination
  app.get('/api/settings-changes', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
      }
      
      const changeType = req.query.type
      const limit = parseInt(req.query.limit) || 100
      const skip = parseInt(req.query.skip) || 0
      
      let query = ''
      if (changeType) {
        query = `WHERE "change_type" = ${Influx.escape.stringLit(changeType)}`
      }
      
      // For pagination in InfluxDB, we need to first get all records and then slice them
      const changes = await influx.query(`
        SELECT *
        FROM "setting_changes"
        ${query}
        ORDER BY time DESC
        LIMIT ${limit + skip}
      `)
      
      // Manual pagination by slicing the results
      const paginatedChanges = changes.slice(skip, skip + limit)
      
      // Count total records - this is less efficient in InfluxDB but necessary for pagination info
      const countQuery = `SELECT count("new_value") FROM "setting_changes" ${query}`
      const countResult = await influx.query(countQuery)
      const total = countResult.length > 0 ? countResult[0].count : 0
      
      res.json({
        changes: paginatedChanges,
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
  
  // API endpoint for learner mode status
  app.get('/api/learner/status', (req, res) => {
    res.json({ 
      active: learnerModeActive,
      monitored_settings: settingsToMonitor,
      current_system_state: currentSystemState,
      db_connected: dbConnected
    })
  })
  
  // Toggle learner mode
  app.post('/api/learner/toggle', (req, res) => {
    learnerModeActive = !learnerModeActive
    
    console.log(`Learner mode ${learnerModeActive ? 'activated' : 'deactivated'}`)
    
    res.json({ 
      success: true, 
      active: learnerModeActive,
      message: `Learner mode ${learnerModeActive ? 'activated' : 'deactivated'}`
    })
  })
  
  // Get recent changes detected by learner mode
  app.get('/api/learner/changes', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
      }
      
      const limit = parseInt(req.query.limit) || 50
      
      const changes = await influx.query(`
        SELECT *
        FROM "settings_policy"."setting_changes"
        ORDER BY time DESC
        LIMIT ${limit}
      `)
      
      // Format the timestamp for each record
      const formattedChanges = changes.map(change => {
        // Create a properly formatted object with the timestamp
        return {
          ...change,
          formatted_time: moment(change.time).format('YYYY-MM-DD HH:mm:ss')
        }
      })
      
      res.json(formattedChanges)
    } catch (error) {
      console.error('Error retrieving learner changes:', error)
      res.status(500).json({ error: 'Failed to retrieve data' })
    }
  })
  
  // Learner mode dashboard
  app.get('/learner', async (req, res) => {
    try {
      let changesCount = 0
      if (dbConnected) {
        const result = await influx.query(`
          SELECT count("new_value")
          FROM "settings_policy"."setting_changes"
        `)
        
        if (result && result.length > 0) {
          changesCount = result[0].count_new_value || 0
        }
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
  
  // Update the direct MQTT command injection route
  app.post('/api/command', (req, res) => {
    try {
      // Check if learner mode is active
      if (!learnerModeActive) {
        return res.status(403).json({ error: 'Learner mode is not active. Cannot send commands.' })
      }
      
      const { topic, value } = req.body
      
      if (!topic || !value) {
        return res.status(400).json({ error: 'Missing topic or value' })
      }
      
      if (!mqttClient || !mqttClient.connected) {
        return res.status(503).json({ error: 'MQTT client not connected' })
      }
      
      mqttClient.publish(topic, value.toString(), { qos: 1, retain: false }, (err) => {
        if (err) {
          console.error(`Error publishing to ${topic}: ${err.message}`)
          return res.status(500).json({ error: err.message })
        }
        
        console.log(`Manual command sent: ${topic} = ${value}`)
        res.json({ success: true, message: `Command sent: ${topic} = ${value}` })
      })
    } catch (error) {
      console.error('Error sending command:', error)
      res.status(500).json({ error: error.message })
    }
  })
  
  // ================ MQTT and CRON SCHEDULING ================
  
  // Connect to MQTT with robust error handling
  function connectToMqtt() {
    mqttClient = mqtt.connect(`mqtt://${mqttConfig.host}:${mqttConfig.port}`, {
      username: mqttConfig.username,
      password: mqttConfig.password,
      reconnectPeriod: mqttConfig.reconnectPeriod,
      connectTimeout: mqttConfig.connectTimeout
    })
  
    mqttClient.on('connect', () => {
      console.log('Connected to MQTT broker')
      // Subscribe to all topics with the prefix
      mqttClient.subscribe(`${mqttTopicPrefix}/#`, (err) => {
        if (err) {
          console.error('Error subscribing to topics:', err.message)
        } else {
          console.log(`Subscribed to ${mqttTopicPrefix}/#`)
        }
      })
    })
  
    mqttClient.on('message', (topic, message) => {
      // Always handle the message for state tracking
      handleMqttMessage(topic, message)
    })
  
    mqttClient.on('error', (err) => {
      console.error('MQTT error:', err.message)
    })
    
    mqttClient.on('disconnect', () => {
      console.log('Disconnected from MQTT broker')
    })
    
    mqttClient.on('reconnect', () => {
      console.log('Reconnecting to MQTT broker...')
    })
  }
  
  // Save MQTT message to InfluxDB with better error handling
  async function saveMessageToInfluxDB(topic, message) {
    try {
      const parsedMessage = parseFloat(message.toString())
  
      if (isNaN(parsedMessage)) {
        return
      }
  
      const timestamp = new Date()
      const dataPoint = {
        measurement: 'state',
        fields: { 
          value: parsedMessage
        },
        tags: { 
          topic: topic
        },
        timestamp
      }
  
      await retry(
        async () => {
          await influx.writePoint(dataPoint, {
            precision: 'ms',
            retentionPolicy: 'system_state_policy'
          })
        },
        {
          retries: 5,
          minTimeout: 1000,
        }
      )
    } catch (err) {
      console.error('Error saving message to InfluxDB:', err.message)
    }
  }
  
  // Periodic rule evaluation (every minute)
  cron.schedule('* * * * *', () => {
    console.log('Running scheduled rule evaluation...')
    processRules()
  })
  
  // Weekend rules scheduling
  cron.schedule('0 0 * * 6', () => {
    console.log('It\'s Saturday! Applying weekend settings...')
    // Can add specific weekend settings here if needed
  })
  
  cron.schedule('0 0 * * 1', () => {
    console.log('It\'s Monday! Reverting weekend settings...')
    // Can add specific weekday settings here if needed
  })
  
  // Graceful shutdown function
  function gracefulShutdown() {
    console.log('Starting graceful shutdown...')
    
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
    
    // Connect to InfluxDB
    try {
      const connected = await connectToInfluxDB()
      
      if (connected && dbConnected) {
        // Load rules from InfluxDB
        await loadRules()
      }
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
