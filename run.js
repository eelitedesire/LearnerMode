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
const mongoose = require('mongoose')
const cron = require('node-cron')

// Modify the Mongoose Schemas to include user identification
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
    change_type: String,
    // Add user identification fields
    user_id: String,
    mqtt_username: String
  })

// Rule Schema with user identification
const RuleSchema = new mongoose.Schema({
    name: { type: String, required: true },
    description: String,
    active: { type: Boolean, default: true },
    conditions: [{
      parameter: String,
      operator: String,
      value: Number,
    }],
    timeRestrictions: {
      days: [String],
      startTime: String,
      endTime: String,
      enabled: Boolean
    },
    actions: [{
      setting: String,
      value: String,
      inverter: String
    }],
    createdAt: { type: Date, default: Date.now },
    lastTriggered: Date,
    triggerCount: { type: Number, default: 0 },
    // Add user identification fields
    user_id: String,
    mqtt_username: String
  })




// Create MongoDB models
let SettingsChange
let Rule
let dbConnected = false

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
const mongoDbUri = options.mongodb_uri || process.env.MONGODB_URI || 'mongodb://localhost:27017/energy_monitor'

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
  host: options.influxdb_host || '192.168.138.27',
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

// Connect to MongoDB database
async function connectToDatabase() {
    try {
      // Set mongoose options
      const options = {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 5000, // Timeout after 5s instead of 30s
        connectTimeoutMS: 10000,
      };
  
      // Connect to MongoDB
      await mongoose.connect(mongoDbUri, options);
      
      console.log('Connected to MongoDB');
      
      // Create models if connection successful
      SettingsChange = mongoose.model('SettingsChange', SettingsChangeSchema);
      Rule = mongoose.model('Rule', RuleSchema);
      
      // Create database indexes
      createDatabaseIndexes();
      
      dbConnected = true;
      
      return true;
    } catch (error) {
      console.error('MongoDB connection error:', error.message);
      dbConnected = false;
      
      // Models will be undefined until successful connection
      SettingsChange = null;
      Rule = null;
      
      return false;
    }
  }
  
// ================ USER IDENTIFICATION SYSTEM ================

