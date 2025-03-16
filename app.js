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
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { startOfDay } = require('date-fns')
const { AuthenticateUser } = require('./utils/mongoService')


// Middleware setup
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: '*' }))
app.use(bodyParser.urlencoded({ extended: true }))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(express.static(path.join(__dirname, 'public')))
app.set('view engine', 'ejs')
app.set('views', path.join(__dirname, 'views'))


// Read configuration from Home Assistant add-on options
let options;
try {
  options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
} catch (error) {
  options = JSON.parse(fs.readFileSync('./options.json', 'utf8'));
}

// Extract inverter and battery numbers from options
const inverterNumber = options.inverter_number || 1
const batteryNumber = options.battery_number || 1
// MQTT topic prefix
const mqttTopicPrefix = options.mqtt_topic_prefix || '${mqttTopicPrefix}'

// Constants
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');
const CACHE_DURATION = 24 * 3600000; // 24 hours in milliseconds


// Middleware
app.use(helmet({
  contentSecurityPolicy: false // Disabled for development, enable in production
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: process.env.NODE_ENV === 'production' }
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);


// Ensure data directory and settings file exist
if (!fs.existsSync(path.dirname(SETTINGS_FILE))) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
}
if (!fs.existsSync(SETTINGS_FILE)) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
    apiKey: '',
    selectedZone: '',
    username: ''
  }));
}

// InfluxDB configuration
const influxConfig = {
  host: '172.20.10.4',
  port: 8086,
  database: 'home_assistant',
  username: 'admin',
  password: 'adminpassword',
  protocol: 'http',
  timeout: 10000,
}
const influx = new Influx.InfluxDB(influxConfig)

// MQTT configuration
const mqttConfig = {
  host: options.mqtt_host,
  port: options.mqtt_port,
  username: options.mqtt_username,
  password: options.mqtt_password,
}

// Connect to MQTT broker
let mqttClient
let incomingMessages = []
const MAX_MESSAGES = 400

// Learner mode configuration
let learnerModeActive = false;
const settingsToMonitor = [
    'energy_pattern',
    'grid_charge',
    'power',
    'device_mode',
    'voltage',
    'work_mode_timer'  // Added to capture timer changes
  ];
  
  // Enhance the system state tracking to include more parameters
  let currentSystemState = {
    battery_soc: null,
    pv_power: null,
    load: null,
    grid_voltage: null,  // Added grid voltage
    grid_power: null,    // Added grid power
    inverter_state: null, // Added inverter state
    timestamp: null
  };

// Define log file paths with fallback options
const primaryDataDir = '/data';
const fallbackDataDir = path.join(__dirname, 'data');
let dataDir, logsDir, learnerLogFile, settingsChangesFile;

// Try to set up log directories with proper error handling
try {
  // Try primary location first
  dataDir = primaryDataDir;
  logsDir = path.join(dataDir, 'logs');
  
  // Check if primary data directory exists and is writable
  if (!fs.existsSync(dataDir)) {
    console.log(`Primary data directory ${dataDir} does not exist, attempting to create it`);
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  // Test write permissions by writing a temp file
  const testFile = path.join(dataDir, '.write_test');
  fs.writeFileSync(testFile, 'test');
  fs.unlinkSync(testFile);
  
  // Primary location is writable, use it
  console.log(`Using primary data directory: ${dataDir}`);
} catch (error) {
  // Fall back to local directory
  console.warn(`Cannot use primary data directory: ${error.message}`);
  console.log(`Falling back to local data directory`);
  
  dataDir = fallbackDataDir;
  logsDir = path.join(dataDir, 'logs');
  
  // Create fallback directories
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

// Now create logs directory if it doesn't exist
if (!fs.existsSync(logsDir)) {
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    console.log(`Created logs directory at: ${logsDir}`);
  } catch (error) {
    console.error(`Error creating logs directory: ${error.message}`);
  }
}

// Set file paths after directory setup
learnerLogFile = path.join(logsDir, 'learner_mode.log');
settingsChangesFile = path.join(logsDir, 'settings_changes.json');

// Function for logging to file with better error handling
function logToFile(message) {
  try {
    // Double check directory exists before writing
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
      console.log(`Created logs directory at: ${logsDir}`);
    }
    
    const timestamp = moment().format('YYYY-MM-DD HH:mm:ss');
    const logMessage = `[${timestamp}] ${message}\n`;
    
    // Use synchronous write to ensure logging completes
    fs.appendFileSync(learnerLogFile, logMessage);
  } catch (err) {
    console.error(`Logging error: ${err.message}`);
    console.error(`Attempted to write to: ${learnerLogFile}`);
    console.error(`Current working directory: ${process.cwd()}`);
  }
}

