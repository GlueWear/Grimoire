const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');
const mammoth = require('mammoth');

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// FILE UPLOAD
// ============================================

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, 'public/uploads'),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const unique = crypto.randomBytes(8).toString('hex');
      cb(null, unique + ext);
    }
  }),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file received' });
  }
  res.json({
    success: true,
    url: '/uploads/' + req.file.filename,
    originalName: req.file.originalname,
    mimetype: req.file.mimetype
  });
});

app.get('/api/preview/docx', async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'Missing path' });
  // Only allow files inside public/uploads
  const resolved = path.resolve(__dirname, 'public', filePath.replace(/^\//, ''));
  if (!resolved.startsWith(path.resolve(__dirname, 'public', 'uploads'))) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const result = await mammoth.convertToHtml({ path: resolved });
    res.json({ html: result.value });
  } catch (err) {
    res.status(500).json({ error: 'Conversion failed: ' + err.message });
  }
});

// ============================================
// NOCKBLOCKS API PROXY
// ============================================

const NOCKBLOCKS_URL = 'https://nockblocks.com/rpc/v1';
const NOCKBLOCKS_API_KEY = 'SlfkgK63EJtLJHn2aXYztjzPkCUAGOuOZ7FivhlWtDc';

// Get balance for a Nockchain address
app.get('/api/balance/:address', async (req, res) => {
  const { address } = req.params;
  
  if (!address) {
    return res.status(400).json({ success: false, message: 'Address required' });
  }
  
  try {
    const response = await fetch(NOCKBLOCKS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${NOCKBLOCKS_API_KEY}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'getNotesByAddress',
        params: [{ address, showSpent: false }],
        id: 1
      })
    });
    
    const data = await response.json();
    
    if (data.error) {
      throw new Error(data.error.message || JSON.stringify(data.error));
    }
    
    const notes = data.result || [];
    const totalBalance = notes.reduce((sum, note) => sum + (note.assets || note.amount || 0), 0);
    
    res.json({
      success: true,
      address,
      balance: totalBalance,
      noteCount: notes.length
    });
  } catch (error) {
    console.error('NockBlocks API error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get wallet address for a username
app.get('/api/wallet-address/:username', (req, res) => {
  const { username } = req.params;
  
  if (!username) {
    return res.status(400).json({ success: false, message: 'Username required' });
  }
  
  const address = state.walletAddresses[username.toLowerCase()];
  
  if (!address) {
    return res.status(404).json({ success: false, message: 'No wallet registered for this user' });
  }
  
  res.json({ success: true, address });
});

// ============================================
// IN-MEMORY DATA STORE
// ============================================

const state = {
  // Users currently connected (socketId → user object)
  users: new Map(),
  
  // User sessions - maps username to Set of socketIds (for multi-session support)
  userSessions: new Map(),
  
  // Active usernames (for uniqueness enforcement - visitors/agents only)
  activeUsernames: new Set(),
  
  // Notes: { noteId: { id, name, type, users, messages, children, parent, visibility, writable } }
  notes: {
    cover: {
      id: 'cover',
      name: 'ARS NOTORIA',
      type: 'notebook',
      users: [], // empty = everyone has access
      messages: [],
      threads: {},
      children: [],
      parent: null,
      isSpecial: true,
      visibility: 'public',
      writable: true
    }
  },
  
  // Artifacts: { id: { name, type, creator, creatorType, contributors, versions } }
  artifacts: {},
  
  // Wallets: keyed by username (not socketId)
  wallets: {},
  
  // Wallet address mapping: username → Iris wallet address (pkh)
  walletAddresses: {},
  
  // Registered bot webhooks: { socketId: bot }
  bots: {}
};

let messageIdCounter = 0;
let artifactIdCounter = 0;
let noteIdCounter = 0;

// ============================================
// HELPER FUNCTIONS
// ============================================

function getTimeString() {
  const now = new Date();
  return now.getHours().toString().padStart(2, '0') + ':' + 
         now.getMinutes().toString().padStart(2, '0');
}

function initWallet(username) {
  if (!state.wallets[username]) {
    state.wallets[username] = {
      balance: 100000.00,
      transactions: []
    };
  }
  return state.wallets[username];
}

// Get all socket IDs for a username
function getSocketsForUser(username) {
  return state.userSessions.get(username.toLowerCase()) || new Set();
}

// Emit to all sockets for a user
function emitToUser(username, event, data) {
  const sockets = getSocketsForUser(username);
  sockets.forEach(socketId => {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      socket.emit(event, data);
    }
  });
}

// Get deduplicated user list (unique by name)
function getUniqueUsers() {
  const seen = new Map();
  state.users.forEach(u => {
    if (!seen.has(u.name.toLowerCase())) {
      seen.set(u.name.toLowerCase(), { name: u.name, type: u.type });
    }
  });
  return Array.from(seen.values());
}

function broadcastUserList() {
  const userList = getUniqueUsers();
  io.emit('userList', userList);
}

// Broadcast an event to all unique users in a note (handles multi-session)
function broadcastToNote(noteId, event, data) {
  const notifiedUsers = new Set();
  const userIds = getUsersInNote(noteId);
  userIds.forEach(id => {
    const user = state.users.get(id);
    if (!user || notifiedUsers.has(user.name.toLowerCase())) return;
    notifiedUsers.add(user.name.toLowerCase());
    emitToUser(user.name, event, data);
  });
}

function canAccessNote(socketId, note) {
  // Cover is accessible to everyone
  if (note.isSpecial || note.id === 'cover') return true;
  
  const user = state.users.get(socketId);
  if (!user) return false;
  
  // Check this note directly
  if (note.users && note.users.includes(user.name)) return true;
  if (note.creator === user.name) return true;
  
  // Check ancestors - if user has access to any parent, they have access here
  let current = note;
  while (current.parent) {
    const parent = state.notes[current.parent];
    if (!parent) break;
    
    if (parent.users && parent.users.includes(user.name)) return true;
    if (parent.creator === user.name) return true;
    
    current = parent;
  }
  
  return false;
}

function getUsersInNote(noteId) {
  const note = state.notes[noteId];
  if (!note) return [];
  
  // For Cover, return all connected users
  if (note.isSpecial || noteId === 'cover') {
    return Array.from(state.users.keys());
  }
  
  // Find all connected users who have access (including via ancestors)
  const socketIds = [];
  state.users.forEach((user, socketId) => {
    if (canAccessNote(socketId, note)) {
      socketIds.push(socketId);
    }
  });
  
  return socketIds;
}

// --------------------------------------------
// LIGHT BIKE GAME HELPERS
// --------------------------------------------

function applyLightBikeMove(pos, move) {
  const directions = ['north', 'east', 'south', 'west'];
  let dirIdx = directions.indexOf(pos.direction);
  
  if (move === 'LEFT') {
    dirIdx = (dirIdx + 3) % 4; // Turn left
  } else if (move === 'RIGHT') {
    dirIdx = (dirIdx + 1) % 4; // Turn right
  }
  
  const newDir = directions[dirIdx];
  let newX = pos.x;
  let newY = pos.y;
  
  switch (newDir) {
    case 'north': newY--; break;
    case 'south': newY++; break;
    case 'east': newX++; break;
    case 'west': newX--; break;
  }
  
  return { x: newX, y: newY, direction: newDir };
}

function checkLightBikeCollision(pos, ownTrail, enemyTrail) {
  // Wall collision
  if (pos.x < 0 || pos.x >= 50 || pos.y < 0 || pos.y >= 50) {
    return true;
  }
  
  // Own trail collision (skip last position which is current)
  for (let i = 0; i < ownTrail.length - 1; i++) {
    if (ownTrail[i].x === pos.x && ownTrail[i].y === pos.y) {
      return true;
    }
  }
  
  // Enemy trail collision
  for (let i = 0; i < enemyTrail.length; i++) {
    if (enemyTrail[i].x === pos.x && enemyTrail[i].y === pos.y) {
      return true;
    }
  }
  
  return false;
}

// Dummy bot AI for testing
function getDummyBotMove(dummyType, myPos, enemyPos, myTrail, enemyTrail) {
  const moves = ['LEFT', 'RIGHT', 'STRAIGHT'];
  
  switch (dummyType) {
    case 'random':
      // Pure random
      return moves[Math.floor(Math.random() * 3)];
      
    case 'clockwise':
      // Always tries to turn right, goes straight if would crash
      const rightMove = applyLightBikeMove(myPos, 'RIGHT');
      if (!checkLightBikeCollision(rightMove, myTrail, enemyTrail)) {
        return 'RIGHT';
      }
      const straightMove = applyLightBikeMove(myPos, 'STRAIGHT');
      if (!checkLightBikeCollision(straightMove, myTrail, enemyTrail)) {
        return 'STRAIGHT';
      }
      return 'LEFT';
      
    case 'survivor':
      // Tries to survive - picks move that doesn't crash, prefers straight
      const straight = applyLightBikeMove(myPos, 'STRAIGHT');
      const left = applyLightBikeMove(myPos, 'LEFT');
      const right = applyLightBikeMove(myPos, 'RIGHT');
      
      const straightSafe = !checkLightBikeCollision(straight, myTrail, enemyTrail);
      const leftSafe = !checkLightBikeCollision(left, myTrail, enemyTrail);
      const rightSafe = !checkLightBikeCollision(right, myTrail, enemyTrail);
      
      // Prefer straight, then pick randomly between safe options
      if (straightSafe) return 'STRAIGHT';
      
      const safeOptions = [];
      if (leftSafe) safeOptions.push('LEFT');
      if (rightSafe) safeOptions.push('RIGHT');
      
      if (safeOptions.length > 0) {
        return safeOptions[Math.floor(Math.random() * safeOptions.length)];
      }
      
      // No safe moves, just go straight and die
      return 'STRAIGHT';
      
    default:
      return 'STRAIGHT';
  }
}

// Add user to a note and all its children recursively
function addUserToNoteTree(noteId, userName) {
  const note = state.notes[noteId];
  if (!note) return;
  
  if (!note.users) note.users = [];
  if (!note.users.includes(userName)) {
    note.users.push(userName);
  }
  
  // Recurse into children
  if (note.children && note.children.length > 0) {
    note.children.forEach(childId => addUserToNoteTree(childId, userName));
  }
}

// Collect all notes in a tree (parent + all descendants)
function collectNoteTree(noteId) {
  const note = state.notes[noteId];
  if (!note) return [];
  
  let result = [note];
  if (note.children && note.children.length > 0) {
    note.children.forEach(childId => {
      result = result.concat(collectNoteTree(childId));
    });
  }
  return result;
}

function deleteNoteRecursive(noteId) {
  const note = state.notes[noteId];
  if (!note) return;
  
  // Delete children first
  if (note.children) {
    note.children.forEach(childId => deleteNoteRecursive(childId));
  }
  
  delete state.notes[noteId];
}

// ============================================
// SOCKET.IO HANDLERS
// ============================================

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  
  // --------------------------------------------
  // JOIN - User identifies themselves
  // --------------------------------------------
  socket.on('join', (data) => {
    const { name, type } = data;
    const nameLower = name.toLowerCase();
    
    // Check if username is already taken (only for non-urbit users)
    // Urbit IDs are authenticated by MetaMask, so same person can have multiple sessions
    if (type !== 'urbit' && state.activeUsernames.has(nameLower)) {
      socket.emit('joinError', { 
        message: `The name "${name}" is already in use. Please choose another.` 
      });
      return;
    }
    
    // Reserve the username (case-insensitive) - for non-urbit only
    if (type !== 'urbit') {
      state.activeUsernames.add(nameLower);
    }
    
    // Track this socket for the user
    if (!state.userSessions.has(nameLower)) {
      state.userSessions.set(nameLower, new Set());
    }
    state.userSessions.get(nameLower).add(socket.id);
    
    state.users.set(socket.id, {
      id: socket.id,
      name,
      type,
      joinedAt: Date.now(),
      currentNote: 'cover'
    });
    
    // Initialize wallet (keyed by username, not socket)
    initWallet(name);
    
    console.log(`User joined: ${name} (${type}) - ${state.userSessions.get(nameLower).size} session(s)`);
    
    // Get notes this user has access to
    const userNotes = {};
    Object.entries(state.notes).forEach(([id, note]) => {
      if (canAccessNote(socket.id, note)) {
        userNotes[id] = note;
      }
    });
    
    // Send current state to new user
    socket.emit('init', {
      notes: userNotes,
      currentNote: 'cover',
      artifacts: state.artifacts,
      wallet: state.wallets[name],
      users: getUniqueUsers(),
      agents: Object.values(state.bots).map(b => ({ name: b.name, owner: b.owner }))
    });
    
    // Broadcast updated user list (deduped)
    broadcastUserList();
    
    // Notify others (only if this is the first session for this user)
    if (state.userSessions.get(nameLower).size === 1) {
      socket.broadcast.emit('userJoined', { name, type });
    }
  });
  
  // --------------------------------------------
  // SWITCH NOTE
  // --------------------------------------------
  socket.on('switchNote', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    const { noteId } = data;
    const note = state.notes[noteId];
    
    if (note && canAccessNote(socket.id, note)) {
      user.currentNote = noteId;
      console.log(`${user.name} switched to note: ${noteId}`);
    }
  });
  
  // --------------------------------------------
  // CREATE NOTE
  // --------------------------------------------
  socket.on('createNote', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    const { name, parentId } = data;
    
    // Server assigns the ID
    const noteId = 'note-' + (++noteIdCounter);
    
    // Start with creator in users list
    let noteUsers = [user.name];
    let noteType = 'notebook';
    
    // Walk up the tree to find if any ancestor is shared
    // If so, inherit users from the nearest shared ancestor
    if (parentId) {
      let current = state.notes[parentId];
      while (current) {
        if (current.type === 'dm' && current.users && current.users.length > 1) {
          // Found a shared ancestor - inherit its users
          noteUsers = [...current.users];
          if (!noteUsers.includes(user.name)) {
            noteUsers.push(user.name);
          }
          noteType = 'dm';
          break;
        }
        // Walk up to parent
        current = current.parent ? state.notes[current.parent] : null;
      }
    }
    
    const note = {
      id: noteId,
      name: name,
      type: noteType,
      creator: user.name,
      users: noteUsers,
      messages: [],
      threads: {},
      children: [],
      parent: parentId || null,
      visibility: 'private',
      writable: true
    };
    
    state.notes[noteId] = note;
    
    // Add to parent's children if nested
    if (parentId && state.notes[parentId]) {
      state.notes[parentId].children.push(noteId);
    }
    
    console.log(`${user.name} created note: ${name} (${noteId}), users: ${noteUsers.join(', ')}`);
    
    // Send note to creator
    socket.emit('noteCreated', { note });
    
    // If shared (has other users), notify them too (all their sessions)
    if (noteUsers.length > 1) {
      noteUsers.forEach(userName => {
        if (userName === user.name) return; // Skip creator, already sent
        emitToUser(userName, 'noteCreated', { note });
      });
    }
  });
  
  // --------------------------------------------
  // RENAME NOTE
  // --------------------------------------------
  socket.on('renameNote', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    const { noteId, name } = data;
    const note = state.notes[noteId];
    
    if (note && !note.isSpecial) {
      note.name = name;
      
      // Notify all users who have access
      const userIds = getUsersInNote(noteId);
      userIds.forEach(id => {
        io.to(id).emit('noteRenamed', { noteId, name });
      });
    }
  });
  
  // --------------------------------------------
  // DELETE NOTE
  // --------------------------------------------
  socket.on('deleteNote', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    const { noteId } = data;
    const note = state.notes[noteId];
    
    if (note && !note.isSpecial) {
      // Remove from parent
      if (note.parent && state.notes[note.parent]) {
        const idx = state.notes[note.parent].children.indexOf(noteId);
        if (idx > -1) state.notes[note.parent].children.splice(idx, 1);
      }
      
      // Delete recursively
      deleteNoteRecursive(noteId);
      
      // Notify users
      io.emit('noteDeleted', { noteId });
    }
  });
  
  // --------------------------------------------
  // DUPLICATE NOTE
  // --------------------------------------------
  socket.on('duplicateNote', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    const { sourceNoteId, newName } = data;
    const sourceNote = state.notes[sourceNoteId];
    
    if (!sourceNote) return;
    
    // Server assigns ID
    const newNoteId = 'note-' + (++noteIdCounter);
    
    // Create duplicate
    const newNote = {
      id: newNoteId,
      name: newName,
      type: 'notebook',
      creator: user.name,
      users: [user.name],
      messages: [...sourceNote.messages],
      threads: { ...sourceNote.threads },
      children: [],
      parent: null,
      visibility: 'private',
      writable: true
    };
    
    state.notes[newNoteId] = newNote;
    
    console.log(`${user.name} duplicated note ${sourceNoteId} as ${newNoteId}`);
    
    // Send to creator only
    socket.emit('noteCreated', { note: newNote });
  });
  
  // --------------------------------------------
  // CONVERT NOTE TO DM (when no existing DM)
  // --------------------------------------------
  socket.on('convertNoteToDM', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    const { noteId, userName } = data;
    const note = state.notes[noteId];
    
    if (!note) return;
    
    // Remove from old parent
    if (note.parent && state.notes[note.parent]) {
      const idx = state.notes[note.parent].children.indexOf(noteId);
      if (idx > -1) state.notes[note.parent].children.splice(idx, 1);
    }
    
    // Convert note to DM
    note.type = 'dm';
    note.name = userName; // Set name to the other person (for creator's view)
    note.parent = null;
    note.creator = user.name; // Set creator for DM lookup
    
    // Add both users to this note AND all children
    addUserToNoteTree(noteId, user.name);
    addUserToNoteTree(noteId, userName);
    
    console.log(`${user.name} converted note ${noteId} to DM with ${userName}, users: ${note.users}`);
    
    // Notify the recipient (all their sessions) - send main note and all children
    const recipientNote = { ...note, name: user.name };
    emitToUser(userName, 'noteInvite', { 
      note: recipientNote, 
      fromUser: user.name 
    });
    
    // Send all children
    const allNotes = collectNoteTree(noteId);
    allNotes.forEach(n => {
      if (n.id !== noteId) {
        emitToUser(userName, 'noteInvite', {
          note: n,
          fromUser: user.name
        });
      }
    });
  });
  
  // --------------------------------------------
  // SHARE NOTE WITH USER (move notebook under DM)
  // --------------------------------------------
  socket.on('shareNoteWithUser', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    const { noteId, userName, dmId } = data;
    const note = state.notes[noteId];
    
    if (!note) return;
    
    // Find or create the DM
    let dm = state.notes[dmId];
    if (!dm) {
      // Create the DM
      dm = {
        id: dmId,
        name: userName,
        type: 'dm',
        creator: user.name,
        users: [user.name, userName],
        messages: [],
        threads: {},
        children: [],
        parent: null,
        visibility: 'private',
        writable: true
      };
      state.notes[dmId] = dm;
    }
    
    // Remove note from old parent
    if (note.parent && state.notes[note.parent]) {
      const idx = state.notes[note.parent].children.indexOf(noteId);
      if (idx > -1) state.notes[note.parent].children.splice(idx, 1);
    }
    
    // Move note under DM
    note.parent = dmId;
    if (!dm.children) dm.children = [];
    if (!dm.children.includes(noteId)) {
      dm.children.push(noteId);
    }
    
    // Add users to the note AND all its children
    addUserToNoteTree(noteId, user.name);
    addUserToNoteTree(noteId, userName);
    
    console.log(`${user.name} shared note ${noteId} with ${userName}, moved under DM ${dmId}`);
    
    // Notify the sharer (update their view)
    const sharerDm = { ...dm, name: userName };
    socket.emit('noteShared', { 
      note: note, 
      dm: sharerDm 
    });
    
    // Notify the recipient (all their sessions) - send DM, note, and all children
    const recipientDm = { ...dm, name: user.name };
    emitToUser(userName, 'noteShared', { 
      note: note, 
      dm: recipientDm,
      fromUser: user.name
    });
    
    // Send all children of the shared note
    const allNotes = collectNoteTree(noteId);
    allNotes.forEach(n => {
      if (n.id !== noteId) {
        emitToUser(userName, 'noteInvite', {
          note: n,
          fromUser: user.name
        });
      }
    });
  });
  
  // --------------------------------------------
  // INVITE TO NOTE
  // --------------------------------------------
  socket.on('inviteToNote', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    const { noteId, userName } = data;
    const note = state.notes[noteId];
    
    if (!note || note.isSpecial) return;
    
    // Add creator if not present
    if (note.creator && !note.users) {
      note.users = [];
    }
    if (note.creator && !note.users.includes(note.creator)) {
      note.users.push(note.creator);
    }
    
    // Add invited user to this note AND all nested children
    addUserToNoteTree(noteId, userName);
    
    // Count real users (non-agents)
    const realUsers = note.users.filter(u => {
      const isAgent = Object.values(state.bots).some(b => b.name === u);
      return !isAgent;
    });
    
    // Update note type - always 'dm' (shared note)
    // Name handling: 2 people = other person's name per user, 3+ = comma list
    note.type = 'dm';
    
    if (realUsers.length > 2) {
      // 3+ people - update name to comma list
      const otherMembers = realUsers.filter(u => u !== note.creator);
      note.name = otherMembers.slice(0, 3).join(', ') + (otherMembers.length > 3 ? '...' : '');
    }
    
    console.log(`${user.name} invited ${userName} to note ${noteId}, users: ${realUsers.length}, name: ${note.name}`);
    
    // Send note AND all children to invited user (all their sessions)
    let inviteeName = note.name;
    if (realUsers.length === 2) {
      // 2 people: invitee sees inviter's name
      inviteeName = user.name;
    } else {
      // 3+ people: show comma list excluding themselves
      const theirOthers = realUsers.filter(u => u !== userName);
      inviteeName = theirOthers.slice(0, 3).join(', ') + (theirOthers.length > 3 ? '...' : '');
    }
    
    // Check if invitee has access to the parent
    // If not, this note should appear top-level for them
    let noteForInvitee = { ...note, name: inviteeName };
    if (note.parent) {
      const parent = state.notes[note.parent];
      if (!parent || !parent.users || !parent.users.includes(userName)) {
        // Invitee doesn't have access to parent - make this top-level for them
        noteForInvitee.parent = null;
      }
    }
    
    // Send the main note to all invitee sessions
    emitToUser(userName, 'noteInvite', {
      note: noteForInvitee,
      fromUser: user.name
    });
    
    // Send all nested children to all invitee sessions
    const allNotes = collectNoteTree(noteId);
    allNotes.forEach(n => {
      if (n.id !== noteId) { // Skip the parent, already sent
        emitToUser(userName, 'noteInvite', {
          note: n,
          fromUser: user.name
        });
      }
    });
    
    // Notify all users in note about changes (by unique username)
    const notifiedUsers = new Set();
    const userIds = getUsersInNote(noteId);
    userIds.forEach(id => {
      const viewingUser = state.users.get(id);
      if (!viewingUser || notifiedUsers.has(viewingUser.name.toLowerCase())) return;
      if (viewingUser.name === userName) return; // Don't double-send to invitee
      
      notifiedUsers.add(viewingUser.name.toLowerCase());
      
      let viewName = note.name;
      
      if (realUsers.length === 2) {
        // 2 people: each sees the other's name
        const otherPerson = realUsers.find(u => u !== viewingUser.name);
        if (otherPerson) viewName = otherPerson;
      } else if (realUsers.length > 2) {
        // 3+ people: each sees comma list excluding themselves
        const theirOthers = realUsers.filter(u => u !== viewingUser.name);
        viewName = theirOthers.slice(0, 3).join(', ') + (theirOthers.length > 3 ? '...' : '');
      }
      
      emitToUser(viewingUser.name, 'noteTypeChanged', {
        noteId: noteId,
        type: note.type,
        name: viewName,
        users: note.users
      });
    });
  });
  
  // --------------------------------------------
  // INVITE MULTIPLE USERS (batch invite)
  // --------------------------------------------
  socket.on('inviteMultiple', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    const { noteId, userNames } = data;
    const note = state.notes[noteId];
    
    if (!note || note.isSpecial || !userNames || userNames.length === 0) return;
    
    console.log(`${user.name} batch inviting ${userNames.join(', ')} to note ${noteId}`);
    
    // CASE 1: Already a shared note - just add users, DON'T rename
    if (note.type === 'dm') {
      // Add all invited users to this note AND all children
      userNames.forEach(userName => {
        addUserToNoteTree(noteId, userName);
      });
      
      // Count real users (non-agents)
      const realUsers = note.users.filter(u => {
        const isAgent = Object.values(state.bots).some(b => b.name === u);
        return !isAgent;
      });
      
      // Keep existing name - don't auto-rename
      // Send update to inviter (with their view - preserve their parent access)
      let noteForInviter = { ...note };
      if (note.parent) {
        const parent = state.notes[note.parent];
        if (!parent || !parent.users || !parent.users.includes(user.name)) {
          // Inviter doesn't have access to parent - keep it null for them
          noteForInviter.parent = null;
        }
      }
      socket.emit('inviteMultipleResult', { 
        note: noteForInviter
      });
      
      // Send to each invitee
      sendToInvitees(note, noteId, userNames, realUsers, user);
      
      // Notify existing users
      notifyExistingUsers(note, noteId, userNames, realUsers, user);
      return;
    }
    
    // CASE 2: Notebook + 1 person - check for existing DM
    if (note.type === 'notebook' && userNames.length === 1) {
      const inviteeName = userNames[0];
      
      // Look for existing 2-person DM with this person
      let existingDM = null;
      for (const [id, n] of Object.entries(state.notes)) {
        if (n.type === 'dm' && !n.isSpecial && !n.parent) {
          const noteUsers = n.users || [];
          if (noteUsers.length === 2 && noteUsers.includes(user.name) && noteUsers.includes(inviteeName)) {
            existingDM = n;
            break;
          }
        }
      }
      
      if (existingDM) {
        // NEST under existing DM
        // Remove from old parent
        if (note.parent && state.notes[note.parent]) {
          const idx = state.notes[note.parent].children.indexOf(noteId);
          if (idx > -1) state.notes[note.parent].children.splice(idx, 1);
        }
        
        // Move under DM
        note.parent = existingDM.id;
        note.type = 'dm';
        if (!existingDM.children) existingDM.children = [];
        if (!existingDM.children.includes(noteId)) {
          existingDM.children.push(noteId);
        }
        
        // Add users to note tree
        addUserToNoteTree(noteId, user.name);
        addUserToNoteTree(noteId, inviteeName);
        
        console.log(`Nested note ${noteId} under existing DM ${existingDM.id}`);
        
        // Send noteShared to inviter
        const sharerDm = { ...existingDM, name: inviteeName };
        socket.emit('noteShared', { 
          note: note, 
          dm: sharerDm 
        });
        
        // Send to invitee (all their sessions)
        const recipientDm = { ...existingDM, name: user.name };
        emitToUser(inviteeName, 'noteShared', { 
          note: note, 
          dm: recipientDm,
          fromUser: user.name
        });
        
        // Send children
        const allNotes = collectNoteTree(noteId);
        allNotes.forEach(n => {
          if (n.id !== noteId) {
            emitToUser(inviteeName, 'noteInvite', {
              note: n,
              fromUser: user.name
            });
          }
        });
        return;
      }
      
      // NO existing DM - convert this note to the DM
      // Remove from old parent
      if (note.parent && state.notes[note.parent]) {
        const idx = state.notes[note.parent].children.indexOf(noteId);
        if (idx > -1) state.notes[note.parent].children.splice(idx, 1);
      }
      
      note.type = 'dm';
      note.parent = null;
      note.name = inviteeName;
      note.creator = user.name;
      
      // Add users
      addUserToNoteTree(noteId, user.name);
      addUserToNoteTree(noteId, inviteeName);
      
      console.log(`Converted note ${noteId} to DM with ${inviteeName}`);
      
      // Send update to inviter
      socket.emit('inviteMultipleResult', { 
        note: { ...note, name: inviteeName }
      });
      
      // Send to invitee (all their sessions)
      emitToUser(inviteeName, 'noteInvite', {
        note: { ...note, name: user.name },
        fromUser: user.name
      });
      
      // Send children
      const allNotesForDM = collectNoteTree(noteId);
      allNotesForDM.forEach(n => {
        if (n.id !== noteId) {
          emitToUser(inviteeName, 'noteInvite', {
            note: n,
            fromUser: user.name
          });
        }
      });
      return;
    }
    
    // CASE 3: Notebook + 2+ people - convert to group
    // Remove from old parent (becomes top-level)
    if (note.parent && state.notes[note.parent]) {
      const parent = state.notes[note.parent];
      if (parent.type !== 'dm') {
        const idx = parent.children.indexOf(noteId);
        if (idx > -1) parent.children.splice(idx, 1);
        note.parent = null;
      }
    }
    
    note.type = 'dm';
    note.creator = user.name;
    
    // Add all users
    if (!note.users) note.users = [];
    if (!note.users.includes(user.name)) note.users.push(user.name);
    userNames.forEach(userName => {
      addUserToNoteTree(noteId, userName);
    });
    
    // Count real users
    const realUsers = note.users.filter(u => {
      const isAgent = Object.values(state.bots).some(b => b.name === u);
      return !isAgent;
    });
    
    // Set name (comma list of others for inviter)
    const inviterOthers = realUsers.filter(u => u !== user.name);
    const inviterName = inviterOthers.slice(0, 3).join(', ') + (inviterOthers.length > 3 ? '...' : '');
    note.name = inviterName;
    
    console.log(`Converted note ${noteId} to group with ${realUsers.join(', ')}`);
    
    // Send update to inviter
    socket.emit('inviteMultipleResult', { 
      note: { ...note, name: inviterName }
    });
    
    // Send to each invitee
    sendToInvitees(note, noteId, userNames, realUsers, user);
  });
  
  // Helper: Send note to invitees (all their sessions)
  function sendToInvitees(note, noteId, userNames, realUsers, inviter) {
    userNames.forEach(userName => {
      // Calculate name for this invitee
      const theirOthers = realUsers.filter(u => u !== userName);
      const theirName = theirOthers.length === 1
        ? theirOthers[0]
        : theirOthers.slice(0, 3).join(', ') + (theirOthers.length > 3 ? '...' : '');
      
      // Check if invitee has access to parent
      let noteForInvitee = { ...note, name: theirName };
      if (note.parent) {
        const parent = state.notes[note.parent];
        if (!parent || !parent.users || !parent.users.includes(userName)) {
          noteForInvitee.parent = null;
        }
      }
      
      emitToUser(userName, 'noteInvite', {
        note: noteForInvitee,
        fromUser: inviter.name
      });
      
      // Send children
      const allNotes = collectNoteTree(noteId);
      allNotes.forEach(n => {
        if (n.id !== noteId) {
          emitToUser(userName, 'noteInvite', {
            note: n,
            fromUser: inviter.name
          });
        }
      });
    });
  }
  
  // Helper: Notify existing users of changes (all their sessions)
  function notifyExistingUsers(note, noteId, newUserNames, realUsers, inviter) {
    const existingUserNames = note.users.filter(u => u !== inviter.name && !newUserNames.includes(u));
    existingUserNames.forEach(userName => {
      const theirOthers = realUsers.filter(u => u !== userName);
      const theirName = theirOthers.length === 1
        ? theirOthers[0]
        : theirOthers.slice(0, 3).join(', ') + (theirOthers.length > 3 ? '...' : '');
      
      emitToUser(userName, 'noteTypeChanged', {
        noteId: noteId,
        type: note.type,
        name: theirName,
        users: note.users
      });
    });
  }
  
  // --------------------------------------------
  // CHAT MESSAGE
  // --------------------------------------------
  socket.on('message', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    const noteId = data.noteId || user.currentNote || 'cover';
    const note = state.notes[noteId];
    
    if (!note) {
      console.log(`Message to non-existent note: ${noteId}`);
      return;
    }
    
    const messageId = 'msg-' + (++messageIdCounter);
    const timeStr = getTimeString();
    
    const message = {
      id: messageId,
      noteId: noteId,
      author: user.name,
      authorType: user.type,
      text: data.text,
      time: timeStr,
      timestamp: Date.now(),
      replyTo: data.replyTo || null,
      quote: data.quote || null
    };
    
    // Store in note
    note.messages.push(message);
    
    // Track threads within note
    if (data.replyTo) {
      if (!note.threads[data.replyTo]) {
        note.threads[data.replyTo] = [];
      }
      note.threads[data.replyTo].push(messageId);
    }
    
    // Broadcast to all users who have access to this note (handles multi-session)
    broadcastToNote(noteId, 'message', message);
    
    console.log(`Message in ${noteId} from ${user.name}: ${data.text.substring(0, 50)}`);
    
    // Check for @mentions and trigger bot webhooks
    const mentions = data.text.match(/@[~\w-]+/g);
    if (mentions) {
      mentions.forEach(mention => {
        const botName = mention.slice(1);
        // Find bot by name
        Object.values(state.bots).forEach(bot => {
          if (bot.name === botName && bot.webhookUrl) {
            console.log(`Triggering webhook for ${bot.name}`);
            triggerWebhook(bot, message);
          }
        });
      });
    }
  });
  
  // --------------------------------------------
  // ARTIFACT CREATE
  // --------------------------------------------
  socket.on('createArtifact', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    const artifactId = 'artifact-' + (++artifactIdCounter);
    const timeStr = getTimeString();
    
    const noteId = user.currentNote || 'cover';
    const note = state.notes[noteId];
    
    const artifact = {
      id: artifactId,
      name: data.name,
      type: data.type,
      creator: user.name,
      creatorType: user.type,
      noteId: noteId,
      contributors: [],
      versions: [{
        version: 1,
        content: data.content,
        modified: timeStr,
        editor: user.name,
        editorType: user.type
      }]
    };
    
    state.artifacts[artifactId] = artifact;
    
    // Broadcast to all clients in this note (handles multi-session)
    broadcastToNote(noteId, 'artifactCreated', artifact);
    
    // Also post a message about it (include comment if provided)
    const messageId = 'msg-' + (++messageIdCounter);
    const messageText = data.comment ? data.comment : `created artifact: ${data.name}`;
    const message = {
      id: messageId,
      noteId: noteId,
      author: user.name,
      authorType: user.type,
      text: messageText,
      time: timeStr,
      timestamp: Date.now(),
      artifactId: artifactId,
      artifactVersion: 1
    };
    
    if (note) {
      note.messages.push(message);
    }
    
    broadcastToNote(noteId, 'message', message);
  });
  
  // --------------------------------------------
  // ARTIFACT EDIT
  // --------------------------------------------
  socket.on('editArtifact', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    const artifact = state.artifacts[data.artifactId];
    if (!artifact) return;
    
    const timeStr = getTimeString();
    const newVersion = artifact.versions.length + 1;
    const noteId = user.currentNote || 'cover';
    const note = state.notes[noteId];
    
    artifact.versions.push({
      version: newVersion,
      content: data.content,
      modified: timeStr,
      editor: user.name,
      editorType: user.type
    });
    
    // Add to contributors if not already
    if (!artifact.contributors.includes(user.name) && artifact.creator !== user.name) {
      artifact.contributors.push(user.name);
    }
    
    // Broadcast update to users in note (handles multi-session)
    broadcastToNote(noteId, 'artifactUpdated', artifact);
    
    // Post message about edit
    const messageId = 'msg-' + (++messageIdCounter);
    const message = {
      id: messageId,
      noteId: noteId,
      author: user.name,
      authorType: user.type,
      text: `edited artifact: ${artifact.name}`,
      time: timeStr,
      timestamp: Date.now(),
      artifactId: artifact.id,
      artifactVersion: newVersion
    };
    
    if (note) {
      note.messages.push(message);
    }
    
    broadcastToNote(noteId, 'message', message);
  });
  
  // --------------------------------------------
  // DELETE ARTIFACT
  // --------------------------------------------
  socket.on('deleteArtifact', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    const artifact = state.artifacts[data.artifactId];
    if (!artifact) return;
    const noteId = artifact.noteId;
    // Remove artifact
    delete state.artifacts[data.artifactId];
    // Remove associated messages from note
    const note = state.notes[noteId];
    if (note) {
      note.messages = note.messages.filter(m => m.artifactId !== data.artifactId);
    }
    broadcastToNote(noteId, 'artifactDeleted', { artifactId: data.artifactId });
  });

  // --------------------------------------------
  // CANVAS ARTIFACT
  // --------------------------------------------

  // Broadcast new drawn path or placed image to all in note
  socket.on('canvasObjectAdded', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    const noteId = user.currentNote || 'cover';
    broadcastToNote(noteId, 'canvasObjectAdded', data);
  });

  // Broadcast moved/resized object to all in note
  socket.on('canvasObjectModified', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    const noteId = user.currentNote || 'cover';
    broadcastToNote(noteId, 'canvasObjectModified', data);
  });

  // Clear canvas: reset saved state and broadcast
  socket.on('canvasClear', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    const artifact = state.artifacts[data.artifactId];
    if (!artifact) return;
    const noteId = user.currentNote || 'cover';
    const timeStr = getTimeString();
    // Overwrite version 1 (canvas always saves in place)
    artifact.versions[0] = {
      version: 1,
      content: '{}',
      modified: timeStr,
      editor: user.name,
      editorType: user.type
    };
    artifact.versions.length = 1;
    broadcastToNote(noteId, 'canvasClear', { artifactId: data.artifactId });
  });

  // Auto-save: overwrite canvas state in place (no version accumulation)
  socket.on('canvasSave', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    const artifact = state.artifacts[data.artifactId];
    if (!artifact) return;
    const timeStr = getTimeString();
    artifact.versions[0] = {
      version: 1,
      content: data.dataUrl,
      modified: timeStr,
      editor: user.name,
      editorType: user.type
    };
    artifact.versions.length = 1;
    broadcastToNote(artifact.noteId, 'canvasSync', { artifactId: data.artifactId, json: data.dataUrl, from: socket.id, sync: data.sync });
  });

  // --------------------------------------------
  // LIGHT BIKE GAME
  // --------------------------------------------
  
  socket.on('lightbikeSelectPlayer', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    const { artifactId, playerNum, botName, owner } = data;
    
    // Initialize game state if needed
    if (!state.lightbikeGames) state.lightbikeGames = {};
    if (!state.lightbikeGames[artifactId]) {
      state.lightbikeGames[artifactId] = {
        player1: null,
        player2: null,
        state: 'waiting'
      };
    }
    
    const game = state.lightbikeGames[artifactId];
    
    // Check if slot is already taken
    if (playerNum === 1 && game.player1) return;
    if (playerNum === 2 && game.player2) return;
    
    // Check if it's a dummy bot
    if (botName.startsWith('dummy:')) {
      const dummyType = botName.split(':')[1];
      const dummyNames = {
        'random': '🤖 Random',
        'clockwise': '🤖 Clockwise',
        'survivor': '🤖 Survivor'
      };
      
      if (playerNum === 1) {
        game.player1 = { bot: dummyNames[dummyType] || botName, owner: 'system', isDummy: true, dummyType: dummyType };
      } else {
        game.player2 = { bot: dummyNames[dummyType] || botName, owner: 'system', isDummy: true, dummyType: dummyType };
      }
    } else {
      // Verify the bot belongs to this user
      const bot = Object.values(state.bots).find(b => b.name === botName && b.owner === owner);
      if (!bot) return;
      
      // Assign player
      if (playerNum === 1) {
        game.player1 = { bot: botName, owner: owner, webhook: bot.webhookUrl };
      } else {
        game.player2 = { bot: botName, owner: owner, webhook: bot.webhookUrl };
      }
    }
    
    // Update state
    if (game.player1 && game.player2) {
      game.state = 'ready';
    }
    
    // Get note for this artifact to broadcast
    const artifact = state.artifacts[artifactId];
    if (!artifact) return;
    
    const noteId = artifact.noteId || 'cover';
    
    // Broadcast game state update (handles multi-session)
    broadcastToNote(noteId, 'lightbikeGameUpdate', { artifactId, game });
  });
  
  socket.on('lightbikeStart', async (data) => {
    const { artifactId } = data;
    
    if (!state.lightbikeGames || !state.lightbikeGames[artifactId]) return;
    
    const game = state.lightbikeGames[artifactId];
    if (game.state !== 'ready') return;
    
    // Initialize game
    game.state = 'running';
    game.tick = 0;
    game.pos1 = { x: 12, y: 25, direction: 'east' };
    game.pos2 = { x: 37, y: 25, direction: 'west' };
    game.trail1 = [{ x: 12, y: 25 }];
    game.trail2 = [{ x: 37, y: 25 }];
    game.winner = null;
    
    // Get note for this artifact
    const artifact = state.artifacts[artifactId];
    const noteId = artifact ? artifact.noteId : 'cover';
    const note = state.notes[noteId];

    // Announce game start in chat
    const startMsgId = 'msg-' + (++messageIdCounter);
    const startMsg = {
      id: startMsgId,
      noteId,
      author: 'SYSTEM',
      authorType: 'system',
      text: `LIGHT BIKE: ${game.player1.bot} (${game.player1.owner}) vs ${game.player2.bot} (${game.player2.owner}) — GAME STARTED`,
      time: getTimeString(),
      timestamp: Date.now()
    };
    if (note) note.messages.push(startMsg);
    broadcastToNote(noteId, 'message', startMsg);

    // Send initial briefing to LLM bots
    const briefingP1 = `You are playing LIGHT BIKE (like Tron).

RULES:
- 50x50 grid arena (coordinates 0-49)
- You leave a trail behind you that kills on contact
- Hit a wall or any trail (yours or enemy's) = you die
- Last one alive wins

CONTROLS - respond with ONLY one of these words:
- LEFT = turn 90° counterclockwise
- RIGHT = turn 90° clockwise
- STRAIGHT = keep current direction

DIRECTIONS:
- If facing EAST and turn LEFT, you face NORTH
- If facing EAST and turn RIGHT, you face SOUTH
- NORTH = y decreases, SOUTH = y increases, EAST = x increases, WEST = x decreases

You are PLAYER 1 (amber). You start at position (12, 25) facing EAST.
Your opponent starts at (37, 25) facing WEST.

Each turn I will tell you positions. Respond with ONLY: LEFT, RIGHT, or STRAIGHT

Game starting now!`;

    const briefingP2 = `You are playing LIGHT BIKE (like Tron).

RULES:
- 50x50 grid arena (coordinates 0-49)
- You leave a trail behind you that kills on contact
- Hit a wall or any trail (yours or enemy's) = you die
- Last one alive wins

CONTROLS - respond with ONLY one of these words:
- LEFT = turn 90° counterclockwise
- RIGHT = turn 90° clockwise
- STRAIGHT = keep current direction

DIRECTIONS:
- If facing WEST and turn LEFT, you face SOUTH
- If facing WEST and turn RIGHT, you face NORTH
- NORTH = y decreases, SOUTH = y increases, EAST = x increases, WEST = x decreases

You are PLAYER 2 (blue). You start at position (37, 25) facing WEST.
Your opponent starts at (12, 25) facing EAST.

Each turn I will tell you positions. Respond with ONLY: LEFT, RIGHT, or STRAIGHT

Game starting now!`;

    // Send briefings (don't wait for response)
    if (!game.player1.isDummy && game.player1.webhook) {
      try {
        await fetch(game.player1.webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: { text: "@" + game.player1.bot + " " + briefingP1 }, botName: game.player1.bot })
        });
      } catch (e) {
        console.log('Light Bike: P1 briefing error', e.message);
      }
    }
    
    if (!game.player2.isDummy && game.player2.webhook) {
      try {
        await fetch(game.player2.webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: { text: "@" + game.player2.bot + " " + briefingP2 }, botName: game.player2.bot })
        });
      } catch (e) {
        console.log('Light Bike: P2 briefing error', e.message);
      }
    }
    
    // Broadcast initial state (handles multi-session)
    broadcastToNote(noteId, 'lightbikeTick', { artifactId, gameState: game });
    
    // Run game loop - 10 seconds per tick
    const gameLoop = setInterval(async () => {
      if (game.state !== 'running') {
        clearInterval(gameLoop);
        return;
      }
      
      game.tick++;
      
      // Build tick prompt for LLM bots
      const tickPromptP1 = `TICK ${game.tick}:
You: (${game.pos1.x}, ${game.pos1.y}) facing ${game.pos1.direction.toUpperCase()}
Enemy: (${game.pos2.x}, ${game.pos2.y}) facing ${game.pos2.direction.toUpperCase()}
Your move? (LEFT, RIGHT, or STRAIGHT)`;

      const tickPromptP2 = `TICK ${game.tick}:
You: (${game.pos2.x}, ${game.pos2.y}) facing ${game.pos2.direction.toUpperCase()}
Enemy: (${game.pos1.x}, ${game.pos1.y}) facing ${game.pos1.direction.toUpperCase()}
Your move? (LEFT, RIGHT, or STRAIGHT)`;

      // Query player 1
      let move1 = 'STRAIGHT';
      if (game.player1.isDummy) {
        move1 = getDummyBotMove(game.player1.dummyType, game.pos1, game.pos2, game.trail1, game.trail2);
      } else {
        try {
          const resp1 = await fetch(game.player1.webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: { text: "@" + game.player1.bot + " " + tickPromptP1 }, botName: game.player1.bot })
          });
          const data1 = await resp1.json();
          // Parse response - look for LEFT, RIGHT, or STRAIGHT in the response
          const responseText = (data1.reply || data1.response || data1.text || data1.message || '').toUpperCase();
          if (responseText.includes('LEFT')) {
            move1 = 'LEFT';
          } else if (responseText.includes('RIGHT')) {
            move1 = 'RIGHT';
          } else {
            move1 = 'STRAIGHT';
          }
          console.log(`Light Bike P1 (${game.player1.bot}): "${responseText}" -> ${move1}`);
        } catch (e) {
          console.log('Light Bike: P1 bot error', e.message);
        }
      }
      
      // Query player 2
      let move2 = 'STRAIGHT';
      if (game.player2.isDummy) {
        move2 = getDummyBotMove(game.player2.dummyType, game.pos2, game.pos1, game.trail2, game.trail1);
      } else {
        try {
          const resp2 = await fetch(game.player2.webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: { text: "@" + game.player2.bot + " " + tickPromptP2 }, botName: game.player2.bot })
          });
          const data2 = await resp2.json();
          // Parse response - look for LEFT, RIGHT, or STRAIGHT in the response
          const responseText = (data2.reply || data2.response || data2.text || data2.message || '').toUpperCase();
          if (responseText.includes('LEFT')) {
            move2 = 'LEFT';
          } else if (responseText.includes('RIGHT')) {
            move2 = 'RIGHT';
          } else {
            move2 = 'STRAIGHT';
          }
          console.log(`Light Bike P2 (${game.player2.bot}): "${responseText}" -> ${move2}`);
        } catch (e) {
          console.log('Light Bike: P2 bot error', e.message);
        }
      }
      
      // Apply moves
      game.pos1 = applyLightBikeMove(game.pos1, move1);
      game.pos2 = applyLightBikeMove(game.pos2, move2);
      
      // Add to trails
      game.trail1.push({ x: game.pos1.x, y: game.pos1.y });
      game.trail2.push({ x: game.pos2.x, y: game.pos2.y });
      
      // Check collisions
      const p1Dead = checkLightBikeCollision(game.pos1, game.trail1, game.trail2);
      const p2Dead = checkLightBikeCollision(game.pos2, game.trail2, game.trail1);
      
      if (p1Dead && p2Dead) {
        game.state = 'finished';
        game.winner = null; // Draw
      } else if (p1Dead) {
        game.state = 'finished';
        game.winner = game.player2.bot;
      } else if (p2Dead) {
        game.state = 'finished';
        game.winner = game.player1.bot;
      }
      
      // Max ticks safety (at 10sec/tick, 100 ticks = ~16 minutes max)
      if (game.tick > 100) {
        game.state = 'finished';
        game.winner = null;
      }
      
      // Broadcast tick to all users in note (handles multi-session)
      broadcastToNote(noteId, 'lightbikeTick', { artifactId, gameState: game });
      
      if (game.state === 'finished') {
        clearInterval(gameLoop);
        const endMsgId = 'msg-' + (++messageIdCounter);
        const resultText = game.winner ? `LIGHT BIKE: ${game.winner} WINS!` : 'LIGHT BIKE: DRAW!';
        const endMsg = {
          id: endMsgId,
          noteId,
          author: 'SYSTEM',
          authorType: 'system',
          text: resultText,
          time: getTimeString(),
          timestamp: Date.now()
        };
        if (note) note.messages.push(endMsg);
        broadcastToNote(noteId, 'message', endMsg);
      }
    }, 10000); // 10 seconds per tick
  });
  
  // --------------------------------------------
  // WALLET - REGISTER ADDRESS
  // --------------------------------------------
  socket.on('registerWalletAddress', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    const { address } = data;
    if (!address) return;
    
    state.walletAddresses[user.name.toLowerCase()] = address;
    console.log(`Wallet address registered: ${user.name} → ${address}`);
    
    // Confirm to client
    socket.emit('walletAddressRegistered', { success: true, address });
  });
  
  // --------------------------------------------
  // WALLET - NOCK SEND CONFIRMED (on-chain)
  // --------------------------------------------
  socket.on('nockSendConfirmed', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    const { to, amount, txHash, replyToMessageId } = data;
    console.log(`nockSendConfirmed: ${user.name} sent ${amount} NOCK to ${to}, tx: ${txHash}`);
    
    const timeStr = getTimeString();
    const timestamp = Date.now();
    
    // Initialize wallets for both users
    const senderWallet = initWallet(user.name);
    
    // Log transaction for sender (sent - red)
    senderWallet.transactions.unshift({
      type: 'sent',
      to: to,
      amount: amount,
      txid: txHash,
      time: timeStr,
      timestamp: timestamp
    });
    // Keep last 50
    if (senderWallet.transactions.length > 50) senderWallet.transactions.length = 50;
    
    // Send updated wallet to sender
    const senderSockets = getSocketsForUser(user.name);
    senderSockets.forEach(sid => {
      io.to(sid).emit('walletUpdate', senderWallet);
    });
    
    // Check if recipient is a GRIMOIRE user (not just an address)
    const recipientIsUser = !to.startsWith('0x');
    
    if (recipientIsUser) {
      // Log transaction for recipient (received - green)
      const recipientWallet = initWallet(to);
      recipientWallet.transactions.unshift({
        type: 'received',
        from: user.name,
        amount: amount,
        txid: txHash,
        time: timeStr,
        timestamp: timestamp
      });
      if (recipientWallet.transactions.length > 50) recipientWallet.transactions.length = 50;
      
      // Send updated wallet to recipient
      const recipientSockets = getSocketsForUser(to);
      recipientSockets.forEach(sid => {
        io.to(sid).emit('walletUpdate', recipientWallet);
      });
    }
    
    // Now handle the message/DM
    if (replyToMessageId) {
      // REPLY SEND - post as reply in current note
      const noteId = user.currentNote || 'cover';
      const note = state.notes[noteId];
      
      const messageId = 'msg-' + (++messageIdCounter);
      const message = {
        id: messageId,
        noteId: noteId,
        author: user.name,
        authorType: user.type,
        text: `sent ${amount.toFixed(2)} $NOCK`,
        time: timeStr,
        timestamp: timestamp,
        isNockSend: true,
        txHash: txHash,
        replyTo: replyToMessageId
      };
      
      if (note) {
        note.messages.push(message);
        if (!note.threads) note.threads = {};
        if (!note.threads[replyToMessageId]) {
          note.threads[replyToMessageId] = [];
        }
        note.threads[replyToMessageId].push(messageId);
      }
      
      broadcastToNote(noteId, 'message', message);
      
    } else if (recipientIsUser) {
      // WALLET SEND to GRIMOIRE user - find existing DM or create new one
      
      // Search for existing DM between these two users
      let dm = null;
      for (const noteId in state.notes) {
        const note = state.notes[noteId];
        if (note.type === 'dm' && note.users && note.users.length === 2) {
          const hasUser = note.users.some(u => u.toLowerCase() === user.name.toLowerCase());
          const hasRecipient = note.users.some(u => u.toLowerCase() === to.toLowerCase());
          if (hasUser && hasRecipient) {
            dm = note;
            break;
          }
        }
      }
      
      let dmCreated = false;
      
      // Create DM only if none exists
      if (!dm) {
        dmCreated = true;
        const participants = [user.name, to].sort();
        const dmId = 'dm-' + participants.map(p => p.toLowerCase()).join('-');
        dm = {
          id: dmId,
          name: to,  // Will be personalized per-user when sent
          type: 'dm',
          creator: user.name,
          users: participants,
          messages: [],
          threads: {},
          children: [],
          parent: null,
          visibility: 'private',
          writable: true
        };
        state.notes[dmId] = dm;
        console.log(`Created DM ${dmId} for wallet send between ${user.name} and ${to}`);
      }
      
      const messageId = 'msg-' + (++messageIdCounter);
      const message = {
        id: messageId,
        noteId: dm.id,
        author: user.name,
        authorType: user.type,
        text: `sent ${amount.toFixed(2)} $NOCK`,
        time: timeStr,
        timestamp: timestamp,
        isNockSend: true,
        txHash: txHash
      };
      
      dm.messages.push(message);
      
      // If DM was just created, send noteCreated to both users
      if (dmCreated) {
        // Send to sender with recipient's name as DM name
        const senderDm = { ...dm, name: to };
        senderSockets.forEach(sid => {
          io.to(sid).emit('noteCreated', { note: senderDm });
        });
        
        // Send to recipient with sender's name as DM name
        const recipientSockets = getSocketsForUser(to);
        const recipientDm = { ...dm, name: user.name };
        recipientSockets.forEach(sid => {
          io.to(sid).emit('noteCreated', { note: recipientDm });
        });
      }
      
      // Broadcast message to both participants
      broadcastToNote(dm.id, 'message', message);
      
      // Also notify recipient about the DM
      const recipientSockets = getSocketsForUser(to);
      recipientSockets.forEach(sid => {
        io.to(sid).emit('dmNotification', { 
          dmId: dm.id, 
          from: user.name, 
          preview: `sent ${amount.toFixed(2)} $NOCK` 
        });
      });
    }
    // If wallet send to raw address (not a user), no message is posted
  });
  
  // --------------------------------------------
  // WALLET - GET WALLET
  // --------------------------------------------
  socket.on('getWallet', () => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    const wallet = initWallet(user.name);
    socket.emit('walletUpdate', wallet);
  });
  
  // --------------------------------------------
  // WALLET - SEND NOCK (fake/legacy)
  // --------------------------------------------
  socket.on('sendNock', (data) => {
    const user = state.users.get(socket.id);
    if (!user) {
      console.log('sendNock: No user found for socket', socket.id);
      return;
    }
    
    const { to, amount, replyToMessageId } = data;
    console.log(`sendNock: ${user.name} sending ${amount} to ${to}`);
    
    const wallet = state.wallets[user.name];
    
    if (!wallet || wallet.balance < amount) {
      console.log('sendNock: Insufficient balance or no wallet');
      socket.emit('error', { message: 'Insufficient balance' });
      return;
    }
    
    const timeStr = getTimeString();
    
    // Deduct from sender
    wallet.balance -= amount;
    wallet.transactions.push({
      type: 'sent',
      who: to,
      amount,
      time: timeStr
    });
    console.log(`sendNock: Deducted from ${user.name}, new balance: ${wallet.balance}`);
    
    // Add to recipient's wallet (by username)
    const recipientWallet = initWallet(to);
    recipientWallet.balance += amount;
    recipientWallet.transactions.push({
      type: 'received',
      who: user.name,
      amount,
      time: timeStr
    });
    console.log(`sendNock: Added to ${to}, new balance: ${recipientWallet.balance}`);
    
    // Notify recipient of wallet update (all their sessions)
    emitToUser(to, 'walletUpdate', recipientWallet);
    
    // Notify sender of wallet update (all their sessions)
    emitToUser(user.name, 'walletUpdate', wallet);
    console.log('sendNock: Sent walletUpdate to both parties');
    
    // If this is a reply (hover SEND), keep in current note and thread
    if (replyToMessageId) {
      const noteId = user.currentNote || 'cover';
      const note = state.notes[noteId];
      
      const messageId = 'msg-' + (++messageIdCounter);
      const message = {
        id: messageId,
        noteId: noteId,
        author: user.name,
        authorType: user.type,
        text: `sent ${amount.toFixed(2)} $NOCK`,
        time: timeStr,
        timestamp: Date.now(),
        isNockSend: true,
        replyTo: replyToMessageId
      };
      
      if (note) {
        note.messages.push(message);
        if (!note.threads) note.threads = {};
        if (!note.threads[replyToMessageId]) {
          note.threads[replyToMessageId] = [];
        }
        note.threads[replyToMessageId].push(messageId);
      }
      
      broadcastToNote(noteId, 'message', message);
    } else {
      // Wallet modal SEND - goes to 2-person DM only (not groups)
      let dmNote = null;
      let dmNoteId = null;
      
      for (const [id, note] of Object.entries(state.notes)) {
        // Only match top-level DMs with exactly 2 users
        if (note.type === 'dm' && !note.isSpecial && !note.parent) {
          const noteUsers = note.users || [];
          // Must have exactly 2 users and include both sender and recipient
          if (noteUsers.length === 2 && noteUsers.includes(user.name) && noteUsers.includes(to)) {
            dmNote = note;
            dmNoteId = id;
            break;
          }
        }
      }
      
      // If no DM exists, create one
      if (!dmNote) {
        dmNoteId = 'note-' + (++noteIdCounter);
        dmNote = {
          id: dmNoteId,
          name: to,
          type: 'dm',
          creator: user.name,
          users: [user.name, to],
          messages: [],
          threads: {},
          children: [],
          parent: null,
          visibility: 'private',
          writable: true
        };
        state.notes[dmNoteId] = dmNote;
        
        // Notify sender about the new DM (all their sessions)
        emitToUser(user.name, 'noteInvite', { note: dmNote, fromUser: to });
        
        // Notify recipient about the new DM (all their sessions)
        const recipientNote = { ...dmNote, name: user.name };
        emitToUser(to, 'noteInvite', { note: recipientNote, fromUser: user.name });
      }
      
      // Post message to DM
      const messageId = 'msg-' + (++messageIdCounter);
      const message = {
        id: messageId,
        noteId: dmNoteId,
        author: user.name,
        authorType: user.type,
        text: `sent ${amount.toFixed(2)} $NOCK`,
        time: timeStr,
        timestamp: Date.now(),
        isNockSend: true
      };
      
      dmNote.messages.push(message);
      
      // Send to all users in the DM (all their sessions, deduped)
      const notifiedUsers = new Set();
      const userIds = getUsersInNote(dmNoteId);
      userIds.forEach(id => {
        const viewingUser = state.users.get(id);
        if (!viewingUser || notifiedUsers.has(viewingUser.name.toLowerCase())) return;
        notifiedUsers.add(viewingUser.name.toLowerCase());
        emitToUser(viewingUser.name, 'message', message);
      });
    }
  });
  
  // --------------------------------------------
  // WALLET - REQUEST NOCK
  // --------------------------------------------
  socket.on('requestNock', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    const { from, amount } = data;
    const timeStr = getTimeString();
    
    // Find existing top-level 2-person DM with this person or create one
    let dmNote = null;
    let dmNoteId = null;
    
    for (const [id, note] of Object.entries(state.notes)) {
      // Only match top-level DMs with exactly 2 users
      if (note.type === 'dm' && !note.isSpecial && !note.parent) {
        const noteUsers = note.users || [];
        // Must have exactly 2 users and include both parties
        if (noteUsers.length === 2 && noteUsers.includes(user.name) && noteUsers.includes(from)) {
          dmNote = note;
          dmNoteId = id;
          break;
        }
      }
    }
    
    // If no DM exists, create one
    if (!dmNote) {
      dmNoteId = 'note-' + (++noteIdCounter);
      dmNote = {
        id: dmNoteId,
        name: from, // Named after the other person from requester's perspective
        type: 'dm',
        creator: user.name,
        users: [user.name, from],
        messages: [],
        threads: {},
        children: [],
        parent: null,
        visibility: 'private',
        writable: true
      };
      state.notes[dmNoteId] = dmNote;
      
      // Notify requester about the new DM
      emitToUser(user.name, 'noteInvite', { note: dmNote, fromUser: from });
      
      // Notify recipient about the new DM (all their sessions)
      const recipientNote = { ...dmNote, name: user.name }; // Named after requester for recipient
      emitToUser(from, 'noteInvite', { note: recipientNote, fromUser: user.name });
    }
    
    const messageId = 'msg-' + (++messageIdCounter);
    const message = {
      id: messageId,
      noteId: dmNoteId,
      author: user.name,
      authorType: user.type,
      text: `requesting ${amount.toFixed(2)} $NOCK`,
      time: timeStr,
      timestamp: Date.now(),
      isNockRequest: true
    };
    
    dmNote.messages.push(message);
    
    // Send to all users in the DM (all their sessions)
    const notifiedUsers = new Set();
    const userIds = getUsersInNote(dmNoteId);
    userIds.forEach(id => {
      const viewingUser = state.users.get(id);
      if (!viewingUser || notifiedUsers.has(viewingUser.name.toLowerCase())) return;
      notifiedUsers.add(viewingUser.name.toLowerCase());
      emitToUser(viewingUser.name, 'message', message);
    });
  });
  
  // --------------------------------------------
  // BOT WEBHOOK REGISTRATION
  // --------------------------------------------
  socket.on('registerBot', (data) => {
    const user = state.users.get(socket.id);
    if (!user) return;
    
    state.bots[socket.id] = {
      id: socket.id,
      name: data.name,
      webhookUrl: data.webhookUrl,
      owner: user.name
    };
    
    console.log(`Bot registered: ${data.name} -> ${data.webhookUrl} (owner: ${user.name})`);
    socket.emit('botRegistered', { success: true, name: data.name, owner: user.name });
    
    // Broadcast updated agents list to all users (with owner info)
    const agentList = Object.values(state.bots).map(b => ({ name: b.name, owner: b.owner }));
    io.emit('agentsList', agentList);
  });
  
  // --------------------------------------------
  // DISCONNECT
  // --------------------------------------------
  socket.on('disconnect', () => {
    const user = state.users.get(socket.id);
    if (user) {
      const nameLower = user.name.toLowerCase();
      
      // Remove this socket from user's sessions
      const sessions = state.userSessions.get(nameLower);
      if (sessions) {
        sessions.delete(socket.id);
        
        // If no more sessions, user has fully disconnected
        if (sessions.size === 0) {
          state.userSessions.delete(nameLower);
          console.log(`User left: ${user.name} (all sessions closed)`);
          socket.broadcast.emit('userLeft', { name: user.name });
          
          // Free up the username (only for non-urbit users)
          if (user.type !== 'urbit') {
            state.activeUsernames.delete(nameLower);
          }
        } else {
          console.log(`User session closed: ${user.name} (${sessions.size} session(s) remaining)`);
        }
      }
    }
    
    state.users.delete(socket.id);
    delete state.bots[socket.id];
    
    broadcastUserList();
  });
});