// Function to generate a unique user ID based on MQTT credentials
function generateUserId() {
    // Create a unique identifier by combining MQTT username, hostname, and a fixed salt
    const userIdBase = `${mqttConfig.username}:${options.mqtt_host}:${options.mqtt_topic_prefix}`;
    
    // Use a simple hash function to create a shorter ID
    let hash = 0;
    for (let i = 0; i < userIdBase.length; i++) {
      const char = userIdBase.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    
    return `user_${Math.abs(hash).toString(16)}`;
  }
  
  // Store the user ID as a global variable - place this after MQTT config is loaded
  const USER_ID = generateUserId();
  console.log(`Generated User ID: ${USER_ID}`);
  
  // Create database indexes for user identification
  async function createDatabaseIndexes() {
    if (!dbConnected) return;
    
    try {
      await SettingsChange.collection.createIndex({ user_id: 1 });
      
      await Rule.collection.createIndex({ mqtt_username: 1 });
      await Rule.collection.createIndex({ user_id: 1 });
      
      console.log('Database indexes created including user identification');
    } catch (error) {
      console.error('Error creating database indexes:', error.message);
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

  // ** MODIFIED SECTION: Always handle setting changes, regardless of learner mode **
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

  // Always update previousSettings to track the latest values
  if (settingsToMonitor.some(setting => specificTopic.includes(setting))) {
    previousSettings[specificTopic] = messageContent
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
      console.log(`${changeType.toUpperCase()} CHANGE DETECTED: ${specificTopic} - ${messageContent}`);
      
      // Create a detailed change record with user identification
      const changeData = {
        timestamp: new Date(),
        topic: specificTopic,
        old_value: previousSettings[specificTopic],
        new_value: messageContent,
        system_state: { ...currentSystemState },
        change_type: changeType,
        // Add user identification
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      };
      
      // Update previous settings
      previousSettings[specificTopic] = messageContent;
      
      // Save to database if connected
      if (dbConnected && SettingsChange) {
        try {
          const settingsChange = new SettingsChange(changeData);
          await settingsChange.save();
          console.log('Change saved to database');
        } catch (error) {
          console.error('Error saving to database:', error.message);
          // If DB fails, log to console as fallback
          console.log('Change data (fallback):', JSON.stringify(changeData));
        }
      } else {
        // Not connected to DB, log to console as fallback
        console.log('Database not connected, logging change to console');
        console.log('Change data:', JSON.stringify(changeData));
        
        // Try to connect to database in background
        retryDatabaseConnection();
      }
      
      // Send notifications based on change type
      if (changeType === 'grid_charge') {
        sendGridChargeNotification(changeData);
      } else if (changeType === 'energy_pattern') {
        sendEnergyPatternNotification(changeData);
      } else if (changeType === 'voltage_point') {
        sendVoltagePointNotification(changeData);
      }
    }
  }

// Function to handle battery charging setting changes
async function handleBatteryChargingSettingChange(specificTopic, messageContent, settingType) {
    // Only proceed if the setting has changed
    if (previousSettings[specificTopic] !== messageContent) {
      console.log(`${settingType.toUpperCase()} CHANGE DETECTED: ${specificTopic} - ${messageContent}`);
      
      // Create a detailed change record with user identification
      const changeData = {
        timestamp: new Date(),
        topic: specificTopic,
        old_value: previousSettings[specificTopic],
        new_value: messageContent,
        system_state: { ...currentSystemState },
        change_type: settingType,
        // Add user identification
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      };
      
      // Update previous settings
      previousSettings[specificTopic] = messageContent;
      
      // Save to database if connected
      if (dbConnected && SettingsChange) {
        try {
          const settingsChange = new SettingsChange(changeData);
          await settingsChange.save();
          console.log('Battery charging setting change saved to database');
        } catch (error) {
          console.error('Error saving to database:', error.message);
          // If DB fails, log to console as fallback
          console.log('Change data (fallback):', JSON.stringify(changeData));
        }
      } else {
        // Not connected to DB, log to console as fallback
        console.log('Database not connected, logging change to console');
        console.log('Change data:', JSON.stringify(changeData));
        
        // Try to connect to database in background
        retryDatabaseConnection();
      }
      
      // Send notification
      sendBatteryChargingNotification(changeData);
    }
  }

// Function to handle work mode setting changes
async function handleWorkModeSettingChange(specificTopic, messageContent, settingType) {
    // Only proceed if the setting has changed
    if (previousSettings[specificTopic] !== messageContent) {
      console.log(`${settingType.toUpperCase()} CHANGE DETECTED: ${specificTopic} - ${messageContent}`);
      
      // Create a detailed change record with user identification
      const changeData = {
        timestamp: new Date(),
        topic: specificTopic,
        old_value: previousSettings[specificTopic],
        new_value: messageContent,
        system_state: { ...currentSystemState },
        change_type: settingType,
        // Add user identification
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      };
      
      // Update previous settings
      previousSettings[specificTopic] = messageContent;
      
      // Save to database if connected
      if (dbConnected && SettingsChange) {
        try {
          const settingsChange = new SettingsChange(changeData);
          await settingsChange.save();
          console.log('Work mode setting change saved to database');
        } catch (error) {
          console.error('Error saving to database:', error.message);
          // If DB fails, log to console as fallback
          console.log('Change data (fallback):', JSON.stringify(changeData));
        }
      } else {
        // Not connected to DB, log to console as fallback
        console.log('Database not connected, logging change to console');
        console.log('Change data:', JSON.stringify(changeData));
        
        // Try to connect to database in background
        retryDatabaseConnection();
      }
      
      // Send notification
      sendWorkModeNotification(changeData);
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
    console.warn('Cannot apply action: Learner mode is not active');
    return false;
  }

  const { setting, value, inverter } = action;
  let inverters = [];
  
  // Determine which inverters to apply the action to
  if (inverter === 'all') {
    // Apply to all inverters
    for (let i = 1; i <= inverterNumber; i++) {
      inverters.push(`inverter_${i}`);
    }
  } else {
    // Apply to a specific inverter
    inverters.push(inverter);
  }
  
  // Apply the action to each inverter
  inverters.forEach(inv => {
    let topic, mqttValue;
    
    // Construct the topic and value based on the setting
    switch (setting) {
      // Existing settings
      case 'grid_charge':
        topic = `${mqttTopicPrefix}/${inv}/grid_charge/set`;
        mqttValue = value;
        break;
      case 'energy_pattern':
        topic = `${mqttTopicPrefix}/${inv}/energy_pattern/set`;
        mqttValue = value;
        break;
      
      // Battery charging settings
      case 'max_discharge_current':
        topic = `${mqttTopicPrefix}/${inv}/max_discharge_current/set`;
        mqttValue = value;
        break;
      case 'max_charge_current':
        topic = `${mqttTopicPrefix}/${inv}/max_charge_current/set`;
        mqttValue = value;
        break;
      case 'max_grid_charge_current':
        topic = `${mqttTopicPrefix}/${inv}/max_grid_charge_current/set`;
        mqttValue = value;
        break;
      case 'max_generator_charge_current':
        topic = `${mqttTopicPrefix}/${inv}/max_generator_charge_current/set`;
        mqttValue = value;
        break;
      case 'battery_float_charge_voltage':
        topic = `${mqttTopicPrefix}/${inv}/battery_float_charge_voltage/set`;
        mqttValue = value;
        break;
      case 'battery_absorption_charge_voltage':
        topic = `${mqttTopicPrefix}/${inv}/battery_absorption_charge_voltage/set`;
        mqttValue = value;
        break;
      case 'battery_equalization_charge_voltage':
        topic = `${mqttTopicPrefix}/${inv}/battery_equalization_charge_voltage/set`;
        mqttValue = value;
        break;
        
      // Work mode settings
      case 'remote_switch':
        topic = `${mqttTopicPrefix}/${inv}/remote_switch/set`;
        mqttValue = value;
        break;
      case 'generator_charge':
        topic = `${mqttTopicPrefix}/${inv}/generator_charge/set`;
        mqttValue = value;
        break;
      case 'force_generator_on':
        topic = `${mqttTopicPrefix}/${inv}/force_generator_on/set`;
        mqttValue = value;
        break;
      case 'output_shutdown_voltage':
        topic = `${mqttTopicPrefix}/${inv}/output_shutdown_voltage/set`;
        mqttValue = value;
        break;
      case 'stop_battery_discharge_voltage':
        topic = `${mqttTopicPrefix}/${inv}/stop_battery_discharge_voltage/set`;
        mqttValue = value;
        break;
      case 'start_battery_discharge_voltage':
        topic = `${mqttTopicPrefix}/${inv}/start_battery_discharge_voltage/set`;
        mqttValue = value;
        break;
      case 'start_grid_charge_voltage':
        topic = `${mqttTopicPrefix}/${inv}/start_grid_charge_voltage/set`;
        mqttValue = value;
        break;
        
      // Work mode detail settings
      case 'work_mode':
        topic = `${mqttTopicPrefix}/${inv}/work_mode/set`;
        mqttValue = value;
        break;
      case 'solar_export_when_battery_full':
        topic = `${mqttTopicPrefix}/${inv}/solar_export_when_battery_full/set`;
        mqttValue = value;
        break;
      case 'max_sell_power':
        topic = `${mqttTopicPrefix}/${inv}/max_sell_power/set`;
        mqttValue = value;
        break;
      case 'max_solar_power':
        topic = `${mqttTopicPrefix}/${inv}/max_solar_power/set`;
        mqttValue = value;
        break;
      case 'grid_trickle_feed':
        topic = `${mqttTopicPrefix}/${inv}/grid_trickle_feed/set`;
        mqttValue = value;
        break;
        
      // Voltage point settings (existing)
      case 'voltage_point_1':
      case 'voltage_point_2':
      case 'voltage_point_3':
      case 'voltage_point_4':
      case 'voltage_point_5':
      case 'voltage_point_6':
        topic = `${mqttTopicPrefix}/${inv}/${setting}/set`;
        mqttValue = value;
        break;
      default:
        console.warn(`Unknown setting: ${setting}`);
        return;
    }
    
    // Send the command via MQTT
    if (mqttClient && mqttClient.connected) {
      mqttClient.publish(topic, mqttValue.toString(), { qos: 1, retain: false }, (err) => {
        if (err) {
          console.error(`Error publishing to ${topic}: ${err.message}`);
        } else {
          console.log(`Command sent: ${topic} = ${mqttValue}`);
        }
      });
    } else {
      console.warn('MQTT client not connected, cannot send command');
    }
  });
  
  return true;
}

// Function to process all rules
async function processRules() {
    if (!dbConnected) return;
    
    try {
      // Get all active rules for the current user
      const rules = await Rule.find({ 
        active: true,
        user_id: USER_ID // Filter by user ID
      });
      
      for (const rule of rules) {
        // Check time restrictions
        if (rule.timeRestrictions && rule.timeRestrictions.enabled) {
          const { days, startTime, endTime, specificDates } = rule.timeRestrictions;
          
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
          
          // Check specific dates (if configured)
          if (specificDates && specificDates.length > 0) {
            const today = moment().format('YYYY-MM-DD');
            const isSpecialDate = specificDates.includes(today);
            
            // If specific dates are defined but today is not in the list, skip
            if (!isSpecialDate) {
              continue;
            }
          }
        }
        
        // Check if all conditions are met
        const allConditionsMet = rule.conditions.length === 0 || 
          rule.conditions.every(condition => evaluateCondition(condition));
        
        if (allConditionsMet) {
          console.log(`Rule "${rule.name}" triggered: ${rule.description}`);
          
          // We always record the rule match, but only apply actions if learner mode is active
          if (learnerModeActive) {
            // Apply all actions
            rule.actions.forEach(action => {
              applyAction(action);
            });
          } else {
            console.log(`Rule "${rule.name}" matched conditions but actions weren't applied because learner mode is inactive`);
          }
          
          // Always update rule statistics regardless of whether we applied the action
          rule.lastTriggered = new Date();
          rule.triggerCount += 1;
          await rule.save();
        }
      }
    } catch (error) {
      console.error('Error processing rules:', error);
    }
  }

// Function to create a default set of rules if none exist
async function createDefaultRules() {
    if (!dbConnected) return
    
    try {
      // Check if this user already has rules
      const count = await Rule.countDocuments({ user_id: USER_ID })
      
      if (count === 0) {
        console.log('Creating default rules for user:', USER_ID)
        
        // Rule 1: If load is lower than 5000W, change energy pattern to battery first
        const rule1 = new Rule({
          name: 'Low Load Battery First',
          description: 'If load is lower than 5000W, change energy pattern to battery first',
          active: true,
          conditions: [{
            parameter: 'load',
            operator: 'lt',
            value: 5000
          }],
          actions: [{
            setting: 'energy_pattern',
            value: 'Battery first',
            inverter: 'all'
          }],
          user_id: USER_ID,
          mqtt_username: mqttConfig.username
        })
        
        // Rule 2: If SOC is lower than 20%, turn Grid charge on
        const rule2 = new Rule({
          name: 'Low Battery Enable Grid Charge',
          description: 'If SOC is lower than 20%, turn Grid charge on',
          active: true,
          conditions: [{
            parameter: 'battery_soc',
            operator: 'lt',
            value: 20
          }],
          actions: [{
            setting: 'grid_charge',
            value: 'Enabled',
            inverter: 'all'
          }],
          user_id: USER_ID,
          mqtt_username: mqttConfig.username
        })
        
        // Rule 3: Turn Grid charge off on weekends
        const rule3 = new Rule({
          name: 'Weekend Grid Charge Off',
          description: 'Turn Grid charge off every Saturday and Sunday',
          active: true,
          timeRestrictions: {
            days: ['saturday', 'sunday'],
            enabled: true
          },
          conditions: [],
          actions: [{
            setting: 'grid_charge',
            value: 'Disabled',
            inverter: 'all'
          }],
          user_id: USER_ID,
          mqtt_username: mqttConfig.username
        })
        
        // Rule 4: Complex condition for grid charge
        const rule4 = new Rule({
          name: 'Smart Grid Charge Management',
          description: 'If SOC < 70% AND Load < 10000W AND PV > 8000W, turn Grid charge ON',
          active: true,
          conditions: [
            {
              parameter: 'battery_soc',
              operator: 'lt',
              value: 70
            },
            {
              parameter: 'load',
              operator: 'lt',
              value: 10000
            },
            {
              parameter: 'pv_power',
              operator: 'gt',
              value: 8000
            }
          ],
          actions: [{
            setting: 'grid_charge',
            value: 'Enabled',
            inverter: 'all'
          }],
          user_id: USER_ID,
          mqtt_username: mqttConfig.username
        })
        
        // Rule 5: Emergency grid charge off
        const rule5 = new Rule({
          name: 'Emergency Grid Charge Off',
          description: 'If load > 13000W OR PV < 8000W, turn Grid charge OFF (9:00-17:00)',
          active: true,
          timeRestrictions: {
            startTime: '09:00',
            endTime: '17:00',
            enabled: true
          },
          conditions: [
            {
              parameter: 'load',
              operator: 'gt',
              value: 13000
            }
          ],
          actions: [{
            setting: 'grid_charge',
            value: 'Disabled',
            inverter: 'all'
          }],
          user_id: USER_ID,
          mqtt_username: mqttConfig.username
        })
        
        // Save all default rules
        await Promise.all([
          rule1.save(),
          rule2.save(),
          rule3.save(),
          rule4.save(),
          rule5.save()
        ])
        
        console.log('Default rules created for user:', USER_ID)
      }
    } catch (error) {
      console.error('Error creating default rules:', error.message)
    }
  }


// ================ API ROUTES ================

// API Routes with database integration

app.get('/api/energy-pattern-changes', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
      }
      
      const energyPatternChanges = await SettingsChange.find({ 
        $or: [
          { topic: { $regex: 'energy_pattern' } },
          { change_type: 'energy_pattern' }
        ],
        user_id: USER_ID // Filter by user ID
      }).sort({ timestamp: -1 })
      
      res.json(energyPatternChanges)
    } catch (error) {
      console.error('Error retrieving energy pattern changes:', error)
      res.status(500).json({ error: 'Failed to retrieve data' })
    }
  })