// Initialize or load existing settings changes data
let settingsChanges = [];
try {
  if (fs.existsSync(settingsChangesFile)) {
    const fileContent = fs.readFileSync(settingsChangesFile, 'utf8');
    // Only try to parse if the file has content
    if (fileContent && fileContent.trim().length > 0) {
      settingsChanges = JSON.parse(fileContent);
    }
  }
} catch (error) {
  console.error('Error loading settings changes file:', error);
  console.log('Creating new settings changes file');
  // Initialize with empty array and save
  settingsChanges = [];
  try {
    fs.writeFileSync(settingsChangesFile, JSON.stringify(settingsChanges));
  } catch (writeError) {
    console.error('Error initializing settings file:', writeError);
  }
}

// Function to save settings changes
function saveSettingsChanges() {
  try {
    // Ensure directory exists
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    fs.writeFileSync(settingsChangesFile, JSON.stringify(settingsChanges, null, 2));
  } catch (error) {
    console.error('Error saving settings changes:', error);
    logToFile('Error saving settings changes: ' + error.message);
  }
}
// Track previous state of settings to detect changes
let previousSettings = {};

// Handle incoming MQTT messages

// Handle incoming MQTT messages
function handleMqttMessage(topic, message) {
  const formattedMessage = `${topic}: ${message.toString()}`;
  
  // Add to the circular buffer of messages
  incomingMessages.push(formattedMessage);
  if (incomingMessages.length > MAX_MESSAGES) {
    incomingMessages.shift();
  }

  // Parse message content
  let messageContent;
  try {
    messageContent = message.toString();
    
    // Try to parse as JSON if it looks like JSON
    if (messageContent.startsWith('{') && messageContent.endsWith('}')) {
      messageContent = JSON.parse(messageContent);
    }
  } catch (error) {
    // If not JSON, keep as string
    messageContent = message.toString();
  }

  // Extract the specific topic part after the prefix
  const topicPrefix = options.mqtt_topic_prefix || '';
  let specificTopic = topic;
  if (topic.startsWith(topicPrefix)) {
    specificTopic = topic.substring(topicPrefix.length + 1); // +1 for the slash
  }

  // Update system state for key metrics with more parameters
  if (specificTopic.includes('battery_state_of_charge')) {
    currentSystemState.battery_soc = parseFloat(messageContent);
    currentSystemState.timestamp = moment().format('YYYY-MM-DD HH:mm:ss');
  } else if (specificTopic.includes('pv_power')) {
    currentSystemState.pv_power = parseFloat(messageContent);
  } else if (specificTopic.includes('load_power')) {
    currentSystemState.load = parseFloat(messageContent);
  } else if (specificTopic.includes('grid_voltage')) {
    currentSystemState.grid_voltage = parseFloat(messageContent);
  } else if (specificTopic.includes('grid_power')) {
    currentSystemState.grid_power = parseFloat(messageContent);
  } else if (specificTopic.includes('inverter_state') || specificTopic.includes('device_mode')) {
    currentSystemState.inverter_state = messageContent;
  }

  // Handle specific settings changes
  if (specificTopic.includes('grid_charge')) {
    handleSettingChange(specificTopic, messageContent, 'grid_charge');
  } else if (specificTopic.includes('energy_pattern')) {
    handleSettingChange(specificTopic, messageContent, 'energy_pattern');
  } else {
    // Check if this is any other settings topic we're monitoring
    for (const setting of settingsToMonitor) {
      if (specificTopic.includes(setting)) {
        handleSettingChange(specificTopic, messageContent, 'other_setting');
        break;
      }
    }
  }
}

// Function to handle setting changes
function handleSettingChange(specificTopic, messageContent, changeType) {
  // Only proceed if the setting has changed
  if (previousSettings[specificTopic] !== messageContent) {
    // Log the change
    console.log(`${changeType.toUpperCase()} CHANGE DETECTED: ${specificTopic} - ${messageContent}`);
    logToFile(`${changeType.toUpperCase()} CHANGE DETECTED: ${specificTopic} - ${messageContent}`);
    
    // Create a detailed change record
    const changeData = {
      id: Date.now().toString(),
      timestamp: moment().format('YYYY-MM-DD HH:mm:ss'),
      topic: specificTopic,
      old_value: previousSettings[specificTopic],
      new_value: messageContent,
      system_state: { ...currentSystemState },
      change_type: changeType
    };
    
    // Add to the changes array and save
    settingsChanges.push(changeData);
    saveSettingsChanges();
    
    // Update previous settings
    previousSettings[specificTopic] = messageContent;
    
    // Send appropriate notification based on change type
    if (changeType === 'grid_charge') {
      sendGridChargeNotification(changeData);
    } else if (changeType === 'energy_pattern') {
      sendEnergyPatternNotification(changeData);
    }
  }
}