// ============================================
// BOT WEBHOOK TRIGGER
// ============================================

async function triggerWebhook(bot, message) {
  try {
    const response = await fetch(bot.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: message,
        botName: bot.name
      })
    });
    
    if (response.ok) {
      const data = await response.json();
      
      // Handle text reply
      if (data.reply) {
        const messageId = 'msg-' + (++messageIdCounter);
        const timeStr = getTimeString();
        
        // Get the note the original message was in
        const noteId = message.noteId || 'cover';
        const note = state.notes[noteId];
        
        const botMessage = {
          id: messageId,
          noteId: noteId,
          author: bot.name,
          authorType: 'agent',
          text: data.reply,
          time: timeStr,
          timestamp: Date.now(),
          replyTo: message.id
        };
        
        // Store in note
        if (note) {
          note.messages.push(botMessage);
          
          if (!note.threads) {
            note.threads = {};
          }
          if (!note.threads[message.id]) {
            note.threads[message.id] = [];
          }
          note.threads[message.id].push(messageId);
        }
        
        // Broadcast to users in the note
        const userIds = getUsersInNote(noteId);
        userIds.forEach(id => {
          io.to(id).emit('message', botMessage);
        });
      }
      
      // Handle actions
      if (data.actions && Array.isArray(data.actions)) {
        for (const action of data.actions) {
          await executeAction(bot, action, message);
        }
      }
    }
  } catch (err) {
    console.error(`Webhook error for ${bot.name}:`, err.message);
  }
}