// === Add API endpoints for retrieving battery charging settings changes ===
app.get('/api/battery-charging-changes', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
      }
      
      const batteryChargingChanges = await SettingsChange.find({ 
        $or: [
          { topic: { $regex: 'max_discharge_current|max_charge_current|max_grid_charge_current|max_generator_charge_current|battery_float_charge_voltage|battery_absorption_charge_voltage|battery_equalization_charge_voltage' } },
          { change_type: { $in: [
            'max_discharge_current', 
            'max_charge_current', 
            'max_grid_charge_current', 
            'max_generator_charge_current', 
            'battery_float_charge_voltage', 
            'battery_absorption_charge_voltage', 
            'battery_equalization_charge_voltage'
          ] } }
        ],
        user_id: USER_ID // Filter by user ID
      }).sort({ timestamp: -1 })
      
      res.json(batteryChargingChanges)
    } catch (error) {
      console.error('Error retrieving battery charging changes:', error)
      res.status(500).json({ error: 'Failed to retrieve data' })
    }
  })

// === Add API endpoints for retrieving work mode settings changes ===
app.get('/api/work-mode-changes', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
      }
      
      const workModeChanges = await SettingsChange.find({ 
        $or: [
          { topic: { $regex: 'remote_switch|generator_charge|force_generator_on|output_shutdown_voltage|stop_battery_discharge_voltage|start_battery_discharge_voltage|start_grid_charge_voltage|work_mode|solar_export_when_battery_full|max_sell_power|max_solar_power|grid_trickle_feed' } },
          { change_type: { $in: [
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
          ] } }
        ],
        user_id: USER_ID // Filter by user ID
      }).sort({ timestamp: -1 })
      
      res.json(workModeChanges)
    } catch (error) {
      console.error('Error retrieving work mode changes:', error)
      res.status(500).json({ error: 'Failed to retrieve data' })
    }
  })