function sendGridChargeNotification(changeData) {
  console.log('IMPORTANT: Grid Charge Setting Changed!');
  console.log(`From: ${changeData.old_value} → To: ${changeData.new_value}`);
  console.log(`Battery SOC: ${changeData.system_state.battery_state_of_charge}%`);
  console.log(`PV Power: ${changeData.system_state.pv_power}W`);
  console.log(`Grid Voltage: ${changeData.system_state.grid_voltage}V`);
  console.log(`Load: ${changeData.system_state.load}W`);
  console.log(`Time: ${changeData.timestamp}`);
}

function sendEnergyPatternNotification(changeData) {
  console.log('IMPORTANT: Energy Pattern Setting Changed!');
  console.log(`From: ${changeData.old_value} → To: ${changeData.new_value}`);
  console.log(`Battery SOC: ${changeData.system_state.battery_state_of_charge}%`);
  console.log(`PV Power: ${changeData.system_state.pv_power}W`);
  console.log(`Grid Voltage: ${changeData.system_state.grid_voltage}V`);
  console.log(`Load: ${changeData.system_state.load}W`);
  console.log(`Time: ${changeData.timestamp}`);
}

app.get('/api/grid-charge-changes', (req, res) => {
  const gridChargeChanges = settingsChanges.filter(
    change => change.topic.includes('grid_charge') || change.change_type === 'grid_charge'
  );
  res.json(gridChargeChanges);
});

app.get('/api/energy-pattern-changes', (req, res) => {
  const energyPatternChanges = settingsChanges.filter(
    change => change.topic.includes('energy_pattern') || change.change_type === 'energy_pattern'
  );
  res.json(energyPatternChanges);
});

app.get('/grid-charge', (req, res) => {
  res.render('grid-charge', { 
    active: learnerModeActive,
    changes_count: settingsChanges.filter(
      change => change.topic.includes('grid_charge') || change.change_type === 'grid_charge'
    ).length
  });
});

app.get('/energy-pattern', (req, res) => {
  res.render('energy-pattern', { 
    active: learnerModeActive,
    changes_count: settingsChanges.filter(
      change => change.topic.includes('energy_pattern') || change.change_type === 'energy_pattern'
    ).length
  });
});

app.get('/api/settings-changes', (req, res) => {
  const changeType = req.query.type;
  let filteredChanges = settingsChanges;
  
  if (changeType) {
    filteredChanges = settingsChanges.filter(change => change.change_type === changeType);
  }
  
  res.json(filteredChanges);
});


app.get('/api/learner/status', (req, res) => {
  res.json({ 
    active: learnerModeActive,
    monitored_settings: settingsToMonitor,
    current_system_state: currentSystemState,
    log_file_path: learnerLogFile
  });
});

app.post('/api/learner/toggle', (req, res) => {
  learnerModeActive = !learnerModeActive;
  
  logToFile(`Learner mode ${learnerModeActive ? 'activated' : 'deactivated'}`);
  
  res.json({ 
    success: true, 
    active: learnerModeActive,
    message: `Learner mode ${learnerModeActive ? 'activated' : 'deactivated'}`
  });
});

app.get('/api/learner/changes', (req, res) => {
  res.json(settingsChanges);
});

// New endpoint for deleting a change
app.delete('/api/learner/changes/:id', (req, res) => {
  const changeId = req.params.id;
  
  // Find the index of the change to delete
  const changeIndex = settingsChanges.findIndex(change => change.id === changeId);
  
  if (changeIndex === -1) {
    return res.status(404).json({ success: false, message: 'Change not found' });
  }
  
  // Remove the change from the array
  settingsChanges.splice(changeIndex, 1);
  
  // Save the updated changes to the file
  saveSettingsChanges();
  
  logToFile(`Deleted change with ID: ${changeId}`);
  
  res.json({ success: true, message: 'Change deleted successfully' });
});

app.get('/api/system/paths', (req, res) => {
  res.json({
    cwd: process.cwd(),
    data_dir: dataDir,
    logs_dir: logsDir,
    learner_log_file: learnerLogFile,
    settings_changes_file: settingsChangesFile
  });
});

app.get('/learner', (req, res) => {
  res.render('learner', { 
    active: learnerModeActive,
    monitored_settings: settingsToMonitor,
    changes_count: settingsChanges.length,
    log_path: learnerLogFile
  });
});


// Function to generate category options
function generateCategoryOptions(inverterNumber, batteryNumber) {
  const categories = ['all', 'loadPower', 'gridPower', 'pvPower', 'total']

  for (let i = 1; i <= inverterNumber; i++) {
    categories.push(`inverter${i}`)
  }

  for (let i = 1; i <= batteryNumber; i++) {
    categories.push(`battery${i}`)
  }

  return categories
}

