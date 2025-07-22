const fs = require('fs');
const path = require('path');
const express = require('express');
const wiegine = require('ws3-fca');
const WebSocket = require('ws');

// Initialize Express app
const app = express();
const PORT = 3000;

// Bot configuration
let botConfig = {
  prefix: '!',
  adminID: ''
};

// Bot state
let botState = {
  running: false,
  api: null
};

// Locked groups and nicknames
const lockedGroups = {};
const lockedNicknames = {};

// WebSocket server
let wss;

// HTML Control Panel (simplified)
const htmlControlPanel = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Simple Messenger Bot</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
        }
        .status {
            padding: 10px;
            margin-bottom: 20px;
            border-radius: 5px;
            background: #f0f0f0;
        }
        .online { background: #d4edda; }
        .offline { background: #f8d7da; }
        button {
            padding: 8px 15px;
            margin: 5px;
            cursor: pointer;
        }
        input {
            padding: 8px;
            margin: 5px 0;
            width: 100%;
        }
        .log {
            height: 200px;
            overflow-y: auto;
            border: 1px solid #ddd;
            padding: 10px;
            margin-top: 20px;
            font-family: monospace;
        }
    </style>
</head>
<body>
    <h1>Simple Messenger Bot</h1>
    
    <div class="status offline" id="status">
        Status: Offline
    </div>
    
    <div>
        <input type="file" id="cookie-file" accept=".txt,.json">
        <small>Select your cookie file (txt or json)</small>
    </div>
    
    <div>
        <input type="text" id="prefix" value="${botConfig.prefix}" placeholder="Command prefix">
    </div>
    
    <div>
        <input type="text" id="admin-id" placeholder="Admin Facebook ID" value="${botConfig.adminID}">
    </div>
    
    <button id="start-btn">Start Bot</button>
    <button id="stop-btn" disabled>Stop Bot</button>
    
    <div class="log" id="log-container"></div>

    <script>
        const socket = new WebSocket('ws://' + window.location.host);
        const logContainer = document.getElementById('log-container');
        const statusDiv = document.getElementById('status');
        const startBtn = document.getElementById('start-btn');
        const stopBtn = document.getElementById('stop-btn');

        function addLog(message) {
            const logEntry = document.createElement('div');
            logEntry.textContent = \`[\${new Date().toLocaleTimeString()}] \${message}\`;
            logContainer.appendChild(logEntry);
            logContainer.scrollTop = logContainer.scrollHeight;
        }

        socket.onopen = () => addLog('Connected to bot server');
        
        socket.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'log') {
                addLog(data.message);
            } else if (data.type === 'status') {
                statusDiv.className = data.running ? 'status online' : 'status offline';
                statusDiv.textContent = \`Status: \${data.running ? 'Online' : 'Offline'}\`;
                startBtn.disabled = data.running;
                stopBtn.disabled = !data.running;
            }
        };
        
        socket.onclose = () => addLog('Disconnected from bot server');

        startBtn.addEventListener('click', () => {
            const fileInput = document.getElementById('cookie-file');
            if (fileInput.files.length === 0) {
                addLog('Please select a cookie file');
                return;
            }
            
            const file = fileInput.files[0];
            const reader = new FileReader();
            
            reader.onload = (event) => {
                const cookieContent = event.target.result;
                const prefix = document.getElementById('prefix').value.trim();
                const adminId = document.getElementById('admin-id').value.trim();
                
                socket.send(JSON.stringify({
                    type: 'start',
                    cookieContent,
                    prefix,
                    adminId
                }));
            };
            
            reader.readAsText(file);
        });
        
        stopBtn.addEventListener('click', () => {
            socket.send(JSON.stringify({ type: 'stop' }));
        });
        
        addLog('Control panel ready');
    </script>
</body>
</html>
`;

// Start bot function
function startBot(cookieContent, prefix, adminID) {
  botState.running = true;
  botConfig.prefix = prefix;
  botConfig.adminID = adminID;
  
  try {
    fs.writeFileSync('selected_cookie.txt', cookieContent);
    broadcast({ type: 'log', message: 'Cookie file saved' });
  } catch (err) {
    broadcast({ type: 'log', message: `Failed to save cookie: ${err.message}` });
    botState.running = false;
    return;
  }

  wiegine.login(cookieContent, {}, (err, api) => {
    if (err || !api) {
      broadcast({ type: 'log', message: `Login failed: ${err?.message || err}` });
      botState.running = false;
      return;
    }

    botState.api = api;
    broadcast({ type: 'log', message: 'Bot logged in and running' });
    broadcast({ type: 'status', running: true });
    
    api.setOptions({ listenEvents: true });

    // Event listener
    api.listenMqtt((err, event) => {
      if (err) {
        broadcast({ type: 'log', message: `Listen error: ${err}` });
        return;
      }

      // Message handling
      if (event.type === 'message' && event.body?.startsWith(botConfig.prefix)) {
        const senderID = event.senderID;
        const args = event.body.slice(botConfig.prefix.length).trim().split(' ');
        const command = args[0].toLowerCase();
        const groupName = args.slice(2).join(' ');
        const isAdmin = senderID === botConfig.adminID;

        if (command === 'groupnamelock' && args[1] === 'on' && isAdmin) {
          lockedGroups[event.threadID] = groupName;
          api.setTitle(groupName, event.threadID, (err) => {
            if (err) return api.sendMessage('Failed to lock group name.', event.threadID);
            api.sendMessage(`Group name locked: ${groupName}`, event.threadID);
          });
        } 
        else if (command === 'nicknamelock' && args[1] === 'on' && isAdmin) {
          const nickname = groupName;
          api.getThreadInfo(event.threadID, (err, info) => {
            if (err) return console.error('Thread info error:', err);
            info.participantIDs.forEach((userID, i) => {
              setTimeout(() => {
                api.changeNickname(nickname, event.threadID, userID, () => {});
              }, i * 2000);
            });
            lockedNicknames[event.threadID] = nickname;
            api.sendMessage(`Nicknames locked: ${nickname}`, event.threadID);
          });
        }
      }

      // Thread name changes
      if (event.logMessageType === 'log:thread-name') {
        const locked = lockedGroups[event.threadID];
        if (locked) {
          api.setTitle(locked, event.threadID, () => {
            api.sendMessage('Group name is locked', event.threadID);
          });
        }
      }

      // Nickname changes
      if (event.logMessageType === 'log:thread-nickname') {
        const locked = lockedNicknames[event.threadID];
        if (locked) {
          const userID = event.logMessageData.participant_id;
          api.changeNickname(locked, event.threadID, userID, () => {
            api.sendMessage('Nickname is locked', event.threadID);
          });
        }
      }
    });
  });
}

// Stop bot function
function stopBot() {
  if (botState.api) {
    botState.api.logout();
    botState.api = null;
  }
  botState.running = false;
  broadcast({ type: 'status', running: false });
  broadcast({ type: 'log', message: 'Bot stopped' });
}

// WebSocket broadcast function
function broadcast(message) {
  if (!wss) return;
  
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

// Set up Express server
app.get('/', (req, res) => {
  res.send(htmlControlPanel);
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`Control panel running at http://localhost:${PORT}`);
});

// Set up WebSocket server
wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ 
    type: 'status', 
    running: botState.running 
  }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'start') {
        botConfig.prefix = data.prefix;
        botConfig.adminID = data.adminId;
        
        try {
          if (!data.cookieContent) throw new Error('No cookie content provided');
          startBot(data.cookieContent, botConfig.prefix, botConfig.adminID);
        } catch (err) {
          broadcast({ type: 'log', message: `Error with cookie: ${err.message}` });
        }
      } else if (data.type === 'stop') {
        stopBot();
      }
    } catch (err) {
      console.error('Error processing WebSocket message:', err);
    }
  });
});