// === Add routes for viewing battery charging and work mode settings ===
app.get('/battery-charging', async (req, res) => {
  try {
    let changesCount = 0
    if (dbConnected) {
      changesCount = await SettingsChange.countDocuments({ 
        $or: [
          { topic: { $regex: 'max_discharge_current|max_charge_current|max_grid_charge_current|max_generator_charge_current|battery_float_charge_voltage|battery_absorption_charge_voltage|battery_equalization_charge_voltage' } },
          { change_type: { $in: [
            'max_discharge_current', 
            'max_charge_current', 
            'max_grid_charge_current', 
            'max_generator_charge_current', 
            'battery_float_charge_voltage', 
            'battery_absorption_charge_voltage', 
            'battery_equalization_charge_voltage'
          ] } }
        ]
      })
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

app.get('/work-mode', async (req, res) => {
  try {
    let changesCount = 0
    if (dbConnected) {
      changesCount = await SettingsChange.countDocuments({ 
        $or: [
          { topic: { $regex: 'remote_switch|generator_charge|force_generator_on|output_shutdown_voltage|stop_battery_discharge_voltage|start_battery_discharge_voltage|start_grid_charge_voltage|work_mode|solar_export_when_battery_full|max_sell_power|max_solar_power|grid_trickle_feed' } },
          { change_type: { $in: [
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
          ] } }
        ]
      })
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

// === Add routes for viewing battery charging and work mode settings ===
app.get('/battery-charging', async (req, res) => {
    try {
      let changesCount = 0
      if (dbConnected) {
        changesCount = await SettingsChange.countDocuments({ 
          $or: [
            { topic: { $regex: 'max_discharge_current|max_charge_current|max_grid_charge_current|max_generator_charge_current|battery_float_charge_voltage|battery_absorption_charge_voltage|battery_equalization_charge_voltage' } },
            { change_type: { $in: [
              'max_discharge_current', 
              'max_charge_current', 
              'max_grid_charge_current', 
              'max_generator_charge_current', 
              'battery_float_charge_voltage', 
              'battery_absorption_charge_voltage', 
              'battery_equalization_charge_voltage'
            ] } }
          ],
          user_id: USER_ID // Filter by user ID
        })
      }
      
      res.render('battery-charging', { 
        active: learnerModeActive,
        changes_count: changesCount,
        db_connected: dbConnected,
        user_id: USER_ID // Pass user ID to template
      })
    } catch (error) {
      console.error('Error rendering battery-charging page:', error)
      res.status(500).send('Error loading page data')
    }
  })

// 3. Add API endpoint for getting current battery charging and work mode settings
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


// Fix API endpoints for manually changing work mode settings from UI
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


// 5. Add API endpoint for retrieving setting history to create charts/graphs in UI
app.get('/api/settings-history/:setting', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
      }
      
      const setting = req.params.setting
      const days = parseInt(req.query.days) || 7 // Default to 7 days
      
      // Calculate date threshold (e.g., past 7 days)
      const dateThreshold = new Date()
      dateThreshold.setDate(dateThreshold.getDate() - days)
      
      // Find all changes for this setting
      const changes = await SettingsChange.find({
        $or: [
          { topic: { $regex: setting } },
          { change_type: setting }
        ],
        timestamp: { $gte: dateThreshold },
        user_id: USER_ID // Filter by user ID
      }).sort({ timestamp: 1 })
      
      // Format data for charting (timestamp + value pairs)
      const formattedData = changes.map(change => ({
        timestamp: change.timestamp,
        value: change.new_value,
        old_value: change.old_value,
        system_state: change.system_state
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


  app.get('/work-mode', async (req, res) => {
    try {
      let changesCount = 0
      if (dbConnected) {
        changesCount = await SettingsChange.countDocuments({ 
          $or: [
            { topic: { $regex: 'remote_switch|generator_charge|force_generator_on|output_shutdown_voltage|stop_battery_discharge_voltage|start_battery_discharge_voltage|start_grid_charge_voltage|work_mode|solar_export_when_battery_full|max_sell_power|max_solar_power|grid_trickle_feed' } },
            { change_type: { $in: [
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
            ] } }
          ],
          user_id: USER_ID // Filter by user ID
        })
      }
      
      res.render('work-mode', { 
        active: learnerModeActive,
        changes_count: changesCount,
        db_connected: dbConnected,
        user_id: USER_ID // Pass user ID to template
      })
    } catch (error) {
      console.error('Error rendering work-mode page:', error)
      res.status(500).send('Error loading page data')
    }
  })


// New API endpoint for voltage point changes
app.get('/api/voltage-point-changes', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' });
      }
      
      const voltagePointChanges = await SettingsChange.find({ 
        $or: [
          { topic: { $regex: 'voltage_point' } },
          { change_type: 'voltage_point' }
        ],
        user_id: USER_ID // Filter by user ID
      }).sort({ timestamp: -1 });
      
      res.json(voltagePointChanges);
    } catch (error) {
      console.error('Error retrieving voltage point changes:', error);
      res.status(500).json({ error: 'Failed to retrieve data' });
    }
  });

  app.get('/grid-charge', async (req, res) => {
    try {
      let changesCount = 0;
      if (dbConnected) {
        changesCount = await SettingsChange.countDocuments({ 
          $or: [
            { topic: { $regex: 'grid_charge' } },
            { change_type: 'grid_charge' }
          ],
          user_id: USER_ID // Filter by user ID
        });
      }
      
      res.render('grid-charge', { 
        active: learnerModeActive,
        changes_count: changesCount,
        db_connected: dbConnected,
        user_id: USER_ID // Pass user ID to template
      });
    } catch (error) {
      console.error('Error rendering grid-charge page:', error);
      res.status(500).send('Error loading page data');
    }
  });

app.get('/api/grid-charge-changes', async (req, res) => {
  try {
    if (!dbConnected) {
      return res.status(503).json({ error: 'Database not connected', status: 'disconnected' });
    }
    
    // Get all changes related to grid charge, including:
    // - Basic grid_charge setting
    // - max_grid_charge_current
    // - grid_charge_point_X settings
    const gridChargeChanges = await SettingsChange.find({ 
      $or: [
        { topic: { $regex: 'grid_charge' } },
        { change_type: { $in: ['grid_charge', 'max_grid_charge_current'] } }
      ],
      user_id: USER_ID // Filter by user ID
    }).sort({ timestamp: -1 });
    
    res.json(gridChargeChanges);
  } catch (error) {
    console.error('Error retrieving grid charge changes:', error);
    res.status(500).json({ error: 'Failed to retrieve data' });
  }
});

app.get('/energy-pattern', async (req, res) => {
    try {
      let changesCount = 0
      if (dbConnected) {
        changesCount = await SettingsChange.countDocuments({ 
          $or: [
            { topic: { $regex: 'energy_pattern' } },
            { change_type: 'energy_pattern' }
          ],
          user_id: USER_ID // Filter by user ID
        })
      }
      
      res.render('energy-pattern', { 
        active: learnerModeActive,
        changes_count: changesCount,
        db_connected: dbConnected,
        user_id: USER_ID // Pass user ID to template
      })
    } catch (error) {
      console.error('Error rendering energy-pattern page:', error)
      res.status(500).send('Error loading page data')
    }
  })

// New route for voltage point view
app.get('/voltage-point', async (req, res) => {
    try {
      let changesCount = 0;
      if (dbConnected) {
        changesCount = await SettingsChange.countDocuments({ 
          $or: [
            { topic: { $regex: 'voltage_point' } },
            { change_type: 'voltage_point' }
          ],
          user_id: USER_ID // Filter by user ID
        });
      }
      
      res.render('voltage-point', { 
        active: learnerModeActive,
        changes_count: changesCount,
        db_connected: dbConnected,
        user_id: USER_ID // Pass user ID to template
      });
    } catch (error) {
      console.error('Error rendering voltage-point page:', error);
      res.status(500).send('Error loading page data');
    }
  });

  app.get('/wizard', async (req, res) => {
    try {
      // Check if editing an existing rule (optional)
      const ruleId = req.query.edit;
      let rule = null;
      
      if (ruleId && dbConnected) {
        // Find rule by ID and user ID to ensure it belongs to this user
        rule = await Rule.findOne({
          _id: ruleId,
          user_id: USER_ID
        });
      }
      
      // Get current system state for reference
      const systemState = { ...currentSystemState };
      
      // Get the number of inverters from config
      const numInverters = inverterNumber || 1;
      
      res.render('wizard', { 
        rule,
        systemState,
        numInverters,
        editMode: !!ruleId,
        db_connected: dbConnected,
        user_id: USER_ID // Pass user ID to template
      });
    } catch (error) {
      console.error('Error rendering wizard page:', error);
      res.status(500).send('Error loading wizard page');
    }
  });

// ================ RULES MANAGEMENT API ================

// Get all rules
app.post('/api/rules', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' });
      }
      
      // Validate the request body
      const { name, description, active, conditions, timeRestrictions, actions } = req.body;
      
      if (!name) {
        return res.status(400).json({ error: 'Rule name is required' });
      }
      
      if (!actions || actions.length === 0) {
        return res.status(400).json({ error: 'At least one action is required' });
      }
      
      // Handle specific dates if present
      let processedTimeRestrictions = { ...timeRestrictions };
      
      // Create the rule with user identification
      const rule = new Rule({
        name,
        description,
        active: active !== undefined ? active : true,
        conditions: conditions || [],
        timeRestrictions: processedTimeRestrictions,
        actions,
        // Add user identification
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      });
      
      await rule.save();
      
      // Log the creation
      console.log(`Rule "${name}" created successfully`);
      
      res.status(201).json(rule);
    } catch (error) {
      console.error('Error creating rule:', error);
      res.status(400).json({ error: error.message });
    }
  });

// Get a specific rule
app.put('/api/rules/:id', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' });
      }
      
      const { name, description, active, conditions, timeRestrictions, actions } = req.body;
      
      if (!name) {
        return res.status(400).json({ error: 'Rule name is required' });
      }
      
      if (!actions || actions.length === 0) {
        return res.status(400).json({ error: 'At least one action is required' });
      }
      
      // Find the rule filtered by both ID and user_id to ensure it belongs to this user
      const rule = await Rule.findOne({
        _id: req.params.id,
        user_id: USER_ID
      });
      
      if (!rule) {
        return res.status(404).json({ error: 'Rule not found' });
      }
      
      // Update the rule
      rule.name = name;
      rule.description = description;
      rule.active = active !== undefined ? active : true;
      rule.conditions = conditions || [];
      rule.timeRestrictions = timeRestrictions;
      rule.actions = actions;
      // Keep the user identification unchanged
      
      await rule.save();
      
      console.log(`Rule "${name}" updated successfully`);
      
      res.json(rule);
    } catch (error) {
      console.error('Error updating rule:', error);
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/rules/:id/duplicate', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' });
      }
      
      // Find the original rule filtered by both ID and user_id
      const originalRule = await Rule.findOne({
        _id: req.params.id,
        user_id: USER_ID
      });
      
      if (!originalRule) {
        return res.status(404).json({ error: 'Rule not found' });
      }
      
      // Create a new rule based on the original
      const newRule = new Rule({
        name: `Copy of ${originalRule.name}`,
        description: originalRule.description,
        active: originalRule.active,
        conditions: originalRule.conditions,
        timeRestrictions: originalRule.timeRestrictions,
        actions: originalRule.actions,
        // Add user identification
        user_id: USER_ID,
        mqtt_username: mqttConfig.username
      });
      
      await newRule.save();
      
      console.log(`Rule "${originalRule.name}" duplicated as "${newRule.name}"`);
      
      res.status(201).json(newRule);
    } catch (error) {
      console.error('Error duplicating rule:', error);
      res.status(400).json({ error: error.message });
    }
  });