async function executeAction(bot, action, triggerMessage) {
  const timeStr = getTimeString();
  const noteId = triggerMessage.noteId || 'cover';
  const note = state.notes[noteId];
  
  switch (action.type) {
    case 'createArtifact': {
      const artifactId = 'artifact-' + (++artifactIdCounter);
      
      const artifact = {
        id: artifactId,
        name: action.name || 'untitled',
        type: action.artifactType || 'markdown',
        creator: bot.name,
        creatorType: 'agent',
        noteId: noteId,
        contributors: [],
        versions: [{
          version: 1,
          content: action.content || '',
          modified: timeStr,
          editor: bot.name,
          editorType: 'agent'
        }]
      };
      
      state.artifacts[artifactId] = artifact;
      
      const userIds = getUsersInNote(noteId);
      userIds.forEach(id => {
        io.to(id).emit('artifactCreated', artifact);
      });
      
      // Post message about artifact creation
      const messageId = 'msg-' + (++messageIdCounter);
      const msg = {
        id: messageId,
        noteId: noteId,
        author: bot.name,
        authorType: 'agent',
        text: `created artifact: ${artifact.name}`,
        time: timeStr,
        timestamp: Date.now(),
        artifactId: artifactId,
        artifactVersion: 1
      };
      
      if (note) note.messages.push(msg);
      userIds.forEach(id => {
        io.to(id).emit('message', msg);
      });
      
      console.log(`Bot ${bot.name} created artifact: ${artifact.name}`);
      break;
    }
    
    case 'editArtifact': {
      const artifact = state.artifacts[action.artifactId];
      if (!artifact) {
        console.log(`Bot ${bot.name} tried to edit non-existent artifact: ${action.artifactId}`);
        break;
      }
      
      const newVersion = artifact.versions.length + 1;
      artifact.versions.push({
        version: newVersion,
        content: action.content,
        modified: timeStr,
        editor: bot.name,
        editorType: 'agent'
      });
      
      if (!artifact.contributors.includes(bot.name)) {
        artifact.contributors.push(bot.name);
      }
      
      const userIds = getUsersInNote(noteId);
      userIds.forEach(id => {
        io.to(id).emit('artifactUpdated', artifact);
      });
      
      // Post message about edit
      const messageId = 'msg-' + (++messageIdCounter);
      const msg = {
        id: messageId,
        noteId: noteId,
        author: bot.name,
        authorType: 'agent',
        text: `edited artifact: ${artifact.name}`,
        time: timeStr,
        timestamp: Date.now(),
        artifactId: artifact.id,
        artifactVersion: newVersion
      };
      
      if (note) note.messages.push(msg);
      userIds.forEach(id => {
        io.to(id).emit('message', msg);
      });
      
      console.log(`Bot ${bot.name} edited artifact: ${artifact.name} (v${newVersion})`);
      break;
    }
    
    case 'sendNock': {
      // Init wallet by username (recipient might not be online)
      const recipientWallet = initWallet(action.to);
      recipientWallet.balance += action.amount;
      recipientWallet.transactions.push({
        type: 'received',
        who: bot.name,
        amount: action.amount,
        time: timeStr
      });
      
      // Notify recipient (all their sessions, if online)
      emitToUser(action.to, 'walletUpdate', recipientWallet);
      
      // Post message about transfer
      const messageId = 'msg-' + (++messageIdCounter);
      const msg = {
        id: messageId,
        noteId: noteId,
        author: bot.name,
        authorType: 'agent',
        text: `sent ${action.amount.toFixed(2)} $NOCK to ${action.to}`,
        time: timeStr,
        timestamp: Date.now(),
        isNockSend: true
      };
      
      if (note) note.messages.push(msg);
      
      // Send to all users in note (deduped)
      const notifiedUsers = new Set();
      const userIds = getUsersInNote(noteId);
      userIds.forEach(id => {
        const viewingUser = state.users.get(id);
        if (!viewingUser || notifiedUsers.has(viewingUser.name.toLowerCase())) return;
        notifiedUsers.add(viewingUser.name.toLowerCase());
        emitToUser(viewingUser.name, 'message', msg);
      });
      
      console.log(`Bot ${bot.name} sent ${action.amount} NOCK to ${action.to}`);
      break;
    }
    
    case 'message': {
      const messageId = 'msg-' + (++messageIdCounter);
      const msg = {
        id: messageId,
        noteId: noteId,
        author: bot.name,
        authorType: 'agent',
        text: action.text,
        time: timeStr,
        timestamp: Date.now(),
        replyTo: action.replyTo || null
      };
      
      if (note) {
        note.messages.push(msg);
        if (action.replyTo) {
          if (!note.threads) note.threads = {};
          if (!note.threads[action.replyTo]) {
            note.threads[action.replyTo] = [];
          }
          note.threads[action.replyTo].push(messageId);
        }
      }
      
      const userIds = getUsersInNote(noteId);
      userIds.forEach(id => {
        io.to(id).emit('message', msg);
      });
      
      console.log(`Bot ${bot.name} sent message: ${action.text}`);
      break;
    }
    
    default:
      console.log(`Bot ${bot.name} tried unknown action: ${action.type}`);
  }
}

