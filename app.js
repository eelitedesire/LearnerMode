const express = require('express');
const bodyParser = require('body-parser');
const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const moment = require('moment-timezone');

const app = express();
const port = process.env.PORT || 4000;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE'], allowedHeaders: '*' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(cookieParser());

// Load configuration
let options;
try {
  options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
} catch (error) {
  options = JSON.parse(fs.readFileSync('./options.json', 'utf8'));
}

// MQTT Configuration
const mqttConfig = {
  host: options.mqtt_host,
  port: options.mqtt_port,
  username: options.mqtt_username,
  password: options.mqtt_password,
};

// MQTT Client and message storage
let mqttClient;
let incomingMessages = [];
const MAX_MESSAGES = 400;

// Learner mode configuration
let learnerModeActive = false;
const settingsToMonitor = [
  'energy_pattern',
  'grid_charge',
  'power',
  'device_mode',
  'voltage'
];

// Store system state
let currentSystemState = {
  battery_soc: null,
  pv_power: null,
  load: null,
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

// Connect to MQTT broker
function connectToMqtt() {
  mqttClient = mqtt.connect(`mqtt://${mqttConfig.host}:${mqttConfig.port}`, {
    username: mqttConfig.username,
    password: mqttConfig.password,
  });

  mqttClient.on('connect', () => {
    console.log('Connected to MQTT broker');
    logToFile('Connected to MQTT broker');
    
    // Subscribe to all topics under the specified prefix
    const topicPrefix = options.mqtt_topic_prefix || '';
    mqttClient.subscribe(`${topicPrefix}/#`);
    
    // Log connection success
    console.log(`Subscribed to ${topicPrefix}/#`);
    logToFile(`Subscribed to ${topicPrefix}/#`);
  });

  mqttClient.on('error', (error) => {
    console.error('MQTT connection error:', error);
    logToFile(`MQTT connection error: ${error.message}`);
  });

  mqttClient.on('message', (topic, message) => {
    handleMqttMessage(topic, message);
  });
}

// Track previous state of settings to detect changes
let previousSettings = {};

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

  // Update system state for key metrics
  if (specificTopic.includes('battery_state_of_charge')) {
    currentSystemState.battery_soc = parseFloat(messageContent);
    currentSystemState.timestamp = moment().format('YYYY-MM-DD HH:mm:ss');
  } else if (specificTopic.includes('pv_power')) {
    currentSystemState.pv_power = parseFloat(messageContent);
  } else if (specificTopic.includes('load_power')) {
    currentSystemState.load = parseFloat(messageContent);
  }

  // Check if this is a settings topic we're monitoring
  let isSettingsTopic = false;
  for (const setting of settingsToMonitor) {
    if (specificTopic.includes(setting)) {
      isSettingsTopic = true;
      
      // Only proceed if we're in learner mode
      if (learnerModeActive) {
        // Check if the setting has changed
        if (previousSettings[specificTopic] !== messageContent) {
          // Log the change
          const changeData = {
            id: Date.now().toString(), // Add unique ID based on timestamp
            timestamp: moment().format('YYYY-MM-DD HH:mm:ss'),
            topic: specificTopic,
            old_value: previousSettings[specificTopic],
            new_value: messageContent,
            system_state: { ...currentSystemState }
          };
          
          logToFile(`Settings change detected: ${JSON.stringify(changeData)}`);
          settingsChanges.push(changeData);
          saveSettingsChanges();
          
          // Update previous settings
          previousSettings[specificTopic] = messageContent;
        }
      } else {
        // Keep track of current settings even when not in learner mode
        previousSettings[specificTopic] = messageContent;
      }
      break;
    }
  }

  // For debugging, log all messages to the learner log if in debug mode
  if (learnerModeActive && specificTopic.includes('debug')) {
    logToFile(`DEBUG - ${specificTopic}: ${JSON.stringify(messageContent)}`);
  }
}

// API Endpoints
app.get('/api/messages', (req, res) => {
  res.json(incomingMessages);
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

app.get('/api/timezone', (req, res) => {
  res.json({ timezone: moment.tz.guess() });
});

app.post('/api/timezone', (req, res) => {
  const { timezone } = req.body;
  if (moment.tz.zone(timezone)) {
    res.json({ success: true, timezone });
  } else {
    res.status(400).json({ error: 'Invalid timezone' });
  }
});

// Client interface for learner mode
app.get('/learner', (req, res) => {
  res.render('learner', { 
    active: learnerModeActive,
    monitored_settings: settingsToMonitor,
    changes_count: settingsChanges.length,
    log_path: learnerLogFile
  });
});

// Start server
const server = app.listen(port, () => {
  console.log(`Server is running on http://0.0.0.0:${port}`);
  console.log(`Log file path: ${learnerLogFile}`);
  logToFile(`Server started on port ${port}`);
  connectToMqtt();
});

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  logToFile(`Server error: ${err.message}`);
  res.status(500).json({ error: 'Something went wrong!' });
});

app.use((req, res) => {
  res.status(404).send("Sorry, that route doesn't exist.");
});

module.exports = { app, server };