// Add this route to display rule history
app.get('/rule-history', async (req, res) => {
    try {
      let ruleHistory = [];
      let systemState = { ...currentSystemState };
      
      if (dbConnected) {
        // Get all rules with their trigger history for this user
        ruleHistory = await Rule.find({
          lastTriggered: { $exists: true, $ne: null },
          user_id: USER_ID
        }).sort({ lastTriggered: -1 });
      }
      
      res.render('rule-history', {
        ruleHistory,
        db_connected: dbConnected,
        system_state: systemState,
        user_id: USER_ID // Pass user ID to template
      });
    } catch (error) {
      console.error('Error rendering rule history page:', error);
      res.status(500).send('Error loading rule history page');
    }
  });

// API route to get rule execution history
app.get('/api/rules/history', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' });
      }
      
      const limit = parseInt(req.query.limit) || 50;
      const skip = parseInt(req.query.skip) || 0;
      const sortBy = req.query.sortBy || 'lastTriggered';
      const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;
      
      // Build sort options
      const sort = {};
      sort[sortBy] = sortOrder;
      
      // Get rules that have been triggered for the current user
      const ruleHistory = await Rule.find({
        lastTriggered: { $exists: true, $ne: null },
        user_id: USER_ID
      })
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .select('name description lastTriggered triggerCount conditions actions timeRestrictions');
      
      // Get total count for pagination
      const totalCount = await Rule.countDocuments({
        lastTriggered: { $exists: true, $ne: null },
        user_id: USER_ID
      });
      
      res.json({
        rules: ruleHistory,
        pagination: {
          total: totalCount,
          limit,
          skip,
          hasMore: skip + limit < totalCount
        }
      });
    } catch (error) {
      console.error('Error fetching rule history:', error);
      res.status(500).json({ error: 'Failed to retrieve rule history' });
    }
  });


  app.get('/api/rules/statistics', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ 
          totalRules: 0,
          totalExecutions: 0,
          last24Hours: 0,
          mostActiveRule: 'None'
        });
      }
      
      // Get total rules count for the current user
      const totalRules = await Rule.countDocuments({ user_id: USER_ID });
      
      // Get rules with execution data for the current user
      const rulesWithHistory = await Rule.find({
        lastTriggered: { $exists: true, $ne: null },
        user_id: USER_ID
      }).select('name lastTriggered triggerCount');
      
      // Calculate total executions
      const totalExecutions = rulesWithHistory.reduce((sum, rule) => sum + (rule.triggerCount || 0), 0);
      
      // Find most active rule
      let mostActiveRule = null;
      let highestTriggerCount = 0;
      
      for (const rule of rulesWithHistory) {
        if ((rule.triggerCount || 0) > highestTriggerCount) {
          mostActiveRule = rule;
          highestTriggerCount = rule.triggerCount || 0;
        }
      }
      
      // Calculate executions in the last 24 hours
      const now = new Date();
      const oneDayAgo = new Date(now);
      oneDayAgo.setDate(oneDayAgo.getDate() - 1);
      
      const last24Hours = rulesWithHistory.filter(rule => 
        new Date(rule.lastTriggered) >= oneDayAgo
      ).length;
      
      // Send simplified response with just the data needed for the dashboard
      res.json({
        totalRules: totalRules,
        totalExecutions: totalExecutions,
        last24Hours: last24Hours,
        mostActiveRule: mostActiveRule ? mostActiveRule.name : 'None'
      });
    } catch (error) {
      console.error('Error fetching rule statistics:', error);
      // Return default values if error occurs
      res.json({
        totalRules: 0,
        totalExecutions: 0,
        last24Hours: 0,
        mostActiveRule: 'None'
      });
    }
  });