// ============================================
// HTTP ROUTES
// ============================================

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', users: state.users.size });
});

// Bot webhook endpoint (for external bots to post messages)
app.post('/api/bot/message', (req, res) => {
  const { botName, text, apiKey, noteId = 'cover' } = req.body;
  
  // Find bot by name
  const bot = Object.values(state.bots).find(b => b.name === botName);
  
  if (!bot) {
    return res.status(404).json({ error: 'Bot not found' });
  }
  
  const note = state.notes[noteId];
  if (!note) {
    return res.status(404).json({ error: 'Note not found' });
  }
  
  const messageId = 'msg-' + (++messageIdCounter);
  const timeStr = getTimeString();
  
  const message = {
    id: messageId,
    noteId: noteId,
    author: botName,
    authorType: 'agent',
    text,
    time: timeStr,
    timestamp: Date.now()
  };
  
  note.messages.push(message);
  
  const userIds = getUsersInNote(noteId);
  userIds.forEach(id => {
    io.to(id).emit('message', message);
  });
  
  res.json({ success: true, messageId });
});

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║         GRIMOIRE SERVER                ║
║                                        ║
║   Running on http://localhost:${PORT}    ║
║                                        ║
║   Open in multiple browser tabs        ║
║   to test multi-user chat!             ║
╚════════════════════════════════════════╝
  `);
});