const timezonePath = path.join(__dirname, 'timezone.json')

function getCurrentTimezone() {
  try {
    const data = fs.readFileSync(timezonePath, 'utf8')
    return JSON.parse(data).timezone
  } catch (error) {
    return 'Europe/Berlin' // Default timezone
  }
}

function setCurrentTimezone(timezone) {
  fs.writeFileSync(timezonePath, JSON.stringify({ timezone }))
}

let currentTimezone = getCurrentTimezone()

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

// Save MQTT message to InfluxDB
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



// Route handlers
app.get('/messages', (req, res) => {
  res.render('messages', {
    ingress_path: process.env.INGRESS_PATH || '',
    categoryOptions: generateCategoryOptions(inverterNumber, batteryNumber),
  })
})

app.get('/api/messages', (req, res) => {
  const category = req.query.category
  const filteredMessages = filterMessagesByCategory(category)
  res.json(filteredMessages)
})

app.get('/chart', (req, res) => {
  res.render('chart', {
    ingress_path: process.env.INGRESS_PATH || '',
    mqtt_host: options.mqtt_host, // Include mqtt_host here
  })
})


function getSelectedZone(req) {
  // First, check if a zone is provided in the query
  if (req.query.zone) {
    return req.query.zone;
  }
  return null;
}

function checkInverterMessages(messages, expectedInverters) {
  const inverterPattern = new RegExp(`${mqttTopicPrefix}/inverter_(\\d+)/`)
  const foundInverters = new Set()

  messages.forEach((message) => {
    const match = message.match(inverterPattern)
    if (match) {
      foundInverters.add(parseInt(match[1]))
    }
  })

  if (foundInverters.size !== expectedInverters) {
    return `Warning: Expected ${expectedInverters} inverter(s), but found messages from ${foundInverters.size} inverter(s).`
  }
  return null
}

function checkBatteryInformation(messages) {
  // More flexible battery pattern that matches various battery topic formats
  const batteryPatterns = [
    new RegExp(`${mqttTopicPrefix}/battery_\\d+/`),
    new RegExp(`${mqttTopicPrefix}/battery/`),
    new RegExp(`${mqttTopicPrefix}/total/battery`),
    new RegExp(`${mqttTopicPrefix}/\\w+/battery`),
  ]

  // Check if any message matches any of the battery patterns
  const hasBatteryInfo = messages.some((message) =>
    batteryPatterns.some((pattern) => pattern.test(message))
  )

  // Add debug logging to help troubleshoot
  if (!hasBatteryInfo) {
    console.log(
      'Debug: No battery messages found. Current messages:',
      messages.filter((msg) => msg.toLowerCase().includes('battery'))
    )
    return 'Warning: No battery information found in recent messages.'
  }

  return null
}

// Helper function to see what battery messages are being received
function debugBatteryMessages(messages) {
  const batteryMessages = messages.filter((msg) =>
    msg.toLowerCase().includes('battery')
  )
  console.log('Current battery-related messages:', batteryMessages)
  return batteryMessages
}


app.get('/api/timezone', (req, res) => {
  res.json({ timezone: currentTimezone })
})

app.post('/api/timezone', (req, res) => {
  const { timezone } = req.body
  if (moment.tz.zone(timezone)) {
    currentTimezone = timezone
    setCurrentTimezone(timezone)
    res.json({ success: true, timezone: currentTimezone })
  } else {
    res.status(400).json({ error: 'Invalid timezone' })
  }
})

// Function to filter messages by category
function filterMessagesByCategory(category) {
  if (category === 'all') {
    return incomingMessages
  }

  return incomingMessages.filter((message) => {
    const topic = message.split(':')[0]
    const topicParts = topic.split('/')

    if (category.startsWith('inverter')) {
      const inverterNum = category.match(/\d+$/)[0]
      return topicParts[1] === `inverter_${inverterNum}`
    }

    if (category.startsWith('battery')) {
      const batteryNum = category.match(/\d+$/)[0]
      return topicParts[1] === `battery_${batteryNum}`
    }

    const categoryKeywords = {
      loadPower: ['load_power'],
      gridPower: ['grid_power'],
      pvPower: ['pv_power'],
      total: ['total'],
    }

    return categoryKeywords[category]
      ? topicParts.some((part) => categoryKeywords[category].includes(part))
      : false
  })
}

const server = app.listen(port, '0.0.0.0', async () => {
  console.log(`Server is running on http://0.0.0.0:${port}`);
  connectToMqtt();

});




// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).json({ error: 'Something went wrong!' })
})

// 404 handler
app.use((req, res, next) => {
  res.status(404).send("Sorry, that route doesn't exist.")
})

module.exports = { app, server }