// Add a route to get full details for a specific rule's execution history
app.get('/api/rules/:id/execution-history', async (req, res) => {
  try {
    if (!dbConnected) {
      return res.status(503).json({ error: 'Database not connected', status: 'disconnected' });
    }
    
    const rule = await Rule.findById(req.params.id);
    if (!rule) {
      return res.status(404).json({ error: 'Rule not found' });
    }
    
    // If the rule has never been triggered, return an empty history
    if (!rule.lastTriggered) {
      return res.json({
        rule: {
          id: rule._id,
          name: rule.name,
          description: rule.description,
          active: rule.active
        },
        executionHistory: []
      });
    }
    
    // Get rule details and execution history
    const ruleDetails = {
      id: rule._id,
      name: rule.name,
      description: rule.description,
      active: rule.active,
      conditions: rule.conditions,
      actions: rule.actions,
      timeRestrictions: rule.timeRestrictions,
      lastTriggered: rule.lastTriggered,
      triggerCount: rule.triggerCount || 0
    };
    
    res.json({
      rule: ruleDetails
    });
  } catch (error) {
    console.error('Error fetching rule execution history:', error);
    res.status(500).json({ error: 'Failed to retrieve rule execution history' });
  }
});


app.post('/api/rules/:id/execute', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' });
      }
      
      // Check if learner mode is active
      if (!learnerModeActive) {
        return res.status(403).json({ error: 'Learner mode is not active. Cannot execute rules.' });
      }
      
      // Find the rule filtered by both ID and user_id
      const rule = await Rule.findOne({
        _id: req.params.id,
        user_id: USER_ID
      });
      
      if (!rule) {
        return res.status(404).json({ error: 'Rule not found' });
      }
      
      // Force execution regardless of conditions
      if (rule.actions && rule.actions.length > 0) {
        let allActionsApplied = true;
        
        rule.actions.forEach(action => {
          const actionApplied = applyAction(action);
          if (!actionApplied) {
            allActionsApplied = false;
          }
        });
        
        if (!allActionsApplied) {
          return res.status(403).json({ error: 'Some or all actions could not be applied because learner mode is inactive' });
        }
      } else {
        return res.status(400).json({ error: 'Rule has no actions to execute' });
      }
      
      // Update rule statistics
      rule.lastTriggered = new Date();
      rule.triggerCount = (rule.triggerCount || 0) + 1;
      await rule.save();
      
      // Log the execution
      console.log(`Rule "${rule.name}" manually executed at ${rule.lastTriggered}`);
      
      res.json({ 
        message: `Rule "${rule.name}" executed successfully`, 
        execution: {
          ruleId: rule._id,
          ruleName: rule.name,
          timestamp: rule.lastTriggered,
          triggerCount: rule.triggerCount,
          actions: rule.actions.map(action => ({
            setting: action.setting,
            value: action.value,
            inverter: action.inverter
          }))
        }
      });
    } catch (error) {
      console.error('Error executing rule:', error);
      res.status(500).json({ error: error.message });
    }
  });


// Enhance the rules page with additional data
app.get('/rules', async (req, res) => {
    try {
      let rulesCount = 0;
      let activeRulesCount = 0;
      let systemState = { ...currentSystemState };
      let recentlyTriggered = [];
      
      if (dbConnected) {
        rulesCount = await Rule.countDocuments({ user_id: USER_ID });
        activeRulesCount = await Rule.countDocuments({ active: true, user_id: USER_ID });
        
        // Get recently triggered rules
        recentlyTriggered = await Rule.find({
          lastTriggered: { $exists: true, $ne: null },
          user_id: USER_ID
        })
        .sort({ lastTriggered: -1 })
        .limit(5)
        .select('name lastTriggered');
      }
      
      res.render('rules', { 
        db_connected: dbConnected,
        rules_count: rulesCount,
        active_rules_count: activeRulesCount,
        system_state: systemState,
        recently_triggered: recentlyTriggered,
        user_id: USER_ID // Pass user ID to template
      });
    } catch (error) {
      console.error('Error rendering rules page:', error);
      res.status(500).send('Error loading page data');
    }
  });
  

app.get('/api/rules', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' });
      }
      
      const rules = await Rule.find({ user_id: USER_ID }).sort({ name: 1 });
      res.json(rules);
    } catch (error) {
      console.error('Error retrieving rules:', error);
      res.status(500).json({ error: 'Failed to retrieve rules' });
    }
  });

  app.delete('/api/rules/:id', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' });
      }
      
      // Find and delete the rule filtered by both ID and user_id
      const rule = await Rule.findOneAndDelete({
        _id: req.params.id,
        user_id: USER_ID
      });
      
      if (!rule) {
        return res.status(404).json({ error: 'Rule not found' });
      }
      
      res.json({ message: 'Rule deleted successfully' });
    } catch (error) {
      console.error('Error deleting rule:', error);
      res.status(500).json({ error: error.message });
    }
  });

app.get('/api/rules/:id', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' });
      }
      
      // Find the rule filtered by both ID and user_id
      const rule = await Rule.findOne({
        _id: req.params.id,
        user_id: USER_ID
      });
      
      if (!rule) {
        return res.status(404).json({ error: 'Rule not found' });
      }
      
      res.json(rule);
    } catch (error) {
      console.error('Error retrieving rule:', error);
      res.status(500).json({ error: 'Failed to retrieve rule' });
    }
  });

// API endpoint for current system state
app.get('/api/system-state', (req, res) => {
  res.json({ 
    current_state: currentSystemState,
    timestamp: new Date()
  })
})

app.get('/api/settings-changes', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
      }
      
      const changeType = req.query.type
      const limit = parseInt(req.query.limit) || 100
      const skip = parseInt(req.query.skip) || 0
      
      let query = { user_id: USER_ID } // Filter by user ID
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
    change_detection: 'always', // Indicating that changes are always detected
    action_execution: learnerModeActive ? 'enabled' : 'disabled', // Only execute actions when learner mode is active
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
    message: `Learner mode ${learnerModeActive ? 'activated' : 'deactivated'}`,
    note: "Setting changes are still detected and recorded, but commands will only be sent when learner mode is active."
  })
})

app.get('/api/learner/changes', async (req, res) => {
    try {
      if (!dbConnected) {
        return res.status(503).json({ error: 'Database not connected', status: 'disconnected' })
      }
      
      const limit = parseInt(req.query.limit) || 50
      const changes = await SettingsChange.find({ user_id: USER_ID }) // Filter by user ID
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
        changesCount = await SettingsChange.countDocuments({ user_id: USER_ID })
      }
      
      res.render('learner', { 
        active: learnerModeActive,
        change_detection: 'always', // New property to inform the front-end
        monitored_settings: settingsToMonitor,
        changes_count: changesCount,
        db_connected: dbConnected,
        user_id: USER_ID // Pass user ID to template
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
    
    const { topic, value } = req.body;
    
    if (!topic || !value) {
      return res.status(400).json({ error: 'Missing topic or value' });
    }
    
    if (!mqttClient || !mqttClient.connected) {
      return res.status(503).json({ error: 'MQTT client not connected' });
    }
    
    mqttClient.publish(topic, value.toString(), { qos: 1, retain: false }, (err) => {
      if (err) {
        console.error(`Error publishing to ${topic}: ${err.message}`);
        return res.status(500).json({ error: err.message });
      }
      
      console.log(`Manual command sent: ${topic} = ${value}`);
      res.json({ success: true, message: `Command sent: ${topic} = ${value}` });
    });
  } catch (error) {
    console.error('Error sending command:', error);
    res.status(500).json({ error: error.message });
  }
});

// ================ MQTT and CRON SCHEDULING ================

// Connect to MQTT with robust error handling
function connectToMqtt() {
  mqttClient = mqtt.connect(`mqtt://${mqttConfig.host}:${mqttConfig.port}`, {
    username: mqttConfig.username,
    password: mqttConfig.password,
    clientId: mqttConfig.clientId,
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
    
    // Always save messages to InfluxDB regardless of learner mode
    saveMessageToInfluxDB(topic, message)
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
    
    // Create default rules if connected to DB
    if (dbConnected) {
      await createDefaultRules()
      // Remove this line:
      // await createDefaultBatteryAndWorkModeRules() 
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
